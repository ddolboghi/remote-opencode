import type { SSEClient } from './sseClient.js';
import * as dataStore from './dataStore.js';
import { sanitizeModel } from '../utils/stringUtils.js';
import type { MessageWithParts, SessionStatusInfo } from '../types/index.js';

const threadSseClients = new Map<string, SSEClient>();
export type SessionBusyState = 'busy' | 'idle' | 'unknown';

export async function createSession(port: number): Promise<string> {
  const url = `http://127.0.0.1:${port}/session`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error('Invalid session response: missing id');
  }

  return data.id;
}

function parseModelString(model: string): { providerID: string; modelID: string } | null {
  const clean = sanitizeModel(model);
  const slashIndex = clean.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }
  return {
    providerID: clean.slice(0, slashIndex),
    modelID: clean.slice(slashIndex + 1),
  };
}

export async function sendPrompt(port: number, sessionId: string, text: string, model?: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/session/${sessionId}/prompt_async`;
  const body: {
    parts: { type: string; text: string }[];
    model?: { providerID: string; modelID: string };
  } = {
    parts: [{ type: 'text', text }],
  };

  if (model) {
    const cleanModel = sanitizeModel(model);
    const parsedModel = parseModelString(cleanModel);
    if (parsedModel) {
      body.model = parsedModel;
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`);
  }
}

export async function validateSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getSessionInfo(port: number, sessionId: string): Promise<SessionInfo | null> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return { id: data.id, title: data.title ?? '' };
  } catch {
    return null;
  }
}

export interface SessionInfo {
  id: string;
  title: string;
}

export async function getSessionChildren(port: number, sessionId: string): Promise<SessionInfo[]> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}/children`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((session): session is { id: string; title?: string } => typeof session?.id === 'string')
      .map((session) => ({
        id: session.id,
        title: session.title ?? '',
      }));
  } catch {
    return [];
  }
}

export async function getSessionMessages(
  port: number,
  sessionId: string,
  limit = 20
): Promise<MessageWithParts[]> {
  try {
    const url = new URL(`http://127.0.0.1:${port}/session/${sessionId}/message`);
    url.searchParams.set('limit', String(limit));
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? (data as MessageWithParts[]) : [];
  } catch {
    return [];
  }
}

export async function getSessionStatusMap(
  port: number
): Promise<Record<string, SessionStatusInfo>> {
  try {
    const url = `http://127.0.0.1:${port}/session/status`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return {};
    const data = await response.json();
    return typeof data === 'object' && data !== null ? (data as Record<string, SessionStatusInfo>) : {};
  } catch {
    return {};
  }
}

export async function listSessions(port: number): Promise<SessionInfo[]> {
  try {
    const url = `http://127.0.0.1:${port}/session`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json();
    if (Array.isArray(data)) {
      return data.map((s: { id: string; title?: string }) => ({
        id: s.id,
        title: s.title ?? '',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export async function abortSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/session/${sessionId}/abort`;
    const response = await fetch(url, {
      method: 'POST',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function getSessionForThread(threadId: string): { sessionId: string; projectPath: string; port: number } | undefined {
  const session = dataStore.getThreadSession(threadId);
  if (!session) return undefined;
  return { sessionId: session.sessionId, projectPath: session.projectPath, port: session.port };
}

export function setSessionForThread(threadId: string, sessionId: string, projectPath: string, port: number): void {
  const existing = dataStore.getThreadSession(threadId);
  const now = Date.now();
  dataStore.setThreadSession({
    threadId,
    sessionId,
    projectPath,
    port,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  });
}

export async function ensureSessionForThread(threadId: string, projectPath: string, port: number): Promise<string> {
  const existingSession = getSessionForThread(threadId);

  if (existingSession && existingSession.projectPath === projectPath) {
    const isValid = await validateSession(port, existingSession.sessionId);
    if (isValid) {
      setSessionForThread(threadId, existingSession.sessionId, projectPath, port);
      return existingSession.sessionId;
    }
  }

  const sessionId = await createSession(port);
  setSessionForThread(threadId, sessionId, projectPath, port);
  return sessionId;
}

export function updateSessionLastUsed(threadId: string): void {
  dataStore.updateThreadSessionLastUsed(threadId);
}

export function clearSessionForThread(threadId: string): void {
  dataStore.clearThreadSession(threadId);
}

export function setSseClient(threadId: string, client: SSEClient): void {
  threadSseClients.set(threadId, client);
}

export function getSseClient(threadId: string): SSEClient | undefined {
  return threadSseClients.get(threadId);
}

export function clearSseClient(threadId: string): void {
  threadSseClients.delete(threadId);
}

export async function getSessionBusyState(port: number, sessionId: string): Promise<SessionBusyState> {
  try {
    const status = (await getSessionStatusMap(port))?.[sessionId]?.type;
    if (status === 'busy' || status === 'retry') return 'busy';
    if (status === 'idle') return 'idle';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function isSessionBusy(port: number, sessionId: string): Promise<boolean> {
  return (await getSessionBusyState(port, sessionId)) === 'busy';
}
