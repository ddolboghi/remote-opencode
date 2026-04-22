import type { ChildProcess } from 'node:child_process';

export interface ProjectConfig {
  alias: string;
  path: string;
  autoWorktree?: boolean;
}

export interface ChannelBinding {
  channelId: string;
  projectAlias: string;
  model?: string;
}

export interface DataStore {
  projects: ProjectConfig[];
  bindings: ChannelBinding[];
  threadSessions?: ThreadSession[];
  worktreeMappings?: WorktreeMapping[];
  passthroughThreads?: PassthroughThread[];
  queues?: Record<string, QueuedMessage[]>;
  queueSettings?: Record<string, QueueSettings>;
}

export interface QueuedMessage {
  prompt: string;
  userId: string;
  timestamp: number;
  voiceAttachmentUrl?: string;
  voiceAttachmentSize?: number;
}

export interface QueueSettings {
  paused: boolean;
  continueOnFailure: boolean;
  freshContext: boolean;
}


export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
}

export interface VisibleTextPart extends TextPart {
  rawText: string;
  systemTexts: string[];
}

export interface MessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error' | string;
    [key: string]: unknown;
  };
  text?: string;
  rawText?: string;
  systemTexts?: string[];
  [key: string]: unknown;
}

export interface SystemTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
  rawText: string;
}

export interface BackgroundSignal {
  sessionID: string;
  source: 'system_reminder_background_completed';
  text: string;
  rawText: string;
}

export interface RawMessagePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface CompletionSignal {
  sessionID: string;
  source: 'step_finish' | 'part_step_finish';
  event: SSEEvent;
}

export interface ServeInstance {
  port: number;
  process: ChildProcess;
  startTime: number;
  exited?: boolean;
  exitCode?: number | null;
  exitError?: string;
}

export interface ThreadSession {
  threadId: string;
  sessionId: string;
  projectPath: string;
  port: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorktreeMapping {
  threadId: string;
  branchName: string;
  worktreePath: string;
  projectPath: string;
  description: string;
  createdAt: number;
}

export interface PassthroughThread {
  threadId: string;
  enabled: boolean;
  enabledBy: string;  // userId
  enabledAt: number;
}

export interface SessionErrorInfo {
  name: 'ProviderAuthError' | 'UnknownError' | 'MessageOutputLengthError' | 'MessageAbortedError';
  data: {
    message?: string;
    providerID?: string;
  };
}

export interface SessionStatusInfo {
  type: 'busy' | 'idle' | 'retry';
  attempt?: number;
  message?: string;
  next?: string;
}

export interface MessageInfo {
  id: string;
  role?: string;
  type?: string;
  time?: {
    completed?: string | number | null;
    [key: string]: unknown;
  };
  error?: unknown;
  [key: string]: unknown;
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}
