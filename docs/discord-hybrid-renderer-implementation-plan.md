# Hybrid Discord Renderer Implementation Plan

## Goal

Implement a hybrid Discord renderer for OpenCode execution in this repository.

The target behavior is:

- keep **one representative status/control message** in Discord during execution
- keep the **Interrupt** button on that representative message while the run is active
- stop **aggressive live transcript repainting** of the representative message
- keep the existing **terminal settlement** behavior for the representative message
- keep sending **final long output as chunked follow-up messages** at terminalization
- preserve the current **OpenCode lifecycle semantics** (parent/child completion, queue release, interrupt cleanup, SSE disconnect ordering)

## Scope

### Files to edit

- `src/services/executionService.ts`
- `src/__tests__/executionService.test.ts`
- `docs/discord-hybrid-renderer-implementation-plan.md`

### Files to verify but not edit unless absolutely required

- `src/__tests__/queueManager.test.ts`
- `src/handlers/buttonHandler.ts`

## Architectural Boundary

This implementation must stay on the **rendering side** of the execution pipeline.

### Safe to change

- representative-message content selection during active execution
- live status/control rendering frequency
- whether the active representative message includes transcript body text during execution
- render helpers that decide status-only vs terminal-content payloads

### Must remain unchanged

- parent/child completion state machine
- idle debounce and confirmation logic
- `sawCompletionSignal`, `sawBackgroundEvidence`, `sessionBusyState`, `unknownBusyChecks`
- child-session tracking and parent-final confirmation
- interrupt lifecycle and disabled-button terminal settlement
- `disconnectActiveSseClient()` ordering
- queue release timing via `processNextInQueue(...)`
- final chunk send ordering after terminal settlement

In short: **renderer refactor, not lifecycle rewrite**.

## Current Code Facts

- The representative Discord message is created once at run start in `src/services/executionService.ts`.
- The current live renderer is the 1-second `setInterval(...)` loop that continuously rebuilds the representative message from `formatOutput(accumulatedText, ...)`.
- Finalization already behaves like a partial hybrid renderer: it settles the representative message and then sends overflow chunks via `safeSend(...)` using `formatOutputForMobile(...)`.
- Queue busy semantics depend on the active SSE client, not on Discord message edit behavior.
- Interrupt correctness depends on terminal settlement plus cleanup ordering, not on live transcript rendering.

## Desired Hybrid Behavior

### During execution

The representative message should show only:

- branch/model context header
- coarse execution phase/status text
- active interrupt button

It should **not** keep repainting the streamed transcript body every second.

Recommended active-state messages:

- `🚀 Starting OpenCode server...`
- `⏳ Waiting for OpenCode server...`
- `📝 Sending prompt...`
- `⠋ Running...` or a non-animated `Running...`
- `Waiting for background agents...`
- `Generating final response...`
- `Finalizing response...`

Default implementation assumption for this plan:

- **remove the periodic spinner loop entirely**
- render only on meaningful phase/status transitions

### At terminalization

Keep the current contract:

- settle the representative message first
- disable the interrupt button on that message
- send final overflow chunks as follow-up messages
- send terminal completion/error marker messages in the current order

## Exact TDD Plan

Write or adjust tests **before** production code changes.

### Test 1: active status message no longer repaints transcript body

Purpose:

- verify that repeated `message.part.updated` events update internal accumulated text for finalization
- verify that the representative active message does **not** keep repainting the transcript body during execution

Expected behavior:

- the active message contains status labels such as `Running...`
- the active message does not continuously include the streamed long assistant text body
- final output is still present at terminalization

### Test 2: finalization via parent idle/status still works

Purpose:

- preserve current completion behavior when the parent status becomes idle

Expected behavior:

- final terminal message is settled
- interrupt button is disabled
- final output still appears as expected

### Test 3: completion signal still finalizes while phase is running

Purpose:

- preserve direct completion-driven finalization

Expected behavior:

- completion signal triggers finalize
- terminal representative message is correct

### Test 4: long-output finalization still chunks correctly

Purpose:

- preserve the existing hybrid-like final path

Expected behavior:

- first chunk may settle the representative message
- remaining chunks are sent via follow-up messages
- `✅ Done` still appears in the current contract

### Test 5: interrupt still wins terminally

Purpose:

- ensure interrupt still forces terminal state and no later render revives active UI

Expected behavior:

- representative message becomes interrupted terminal state
- interrupt button is disabled
- no late active render reopens the message

### Test 6: queue semantics stay unchanged

Purpose:

- ensure queue progression remains tied to terminal cleanup and SSE disconnect, not render changes

Expected behavior:

- existing `queueManager` tests stay green

## Implementation Steps

1. Save this plan file.
2. Update `src/__tests__/executionService.test.ts` first to define the new hybrid behavior.
3. Run the targeted execution-service test file and confirm the new expectations fail against the old implementation.
4. In `src/services/executionService.ts`, introduce a small render helper for representative status/control content.
5. Remove or neutralize the 1-second full-body repaint loop.
6. Keep status/control edits event-driven and phase-driven only.
7. Preserve `accumulatedText` collection exactly as before for final output assembly and parent-final confirmation.
8. Preserve `finalize()`, `finalizeInterruptedRun()`, and error terminalization ordering.
9. Re-run targeted tests until green.
10. Run broader integration-style tests and the TypeScript build.

## Recommended Implementation Shape

### Add a representative-message renderer

Create a pure helper inside `executionService.ts` that builds active representative content from:

- `contextHeader`
- current `phase`
- optional static status text

This helper should **not** depend on `accumulatedText` for active execution rendering.

### Keep terminal rendering separate

Do not change:

- `buildTerminalContent(...)`
- `formatOutputForMobile(...)`
- terminal chunk sending contract in `finalize()`

### Keep the following data flow intact

- `onPartUpdated(...)` still updates `messageTexts`
- `syncAccumulatedFromLocalRoles()` still updates `accumulatedText`
- `refreshAccumulatedText()` still runs before terminal settlement
- `confirmLatestParentAssistantMessage()` still uses the existing message state machinery

## Pass / Fail Criteria

### PASS

- representative message no longer continuously repaints transcript body during active execution
- interrupt button remains on the representative message during active execution
- terminal settlement still disables the interrupt button
- final long output still appears via chunked terminal delivery
- parent/child completion behavior remains unchanged
- queue handoff behavior remains unchanged
- all verification commands pass

### FAIL

- any change to lifecycle semantics is required just to make the renderer work
- queue progression changes because of renderer behavior
- active representative message still repaints transcript body every second
- interrupt terminal state can still be overwritten later
- final chunk send behavior regresses

## Verification Commands

Run from repository root:

```bash
npm test -- src/__tests__/executionService.test.ts
npm test -- src/__tests__/queueManager.test.ts
npm run build
```

If the execution-service file uses timing-sensitive tests, re-run the same targeted file after any fix to confirm no flaky regression was introduced.

## Manual QA Expectations

Even without a live Discord session, the implementation must be verified through the execution-service test harness because that harness already simulates:

- SSE part updates
- idle/status/completion transitions
- background-child waiting
- interrupt handling
- representative-message edits and terminal settlement

For this task, the test harness is the primary manual QA substitute because it exercises the real service orchestration path end-to-end within the repo.

## Atomic Commit Strategy

Do not commit unless explicitly requested by the user.

If a commit is requested later, keep this as one atomic commit containing only:

- `docs/discord-hybrid-renderer-implementation-plan.md`
- `src/services/executionService.ts`
- `src/__tests__/executionService.test.ts`

Recommended commit message if later requested:

```text
feat: switch Discord execution rendering to hybrid status and terminal chunks
```
