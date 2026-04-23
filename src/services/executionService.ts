import { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Message,
  TextBasedChannel,
  EmbedBuilder
} from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import { SSEClient } from './sseClient.js';
import { formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';
import type { SSEEvent, SessionErrorInfo } from '../types/index.js';

const IDLE_DEBOUNCE_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 5000;
const MAX_IDLE_WAIT_MS = 300000;
const FINAL_TEXT_SETTLE_MS = 1500;
const MAX_UNKNOWN_BUSY_CHECKS = 3;
const LIVE_PREVIEW_DEBOUNCE_MS = 400;
const DISCORD_MESSAGE_LIMIT = 2000;
const MIN_CONTENT_BUDGET = 200;
const BACKGROUND_DISPATCH_VISIBLE_TEXT_REGEX = /\bbackground\s+task\s+(?:dispatched|dispatching|spawned|spawning|launched|launching|started|starting)\b/i;
const pendingTimers = new Set<NodeJS.Timeout>();
const activeRunInterruptHandlers = new Map<string, () => Promise<boolean>>();

type CompletionPhase =
  | 'running'
  | 'awaiting_confirmation'
  | 'waiting_children'
  | 'awaiting_parent_final'
  | 'finalizing'
  | 'done';

type ChildCompletionState =
  | 'busy'
  | 'retry'
  | 'awaiting_assistant_message'
  | 'message_incomplete'
  | 'tool_running'
  | 'unknown'
  | 'terminal_success'
  | 'terminal_error';

function buildStatusContent(contextHeader: string, statusLine: string): string {
  return `${contextHeader}\n\n${statusLine}`;
}

function buildTerminalContent(contextHeader: string, statusLine: string, body?: string): string {
  if (!body?.trim()) {
    return buildStatusContent(contextHeader, statusLine);
  }

  return `${contextHeader}\n\n${statusLine}\n\n${body}`;
}

function getContentBudget(prefix: string): number {
  return Math.max(DISCORD_MESSAGE_LIMIT - prefix.length, MIN_CONTENT_BUDGET);
}

function indicatesBackgroundDispatchVisibleText(text: string): boolean {
  return BACKGROUND_DISPATCH_VISIBLE_TEXT_REGEX.test(text);
}

function buildInterruptRow(threadId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`interrupt_${threadId}`)
        .setLabel('⏸️ Interrupt')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
}

export function clearAllPendingTimers(): void {
  for (const timer of pendingTimers) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}

export async function interruptActiveRun(threadId: string): Promise<boolean> {
  const handler = activeRunInterruptHandlers.get(threadId);
  if (!handler) {
    return false;
  }

  return handler();
}

export async function runPrompt(
  channel: TextBasedChannel, 
  threadId: string, 
  prompt: string, 
  parentChannelId: string
): Promise<void> {
  const projectPath = dataStore.getChannelProjectPath(parentChannelId);
  if (!projectPath) {
    await (channel as any).send('❌ No project bound to parent channel.');
    return;
  }
  
  let worktreeMapping = dataStore.getWorktreeMapping(threadId);
  
  // Auto-create worktree if enabled and no mapping exists for this thread
  if (!worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias)) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(
          `auto/${threadId.slice(0, 8)}-${Date.now()}`
        );
        const worktreePath = await worktreeManager.createWorktree(projectPath, branchName);
        
        const newMapping = {
          threadId,
          branchName,
          worktreePath,
          projectPath,
          description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
          createdAt: Date.now()
        };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        
        const embed = new EmbedBuilder()
          .setTitle(`🌳 Auto-Worktree: ${branchName}`)
          .setDescription('Automatically created for this session')
          .addFields(
            { name: 'Branch', value: branchName, inline: true },
            { name: 'Path', value: worktreePath, inline: true }
          )
          .setColor(0x2ecc71);
        
        const worktreeButtons = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`delete_${threadId}`)
              .setLabel('Delete')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`pr_${threadId}`)
              .setLabel('Create PR')
              .setStyle(ButtonStyle.Primary)
          );
        
        await (channel as any).send({ embeds: [embed], components: [worktreeButtons] });
      } catch (error) {
        console.error('Auto-worktree creation failed:', error);
      }
    }
  }
  
  const effectivePath = worktreeMapping?.worktreePath ?? projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);
  const modelDisplay = preferredModel ? `${preferredModel}` : 'default';
  
  const branchName = worktreeMapping?.branchName ?? await worktreeManager.getCurrentBranch(effectivePath) ?? 'main';
  const contextHeader = buildContextHeader(branchName, modelDisplay);
  
  const buttons = buildInterruptRow(threadId, false);
  
  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({
      content: buildStatusContent(contextHeader, '🚀 Starting OpenCode server...'),
      components: [buttons]
    });
  } catch {
    return;
  }
  
  let port: number;
  let sessionId: string;
  let accumulatedText = '';
  let lastContent = '';
  let promptSent = false;
  let isSendingPrompt = false;
  let hasSessionError = false;
  let idleDebounceTimer: NodeJS.Timeout | null = null;
  let livePreviewTimer: NodeJS.Timeout | null = null;
  let structuredBackgroundReconciliationTimer: NodeJS.Timeout | null = null;
  let isFinalized = false;
  let idleStartTime: number | null = null;
  let phase: CompletionPhase = 'running';
  let activeSseClient: SSEClient | null = null;
  let triggerStructuredBackgroundReconciliation: (() => void) | null = null;
  let sawBackgroundEvidence = false;
  let sawStructuredBackgroundEvidence = false;
  let sawTrackedChildSessions = false;
  let sawCompletionSignal = false;
  let backgroundBaselineMessageSignature: string | null = null;
  let backgroundBaselineVisibleText: string | null = null;
  let parentFinalFallbackSignature: string | null = null;
  let parentFinalFallbackConfirmations = 0;
  let lastVisibleTextAt: number | null = null;
  let pendingVisibleTextAfterConfirmation = false;
  let unknownBusyChecks = 0;
  let sessionBusyState: sessionManager.SessionBusyState = 'unknown';
  const childSessionIds = new Set<string>();
  const childSessionStates = new Map<string, ChildCompletionState>();
  const childSessionErrorHints = new Set<string>();
  let childSessionRefreshInFlight: Promise<void> | null = null;
  let childSessionRefreshQueued = false;
  const messageTexts = new Map<string, string>();
  const messageRoles = new Map<string, string>();
  const rawEvents: SSEEvent[] = [];
  const bufferedParentSignals: {
    sawIdleEvent: boolean;
    sawIdleStatus: boolean;
    sawCompletion: boolean;
    error: SessionErrorInfo | null;
  } = {
    sawIdleEvent: false,
    sawIdleStatus: false,
    sawCompletion: false,
    error: null,
  };
  
  const syncAccumulatedFromLocalRoles = () => {
    const filteredTexts = Array.from(messageTexts.entries())
      .filter(([id]) => messageRoles.get(id) === 'assistant')
      .map(([_, text]) => text);
    accumulatedText = filteredTexts.join('\n\n---\n\n');
  };

  const refreshAccumulatedText = async () => {
    try {
      const messages = await sessionManager.getSessionMessages(port, sessionId, 20);
      for (const msg of messages) {
        if (msg.info?.id && msg.info?.role) {
          messageRoles.set(msg.info.id, msg.info.role);
        }
      }
    } catch {
      // Ignore transient fetch errors
    }
    syncAccumulatedFromLocalRoles();
  };

  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[]): Promise<boolean> => {
    try {
      await streamMessage.edit({ content, components });
      return true;
    } catch (error) {
      console.error('Failed to edit stream message:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const safeSend = async (content: string): Promise<boolean> => {
    try {
      await (channel as any).send({ content });
      return true;
    } catch (error) {
      console.error('Failed to send message:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const clearBufferedParentSignals = (): void => {
    bufferedParentSignals.sawIdleEvent = false;
    bufferedParentSignals.sawIdleStatus = false;
    bufferedParentSignals.sawCompletion = false;
    bufferedParentSignals.error = null;
  };

  const tryBufferParentSignal = (signal: 'idle' | 'idle_status' | 'completion' | 'error', errorInfo?: SessionErrorInfo): boolean => {
    if (!isSendingPrompt || isFinalized) {
      return false;
    }

    if (signal === 'idle') {
      bufferedParentSignals.sawIdleEvent = true;
    } else if (signal === 'idle_status') {
      bufferedParentSignals.sawIdleStatus = true;
    } else if (signal === 'completion') {
      bufferedParentSignals.sawCompletion = true;
    } else if (signal === 'error' && errorInfo) {
      bufferedParentSignals.error = errorInfo;
    }

    return true;
  };

  const getActiveStatusLine = (): string => {
    if (phase === 'waiting_children') {
      return '⏳ Waiting for background agents...';
    }

    if (phase === 'awaiting_parent_final') {
      return '📝 Generating final response...';
    }

    if (phase === 'awaiting_confirmation' || phase === 'finalizing') {
      return '📦 Finalizing response...';
    }

    return '🤖 Running...';
  };

  const renderRepresentativeStatus = async (statusLine: string): Promise<void> => {
    if (isFinalized) {
      return;
    }

    const content = buildStatusContent(contextHeader, statusLine);
    if (content === lastContent) {
      return;
    }

    const edited = await updateStreamMessage(content, [buttons]);
    if (edited) {
      lastContent = content;
    }
  };

  const buildLivePreviewBody = (): string | undefined => {
    const visibleText = accumulatedText.trim();
    if (!visibleText) {
      return undefined;
    }

    const previewPrefix = '…\n';
    const previewBudget = getContentBudget(`${contextHeader}\n\n${getActiveStatusLine()}\n\n${previewPrefix}`);
    if (visibleText.length <= previewBudget) {
      return visibleText;
    }

    return `${previewPrefix}${visibleText.slice(-(previewBudget - previewPrefix.length))}`;
  };

  const renderRepresentativePreview = async (): Promise<void> => {
    if (isFinalized) {
      return;
    }

    const content = buildTerminalContent(
      contextHeader,
      getActiveStatusLine(),
      buildLivePreviewBody(),
    );

    if (content === lastContent) {
      return;
    }

    const edited = await updateStreamMessage(content, [buttons]);
    if (edited) {
      lastContent = content;
    }
  };

  const scheduleLivePreviewRender = (): void => {
    if (isFinalized || hasSessionError) {
      return;
    }

    if (livePreviewTimer) {
      clearTimeout(livePreviewTimer);
      pendingTimers.delete(livePreviewTimer);
    }

    livePreviewTimer = setTimeout(() => {
      pendingTimers.delete(livePreviewTimer!);
      livePreviewTimer = null;
      void renderRepresentativePreview();
    }, LIVE_PREVIEW_DEBOUNCE_MS);

    pendingTimers.add(livePreviewTimer);
  };

  const renderActiveRepresentative = async (): Promise<void> => {
    if (accumulatedText.trim()) {
      await renderRepresentativePreview();
      return;
    }

    await renderRepresentativeStatus(getActiveStatusLine());
  };

  function clearStructuredBackgroundReconciliationTimer(): void {
    if (structuredBackgroundReconciliationTimer) {
      clearTimeout(structuredBackgroundReconciliationTimer);
      pendingTimers.delete(structuredBackgroundReconciliationTimer);
      structuredBackgroundReconciliationTimer = null;
    }
  }

  function syncStructuredBackgroundReconciliation(nextPhase: CompletionPhase): void {
    const shouldTrackStructuredWait = sawStructuredBackgroundEvidence && nextPhase === 'waiting_children';

    if (!shouldTrackStructuredWait || isFinalized) {
      clearStructuredBackgroundReconciliationTimer();
      return;
    }

    if (structuredBackgroundReconciliationTimer) {
      return;
    }

    structuredBackgroundReconciliationTimer = setTimeout(() => {
      pendingTimers.delete(structuredBackgroundReconciliationTimer!);
      structuredBackgroundReconciliationTimer = null;

      if (isFinalized) {
        return;
      }

      triggerStructuredBackgroundReconciliation?.();
    }, IDLE_POLL_INTERVAL_MS);
    pendingTimers.add(structuredBackgroundReconciliationTimer);
  }

  function syncStructuredBackgroundReconciliationIfWaitingChildren(): void {
    if (phase === 'waiting_children') {
      syncStructuredBackgroundReconciliation('waiting_children');
    }
  }

  const setPhase = (nextPhase: CompletionPhase): void => {
    if (phase === nextPhase) {
      syncStructuredBackgroundReconciliation(nextPhase);
      return;
    }

    phase = nextPhase;
    syncStructuredBackgroundReconciliation(nextPhase);
    if (!isFinalized) {
      void renderActiveRepresentative();
    }
  };

  const clearRuntimeArtifacts = (): void => {
    activeRunInterruptHandlers.delete(threadId);

    if (idleDebounceTimer) {
      clearTimeout(idleDebounceTimer);
      pendingTimers.delete(idleDebounceTimer);
      idleDebounceTimer = null;
    }

    if (livePreviewTimer) {
      clearTimeout(livePreviewTimer);
      pendingTimers.delete(livePreviewTimer);
      livePreviewTimer = null;
    }

    clearStructuredBackgroundReconciliationTimer();

  };

  const disconnectActiveSseClient = (): void => {
    activeSseClient?.disconnect();
    activeSseClient = null;
    sessionManager.clearSseClient(threadId);
  };

  type TerminalStreamSettlementResult =
    | { kind: 'full' }
    | { kind: 'status_only' }
    | { kind: 'failed' };

  const settleTerminalStreamMessage = async (
    content: string,
    fallbackStatusLine: string,
  ): Promise<TerminalStreamSettlementResult> => {
    const disabledButtons = [buildInterruptRow(threadId, true)];
    const edited = await updateStreamMessage(content, disabledButtons);
    if (edited) {
      return { kind: 'full' };
    }

    try {
      await streamMessage.edit({
        content: buildStatusContent(contextHeader, fallbackStatusLine),
        components: disabledButtons,
      });
      return { kind: 'status_only' };
    } catch (error) {
      console.error(
        'Failed to settle stream message after terminal edit failure:',
        error instanceof Error ? error.message : error,
      );
    }

    return { kind: 'failed' };
  };

  const finalizeInterruptedRun = async (): Promise<boolean> => {
    if (isFinalized) {
      return true;
    }

    isFinalized = true;
    setPhase('done');
    clearRuntimeArtifacts();

    const settledOriginalMessage = await settleTerminalStreamMessage(
      buildStatusContent(contextHeader, '⏹️ Interrupted.'),
      '⏹️ Interrupted.',
    );
    if (settledOriginalMessage.kind === 'failed') {
      await safeSend('⏹️ Interrupted.');
    }

    disconnectActiveSseClient();
    await processNextInQueue(channel, threadId, parentChannelId);
    return true;
  };

  activeRunInterruptHandlers.set(threadId, finalizeInterruptedRun);
  
  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel);
    if (isFinalized) return;
    
    await updateStreamMessage(buildStatusContent(contextHeader, '⏳ Waiting for OpenCode server...'), [buttons]);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel);
    if (isFinalized) return;
    
    const settings = dataStore.getQueueSettings(threadId);
    
    // If fresh context is enabled, we always clear the session before starting
    if (settings.freshContext) {
      sessionManager.clearSessionForThread(threadId);
    }

    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port);
    if (isFinalized) return;
    
    const sseClient = new SSEClient();
    activeSseClient = sseClient;
    sseClient.connect(`http://127.0.0.1:${port}`);
    sessionManager.setSseClient(threadId, sseClient);

    sseClient.onRawEvent((event) => {
      rawEvents.push(event);
      if (rawEvents.length > 25) {
        rawEvents.shift();
      }
    });

    sseClient.onPartUpdated((part) => {
      if (part.sessionID !== sessionId) return;
      const resumedFromConfirmation = pendingVisibleTextAfterConfirmation;
      const hasBackgroundDispatchSignal = indicatesBackgroundDispatchVisibleText(part.text);
      if (!messageRoles.has(part.messageID)) {
        messageRoles.set(part.messageID, 'assistant');
      }
      messageTexts.set(part.messageID, part.text);
      syncAccumulatedFromLocalRoles();
      if (resumedFromConfirmation) {
        pendingVisibleTextAfterConfirmation = false;
      }
      lastVisibleTextAt = Date.now();
      scheduleLivePreviewRender();

      if (hasBackgroundDispatchSignal) {
        sawBackgroundEvidence = true;
        backgroundBaselineMessageSignature = JSON.stringify({
          messageId: part.messageID,
          visibleText: accumulatedText.trim(),
        });
        backgroundBaselineVisibleText = accumulatedText.trim() || null;
        parentFinalFallbackSignature = null;
        parentFinalFallbackConfirmations = 0;
        void refreshChildSessions();
        if (phase === 'awaiting_confirmation') {
          setPhase('waiting_children');
        }
      }

      if (sawBackgroundEvidence && resumedFromConfirmation && !isFinalized) {
        scheduleIdleCheck(FINAL_TEXT_SETTLE_MS);
      }
    });

    sseClient.onMessagePart((part) => {
      if (part.sessionID !== sessionId) return;

      if (part.type === 'subtask' || part.type === 'agent') {
        sawBackgroundEvidence = true;
        sawStructuredBackgroundEvidence = true;
        syncStructuredBackgroundReconciliationIfWaitingChildren();
        void refreshChildSessions();
        if (phase === 'awaiting_confirmation') {
          setPhase('waiting_children');
        }
      }
    });

    sseClient.onBackgroundSignal((signal) => {
      if (signal.sessionID !== sessionId) return;
      void refreshChildSessions();

      if (signal.source !== 'system_reminder_background_completed') {
        sawBackgroundEvidence = true;
      }
    });

    sseClient.onCompletion(async (signal) => {
      if (signal.sessionID !== sessionId) return;
      if (!promptSent) {
        tryBufferParentSignal('completion');
        return;
      }

      sawCompletionSignal = true;
      if (isFinalized) {
        return;
      }

      scheduleIdleCheck(0);
    });
    
    const finalize = async () => {
      if (isFinalized) return;
      isFinalized = true;
      setPhase('done');
      clearRuntimeArtifacts();

      try {
        if (hasSessionError) {
          disconnectActiveSseClient();
          return;
        }

        await refreshAccumulatedText();

        if (!accumulatedText.trim()) {
          const settlement = await settleTerminalStreamMessage(
            buildStatusContent(contextHeader, '⚠️ No output received — the model may have encountered an issue.'),
            '⚠️ No output received — see follow-up message.'
          );
          disconnectActiveSseClient();
          if (settlement.kind === 'failed') {
            await safeSend('⚠️ No output received — the model may have encountered an issue.');
          }
          await safeSend('⚠️ Done (no output received)');
        } else {
          const terminalStatusLine = '✅ Done';
          const prefix = `${contextHeader}\n\n${terminalStatusLine}\n\n`;
          const firstChunkBudget = getContentBudget(prefix);
          const result = formatOutputForMobile(accumulatedText, firstChunkBudget);

          const settlement = await settleTerminalStreamMessage(
            buildTerminalContent(contextHeader, terminalStatusLine, result.chunks[0]),
            result.chunks.length > 1 ? '✅ Done — output continued below.' : terminalStatusLine
          );

          disconnectActiveSseClient();

          if (settlement.kind === 'failed') {
            await safeSend('⚠️ Final response could not be posted safely because terminal cleanup failed.');
          } else {
            const startIndex = settlement.kind === 'full' ? 1 : 0;
            for (let i = startIndex; i < result.chunks.length; i++) {
              await safeSend(result.chunks[i]);
            }

            await safeSend('✅ Done');
          }
        }

        await processNextInQueue(channel, threadId, parentChannelId);
      } catch (error) {
        console.error('Error in finalize:', error);

        const settlement = await settleTerminalStreamMessage(
          buildStatusContent(contextHeader, '❌ An unexpected error occurred while finalizing the response.'),
          '❌ Finalization failed — see follow-up message.',
        );
        disconnectActiveSseClient();
        if (settlement.kind === 'failed') {
          await safeSend('❌ An unexpected error occurred while finalizing the response.');
        }

        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) {
          await processNextInQueue(channel, threadId, parentChannelId);
        } else {
          dataStore.clearQueue(threadId);
          await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
        }
      }
    };

    const splitVisibleText = (text: string): string =>
      text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const extractVisibleTextFromParts = (parts: unknown[]): string =>
      parts
        .flatMap((part) => {
          if (!part || typeof part !== 'object') {
            return [];
          }
          const candidate = part as { type?: unknown; text?: unknown };
          if (candidate.type !== 'text' || typeof candidate.text !== 'string') {
            return [];
          }
          const visibleText = splitVisibleText(candidate.text);
          return visibleText ? [visibleText] : [];
        })
        .join('\n\n---\n\n');

    const getMessageId = (message: unknown): string | null => {
      if (!message || typeof message !== 'object') {
        return null;
      }
      const info = (message as { info?: { id?: unknown } }).info;
      return typeof info?.id === 'string' ? info.id : null;
    };

    const getMessageSignature = (message: unknown): string | null => {
      if (!message || typeof message !== 'object') {
        return null;
      }

      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) {
        return null;
      }

      const messageId = getMessageId(message) ?? 'unknown';
      const visibleText = extractVisibleTextFromParts(parts);
      return JSON.stringify({ messageId, visibleText });
    };

    const isAssistantMessage = (message: unknown): boolean => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      const info = (message as { info?: { role?: unknown; type?: unknown } }).info;
      if (typeof info?.role === 'string') {
        return info.role.toLowerCase() === 'assistant';
      }
      if (typeof info?.type === 'string') {
        return info.type.toLowerCase() === 'assistant';
      }

      const parts = (message as { parts?: unknown[] }).parts;
      return Array.isArray(parts) && extractVisibleTextFromParts(parts).length > 0;
    };

    const getLatestAssistantMessage = async (targetSessionId: string): Promise<unknown | null> => {
      const messages = await sessionManager.getSessionMessages(port, targetSessionId, 20);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isAssistantMessage(messages[i])) {
          return messages[i];
        }
      }
      return null;
    };

    const getLatestParentAssistantMessage = async (): Promise<unknown | null> =>
      getLatestAssistantMessage(sessionId);

    const hasUnfinishedToolParts = (parts: unknown[]): boolean =>
      parts.some((part) => {
        if (!part || typeof part !== 'object') {
          return false;
        }

        const candidate = part as {
          type?: unknown;
          state?: { status?: unknown };
        };
        if (candidate.type !== 'tool') {
          return false;
        }

        return candidate.state?.status === 'pending' || candidate.state?.status === 'running';
      });

    const evaluateChildSessionState = async (
      childId: string,
      statusType: sessionManager.SessionBusyState | 'retry' | undefined,
    ): Promise<ChildCompletionState> => {
      const cachedState = childSessionStates.get(childId);
      const shouldInspectLatestMessage = statusType === 'idle' || childSessionErrorHints.has(childId);

      if (!shouldInspectLatestMessage) {
        if (statusType === 'busy') {
          return 'busy';
        }
        if (statusType === 'retry') {
          return 'retry';
        }
        if (cachedState === 'terminal_success' || cachedState === 'terminal_error') {
          return cachedState;
        }
        return 'unknown';
      }

      const latestAssistantMessage = await getLatestAssistantMessage(childId);
      if (!latestAssistantMessage) {
        if (statusType === 'busy') {
          return 'busy';
        }
        if (statusType === 'retry') {
          return 'retry';
        }
        return 'awaiting_assistant_message';
      }

      const info = (latestAssistantMessage as {
        info?: {
          time?: { completed?: unknown };
          error?: unknown;
        };
      }).info;
      const parts = (latestAssistantMessage as { parts?: unknown[] }).parts;

      if (info?.time?.completed == null) {
        return 'message_incomplete';
      }

      childSessionErrorHints.delete(childId);

      if (info.error) {
        return 'terminal_error';
      }

      if (!Array.isArray(parts) || parts.length === 0) {
        return 'terminal_error';
      }

      if (hasUnfinishedToolParts(parts)) {
        return 'tool_running';
      }

      return 'terminal_success';
    };

    const syncAccumulatedTextFromMessage = (message: unknown): boolean => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) {
        return false;
      }

      const visibleText = extractVisibleTextFromParts(parts);
      if (!visibleText) {
        return false;
      }

      const messageId = getMessageId(message) ?? `parent-final-${Date.now()}`;
      const existingText = messageTexts.get(messageId);
      if (
        existingText &&
        existingText !== visibleText &&
        backgroundBaselineVisibleText !== null &&
        existingText.trim() !== backgroundBaselineVisibleText.trim()
      ) {
        return true;
      }

      const previousText = messageTexts.get(messageId);
      messageTexts.set(messageId, visibleText);
      syncAccumulatedFromLocalRoles();

      if (previousText !== visibleText) {
        lastVisibleTextAt = Date.now();
      }

      return true;
    };

    const refreshChildSessions = async (): Promise<void> => {
      if (childSessionRefreshInFlight) {
        childSessionRefreshQueued = true;
        await childSessionRefreshInFlight;
        return;
      }

      childSessionRefreshInFlight = (async () => {
        do {
          childSessionRefreshQueued = false;

          const children = await sessionManager.getSessionChildren(port, sessionId);
          const nextChildIds = new Set(children.map((child) => child.id));

          for (const childId of Array.from(childSessionIds)) {
            if (nextChildIds.has(childId)) {
              continue;
            }

            const previousState = childSessionStates.get(childId);
            if (previousState === 'terminal_success' || previousState === 'terminal_error') {
              childSessionIds.delete(childId);
              childSessionStates.delete(childId);
              childSessionErrorHints.delete(childId);
            }
          }

          for (const childId of nextChildIds) {
            childSessionIds.add(childId);
          }

          if (childSessionIds.size > 0) {
            const isLateWeakToStructuredPromotion = sawBackgroundEvidence && !sawStructuredBackgroundEvidence;
            sawBackgroundEvidence = true;
            sawStructuredBackgroundEvidence = true;
            sawTrackedChildSessions = true;

            if (isLateWeakToStructuredPromotion) {
              backgroundBaselineMessageSignature = null;
              backgroundBaselineVisibleText = accumulatedText.trim() || null;
              parentFinalFallbackSignature = null;
              parentFinalFallbackConfirmations = 0;
            }

            syncStructuredBackgroundReconciliationIfWaitingChildren();

            if (backgroundBaselineMessageSignature === null) {
              const latestParentMessage = await getLatestParentAssistantMessage();
              backgroundBaselineMessageSignature = getMessageSignature(latestParentMessage);
              if (latestParentMessage && typeof latestParentMessage === 'object') {
                const parts = (latestParentMessage as { parts?: unknown[] }).parts;
                if (Array.isArray(parts)) {
                  backgroundBaselineVisibleText = extractVisibleTextFromParts(parts);
                }
              }
              if (backgroundBaselineVisibleText === null) {
                backgroundBaselineVisibleText = accumulatedText.trim() || null;
              }
              parentFinalFallbackSignature = null;
              parentFinalFallbackConfirmations = 0;
            }
          }
        } while (childSessionRefreshQueued);
      })();

      try {
        await childSessionRefreshInFlight;
      } finally {
        childSessionRefreshInFlight = null;
      }
    };

    const refreshSessionStatuses = async (): Promise<void> => {
      const statusMap = await sessionManager.getSessionStatusMap(port);
      const parentStatus = statusMap?.[sessionId]?.type;
      if (parentStatus === 'busy' || parentStatus === 'retry') {
        sessionBusyState = 'busy';
      } else if (parentStatus === 'idle') {
        sessionBusyState = 'idle';
      } else {
        sessionBusyState = 'unknown';
      }

      for (const childId of childSessionIds) {
        const childType = statusMap?.[childId]?.type;
        const nextChildState = await evaluateChildSessionState(childId, childType);
        childSessionStates.set(childId, nextChildState);
      }
    };

    const anyChildBusy = (): boolean =>
      Array.from(childSessionIds).some((childId) => {
        const state = childSessionStates.get(childId);
        return (
          state === 'busy' ||
          state === 'retry' ||
          state === 'awaiting_assistant_message' ||
          state === 'message_incomplete' ||
          state === 'tool_running'
        );
      });

    const anyChildUnknown = (): boolean =>
      Array.from(childSessionIds).some((childId) => childSessionStates.get(childId) === 'unknown');

    const getActivePhase = (): CompletionPhase => {
      if (!sawBackgroundEvidence) {
        return 'running';
      }

      if (sawTrackedChildSessions && !anyChildBusy() && !anyChildUnknown()) {
        return 'awaiting_parent_final';
      }

      return 'waiting_children';
    };

    const confirmLatestParentAssistantMessage = async (): Promise<boolean> => {
      const latestParentMessage = await getLatestParentAssistantMessage();
      if (!latestParentMessage) {
        return false;
      }

      const latestMessageSignature = getMessageSignature(latestParentMessage);
      const hasVisibleText = syncAccumulatedTextFromMessage(latestParentMessage);
      if (!hasVisibleText) {
        return false;
      }

      if (backgroundBaselineMessageSignature === null) {
        backgroundBaselineMessageSignature = latestMessageSignature;
        parentFinalFallbackSignature = null;
        parentFinalFallbackConfirmations = 0;
        return false;
      }

      if (
        latestMessageSignature &&
        latestMessageSignature !== backgroundBaselineMessageSignature
      ) {
        parentFinalFallbackSignature = null;
        parentFinalFallbackConfirmations = 0;
        return true;
      }

      const currentVisibleText = accumulatedText.trim();
      if (
        backgroundBaselineVisibleText !== null &&
        currentVisibleText &&
        currentVisibleText !== backgroundBaselineVisibleText &&
        hasStableVisibleFinalText()
      ) {
        if (parentFinalFallbackSignature === currentVisibleText) {
          parentFinalFallbackConfirmations += 1;
        } else {
          parentFinalFallbackSignature = currentVisibleText;
          parentFinalFallbackConfirmations = 1;
        }

        return parentFinalFallbackConfirmations >= 2;
      }

      parentFinalFallbackSignature = null;
      parentFinalFallbackConfirmations = 0;
      return false;
    };

    const hasStableVisibleFinalText = (): boolean =>
      Boolean(
        accumulatedText.trim() &&
        lastVisibleTextAt !== null &&
        Date.now() - lastVisibleTextAt >= FINAL_TEXT_SETTLE_MS
      );

    const canForceFinalizeAfterUnknownBusy = (): boolean => {
      return hasStableVisibleFinalText() && !sawBackgroundEvidence;
    };

    const canFinalizeFromVisibleText = (): boolean => {
      return hasStableVisibleFinalText() && !sawBackgroundEvidence;
    };

    const logFallbackFinalize = (reason: string): void => {
      console.warn('[execution] Finalizing without explicit completion signal', {
        reason,
        sessionId,
        rawEventTail: rawEvents.slice(-5),
      });
    };

    // -- Idle detection with HTTP confirmation --
    // When the session goes idle, we debounce and then confirm via HTTP
    // that no background agents are still running before finalizing.

    const clearIdleTimer = () => {
      if (idleDebounceTimer) {
        clearTimeout(idleDebounceTimer);
        pendingTimers.delete(idleDebounceTimer);
        idleDebounceTimer = null;
      }
    };

    const resetIdleTracking = () => {
      clearIdleTimer();
      idleStartTime = null;
      setPhase(getActivePhase());
      unknownBusyChecks = 0;
    };

    const shouldEnforceIdleWaitCeiling = (nextPhase: CompletionPhase): boolean =>
      nextPhase !== 'waiting_children';

    const scheduleIdleCheck = (delay: number) => {
      if (isFinalized) return;
      clearIdleTimer();
      const nextPhase =
        sawTrackedChildSessions && !anyChildBusy() && !anyChildUnknown()
          ? 'awaiting_parent_final'
          : sawBackgroundEvidence
            ? 'waiting_children'
            : 'awaiting_confirmation';
      setPhase(nextPhase);

      const shouldApplyIdleWaitCeiling = shouldEnforceIdleWaitCeiling(nextPhase);

      if (shouldApplyIdleWaitCeiling) {
        if (idleStartTime === null) {
          idleStartTime = Date.now();
        }
      } else {
        idleStartTime = null;
      }

      if (
        shouldApplyIdleWaitCeiling &&
        idleStartTime !== null &&
        Date.now() - idleStartTime > MAX_IDLE_WAIT_MS
      ) {
        void finalize();
        return;
      }

      idleDebounceTimer = setTimeout(async () => {
        pendingTimers.delete(idleDebounceTimer!);
        idleDebounceTimer = null;

        if (isFinalized) return;

        await refreshChildSessions();
        await refreshSessionStatuses();

        const needsFreshBusyCheck =
          sessionBusyState === 'unknown' ||
          (sessionBusyState === 'busy' && (sawCompletionSignal || canFinalizeFromVisibleText()));
        const busyState = needsFreshBusyCheck
          ? await sessionManager.getSessionBusyState(port, sessionId)
          : sessionBusyState;
        if (busyState === 'busy' && !isFinalized) {
          unknownBusyChecks = 0;
          setPhase(getActivePhase());
          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        if (busyState === 'unknown' && !isFinalized) {
          unknownBusyChecks += 1;

          if (sawTrackedChildSessions) {
            if (anyChildBusy() || anyChildUnknown()) {
              setPhase('waiting_children');
              scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
              return;
            }
          } else {
            if ((sawCompletionSignal || canForceFinalizeAfterUnknownBusy()) && unknownBusyChecks >= MAX_UNKNOWN_BUSY_CHECKS) {
              if (!sawCompletionSignal) {
                logFallbackFinalize('stable_visible_text_after_unknown_busy_checks');
              }
              setPhase('finalizing');
              await finalize();
              return;
            }

            scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
            return;
          }
        }

        unknownBusyChecks = 0;

        if (sawTrackedChildSessions) {
          if (anyChildBusy() || anyChildUnknown()) {
            setPhase('waiting_children');
            scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
            return;
          }

          setPhase('awaiting_parent_final');
          const hasConfirmedParentFinalMessage = await confirmLatestParentAssistantMessage();
          if (!hasConfirmedParentFinalMessage && !isFinalized) {
            scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
            return;
          }

          setPhase('finalizing');
          await finalize();
          return;
        }

        if (!sawCompletionSignal && !canFinalizeFromVisibleText() && !isFinalized) {
          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        if (sawBackgroundEvidence && !canFinalizeFromVisibleText() && !isFinalized) {
          setPhase('waiting_children');
          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        if (!sawCompletionSignal) {
          logFallbackFinalize('stable_visible_text_with_idle_session');
        }

        setPhase('finalizing');
        await finalize();
      }, delay);
      pendingTimers.add(idleDebounceTimer);
    };

    triggerStructuredBackgroundReconciliation = () => {
      if (isFinalized) {
        return;
      }

      scheduleIdleCheck(0);
    };

    const handleParentSessionError = async (errorInfo: SessionErrorInfo): Promise<void> => {
      if (isFinalized) {
        return;
      }

      hasSessionError = true;
      isFinalized = true;
      setPhase('done');
      clearRuntimeArtifacts();

      try {
        const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
        const settlement = await settleTerminalStreamMessage(
          buildStatusContent(contextHeader, `❌ **Error**: ${errorMsg}`),
          '❌ Error — see follow-up message.',
        );
        if (settlement.kind === 'failed') {
          await safeSend(`❌ **Error**: ${errorMsg}`);
        }

        disconnectActiveSseClient();

        const settings = dataStore.getQueueSettings(threadId);
        if (settings.continueOnFailure) {
          await processNextInQueue(channel, threadId, parentChannelId);
        } else {
          dataStore.clearQueue(threadId);
          await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
        }
      } catch (error) {
        console.error('Error in onSessionError:', error);
        await safeSend('❌ An unexpected error occurred while handling a session error.');
      }
    };

    const replayBufferedParentSignals = async (): Promise<void> => {
      if (isFinalized) {
        clearBufferedParentSignals();
        return;
      }

      const bufferedError = bufferedParentSignals.error;
      const sawIdleSignal = bufferedParentSignals.sawIdleEvent || bufferedParentSignals.sawIdleStatus;
      const sawBufferedCompletion = bufferedParentSignals.sawCompletion;
      clearBufferedParentSignals();

      if (bufferedError) {
        await handleParentSessionError(bufferedError);
        return;
      }

      if (sawBufferedCompletion) {
        sawCompletionSignal = true;
      }

      if (sawIdleSignal) {
        sessionBusyState = 'idle';
      }

      if (sawIdleSignal || sawBufferedCompletion) {
        scheduleIdleCheck(sawBufferedCompletion ? 0 : IDLE_DEBOUNCE_MS);
      }
    };

    sseClient.onSessionIdle((idleSessionId) => {
      if (idleSessionId !== sessionId) return;
      if (!promptSent) {
        tryBufferParentSignal('idle');
        return;
      }
      if (isFinalized) return;

      sessionBusyState = 'idle';
      scheduleIdleCheck(IDLE_DEBOUNCE_MS);
    });

    sseClient.onSessionStatus((statusSessionId, status) => {
      if (isFinalized) return;

      if (statusSessionId === sessionId) {
        if (!promptSent) {
          if (status.type === 'idle') {
            tryBufferParentSignal('idle_status');
          }
          return;
        }

        sessionBusyState = status.type === 'idle' ? 'idle' : 'busy';

        if (status.type === 'busy' || status.type === 'retry') {
          // Session resumed — cancel any pending finalization
          resetIdleTracking();
          return;
        }

        scheduleIdleCheck(IDLE_DEBOUNCE_MS);
        return;
      }

      if (!promptSent) return;

      if (childSessionIds.has(statusSessionId)) {
        if (status.type === 'busy' || status.type === 'retry') {
          childSessionErrorHints.delete(statusSessionId);
          childSessionStates.set(statusSessionId, status.type);
          sawBackgroundEvidence = true;
          resetIdleTracking();
          return;
        }

        childSessionStates.set(statusSessionId, 'unknown');
        scheduleIdleCheck(0);
      }
    });

    // Cancel idle check on any SSE activity (including tool part updates)
    sseClient.onActivity((activitySessionId) => {
      if (!promptSent) return;
      if (isFinalized) return;
      if (activitySessionId !== sessionId && !childSessionIds.has(activitySessionId)) return;

      pendingVisibleTextAfterConfirmation =
        phase === 'awaiting_confirmation' ||
        phase === 'waiting_children' ||
        phase === 'awaiting_parent_final';
      if (activitySessionId === sessionId) {
        sessionBusyState = 'busy';
      } else {
        sawBackgroundEvidence = true;
        childSessionStates.set(activitySessionId, 'busy');
        childSessionErrorHints.delete(activitySessionId);
      }
      resetIdleTracking();
    });
    
    sseClient.onSessionError((errorSessionId, errorInfo) => {
      if (errorSessionId === sessionId) {
        if (!promptSent) {
          tryBufferParentSignal('error', errorInfo);
          return;
        }

        void handleParentSessionError(errorInfo);
        return;
      }

      if (!promptSent || isFinalized) {
        return;
      }

      if (childSessionIds.has(errorSessionId) || childSessionStates.has(errorSessionId)) {
        childSessionErrorHints.add(errorSessionId);
        childSessionStates.set(errorSessionId, 'unknown');
        scheduleIdleCheck(0);
      }
    });
    
    sseClient.onError((error) => {
      if (isFinalized) {
        return;
      }

      isFinalized = true;
      setPhase('done');
      clearRuntimeArtifacts();
      
      (async () => {
        try {
          const settlement = await settleTerminalStreamMessage(
            buildStatusContent(contextHeader, `❌ Connection error: ${error.message}`),
            '❌ Connection error — see follow-up message.',
          );
          if (settlement.kind === 'failed') {
            await safeSend(`❌ Connection error: ${error.message}`);
          }

          disconnectActiveSseClient();
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch (handlerError) {
          console.error('Error in SSE onError handler:', handlerError);
          await safeSend('❌ An unexpected connection error occurred.');
        }
      })();
    });
    
    await updateStreamMessage(buildStatusContent(contextHeader, '📝 Sending prompt...'), [buttons]);
    isSendingPrompt = true;
    clearBufferedParentSignals();
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    isSendingPrompt = false;
    if (isFinalized) return;
    promptSent = true;
    await renderActiveRepresentative();
    await replayBufferedParentSignals();
    
  } catch (error) {
    isSendingPrompt = false;

    if (isFinalized) {
      return;
    }

    clearRuntimeArtifacts();
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const settlement = await settleTerminalStreamMessage(
        buildStatusContent(contextHeader, `❌ OpenCode execution failed: ${errorMessage}`),
        '❌ OpenCode execution failed — see follow-up message.',
      );
      if (settlement.kind === 'failed') {
        await safeSend(`❌ OpenCode execution failed: ${errorMessage}`);
      }

    disconnectActiveSseClient();
    
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) {
      await processNextInQueue(channel, threadId, parentChannelId);
    } else {
      dataStore.clearQueue(threadId);
      await safeSend('❌ Execution failed. Queue cleared.');
    }
  }
}
