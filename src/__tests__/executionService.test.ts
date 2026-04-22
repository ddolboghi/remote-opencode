import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sseHarness = vi.hoisted(() => {
  class MockSSEClient {
    static instances: MockSSEClient[] = [];

    partUpdatedCallback?: (part: any) => void;
    sessionIdleCallback?: (sessionId: string) => void;
    sessionStatusCallback?: (sessionId: string, status: any) => void;
    activityCallback?: (sessionId: string) => void;
    rawEventCallback?: (event: any) => void;
    messagePartCallback?: (part: any) => void;
    backgroundSignalCallback?: (signal: any) => void;
    completionCallback?: (signal: any) => void;
    sessionErrorCallback?: (sessionId: string, error: any) => void;
    errorCallback?: (error: Error) => void;

    connect = vi.fn();
    disconnect = vi.fn();

    constructor() {
      MockSSEClient.instances.push(this);
    }

    onPartUpdated(callback: (part: any) => void): void {
      this.partUpdatedCallback = callback;
    }

    onSessionIdle(callback: (sessionId: string) => void): void {
      this.sessionIdleCallback = callback;
    }

    onSessionStatus(callback: (sessionId: string, status: any) => void): void {
      this.sessionStatusCallback = callback;
    }

    onActivity(callback: (sessionId: string) => void): void {
      this.activityCallback = callback;
    }

    onRawEvent(callback: (event: any) => void): void {
      this.rawEventCallback = callback;
    }

    onMessagePart(callback: (part: any) => void): void {
      this.messagePartCallback = callback;
    }

    onBackgroundSignal(callback: (signal: any) => void): void {
      this.backgroundSignalCallback = callback;
    }

    onCompletion(callback: (signal: any) => void): void {
      this.completionCallback = callback;
    }

    onSessionError(callback: (sessionId: string, error: any) => void): void {
      this.sessionErrorCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
      this.errorCallback = callback;
    }

    emitPartUpdated(part: any): void {
      if (part?.sessionID) {
        this.activityCallback?.(part.sessionID);
      }
      this.partUpdatedCallback?.(part);
    }

    emitSessionIdle(sessionId: string): void {
      this.sessionIdleCallback?.(sessionId);
    }

    emitSessionStatus(sessionId: string, status: unknown): void {
      this.sessionStatusCallback?.(sessionId, status);
    }

    emitMessagePart(part: any): void {
      if (part?.sessionID) {
        this.activityCallback?.(part.sessionID);
      }
      this.messagePartCallback?.(part);
    }

    emitCompletion(sessionId: string): void {
      const event = { type: 'step_finish', properties: { sessionID: sessionId } };
      this.rawEventCallback?.(event);
      this.completionCallback?.({ sessionID: sessionId, source: 'step_finish', event });
    }

    emitBackgroundTaskCompleted(sessionId: string): void {
      const text = '<system-reminder>[BACKGROUND TASK COMPLETED] Worker finished.</system-reminder>';
      this.backgroundSignalCallback?.({
        sessionID: sessionId,
        source: 'system_reminder_background_completed',
        text,
        rawText: text,
      });
    }

    emitSessionError(sessionId: string, error: unknown): void {
      this.sessionErrorCallback?.(sessionId, error);
    }

    reset(): void {
      this.partUpdatedCallback = undefined;
      this.sessionIdleCallback = undefined;
      this.sessionStatusCallback = undefined;
      this.activityCallback = undefined;
      this.rawEventCallback = undefined;
      this.messagePartCallback = undefined;
      this.backgroundSignalCallback = undefined;
      this.completionCallback = undefined;
      this.sessionErrorCallback = undefined;
      this.errorCallback = undefined;
      this.connect.mockReset();
      this.disconnect.mockReset();
    }

    static resetAll(): void {
      for (const instance of MockSSEClient.instances) {
        instance.reset();
      }
      MockSSEClient.instances.length = 0;
    }
  }

  return { MockSSEClient };
});

type StreamEditPayload = {
  content: string;
  components?: Array<{
    components?: Array<{
      data?: {
        disabled?: boolean;
      };
    }>;
  }>;
};

function getLastStreamEditPayload(
  streamEdit: ReturnType<typeof vi.fn<(payload: StreamEditPayload) => Promise<unknown>>>,
): StreamEditPayload | undefined {
  const lastCall = streamEdit.mock.calls.at(-1);
  if (!lastCall) {
    return undefined;
  }

  const [payload] = lastCall as [StreamEditPayload];
  return payload;
}

function findStreamEditPayload(
  streamEdit: ReturnType<typeof vi.fn<(payload: StreamEditPayload) => Promise<unknown>>>,
  predicate: (payload: StreamEditPayload) => boolean,
): StreamEditPayload | undefined {
  const match = streamEdit.mock.calls.find((call) => {
    const [payload] = call as [StreamEditPayload];
    return predicate(payload);
  });

  if (!match) {
    return undefined;
  }

  const [payload] = match as [StreamEditPayload];
  return payload;
}

type MockSessionMessage = {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
};

function createAssistantMessage(
  id: string,
  text: string,
  options?: {
    completed?: string | number | null;
    error?: unknown;
    parts?: Array<Record<string, unknown>>;
  },
): MockSessionMessage {
  const completed = options?.completed ?? '2026-04-22T00:00:00.000Z';
  const info: Record<string, unknown> = {
    id,
    role: 'assistant',
  };

  if (completed !== null) {
    info.time = { completed };
  }

  if (options?.error !== undefined) {
    info.error = options.error;
  }

  return {
    info,
    parts: options?.parts ?? [{ type: 'text', text }],
  };
}

function setSessionMessageSequencesBySessionId(
  sessionSequences: Record<string, MockSessionMessage[][]>,
): void {
  const callCounts = new Map<string, number>();

  sessionManagerMock.getSessionMessages.mockImplementation(
    async (_port: number, requestedSessionId: string) => {
      const sequences = sessionSequences[requestedSessionId];
      if (!sequences) {
        return [];
      }

      const currentIndex = callCounts.get(requestedSessionId) ?? 0;
      callCounts.set(requestedSessionId, currentIndex + 1);
      return sequences[Math.min(currentIndex, sequences.length - 1)] ?? [];
    },
  );
}

const dataStoreMock = vi.hoisted(() => ({
  getChannelProjectPath: vi.fn(),
  getWorktreeMapping: vi.fn(),
  getChannelBinding: vi.fn(),
  getProjectAutoWorktree: vi.fn(),
  setWorktreeMapping: vi.fn(),
  getChannelModel: vi.fn(),
  getQueueSettings: vi.fn(),
  clearQueue: vi.fn(),
}));

const sessionManagerMock = vi.hoisted(() => ({
  clearSessionForThread: vi.fn(),
  ensureSessionForThread: vi.fn(),
  setSseClient: vi.fn(),
  clearSseClient: vi.fn(),
  sendPrompt: vi.fn(),
  getSessionBusyState: vi.fn(),
  getSessionChildren: vi.fn(),
  getSessionStatusMap: vi.fn(),
  getSessionMessages: vi.fn(),
  isSessionBusy: vi.fn(),
  getSseClient: vi.fn(),
}));

const serveManagerMock = vi.hoisted(() => ({
  spawnServe: vi.fn(),
  waitForReady: vi.fn(),
}));

const worktreeManagerMock = vi.hoisted(() => ({
  sanitizeBranchName: vi.fn(),
  createWorktree: vi.fn(),
  getCurrentBranch: vi.fn(),
}));

const queueManagerMock = vi.hoisted(() => ({
  processNextInQueue: vi.fn(),
}));

vi.mock('../services/dataStore.js', () => dataStoreMock);
vi.mock('../services/sessionManager.js', () => sessionManagerMock);
vi.mock('../services/serveManager.js', () => serveManagerMock);
vi.mock('../services/worktreeManager.js', () => worktreeManagerMock);
vi.mock('../services/queueManager.js', () => queueManagerMock);
vi.mock('../services/sseClient.js', () => ({
  SSEClient: sseHarness.MockSSEClient,
}));

import { clearAllPendingTimers, interruptActiveRun, runPrompt } from '../services/executionService.js';

describe('executionService messaging and completion handling', () => {
  const prompt = 'very long prompt '.repeat(200);
  const threadId = 'thread-1';
  const parentChannelId = 'parent-1';
  const sessionId = 'session-1';
  const contextHeader = '🌿 `main` · 🤖 `default`';

  let streamEdit: ReturnType<typeof vi.fn<(payload: StreamEditPayload) => Promise<unknown>>>;
  let channelSend: ReturnType<typeof vi.fn>;
  let channel: { send: ReturnType<typeof vi.fn> };
  let streamMessage: { edit: (payload: StreamEditPayload) => Promise<unknown> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sseHarness.MockSSEClient.resetAll();

    dataStoreMock.getChannelProjectPath.mockReturnValue('/project');
    dataStoreMock.getWorktreeMapping.mockReturnValue(undefined);
    dataStoreMock.getChannelBinding.mockReturnValue(undefined);
    dataStoreMock.getProjectAutoWorktree.mockReturnValue(false);
    dataStoreMock.getChannelModel.mockReturnValue(undefined);
    dataStoreMock.getQueueSettings.mockReturnValue({
      paused: false,
      continueOnFailure: false,
      freshContext: false,
    });

    serveManagerMock.spawnServe.mockResolvedValue(4321);
    serveManagerMock.waitForReady.mockResolvedValue(undefined);

    worktreeManagerMock.getCurrentBranch.mockResolvedValue('main');

    sessionManagerMock.ensureSessionForThread.mockResolvedValue(sessionId);
    sessionManagerMock.sendPrompt.mockResolvedValue(undefined);
    sessionManagerMock.getSessionBusyState.mockResolvedValue('idle');
    sessionManagerMock.getSessionChildren.mockResolvedValue([]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
    });
    sessionManagerMock.getSessionMessages.mockImplementation(async (_port: number, requestedSessionId: string) => {
      if (requestedSessionId === sessionId) {
        return [];
      }

      return [
        createAssistantMessage(
          `msg-${requestedSessionId}`,
          `Completed child output for ${requestedSessionId}`,
        ),
      ];
    });
    sessionManagerMock.isSessionBusy.mockResolvedValue(false);
    sessionManagerMock.getSseClient.mockReturnValue(undefined);

    queueManagerMock.processNextInQueue.mockResolvedValue(undefined);

    streamEdit = vi.fn().mockResolvedValue({});
    streamMessage = {
      edit: (payload: StreamEditPayload) => streamEdit(payload),
    };
    let sendCount = 0;
    channelSend = vi.fn().mockImplementation(async (payload: { content?: string }) => {
      sendCount += 1;
      if (sendCount === 1) {
        return streamMessage;
      }
      return payload;
    });

    channel = { send: channelSend };
  });

  afterEach(() => {
    clearAllPendingTimers();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('removes prompt from execution-managed status, stream, and final messages', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    expect(channelSend.mock.calls[0]?.[0].content).toBe(`${contextHeader}\n\n🚀 Starting OpenCode server...`);

    const initialEditContents = streamEdit.mock.calls.map(([payload]) => payload.content);
    expect(initialEditContents).toContain(`${contextHeader}\n\n⏳ Waiting for OpenCode server...`);
    expect(initialEditContents).toContain(`${contextHeader}\n\n📝 Sending prompt...`);
    expect(initialEditContents.every((content: string) => !content.includes(prompt))).toBe(true);

    const client = sseHarness.MockSSEClient.instances[0];
    expect(client).toBeDefined();

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'A'.repeat(5000),
    });

    await vi.advanceTimersByTimeAsync(1000);

    const editContentsAfterStreaming = streamEdit.mock.calls.map(([payload]) => payload.content as string);
    const runningContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(editContentsAfterStreaming.some((content) => content.includes('Running...'))).toBe(true);
    expect(runningContent).not.toContain(prompt);
    expect(runningContent).toContain('A'.repeat(200));
    expect(runningContent.length).toBeLessThanOrEqual(2000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const finalContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(finalContent.startsWith(`${contextHeader}\n\n`)).toBe(true);
    expect(finalContent).not.toContain('Running...');
    expect(finalContent).not.toContain(prompt);
    expect(finalContent.length).toBeLessThanOrEqual(2000);
  });

  it('shows a live transcript preview in the active representative message before completion', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    const editCountBeforeStreaming = streamEdit.mock.calls.length;
    const streamedText = 'Live transcript body '.repeat(160);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-live-status-only',
      text: streamedText,
    });

    await vi.advanceTimersByTimeAsync(2000);

    const editContents = streamEdit.mock.calls.map(([payload]) => payload.content as string);
    expect(streamEdit.mock.calls.length).toBeGreaterThan(editCountBeforeStreaming);
    expect(editContents.some((content) => content.includes('Running...'))).toBe(true);
    expect(editContents.some((content) => content.includes('Live transcript body'))).toBe(true);

    const activePreview = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(activePreview).toContain('Running...');
    expect(activePreview).toContain('Live transcript body');

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const finalContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(finalContent).toContain('Live transcript body');
    expect(finalContent).not.toContain('Running...');
  });

  it('finalizes when the parent status turns idle without a session.idle event', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-status-idle',
      text: 'Final answer from a parent idle status event',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitSessionStatus(sessionId, { type: 'idle' });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer from a parent idle status event');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('finalizes on completion signals even when the phase is still running', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-complete',
      text: 'Final answer from a completion signal',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer from a completion signal');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('replays a parent session error that arrives while sendPrompt is still in flight', async () => {
    let resolveSendPrompt: (() => void) | undefined;
    let notifySendPromptStarted: (() => void) | undefined;
    const sendPromptStarted = new Promise<void>((resolve) => {
      notifySendPromptStarted = resolve;
    });
    sessionManagerMock.sendPrompt.mockImplementation(
      () => new Promise<void>((resolve) => {
        notifySendPromptStarted?.();
        resolveSendPrompt = resolve;
      }),
    );

    const runPromise = runPrompt(channel as any, threadId, prompt, parentChannelId);
    await sendPromptStarted;

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitSessionError(sessionId, {
      name: 'ProviderAuthError',
      data: { message: 'Quota exhausted' },
    });

    resolveSendPrompt?.();
    await runPromise;
    await vi.advanceTimersByTimeAsync(0);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Quota exhausted');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
  });

  it('falls back to sending all final chunks when only the status-only cleanup succeeds', async () => {
    let lastSuccessfulStreamEditPayload: StreamEditPayload | undefined;

    streamEdit.mockImplementation(async (payload: StreamEditPayload) => {
      const { content } = payload;
      const isFinalSettlement = content.startsWith(`${contextHeader}\n\n✅ Done\n\n`);
      const isStatusOnlySettlement = content === `${contextHeader}\n\n✅ Done — output continued below.`;

      if (isFinalSettlement || isStatusOnlySettlement) {
        if (isFinalSettlement) {
          throw new Error('Invalid Form Body');
        }

        lastSuccessfulStreamEditPayload = payload;
        return {};
      }

      lastSuccessfulStreamEditPayload = payload;
      return {};
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'B'.repeat(4200),
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    const fallbackChunks = sentContents.filter(content => content !== '✅ Done');
    expect(fallbackChunks.length).toBeGreaterThan(1);
    expect(fallbackChunks.every(content => content.length <= 2000)).toBe(true);
    expect(fallbackChunks.every(content => !content.includes(prompt))).toBe(true);
    expect(sentContents).toContain('✅ Done');

    const cleanupEdit = findStreamEditPayload(
      streamEdit,
      (payload) => payload?.components?.[0]?.components?.[0]?.data?.disabled === true,
    );
    expect(cleanupEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
    expect(lastSuccessfulStreamEditPayload?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('sends a warning instead of chunks when both terminal settlement edits fail', async () => {
    let lastSuccessfulStreamEditPayload: StreamEditPayload | undefined;

    streamEdit.mockImplementation(async (payload: StreamEditPayload) => {
      const { content } = payload;
      const isFinalSettlement = content.startsWith(`${contextHeader}\n\n✅ Done\n\n`);
      const isStatusOnlySettlement = content === `${contextHeader}\n\n✅ Done — output continued below.`;

      if (isFinalSettlement || isStatusOnlySettlement) {
        throw new Error('Invalid Form Body');
      }

      lastSuccessfulStreamEditPayload = payload;
      return {};
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'Long final answer paragraph. '.repeat(220),
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents.some((content) => content.includes('Long final answer paragraph. '))).toBe(false);
    expect(sentContents).toContain('⚠️ Final response could not be posted safely because terminal cleanup failed.');
    expect(lastSuccessfulStreamEditPayload?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);
  });

  it('marks the original stream message done and clears busy state before sending overflow chunks', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-long-final',
      text: 'Long final answer paragraph. '.repeat(220),
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('✅ Done');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);

    const clearCallOrder = sessionManagerMock.clearSseClient.mock.invocationCallOrder[0];
    const trailingSendCallOrders = channelSend.mock.invocationCallOrder.slice(1);
    expect(clearCallOrder).toBeLessThan(Math.max(...trailingSendCallOrders));
  });

  it('treats parent background-dispatch visible text as background evidence', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'background task dispatched',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Waiting for background agents...');
    expect(latestContent).not.toContain('Finalizing response...');

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
  });

  it('does not finalize or disconnect SSE when the parent only reports background dispatch in visible text', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent-dispatch-only',
      text: 'background task dispatched',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
  });

  it('does not finalize while a child session is still busy', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'busy' },
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1000);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Waiting for background agents...');

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('??Done');
  });

  it('keeps structured background waits alive across repeated reconciliation ticks and restarts the fallback ceiling after children go idle', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'busy' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-long-background',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
    expect(getLastStreamEditPayload(streamEdit)?.content).toContain('Waiting for background agents...');

    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(305000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(true);
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('continues reconciling structured background waits without terminalizing if children never stop', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'busy' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-stuck-background',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(20000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
    expect(getLastStreamEditPayload(streamEdit)?.content).toContain('Waiting for background agents...');
  });

  it('continues reconciling after child activity clears idle checks and finishes once child state goes idle', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'busy' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-busy-active-background',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitMessagePart({
      type: 'thinking',
      sessionID: 'child-1',
      id: 'child-activity-1',
      messageID: 'msg-child-1',
      text: 'Still working...',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(305000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('keeps reconciling when structured evidence appears after the run is already waiting on weak background work', async () => {
    sessionManagerMock.getSessionChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValue([{ id: 'child-1', title: 'Background child' }]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [],
        [createAssistantMessage('msg-parent', 'Final answer after late structured promotion')],
      ],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-late-structured-background',
      text: 'background task dispatched',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');

    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-late-structured-background',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer after late structured promotion',
    });

    await vi.advanceTimersByTimeAsync(1600);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('ignores stale child refresh results that resolve after a newer structured-child discovery', async () => {
    let resolveFirstChildrenRequest: ((children: Array<{ id: string; title: string }>) => void) | undefined;

    sessionManagerMock.getSessionChildren
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstChildrenRequest = resolve;
          }),
      )
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValue([{ id: 'child-1', title: 'Background child' }]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'background task dispatched',
    });

    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-overlapping-refresh',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(0);

    resolveFirstChildrenRequest?.([]);
    await vi.advanceTimersByTimeAsync(0);

    client.emitSessionStatus('child-1', { type: 'busy' });
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const inFlightContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(
      inFlightContent.includes('Waiting for background agents...') ||
        inFlightContent.includes('Generating final response...'),
    ).toBe(true);

    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Final answer after stale child refresh resolution')]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer after stale child refresh resolution',
    });

    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('does not finalize from pre-child parent text when structured child discovery arrives later via the children API', async () => {
    sessionManagerMock.getSessionChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Parent text that arrived before child completion')]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'background task dispatched',
    });

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Parent text that arrived before child completion',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Fresh parent text after child completion')]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Fresh parent text after child completion',
    });

    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('does not finalize before the parent final message is confirmed after children go idle', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-before', 'Interim parent text before child completion')]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1000);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Generating final response...');

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('??Done');
  });

  it('does not finalize when a child is idle but its last assistant message is incomplete', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Parent final text after background work')]],
      'child-1': [[createAssistantMessage('msg-child-incomplete', 'Child text still streaming', { completed: null })]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-child-incomplete',
      messageID: 'msg-parent',
      prompt: 'Background worker',
      description: 'Incomplete background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const activeContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(
      activeContent.includes('Waiting for background agents...') ||
        activeContent.includes('Generating final response...'),
    ).toBe(true);
  });

  it('does not finalize when a child is idle but still has a running tool part', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Parent final text after background work')]],
      'child-1': [[
        createAssistantMessage('msg-child-tool-running', 'Child tool still running', {
          parts: [
            { type: 'text', text: 'Child tool still running' },
            { type: 'tool', state: { status: 'running' } },
          ],
        }),
      ]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-child-tool-running',
      messageID: 'msg-parent',
      prompt: 'Background worker',
      description: 'Tool-running background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
    expect(getLastStreamEditPayload(streamEdit)?.content).toContain('Waiting for background agents...');
  });

  it('finalizes after children go idle and the parent final message is confirmed', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [createAssistantMessage('msg-before', 'Interim parent text before child completion')],
        [createAssistantMessage('msg-before', 'Interim parent text before child completion')],
        [createAssistantMessage('msg-final', 'Final answer from the parent session')],
      ],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(true);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer from the parent session');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('finalizes when the parent final message reuses the same message id with updated text', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [createAssistantMessage('msg-parent', 'Interim parent text before child completion')],
        [createAssistantMessage('msg-parent', 'Interim parent text before child completion')],
        [createAssistantMessage('msg-parent', 'Final answer from the same parent message')],
      ],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer from the same parent message',
    });
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(true);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer from the same parent message');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('requires one extra confirmation before finalizing when only SSE text differs from stale parent messages', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-before', 'Interim parent text before child completion')]],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-before',
      text: 'Final answer streamed from the parent session',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(false);

    const midEdit = getLastStreamEditPayload(streamEdit);
    expect(midEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(true);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer streamed from the parent session');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('finalizes after parent final text arrives without another parent idle event', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [createAssistantMessage('msg-parent', 'Interim parent text before child completion')],
        [createAssistantMessage('msg-parent', 'Final answer after background work')],
      ],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-3',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer after background work',
    });

    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents.some((content) => content.includes('Done'))).toBe(true);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer after background work');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('does not finalize when a child disappears from children and status before any terminal child message is seen', async () => {
    sessionManagerMock.getSessionChildren
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValue([]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Final answer while child metadata vanished')]],
      'child-1': [[]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-4',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer while child metadata vanished',
    });

    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Waiting for background agents...');
  });

  it('finalizes after a child disappears from children and status once terminal success was already observed', async () => {
    sessionManagerMock.getSessionChildren
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValue([]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
      })
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'idle' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [createAssistantMessage('msg-parent', 'Interim parent text before cached child success')],
        [createAssistantMessage('msg-parent', 'Interim parent text before cached child success')],
        [createAssistantMessage('msg-parent', 'Final answer after cached child success')],
      ],
      'child-1': [[createAssistantMessage('msg-child-1', 'Completed child output for child-1')]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-4',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer after cached child success',
    });

    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');

    const midContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(midContent).toContain('Generating final response...');

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer after cached child success');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);
  });

  it('shows waiting for background agents when subtask evidence exists and completion has not been observed', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-1',
      messageID: 'msg-1',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Waiting for background agents...');

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('??Done');
  });

  it('does not mark the run done when a background completion reminder arrives with only empty child and status snapshots', async () => {
    sessionManagerMock.getSessionChildren
      .mockResolvedValueOnce([{ id: 'child-1', title: 'Background child' }])
      .mockResolvedValue([]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-1',
      messageID: 'msg-1',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);
    client.emitBackgroundTaskCompleted(sessionId);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const latestContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(latestContent).toContain('Waiting for background agents...');

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
  });

  it('keeps Discord send/edit flow alive across repeated untracked background-task phases in one run', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    const editContents = (): string[] =>
      streamEdit.mock.calls.map(([payload]) => payload.content as string);

    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-1',
      messageID: 'msg-1',
      prompt: 'Investigate API behavior',
      description: 'Background worker 1',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    expect(getLastStreamEditPayload(streamEdit)?.content).toContain('Waiting for background agents...');

    client.emitBackgroundTaskCompleted(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    const firstReminderContent = getLastStreamEditPayload(streamEdit)?.content ?? '';
    expect(
      firstReminderContent.includes('Waiting for background agents...') ||
        firstReminderContent.includes('Generating final response...'),
    ).toBe(true);

    const firstReminderIndex = editContents().findIndex((content) =>
      content.includes('Waiting for background agents...') ||
      content.includes('Generating final response...'),
    );
    expect(firstReminderIndex).toBeGreaterThanOrEqual(0);

    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-2',
      messageID: 'msg-1',
      prompt: 'Investigate follow-up behavior',
      description: 'Background worker 2',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    client.emitBackgroundTaskCompleted(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    const interimContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(interimContents).not.toContain('✅ Done');
    expect(interimContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'Final answer after multiple background phases',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const activeEdit = getLastStreamEditPayload(streamEdit);
    expect(activeEdit?.content).toContain('Final answer after multiple background phases');
    expect(activeEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);
  });

  it('does not mark the run done from resumed parent text when background work has no tracked child session', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-zero-child-background',
      text: 'background task dispatched',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);
    client.emitBackgroundTaskCompleted(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-zero-child-background',
      text: 'Partial parent reply after background task',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const inFlightEdit = getLastStreamEditPayload(streamEdit);
    expect(inFlightEdit?.content).toContain('Partial parent reply after background task');
    expect(inFlightEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-zero-child-background',
      text: 'Final parent reply after background task',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const activeEdit = getLastStreamEditPayload(streamEdit);
    expect(activeEdit?.content).toContain('Final parent reply after background task');
    expect(activeEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);
  });

  it('does not finalize a weak-background final reply without structural child confirmation', async () => {
    sessionManagerMock.getSessionMessages.mockResolvedValue([
      {
        info: { id: 'msg-weak-background-final', role: 'assistant' },
        parts: [{ type: 'text', text: 'background task dispatched' }],
      },
    ]);

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-weak-background-final',
      text: 'background task dispatched',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(1000);
    client.emitBackgroundTaskCompleted(sessionId);
    await vi.advanceTimersByTimeAsync(1000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-weak-background-final',
      text: 'Final parent reply after a weak background phase',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    let sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const activeEdit = getLastStreamEditPayload(streamEdit);
    expect(activeEdit?.content).toContain('Final parent reply after a weak background phase');
    expect(activeEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);
  });

  it('does not finalize from structured background evidence alone when no child session is ever discovered', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-2',
      messageID: 'msg-1',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'Final answer from the main agent',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);

    const activeEdit = getLastStreamEditPayload(streamEdit);
    expect(activeEdit?.content).toContain('Final answer from the main agent');
    expect(activeEdit?.components?.[0]?.components?.[0]?.data?.disabled).not.toBe(true);
  });

  it('does not finalize while busy-state checks remain unknown for weak background evidence', async () => {
    sessionManagerMock.getSessionStatusMap.mockReset();
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({});
    sessionManagerMock.getSessionBusyState.mockReset();
    sessionManagerMock.getSessionBusyState.mockResolvedValue('unknown');

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'background task dispatched',
    });

    await vi.advanceTimersByTimeAsync(1000);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-1',
      text: 'Final answer from the main agent',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
  });

  it('re-checks a stale busy cache against live session state before deciding to stay running', async () => {
    sessionManagerMock.getSessionStatusMap.mockReset();
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({});
    sessionManagerMock.getSessionBusyState.mockReset();
    sessionManagerMock.getSessionBusyState.mockResolvedValue('idle');

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitSessionStatus(sessionId, { type: 'busy' });
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-stale-busy',
      text: 'Final answer after stale busy cache',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitCompletion(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer after stale busy cache');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('treats child session errors as terminal so they no longer block completion forever', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Background child' },
    ]);
    sessionManagerMock.getSessionStatusMap.mockResolvedValue({
      [sessionId]: { type: 'idle' },
      'child-1': { type: 'busy' },
    });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [
        [createAssistantMessage('msg-parent', 'Interim parent text before child failure')],
        [createAssistantMessage('msg-parent', 'Final answer after child failure')],
      ],
      'child-1': [[
        createAssistantMessage('msg-child-1', 'Background worker failed', {
          error: { name: 'UnknownError', message: 'Background worker failed' },
        }),
      ]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-child-error',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker',
      agent: 'general',
    });

    await Promise.resolve();

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Final answer after child failure',
    });

    await vi.advanceTimersByTimeAsync(1600);

    client.emitSessionError('child-1', {
      name: 'UnknownError',
      data: { message: 'Background worker failed' },
    });

    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).toContain('✅ Done');

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('Final answer after child failure');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('treats terminal_error as terminal for one child while still waiting for other busy children', async () => {
    sessionManagerMock.getSessionChildren.mockResolvedValue([
      { id: 'child-1', title: 'Failed child' },
      { id: 'child-2', title: 'Still busy child' },
    ]);
    sessionManagerMock.getSessionStatusMap
      .mockResolvedValueOnce({
        [sessionId]: { type: 'idle' },
        'child-1': { type: 'busy' },
        'child-2': { type: 'busy' },
      })
      .mockResolvedValue({
        [sessionId]: { type: 'idle' },
        'child-2': { type: 'busy' },
      });
    setSessionMessageSequencesBySessionId({
      [sessionId]: [[createAssistantMessage('msg-parent', 'Parent final text while another child is still busy')]],
      'child-1': [[
        createAssistantMessage('msg-child-1', 'Child one failed', {
          error: { name: 'UnknownError', message: 'Child one failed' },
        }),
      ]],
      'child-2': [[]],
    });

    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-child-error-terminal',
      messageID: 'msg-parent',
      prompt: 'Investigate API behavior',
      description: 'Background worker 1',
      agent: 'general',
    });
    client.emitMessagePart({
      type: 'subtask',
      sessionID: sessionId,
      id: 'part-child-busy',
      messageID: 'msg-parent',
      prompt: 'Investigate follow-up behavior',
      description: 'Background worker 2',
      agent: 'general',
    });

    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(3000);

    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-parent',
      text: 'Parent final text while another child is still busy',
    });

    await vi.advanceTimersByTimeAsync(1600);
    client.emitSessionError('child-1', {
      name: 'UnknownError',
      data: { message: 'Child one failed' },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const sentContents = channelSend.mock.calls
      .slice(1)
      .map(([payload]) => payload.content as string);

    expect(sentContents).not.toContain('✅ Done');
    expect(sentContents).not.toContain('⚠️ Done (no output received)');
    expect(sessionManagerMock.clearSseClient).not.toHaveBeenCalledWith(threadId);
    expect(getLastStreamEditPayload(streamEdit)?.content).toContain('Waiting for background agents...');
  });

  it('forces the visible stream message into an interrupted terminal state', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-interrupt',
      text: 'Still running before interrupt',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const interrupted = await interruptActiveRun(threadId);
    expect(interrupted).toBe(true);

    const editCountAfterInterrupt = streamEdit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);

    expect(streamEdit).toHaveBeenCalledTimes(editCountAfterInterrupt);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(sessionManagerMock.clearSseClient).toHaveBeenCalledWith(threadId);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('⏹️ Interrupted.');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
  });

  it('does not let a queued stream tick overwrite the interrupted terminal state', async () => {
    await runPrompt(channel as any, threadId, prompt, parentChannelId);

    const client = sseHarness.MockSSEClient.instances[0];
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-queued-tick',
      text: 'Still running before queued tick cleanup',
    });

    const interrupted = await interruptActiveRun(threadId);
    expect(interrupted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    const editCountAfterInterrupt = streamEdit.mock.calls.length;
    client.emitSessionStatus(sessionId, { type: 'busy' });
    client.emitPartUpdated({
      sessionID: sessionId,
      messageID: 'msg-queued-tick',
      text: 'Late activity after interrupt should not revive active UI',
    });
    client.emitSessionIdle(sessionId);
    await vi.advanceTimersByTimeAsync(2000);

    const finalEdit = getLastStreamEditPayload(streamEdit);
    expect(finalEdit?.content).toContain('⏹️ Interrupted.');
    expect(finalEdit?.components?.[0]?.components?.[0]?.data?.disabled).toBe(true);
    expect(streamEdit).toHaveBeenCalledTimes(editCountAfterInterrupt);
  });
});
