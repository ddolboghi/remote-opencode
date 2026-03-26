import { EventSource } from 'eventsource';
import type {
  BackgroundSignal,
  CompletionSignal,
  MessagePart,
  SSEEvent,
  SessionErrorInfo,
  SessionStatusInfo,
  SystemTextPart,
  VisibleTextPart,
} from '../types/index.js';

type PartUpdatedCallback = (part: VisibleTextPart) => void;
type MessagePartCallback = (part: MessagePart) => void;
type SessionIdleCallback = (sessionId: string) => void;
type SessionStatusCallback = (sessionId: string, status: SessionStatusInfo) => void;
type SessionErrorCallback = (sessionId: string, error: SessionErrorInfo) => void;
type ErrorCallback = (error: Error) => void;
type ActivityCallback = (sessionId: string) => void;
type RawEventCallback = (event: SSEEvent) => void;
type SystemTextCallback = (part: SystemTextPart) => void;
type BackgroundSignalCallback = (signal: BackgroundSignal) => void;
type CompletionCallback = (signal: CompletionSignal) => void;

const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const BACKGROUND_TASK_COMPLETED_PATTERN = /\[BACKGROUND TASK COMPLETED\]/i;

function splitTextChannels(text: string): { visibleText: string; systemTexts: string[] } {
  const systemTexts = Array.from(text.matchAll(SYSTEM_REMINDER_REGEX), match => match[0]);
  const visibleText = text
    .replace(SYSTEM_REMINDER_REGEX, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { visibleText, systemTexts };
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private partUpdatedCallbacks: PartUpdatedCallback[] = [];
  private messagePartCallbacks: MessagePartCallback[] = [];
  private sessionIdleCallbacks: SessionIdleCallback[] = [];
  private sessionStatusCallbacks: SessionStatusCallback[] = [];
  private sessionErrorCallbacks: SessionErrorCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private activityCallbacks: ActivityCallback[] = [];
  private rawEventCallbacks: RawEventCallback[] = [];
  private systemTextCallbacks: SystemTextCallback[] = [];
  private backgroundSignalCallbacks: BackgroundSignalCallback[] = [];
  private completionCallbacks: CompletionCallback[] = [];

  connect(baseUrl: string): void {
    const url = `${baseUrl}/event`;
    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener('message', (event: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        this.handleError(new Error(`Failed to parse SSE event: ${error}`));
      }
    });

    this.eventSource.addEventListener('error', (error: Event) => {
      this.handleError(error instanceof Error ? error : new Error('SSE connection error'));
    });
  }

  onPartUpdated(callback: PartUpdatedCallback): void {
    this.partUpdatedCallbacks.push(callback);
  }

  onMessagePart(callback: MessagePartCallback): void {
    this.messagePartCallbacks.push(callback);
  }

  onSessionIdle(callback: SessionIdleCallback): void {
    this.sessionIdleCallbacks.push(callback);
  }

  onSessionStatus(callback: SessionStatusCallback): void {
    this.sessionStatusCallbacks.push(callback);
  }

  onSessionError(callback: SessionErrorCallback): void {
    this.sessionErrorCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  onActivity(callback: ActivityCallback): void {
    this.activityCallbacks.push(callback);
  }

  onRawEvent(callback: RawEventCallback): void {
    this.rawEventCallbacks.push(callback);
  }

  onSystemText(callback: SystemTextCallback): void {
    this.systemTextCallbacks.push(callback);
  }

  onBackgroundSignal(callback: BackgroundSignalCallback): void {
    this.backgroundSignalCallbacks.push(callback);
  }

  onCompletion(callback: CompletionCallback): void {
    this.completionCallbacks.push(callback);
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  private handleMessage(event: SSEEvent): void {
    this.rawEventCallbacks.forEach((cb) => cb(event));

    if (event.type === 'message.part.updated') {
      const part = (event.properties as any).part;
      if (part?.sessionID) {
        this.activityCallbacks.forEach((cb) => cb(part.sessionID));
      }
      if (part?.id && part?.sessionID && part?.messageID && part?.type) {
        const messagePart: MessagePart = {
          ...part,
        };
        this.messagePartCallbacks.forEach((cb) => cb(messagePart));

        if (part.type === 'step-finish') {
          this.completionCallbacks.forEach((cb) =>
            cb({ sessionID: part.sessionID, source: 'part_step_finish', event })
          );
        }
      }
      if (part && part.type === 'text' && typeof part.text === 'string') {
        const { visibleText, systemTexts } = splitTextChannels(part.text);
        const basePart = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
        };

        if (visibleText) {
          const textPart: VisibleTextPart = {
            ...basePart,
            text: visibleText,
            rawText: part.text,
            systemTexts,
          };
          this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
        }

        for (const systemText of systemTexts) {
          const systemPart: SystemTextPart = {
            ...basePart,
            text: systemText,
            rawText: part.text,
          };
          this.systemTextCallbacks.forEach((cb) => cb(systemPart));

          if (BACKGROUND_TASK_COMPLETED_PATTERN.test(systemText)) {
            const backgroundSignal: BackgroundSignal = {
              sessionID: part.sessionID,
              source: 'system_reminder_background_completed',
              text: systemText,
              rawText: part.text,
            };
            this.backgroundSignalCallbacks.forEach((cb) => cb(backgroundSignal));
          }
        }
      }
    } else if (event.type === 'session.idle') {
      const sessionID = (event.properties as any).sessionID;
      if (sessionID) {
        this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
      }
    } else if (event.type === 'session.status') {
      const sessionID = (event.properties as any).sessionID;
      const status = (event.properties as any).status as SessionStatusInfo | undefined;
      if (sessionID && status) {
        this.sessionStatusCallbacks.forEach((cb) => cb(sessionID, status));
      }
    } else if (event.type === 'session.error') {
      const sessionID = (event.properties as any).sessionID;
      const error = (event.properties as any).error as SessionErrorInfo | undefined;
      if (sessionID && error) {
        this.sessionErrorCallbacks.forEach((cb) => cb(sessionID, error));
      }
    } else if (event.type === 'step_finish') {
      const sessionID = (event.properties as any).sessionID;
      if (sessionID) {
        this.completionCallbacks.forEach((cb) =>
          cb({ sessionID, source: 'step_finish', event })
        );
      }
    }
  }

  private handleError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }
}
