import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEventSourceInstance = {
  addEventListener: vi.fn(),
  close: vi.fn(),
  readyState: 1,
};

vi.mock('eventsource', () => {
  const EventSourceMock: any = vi.fn().mockImplementation(function() {
    return mockEventSourceInstance;
  });
  EventSourceMock.OPEN = 1;
  EventSourceMock.CLOSED = 2;
  EventSourceMock.CONNECTING = 0;
  
  return {
    EventSource: EventSourceMock,
  };
});

import { SSEClient } from '../services/sseClient.js';
import { EventSource } from 'eventsource';

const MockEventSource = EventSource as unknown as ReturnType<typeof vi.fn>;

describe('SSEClient', () => {
  let client: SSEClient;

  beforeEach(() => {
    mockEventSourceInstance.addEventListener = vi.fn();
    mockEventSourceInstance.close = vi.fn();
    mockEventSourceInstance.readyState = 1;
    MockEventSource.mockClear();
    client = new SSEClient();
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('connect', () => {
    it('should connect to SSE endpoint', () => {
      client.connect('http://127.0.0.1:3000');

      expect(MockEventSource).toHaveBeenCalledWith('http://127.0.0.1:3000/event');
    });

    it('should set up message event listener', () => {
      client.connect('http://127.0.0.1:3000');

      expect(mockEventSourceInstance.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should set up error event listener', () => {
      client.connect('http://127.0.0.1:3000');

      expect(mockEventSourceInstance.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('onPartUpdated', () => {
    it('should trigger callback for text part updates', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onPartUpdated(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: 'Hello, world!',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith({
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'msg-1',
        text: 'Hello, world!',
        rawText: 'Hello, world!',
        systemTexts: [],
      });
    });

    it('should strip system reminders from visible text updates', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onPartUpdated(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: 'Visible text\n<system-reminder>Background completed</system-reminder>',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith({
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'msg-1',
        text: 'Visible text',
        rawText: 'Visible text\n<system-reminder>Background completed</system-reminder>',
        systemTexts: ['<system-reminder>Background completed</system-reminder>'],
      });
    });

    it('should not trigger visible callback for reminder-only text', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onPartUpdated(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: '<system-reminder>Background completed</system-reminder>',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not trigger callback for non-text parts', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onPartUpdated(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not trigger callback for non-part-updated events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onPartUpdated(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'other.event',
          properties: {},
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onMessagePart', () => {
    it('should trigger callback for subtask parts from message.part.updated events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onMessagePart(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      messageHandler({
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'subtask',
              id: 'part-2',
              sessionID: 'session-1',
              messageID: 'msg-1',
              prompt: 'Investigate the API behavior',
              description: 'Background worker',
              agent: 'general',
            },
          },
        }),
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'part-2',
          sessionID: 'session-1',
          messageID: 'msg-1',
          type: 'subtask',
        }),
      );
    });
  });

  describe('onSessionIdle', () => {
    it('should trigger callback for session.idle events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionIdle(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.idle',
          properties: {
            sessionID: 'session-1',
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1');
    });

    it('should not trigger callback for non-idle events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionIdle(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'other.event',
          properties: {},
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onSessionStatus', () => {
    it('should trigger callback for session.status events with busy', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionStatus(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
            status: { type: 'busy' },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1', { type: 'busy' });
    });

    it('should trigger callback for session.status events with idle', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionStatus(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
            status: { type: 'idle' },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1', { type: 'idle' });
    });

    it('should trigger callback for session.status events with retry', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionStatus(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.status',
          properties: {
            sessionID: 'session-2',
            status: { type: 'retry', attempt: 2, message: 'Rate limited', next: '2026-03-26T12:00:00Z' },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-2', {
        type: 'retry',
        attempt: 2,
        message: 'Rate limited',
        next: '2026-03-26T12:00:00Z',
      });
    });

    it('should not trigger callback when status property is missing', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionStatus(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onSessionError', () => {
    it('should trigger callback for session.error events with ProviderAuthError', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionError(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
            error: {
              name: 'ProviderAuthError',
              data: {
                message: 'Invalid model ID',
                providerID: 'ollama',
              },
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1', {
        name: 'ProviderAuthError',
        data: {
          message: 'Invalid model ID',
          providerID: 'ollama',
        },
      });
    });

    it('should trigger callback for session.error events with UnknownError', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionError(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.error',
          properties: {
            sessionID: 'session-2',
            error: {
              name: 'UnknownError',
              data: {
                message: 'Rate limit exceeded',
              },
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-2', {
        name: 'UnknownError',
        data: {
          message: 'Rate limit exceeded',
        },
      });
    });

    it('should not trigger callback when error property is missing', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionError(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not trigger callback for non-error events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSessionError(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.idle',
          properties: {
            sessionID: 'session-1',
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onActivity', () => {
    it('should trigger callback for text part updates', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onActivity(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: 'Hello',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1');
    });

    it('should trigger callback for tool part updates', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onActivity(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith('session-1');
    });

    it('should not trigger callback when part has no sessionID', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onActivity(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not trigger callback for non-part-updated events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onActivity(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'session.idle',
          properties: {
            sessionID: 'session-1',
          },
        }),
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onSystemText', () => {
    it('should trigger callback for extracted system reminder text', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onSystemText(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: 'Visible\n<system-reminder>Background completed</system-reminder>',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith({
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'msg-1',
        text: '<system-reminder>Background completed</system-reminder>',
        rawText: 'Visible\n<system-reminder>Background completed</system-reminder>',
      });
    });
  });

  describe('onBackgroundSignal', () => {
    it('should trigger callback for background task completed reminders', () => {
      const callback = vi.fn();
      const completionCallback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onBackgroundSignal(callback);
      client.onCompletion(completionCallback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const event = {
        data: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'text',
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'msg-1',
              text: '<system-reminder>[BACKGROUND TASK COMPLETED] Worker finished.</system-reminder>',
            },
          },
        }),
      };

      messageHandler(event);

      expect(callback).toHaveBeenCalledWith({
        sessionID: 'session-1',
        source: 'system_reminder_background_completed',
        text: '<system-reminder>[BACKGROUND TASK COMPLETED] Worker finished.</system-reminder>',
        rawText: '<system-reminder>[BACKGROUND TASK COMPLETED] Worker finished.</system-reminder>',
      });
      expect(completionCallback).not.toHaveBeenCalled();
    });
  });

  describe('onRawEvent', () => {
    it('should forward every raw SSE event', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onRawEvent(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const parsedEvent = {
        type: 'session.status',
        properties: {
          sessionID: 'session-1',
          status: { type: 'busy' },
        },
      };

      messageHandler({ data: JSON.stringify(parsedEvent) });

      expect(callback).toHaveBeenCalledWith(parsedEvent);
    });
  });

  describe('onCompletion', () => {
    it('should trigger callback for step-finish parts sent through message.part.updated events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onCompletion(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const stepFinishPartEvent = {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'step-finish',
            id: 'part-3',
            sessionID: 'session-1',
            messageID: 'msg-1',
          },
        },
      };

      messageHandler({ data: JSON.stringify(stepFinishPartEvent) });

      expect(callback).toHaveBeenCalledWith({
        sessionID: 'session-1',
        source: 'part_step_finish',
        event: stepFinishPartEvent,
      });
    });

    it('should trigger callback for step_finish events', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onCompletion(callback);

      const messageHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'message'
      )?.[1];

      const stepFinishEvent = {
        type: 'step_finish',
        properties: {
          sessionID: 'session-1',
        },
      };

      messageHandler({ data: JSON.stringify(stepFinishEvent) });

      expect(callback).toHaveBeenCalledWith({
        sessionID: 'session-1',
        source: 'step_finish',
        event: stepFinishEvent,
      });
    });
  });

  describe('onError', () => {
    it('should trigger callback on error', () => {
      const callback = vi.fn();
      client.connect('http://127.0.0.1:3000');
      client.onError(callback);

      const errorHandler = mockEventSourceInstance.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'error'
      )?.[1];

      const error = new Error('Connection failed');
      errorHandler(error);

      expect(callback).toHaveBeenCalledWith(error);
    });
  });

  describe('disconnect', () => {
    it('should close the connection', () => {
      client.connect('http://127.0.0.1:3000');
      client.disconnect();

      expect(mockEventSourceInstance.close).toHaveBeenCalled();
    });

    it('should handle disconnect when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return true when connected', () => {
      client.connect('http://127.0.0.1:3000');
      mockEventSourceInstance.readyState = 1;

      expect(client.isConnected()).toBe(true);
    });

    it('should return false when disconnected', () => {
      client.connect('http://127.0.0.1:3000');
      mockEventSourceInstance.readyState = 2;

      expect(client.isConnected()).toBe(false);
    });

    it('should return false when not initialized', () => {
      expect(client.isConnected()).toBe(false);
    });
  });
});
