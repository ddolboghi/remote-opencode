# opencode serve에서 병렬 백그라운드 작업(child session) 완료 여부를 안전하게 확인하는 방법

## 핵심 요약

`opencode serve`에서 child session이 끝났는지 **안전하게 확인**하려면, 아래 두 가지를 **분리해서** 확인하는 것이 좋습니다.

1. **세션 상태 확인**
   - `idle | retry | busy`
2. **마지막 assistant 메시지 상태 확인**
   - `time.completed`
   - `error`
   - `parts`
   - tool part의 상태(`pending | running | completed | error`)

즉, **세션이 idle이라고 바로 완료로 단정하지 말고**, 마지막 assistant 메시지가 실제로 정상 종료되었는지도 함께 확인해야 합니다.

---

## 왜 이렇게 봐야 하나

공식 문서 기준으로 `opencode serve`는 다음을 제공합니다.

- child session 조회
- 세션 상태 조회
- 메시지 조회
- SSE 이벤트 구독

또한 공식 타입 기준으로:

- 세션 상태: `idle | retry | busy`
- assistant 메시지: `time.completed`, `error`
- tool part 상태: `pending | running | completed | error`

하지만 이슈 사례상:

- `session.idle`이 먼저 보이거나
- `time.completed`가 찍혔어도 `MessageAbortedError`가 남거나
- `parts`가 비어 있는 경우

가 보고되어 있습니다.

그래서 실무적으로는 아래 순서가 가장 안전합니다.

---

## 안전한 확인 순서

### 1) 부모 세션에서 child session ID를 찾는다

- `GET /session/:id/children`
- 또는 SDK의 `session.children()`

이 단계에서 병렬 실행된 child session들의 ID를 확보합니다.

---

### 2) 해당 child session의 세션 상태를 확인한다

- `GET /session/status`

상태 해석:

- `busy`: 아직 실행 중
- `retry`: 재시도 중
- `idle`: 겉보기엔 실행 종료 상태

단, 여기서 `idle`이 나와도 **바로 성공 완료로 확정하지 않습니다.**

---

### 3) 해당 child session의 최근 메시지를 조회한다

- `GET /session/:id/message?limit=N`
- 또는 SDK의 `session.messages()`

여기서 마지막 **assistant 메시지**를 찾습니다.

---

### 4) 마지막 assistant 메시지의 `time.completed`를 확인한다

- `time.completed`가 존재하면 **메시지 단위로는 종료됨**
- 없으면 아직 스트리밍 중이거나, 중간 상태이거나, 비정상 상황일 수 있음

즉, `time.completed`는 **메시지 완결 여부**를 보는 가장 직접적인 기준입니다.

---

### 5) 같은 메시지의 `error`를 확인한다

- `error`가 있으면 **끝나긴 했지만 실패/중단**일 수 있습니다.
- 예: `MessageAbortedError`

즉, `time.completed`가 있다고 해서 반드시 **정상 성공 완료**는 아닙니다.

---

### 6) 메시지의 `parts`를 확인한다

확인 포인트:

- `parts.length > 0` 인지
- tool part가 있으면 상태가 모두 종료 상태인지

특히 tool part 상태가 다음 중 하나이면 아직 안전하게 끝났다고 보기 어렵습니다.

- `pending`
- `running`

반대로 아래면 종료된 상태로 볼 수 있습니다.

- `completed`
- `error`

---

### 7) 실시간 감시는 SSE 이벤트를 쓰되, 최종 판정은 재조회로 확정한다

- `GET /event`
- 또는 SDK의 `event.subscribe()`

`session.status`, `session.idle` 이벤트를 받을 수 있지만,
**이벤트만으로 완료를 확정하지 말고** 다시 세션/메시지 상태를 재조회해서 최종 판정하는 것이 안전합니다.

---

## 권장 판정 기준

### 정상 완료

아래를 모두 만족:

- 세션 상태가 `idle`
- 마지막 assistant 메시지 존재
- `info.time.completed` 존재
- `info.error` 없음
- `parts.length > 0`
- 모든 tool part가 `completed` 또는 `error`
- `pending`/`running` tool part 없음

---

### 아직 진행 중

아래 중 하나라도 해당:

- 세션 상태가 `busy`
- 세션 상태가 `retry`
- 마지막 assistant 메시지가 없음
- `info.time.completed` 없음
- tool part 중 `pending` 또는 `running` 존재

---

### 종료는 했지만 실패/비정상 가능성 높음

아래 중 하나라도 해당:

- `info.error` 존재
- `parts.length === 0`

---

## TypeScript 예시 코드

아래 코드는 위 순서를 그대로 반영한 예시입니다.

```ts
import { createOpencodeClient } from "@opencode-ai/sdk"
import type {
  AssistantMessage,
  Part,
  ToolPart,
} from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4096",
})

type CompletionState =
  | { done: false; reason: "busy" | "retry" | "no_assistant_message" | "message_incomplete" | "tool_still_running" }
  | { done: true; ok: true; messageId: string }
  | { done: true; ok: false; messageId?: string; reason: "assistant_error" | "empty_parts" }

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return !!message && typeof message === "object" && (message as AssistantMessage).role === "assistant"
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool"
}

function hasUnfinishedTool(parts: Part[]): boolean {
  for (const part of parts) {
    if (!isToolPart(part)) continue

    const status = part.state?.status
    if (status === "pending" || status === "running") {
      return true
    }
  }
  return false
}

async function getLastAssistantTurn(sessionId: string) {
  const res = await client.session.messages({
    path: { id: sessionId },
    query: { limit: 20 },
  })

  const turns = res.data
  const assistantTurns = turns.filter((turn) => isAssistantMessage(turn.info))
  const lastAssistant = assistantTurns.at(-1)

  return lastAssistant
}

async function checkChildSessionSafely(sessionId: string): Promise<CompletionState> {
  // 1) 세션 상태 확인
  const statusRes = await client.fetch("/session/status", { method: "GET" })
  if (!statusRes.ok) {
    throw new Error(`Failed to fetch /session/status: ${statusRes.status}`)
  }

  const statusMap = (await statusRes.json()) as Record<
    string,
    { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }
  >

  const status = statusMap[sessionId]
  if (!status) {
    throw new Error(`Session not found in /session/status: ${sessionId}`)
  }

  if (status.type === "busy") {
    return { done: false, reason: "busy" }
  }
  if (status.type === "retry") {
    return { done: false, reason: "retry" }
  }

  // 2) 마지막 assistant 메시지 확인
  const lastAssistant = await getLastAssistantTurn(sessionId)
  if (!lastAssistant) {
    return { done: false, reason: "no_assistant_message" }
  }

  const { info, parts } = lastAssistant

  // 3) 메시지 완결 여부
  if (!info.time?.completed) {
    return { done: false, reason: "message_incomplete" }
  }

  // 4) 종료는 했지만 에러로 끝난 경우
  if (info.error) {
    return {
      done: true,
      ok: false,
      messageId: info.id,
      reason: "assistant_error",
    }
  }

  // 5) 비정상적으로 빈 parts만 남은 경우 방어
  if (!parts || parts.length === 0) {
    return {
      done: true,
      ok: false,
      messageId: info.id,
      reason: "empty_parts",
    }
  }

  // 6) tool part 정리 여부 확인
  if (hasUnfinishedTool(parts)) {
    return { done: false, reason: "tool_still_running" }
  }

  return {
    done: true,
    ok: true,
    messageId: info.id,
  }
}
```

---

## child session 목록까지 포함한 예시

```ts
async function getChildSessions(parentSessionId: string) {
  const res = await client.session.children({
    path: { id: parentSessionId },
  })
  return res.data
}

async function checkAllChildren(parentSessionId: string) {
  const children = await getChildSessions(parentSessionId)

  const results = await Promise.all(
    children.map(async (child) => {
      const state = await checkChildSessionSafely(child.id)
      return {
        sessionId: child.id,
        title: child.title,
        state,
      }
    }),
  )

  return results
}
```

---

## SSE 이벤트를 이용해 기다렸다가 재검증하는 예시

```ts
async function waitUntilChildFinishes(sessionId: string, timeoutMs = 5 * 60_000) {
  const startedAt = Date.now()

  // 먼저 한 번 즉시 검사
  const initial = await checkChildSessionSafely(sessionId)
  if (initial.done) return initial

  const events = await client.event.subscribe()

  try {
    for await (const event of events.stream) {
      const timedOut = Date.now() - startedAt > timeoutMs
      if (timedOut) {
        throw new Error(`Timed out waiting for session ${sessionId}`)
      }

      const isRelevantStatusEvent =
        event.type === "session.status" &&
        event.properties.sessionID === sessionId

      const isRelevantIdleEvent =
        event.type === "session.idle" &&
        event.properties.sessionID === sessionId

      if (!isRelevantStatusEvent && !isRelevantIdleEvent) {
        continue
      }

      // 이벤트는 힌트로만 쓰고, 최종 판정은 재조회로 확정
      const latest = await checkChildSessionSafely(sessionId)
      if (latest.done) {
        return latest
      }
    }

    throw new Error("Event stream ended before session completion was confirmed")
  } finally {
    // SDK 구현에 따라 close/cancel 메서드명이 다를 수 있어 실제 반환 객체를 확인하는 편이 좋음
    if (typeof (events as any).close === "function") {
      ;(events as any).close()
    }
  }
}
```

---

## 실무 권장 방식

자동화에서는 보통 아래 방식이 가장 안정적입니다.

1. `session.idle` 또는 `session.status` 이벤트를 받는다.
2. 그 이벤트를 **완료 힌트**로만 사용한다.
3. 즉시 `checkChildSessionSafely()`를 다시 호출한다.
4. 아래를 모두 만족할 때만 후속 작업을 시작한다.
   - 세션 `idle`
   - 마지막 assistant 메시지 `time.completed` 존재
   - `error` 없음
   - unfinished tool 없음

즉, **이벤트 기반 트리거 + 최종 재검증** 조합이 가장 안전합니다.

---

## 최종 정리

가장 안전한 완료 판정 조건은 다음입니다.

- 세션 상태: `idle`
- 마지막 assistant 메시지 존재
- `info.time.completed` 존재
- `info.error` 없음
- `parts.length > 0`
- tool part 중 `pending`/`running` 없음

반대로 아래는 완료로 단정하면 안 됩니다.

- `session.idle`만 확인한 경우
- `time.completed`만 보고 `error`를 확인하지 않은 경우
- tool part 상태를 보지 않은 경우

---

## 신뢰도 수준

**0.94**

---

## 주요 주의사항

- `session.idle`은 단독 완료 신호로 쓰지 않는 편이 안전합니다.
- `time.completed`는 “메시지 종료” 신호로는 유용하지만, “정상 성공”까지 보장하지는 않습니다.
- `parts.length === 0`인데도 completed인 비정상 사례를 방어하는 로직이 유용합니다.
