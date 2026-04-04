# Discord interrupt/streaming stuck state RCA and fix proposal

## Summary

When `remote-opencode` runs a long OpenCode task, the Discord thread sometimes remains in a streaming-looking state with an active `Interrupt` button even after the task has already finished or after OpenAI-authenticated Codex usage is exhausted. In the worst case, pressing `Interrupt` also does not transition the message to a terminal `done` or `error` state.

The strongest root cause is **missed terminal-state finalization inside `src/services/executionService.ts`**. The bot keeps the Discord message “live” until `finalize()` or a parent-session error path runs. There are realistic paths where the parent session is effectively done or failed, but none of those terminal handlers are triggered, so the SSE client stays connected, the spinner loop keeps editing the message, and the `Interrupt` button stays enabled.

This is primarily an **application-side lifecycle bug**, not a provider-side streaming semantics bug. External OpenAI docs indicate quota/auth exhaustion should surface as an error or failed terminal state. Discord also does not auto-clear a streaming/thinking UI; the application must explicitly finalize it.

---

## Scope of investigation

Investigated areas:

- `src/services/executionService.ts`
- `src/services/sseClient.ts`
- `src/services/sessionManager.ts`
- `src/services/queueManager.ts`
- `src/handlers/buttonHandler.ts`
- relevant tests in `src/__tests__/executionService.test.ts` and `src/__tests__/sseClient.test.ts`

Also reviewed external references for:

- OpenAI streaming completion/error semantics
- OpenAI auth/quota error behavior
- Discord deferred/loading response lifecycle

---

## User-visible symptom

Observed symptom pattern:

1. A Discord message starts streaming normally and shows an active `Interrupt` button.
2. The actual OpenCode work is already complete, or the underlying provider hits auth/quota exhaustion.
3. The Discord message does not transition to a terminal state like `✅ Done` or `❌ Error`.
4. The message continues to appear active or streaming.
5. Clicking `Interrupt` may acknowledge the abort request ephemerally, but the main stream message still does not become terminal.

---

## Relevant code paths

### 1. Main execution lifecycle

`src/services/executionService.ts:50-953`

This file owns the full Discord streaming state machine:

- sends the initial Discord stream message with the `Interrupt` button
- creates/connects the SSE client
- accumulates assistant text
- tracks parent/child session busy state
- updates the Discord message once per second with a spinner
- decides when to call `finalize()`

Important sections:

- initial stream message and button creation: `120-133`
- SSE registration: `226-283`
- finalization: `285-350`
- idle/finalization heuristics: `648-752`
- parent session error handling: `805-855`
- SSE connection error handling: `857-889`
- streaming update loop: `891-918`

### 2. SSE event parsing

`src/services/sseClient.ts:125-210`

Maps SSE events into callbacks for:

- `message.part.updated`
- `session.idle`
- `session.status`
- `session.error`
- `step_finish`

### 3. Busy-state amplification

`src/services/queueManager.ts:56-59`

```ts
export function isBusy(threadId: string): boolean {
  const sseClient = sessionManager.getSseClient(threadId);
  return !!(sseClient && sseClient.isConnected());
}
```

This means that if the SSE client is never cleared, the thread remains logically busy.

### 4. Interrupt button behavior

`src/handlers/buttonHandler.ts:34-68`

The interrupt handler sends an abort request and replies ephemerally, but it does **not** directly mutate the main streaming message.

---

## How the system is supposed to complete

The intended happy path is:

1. `runPrompt()` creates the stream message and stores an active `SSEClient`.
2. SSE events stream visible text and background-task signals.
3. Idle/completion heuristics decide the session is done.
4. `finalize()` runs.
5. `finalize()` disables the `Interrupt` button, edits the final content, sends `✅ Done`, disconnects SSE, clears the stored SSE client, and advances the queue.

If `finalize()` does not run, the visible Discord state remains “active”.

---

## Primary root cause

### Root cause #1: terminal parent signals do not consistently trigger finalization

**Confidence: high**

The most likely primary bug is that the code can reach a logically complete state without ever entering the terminal finalization path.

### Evidence

#### A. `session.idle` is the main completion trigger

In `executionService.ts`, `onSessionIdle()` schedules the idle check that can eventually call `finalize()`:

```ts
sseClient.onSessionIdle((idleSessionId) => {
  if (idleSessionId !== sessionId) return;
  if (!promptSent) return;
  if (isFinalized) return;

  sessionBusyState = 'idle';
  scheduleIdleCheck(IDLE_DEBOUNCE_MS);
});
```

#### B. `session.status = idle` does not schedule finalization

`onSessionStatus()` updates busy state, but when parent status becomes `idle`, it does not call `scheduleIdleCheck()`:

```ts
if (statusSessionId === sessionId) {
  sessionBusyState = status.type === 'idle' ? 'idle' : 'busy';

  if (status.type === 'busy' || status.type === 'retry') {
    resetIdleTracking();
  }
  return;
}
```

So if OpenCode emits `session.status { type: 'idle' }` but not a usable `session.idle`, the run can stay live forever.

#### C. `step_finish` is ignored while phase is still `running`

`onCompletion()` sets `sawCompletionSignal = true`, but returns early when the phase is still `running`:

```ts
sseClient.onCompletion(async (signal) => {
  if (signal.sessionID !== sessionId) return;
  sawCompletionSignal = true;

  if (phase === 'running' || isFinalized) {
    return;
  }
  scheduleIdleCheck(0);
});
```

This is a strong gap for ordinary runs that complete cleanly but do not first move the phase into one of the waiting states.

### Why this matches the symptom

If the parent session is actually done but `finalize()` never runs:

- the update interval continues
- the original stream message keeps being edited as if work is still live
- the `Interrupt` button never gets disabled
- `queueManager.isBusy()` continues to return `true` because the SSE client is still stored and connected

This directly matches the reported Discord behavior.

---

## Contributing bugs

### Root cause #2: early terminal events can be dropped before `promptSent = true`

**Confidence: medium-high**

`promptSent` flips to `true` only after `await sessionManager.sendPrompt(...)` completes:

```ts
await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
promptSent = true;
```

But several important handlers explicitly ignore events until `promptSent` is true:

- `onSessionIdle`
- `onSessionStatus`
- `onActivity`
- `onSessionError`

This creates a race window where the server can emit a fast terminal event during or immediately after prompt submission, but before the bot considers the prompt “started”.

This is particularly plausible for:

- fast auth failure
- quota exhaustion
- immediate provider rejection

If those failures surface via SSE instead of HTTP non-2xx, the events can be silently ignored and the stream remains visually alive.

---

### Root cause #3: child session errors are ignored even though child sessions affect completion

**Confidence: medium**

`executionService.ts` tracks child sessions and uses them as blockers in completion logic. However, parent error handling ignores `session.error` from any child session:

```ts
sseClient.onSessionError((errorSessionId, errorInfo) => {
  if (errorSessionId !== sessionId) return;
  if (!promptSent) return;
  ...
});
```

That means a child task can fail, but the parent run may continue waiting for child completion or a parent-final state that never arrives.

This is especially relevant when OpenCode launches background agent work and one of those children fails due to quota/auth issues.

---

### Root cause #4: stale stream message remains stale if message edit fails

**Confidence: medium**

`updateStreamMessage()` returns `false` when `streamMessage.edit()` fails. Several terminal paths then fall back to sending a new message instead of repairing the original one.

Examples:

- finalize success path
- finalize no-output path
- `onSessionError`
- `onError`
- top-level catch

This can create a split-brain UX:

- a new message may say `✅ Done` or `❌ Error`
- the original streaming message still shows an enabled `Interrupt` button

This is not the best explanation for the entire bug, but it makes the symptom much worse and can explain why the visible original message appears permanently active.

---

### Root cause #5: interrupt is not a UI finalizer

**Confidence: medium**

`handleInterrupt()` only calls `abortSession()` and sends an ephemeral acknowledgement.

It does **not**:

- disable the clicked button
- update the original stream message
- force a terminal cleanup path

So if the main lifecycle already missed its terminal transition, clicking `Interrupt` usually does not repair the visible Discord state.

---

## Why this is probably not a provider-side streaming semantics issue

External references support the conclusion that the bug is application-side:

- OpenAI streaming APIs expose explicit terminal semantics such as completion/failure states or terminal events.
- OpenAI auth/quota exhaustion is documented as provider error behavior, not as a “keep streaming forever” state.
- Discord deferred/loading states are UI states that must be explicitly finalized by the application.

In short:

- provider side: should eventually say complete, failed, cancelled, or error
- Discord side: remains “thinking/streaming” until this app explicitly finalizes the message

So the real defect is that this app fails to funnel every terminal condition through one reliable finalizer.

---

## Recommended fix strategy

The safest approach is to fix this in small, ordered steps.

### Fix 1: centralize terminal scheduling for the parent session

Add one helper inside `executionService.ts` for “parent may be done now; schedule confirmation/finalization” and call it from all parent terminal-ish events.

Specifically:

- on `session.idle`
- on `session.status` when `status.type === 'idle'`
- on `step_finish` / completion signals even if `phase === 'running'`

Goal:

- remove the assumption that `session.idle` is the only trustworthy entry into finalization

### Fix 2: buffer terminal/error signals that arrive before `promptSent`

Do not drop early parent events.

Recommended approach:

- store pending parent terminal/error signals received before `promptSent`
- replay or process them immediately after `sendPrompt()` resolves

Avoid simply setting `promptSent = true` earlier, because that can let stale or unrelated startup events affect the new run.

### Fix 3: treat child errors as terminal for child tracking

When a tracked child session emits `session.error`, stop treating it as unresolved busy work.

Recommended behavior:

- mark that child as terminal/non-busy
- trigger a new parent completion check
- optionally record child failure information for logs

### Fix 4: make visible-message cleanup idempotent and mandatory

The original stream message must stop looking active on every terminal path.

Recommended behavior:

- always attempt to disable/remove the original `Interrupt` button
- if edit fails, send a replacement terminal message and also mark the original stream message as stale in an internal state map
- optionally store the stream message ID and disable the clicked button from the interrupt interaction itself when possible

### Fix 5: improve observability for provider-driven failure modes

This is not the first fix, but it will make diagnosis much easier.

Recommended additions:

- log whether terminalization came from `session.idle`, `session.status idle`, `step_finish`, parent error, child error, timeout, or fallback
- surface `retry` status reason/message in logs
- log when pre-`promptSent` events are buffered and later replayed

---

## Mandatory tests

The current tests cover parts of the state machine, but there are important gaps. These tests should be added before or alongside the fix.

### 1. Parent completes without `session.idle`

Simulate:

- parent `step_finish`
- parent `session.status = idle`
- no `session.idle`

Assert:

- `finalize()` behavior occurs
- final content is written
- button is disabled
- SSE client is cleared

### 2. Fast parent error during prompt submission

Simulate:

- `sendPrompt()` is in flight
- parent `session.error` arrives before `promptSent = true`

Assert:

- event is not dropped
- Discord shows terminal error state
- SSE client is cleared

### 3. Child error no longer blocks parent forever

Simulate:

- parent launches child work
- child enters tracked set
- child emits `session.error`
- parent has stable final text

Assert:

- parent can still finalize
- message no longer stays in `Waiting for background agents...`

### 4. Original message does not stay interactable after terminal edit failure

Simulate:

- `streamMessage.edit()` fails during finalize/error

Assert:

- user-visible outcome still becomes terminal
- original message is not left as an active-looking live control

### 5. Interrupt click cannot leave the main message permanently live

Simulate:

- interrupt request succeeds
- downstream stream never emits the usual terminal event sequence

Assert:

- visible stream message is forced into a safe interrupted/error/finalizing state
- button is no longer active forever

### 6. Retry/quota path coverage

Simulate:

- provider failure arrives as retry-like or error-like state
- no happy-path final text follows

Assert:

- bot exits the live streaming state deterministically
- Discord ends in a terminal message

---

## Proposed implementation order

1. **Fix terminal scheduling gaps**
   - parent `session.status idle`
   - parent completion while `phase === 'running'`

2. **Fix pre-`promptSent` event loss**
   - buffer and replay early terminal/error events

3. **Fix child error propagation**
   - child errors should stop blocking completion

4. **Fix stale original message cleanup**
   - no active button left behind after terminal state

5. **Add logging/telemetry**
   - make future RCA much easier

This ordering prioritizes the highest-probability lifecycle bug first and avoids masking it with superficial UI-only changes.

---

## Final conclusion

The bug is best explained as a **terminal-state orchestration failure in `executionService.ts`**.

The primary defect is that parent completion/failure signals do not consistently funnel into `finalize()`. The most important gaps are:

- `session.status idle` does not trigger finalization
- completion can be ignored while phase is still `running`
- early terminal/error events can be dropped before `promptSent`

Secondary issues make the symptom more persistent and confusing:

- child session errors do not propagate into completion logic
- the original stream message can remain stale if edit fails
- clicking `Interrupt` does not itself repair the visible stream message

The recommended fix is to make terminalization idempotent, centralized, and independent of a single SSE event type.
