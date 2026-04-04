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
import { formatOutput, formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';
import type { SSEEvent, SessionErrorInfo } from '../types/index.js';

const IDLE_DEBOUNCE_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 5000;
const MAX_IDLE_WAIT_MS = 300000; // 5 minutes max wait for background agents
const FINAL_TEXT_SETTLE_MS = 1500;
const MAX_UNKNOWN_BUSY_CHECKS = 3;
const DISCORD_MESSAGE_LIMIT = 2000;
const MIN_CONTENT_BUDGET = 200;
const pendingTimers = new Set<NodeJS.Timeout>();
const activeRunInterruptHandlers = new Map<string, () => Promise<boolean>>();

type CompletionPhase =
  | 'running'
  | 'awaiting_confirmation'
  | 'waiting_children'
  | 'awaiting_parent_final'
  | 'finalizing'
  | 'done';

function buildStatusContent(contextHeader: string, statusLine: string): string {
  return `${contextHeader}\n\n${statusLine}`;
}

function getContentBudget(prefix: string): number {
  return Math.max(DISCORD_MESSAGE_LIMIT - prefix.length, MIN_CONTENT_BUDGET);
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
  let updateInterval: NodeJS.Timeout | null = null;
  let accumulatedText = '';
  let lastContent = '';
  let tick = 0;
  let promptSent = false;
  let isSendingPrompt = false;
  let hasSessionError = false;
  let idleDebounceTimer: NodeJS.Timeout | null = null;
  let isFinalized = false;
  let idleStartTime: number | null = null;
  let phase: CompletionPhase = 'running';
  let activeSseClient: SSEClient | null = null;
  let sawBackgroundEvidence = false;
  let sawCompletionSignal = false;
  let backgroundBaselineMessageSignature: string | null = null;
  let backgroundBaselineVisibleText: string | null = null;
  let parentFinalFallbackSignature: string | null = null;
  let parentFinalFallbackConfirmations = 0;
  let lastVisibleTextAt: number | null = null;
  let visibleTextRevision = 0;
  let waitingVisibleRevision = 0;
  let pendingVisibleTextAfterConfirmation = false;
  let sawVisibleTextAfterConfirmation = false;
  let unknownBusyChecks = 0;
  let sessionBusyState: sessionManager.SessionBusyState = 'unknown';
  const childSessionIds = new Set<string>();
  const childTerminalSessionIds = new Set<string>();
  const childSessionStates = new Map<string, sessionManager.SessionBusyState>();
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
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  
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

  const clearRuntimeArtifacts = (): void => {
    activeRunInterruptHandlers.delete(threadId);

    if (idleDebounceTimer) {
      clearTimeout(idleDebounceTimer);
      pendingTimers.delete(idleDebounceTimer);
      idleDebounceTimer = null;
    }

    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  };

  const disconnectActiveSseClient = (): void => {
    activeSseClient?.disconnect();
    activeSseClient = null;
    sessionManager.clearSseClient(threadId);
  };

  const settleTerminalStreamMessage = async (content: string, fallbackStatusLine: string): Promise<boolean> => {
    const disabledButtons = [buildInterruptRow(threadId, true)];
    const edited = await updateStreamMessage(content, disabledButtons);
    if (edited) {
      return true;
    }

    try {
      await streamMessage.edit({
        content: buildStatusContent(contextHeader, fallbackStatusLine),
        components: disabledButtons,
      });
    } catch (error) {
      console.error(
        'Failed to settle stream message after terminal edit failure:',
        error instanceof Error ? error.message : error,
      );
    }

    return false;
  };

  const finalizeInterruptedRun = async (): Promise<boolean> => {
    if (isFinalized) {
      return true;
    }

    isFinalized = true;
    phase = 'done';
    clearRuntimeArtifacts();

    const settledOriginalMessage = await settleTerminalStreamMessage(
      buildStatusContent(contextHeader, '⏹️ Interrupted.'),
      '⏹️ Interrupted.',
    );
    if (!settledOriginalMessage) {
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
      if (!messageRoles.has(part.messageID)) {
        messageRoles.set(part.messageID, 'assistant');
      }
      messageTexts.set(part.messageID, part.text);
      syncAccumulatedFromLocalRoles();
      visibleTextRevision += 1;
      if (resumedFromConfirmation) {
        sawVisibleTextAfterConfirmation = true;
        pendingVisibleTextAfterConfirmation = false;
      }
      lastVisibleTextAt = Date.now();

      if (sawBackgroundEvidence && resumedFromConfirmation && !isFinalized) {
        scheduleIdleCheck(FINAL_TEXT_SETTLE_MS);
      }
    });

    sseClient.onMessagePart((part) => {
      if (part.sessionID !== sessionId) return;

      if (part.type === 'subtask' || part.type === 'agent') {
        sawBackgroundEvidence = true;
        void refreshChildSessions();
        if (phase === 'awaiting_confirmation') {
          phase = 'waiting_children';
        }
      }
    });

    sseClient.onBackgroundSignal((signal) => {
      if (signal.sessionID !== sessionId) return;
      sawBackgroundEvidence = true;
      void refreshChildSessions();
      if (phase === 'waiting_children' && !sawCompletionSignal) {
        phase = 'awaiting_parent_final';
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
      phase = 'done';
      clearRuntimeArtifacts();

      try {
        if (hasSessionError) {
          disconnectActiveSseClient();
          return;
        }

        await refreshAccumulatedText();

        if (!accumulatedText.trim()) {
          const edited = await settleTerminalStreamMessage(
            buildStatusContent(contextHeader, '⚠️ No output received — the model may have encountered an issue.'),
            '⚠️ No output received — see follow-up message.'
          );
          if (!edited) {
            await safeSend('⚠️ No output received — the model may have encountered an issue.');
          }
          await safeSend('⚠️ Done (no output received)');
        } else {
          const prefix = `${contextHeader}\n\n`;
          const firstChunkBudget = getContentBudget(prefix);
          const result = formatOutputForMobile(accumulatedText, firstChunkBudget);

          const editSuccess = await settleTerminalStreamMessage(
            prefix + result.chunks[0],
            result.chunks.length > 1 ? '✅ Output continued below.' : '✅ Done'
          );

          // If edit failed (e.g., content exceeds Discord's 2000-char limit), send all chunks as new messages
          const startIndex = editSuccess ? 1 : 0;
          for (let i = startIndex; i < result.chunks.length; i++) {
            await safeSend(result.chunks[i]);
          }

          await safeSend('✅ Done');
        }

        disconnectActiveSseClient();

        await processNextInQueue(channel, threadId, parentChannelId);
      } catch (error) {
        console.error('Error in finalize:', error);
        await safeSend('❌ An unexpected error occurred while processing the response.');
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

    const getLatestParentAssistantMessage = async (): Promise<unknown | null> => {
      const messages = await sessionManager.getSessionMessages(port, sessionId, 20);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isAssistantMessage(messages[i])) {
          return messages[i];
        }
      }
      return null;
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
      const children = await sessionManager.getSessionChildren(port, sessionId);
      const nextChildIds = new Set(children.map((child) => child.id));

      childSessionIds.clear();
      for (const childId of nextChildIds) {
        childSessionIds.add(childId);
      }

      for (const childId of Array.from(childSessionStates.keys())) {
        if (!childSessionIds.has(childId)) {
          childSessionStates.delete(childId);
          childTerminalSessionIds.delete(childId);
        }
      }

      if (childSessionIds.size > 0) {
        sawBackgroundEvidence = true;
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
    };

    const refreshSessionStatuses = async (): Promise<void> => {
      const statusMap = await sessionManager.getSessionStatusMap(port);
      const parentStatus = statusMap?.[sessionId]?.type;
      if (parentStatus === 'busy' || parentStatus === 'retry') {
        sessionBusyState = 'busy';
      } else if (parentStatus === 'idle') {
        sessionBusyState = 'idle';
      }

      for (const childId of childSessionIds) {
        if (childTerminalSessionIds.has(childId)) {
          childSessionStates.set(childId, 'idle');
          continue;
        }

        const childType = statusMap?.[childId]?.type;
        if (childType === 'busy' || childType === 'retry') {
          childSessionStates.set(childId, 'busy');
        } else if (childType === 'idle') {
          childSessionStates.set(childId, 'idle');
        } else {
          childSessionStates.set(childId, 'unknown');
        }
      }
    };

    const anyChildBusy = (): boolean =>
      Array.from(childSessionIds).some((childId) => childSessionStates.get(childId) === 'busy');

    const anyChildUnknown = (): boolean =>
      Array.from(childSessionIds).some((childId) => childSessionStates.get(childId) === 'unknown');

    const markUnknownChildrenIdle = (): void => {
      for (const childId of childSessionIds) {
        if (childSessionStates.get(childId) === 'unknown') {
          childSessionStates.set(childId, 'idle');
        }
      }
    };

    const getActivePhase = (): CompletionPhase => {
      if (!sawBackgroundEvidence) {
        return 'running';
      }

      if (childSessionIds.size > 0 && !anyChildBusy() && !anyChildUnknown()) {
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

      if (childSessionIds.size === 0) {
        return true;
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

    const hasVisibleTextSinceConfirmation = (): boolean => visibleTextRevision > waitingVisibleRevision;

    const canFinalizeFromVisibleText = (): boolean => {
      if (!hasStableVisibleFinalText()) {
        return false;
      }

      if (!sawBackgroundEvidence) {
        return true;
      }

      if (childSessionIds.size === 0) {
        return sawVisibleTextAfterConfirmation || hasVisibleTextSinceConfirmation();
      }

      return false;
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
      phase = getActivePhase();
      unknownBusyChecks = 0;
    };

    const scheduleIdleCheck = (delay: number) => {
      if (isFinalized) return;
      clearIdleTimer();
      phase =
        childSessionIds.size > 0 && !anyChildBusy() && !anyChildUnknown()
          ? 'awaiting_parent_final'
          : sawBackgroundEvidence
            ? 'waiting_children'
            : 'awaiting_confirmation';

      if (idleStartTime === null) {
        idleStartTime = Date.now();
        waitingVisibleRevision = visibleTextRevision;
      }

      // Safety: if we've been waiting too long, finalize regardless
      if (idleStartTime !== null && Date.now() - idleStartTime > MAX_IDLE_WAIT_MS) {
        void finalize();
        return;
      }

      idleDebounceTimer = setTimeout(async () => {
        pendingTimers.delete(idleDebounceTimer!);
        idleDebounceTimer = null;

        if (isFinalized) return;

        await refreshChildSessions();
        await refreshSessionStatuses();

        const busyState =
          sessionBusyState !== 'unknown'
            ? sessionBusyState
            : await sessionManager.getSessionBusyState(port, sessionId);
        if (busyState === 'busy' && !isFinalized) {
          unknownBusyChecks = 0;
          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        if (busyState === 'unknown' && !isFinalized) {
          unknownBusyChecks += 1;

          if ((sawCompletionSignal || canFinalizeFromVisibleText()) && unknownBusyChecks >= MAX_UNKNOWN_BUSY_CHECKS) {
            if (!sawCompletionSignal) {
              logFallbackFinalize('stable_visible_text_after_unknown_busy_checks');
            }
            phase = 'finalizing';
            await finalize();
            return;
          }

          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        unknownBusyChecks = 0;

        if (childSessionIds.size > 0) {
          if (anyChildBusy()) {
            phase = 'waiting_children';
            scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
            return;
          }

          if (anyChildUnknown()) {
            const hasConfirmedParentFinalMessage = await confirmLatestParentAssistantMessage();
            if (!hasConfirmedParentFinalMessage && !isFinalized) {
              phase = 'waiting_children';
              scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
              return;
            }

            // Some completed child sessions remain in /children but no longer appear
            // in /session/status. Once the parent final message is confirmed, those
            // missing children should stop blocking completion.
            markUnknownChildrenIdle();
          }

          phase = 'awaiting_parent_final';
          const hasConfirmedParentFinalMessage = await confirmLatestParentAssistantMessage();
          if (!hasConfirmedParentFinalMessage && !isFinalized) {
            scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
            return;
          }

          phase = 'finalizing';
          await finalize();
          return;
        }

        if (!sawCompletionSignal && !canFinalizeFromVisibleText() && !isFinalized) {
          scheduleIdleCheck(IDLE_POLL_INTERVAL_MS);
          return;
        }

        if (!sawCompletionSignal) {
          logFallbackFinalize('stable_visible_text_with_idle_session');
        }

        phase = 'finalizing';
        await finalize();
      }, delay);
      pendingTimers.add(idleDebounceTimer);
    };

    const handleParentSessionError = async (errorInfo: SessionErrorInfo): Promise<void> => {
      if (isFinalized) {
        return;
      }

      hasSessionError = true;
      isFinalized = true;
      phase = 'done';
      clearRuntimeArtifacts();

      try {
        const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
        const edited = await settleTerminalStreamMessage(
          buildStatusContent(contextHeader, `❌ **Error**: ${errorMsg}`),
          '❌ Error — see follow-up message.',
        );
        if (!edited) {
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
          childTerminalSessionIds.delete(statusSessionId);
        }

        childSessionStates.set(statusSessionId, status.type === 'idle' ? 'idle' : 'busy');
        if (status.type === 'busy' || status.type === 'retry') {
          sawBackgroundEvidence = true;
          resetIdleTracking();
        }
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
        childTerminalSessionIds.add(errorSessionId);
        childSessionStates.set(errorSessionId, 'idle');
        scheduleIdleCheck(0);
      }
    });
    
    sseClient.onError((error) => {
      if (isFinalized) {
        return;
      }

      isFinalized = true;
      phase = 'done';
      clearRuntimeArtifacts();
      
      (async () => {
        try {
          const edited = await settleTerminalStreamMessage(
            buildStatusContent(contextHeader, `❌ Connection error: ${error.message}`),
            '❌ Connection error — see follow-up message.',
          );
          if (!edited) {
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
    
    updateInterval = setInterval(async () => {
      tick++;
      try {
        const spinnerChar = spinner[tick % spinner.length];
        const statusLabel =
          phase === 'waiting_children'
            ? 'Waiting for background agents...'
            : phase === 'awaiting_parent_final'
              ? 'Generating final response...'
              : phase === 'awaiting_confirmation' || phase === 'finalizing'
              ? 'Finalizing response...'
              : 'Running...';
        const prefix = `${contextHeader}\n\n${spinnerChar} **${statusLabel}**\n`;
        const formatted = formatOutput(accumulatedText, getContentBudget(prefix));
        const newContent = formatted || 'Processing...';
        const renderedContent = prefix + newContent;
        
        if (renderedContent !== lastContent || tick % 2 === 0) {
          lastContent = renderedContent;
          await updateStreamMessage(
            renderedContent,
            [buttons]
          );
        }
      } catch (error) {
        console.error('Error in stream update interval:', error instanceof Error ? error.message : error);
      }
    }, 1000);
    
    await updateStreamMessage(buildStatusContent(contextHeader, '📝 Sending prompt...'), [buttons]);
    isSendingPrompt = true;
    clearBufferedParentSignals();
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    isSendingPrompt = false;
    if (isFinalized) return;
    promptSent = true;
    await replayBufferedParentSignals();
    
  } catch (error) {
    isSendingPrompt = false;

    if (isFinalized) {
      return;
    }

    clearRuntimeArtifacts();
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await settleTerminalStreamMessage(
      buildStatusContent(contextHeader, `❌ OpenCode execution failed: ${errorMessage}`),
      '❌ OpenCode execution failed — see follow-up message.',
    );
    if (!edited) {
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
