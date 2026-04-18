## Bug Summary

When the main session produces a very long final response, Discord can receive the full final output as follow-up messages while the original stream message still shows an enabled `Interrupt` button. The visible symptom is misleading: the run is already over, but the original message still looks active.

## Confirmed Root Cause

The bug lives in `src/services/executionService.ts`.

- `settleTerminalStreamMessage()` currently returns a bare boolean even though it represents three different outcomes:
  1. the original stream message was updated with the full final content and disabled buttons
  2. the full final edit failed, but a shorter status-only cleanup edit succeeded with disabled buttons
  3. both settlement edits failed
- `finalize()` interprets any `false` result the same way in the long-output path: send all chunks as follow-up messages and then send `✅ Done`.
- That means case (2) and case (3) are conflated.
- In case (3), the original stream message never receives a successful terminal cleanup edit, so it keeps the last active payload, including the enabled `Interrupt` button.

## Scope and Non-Goals

### In Scope

- Fix the long-output finalization path in `src/services/executionService.ts`
- Add regression coverage in `src/__tests__/executionService.test.ts`
- Keep the change minimal and localized

### Non-Goals

- No refactor of unrelated execution-state logic
- No change to interrupt button behavior while a run is still active
- No change to message chunking logic in `src/utils/messageFormatter.ts`
- No git operations unless explicitly requested later

## Exact Reproduction Test Case

Add a regression test in `src/__tests__/executionService.test.ts` that reproduces the exact bug.

### Setup

1. Start `runPrompt(...)` with the existing mock channel and stream message harness.
2. Emit a long final assistant text such as:

```ts
'Long final answer paragraph. '.repeat(220)
```

This must produce multiple chunks through `formatOutputForMobile(...)`.

3. Override `streamEdit` so that both terminal settlement edits fail:
   - the full final-content edit whose content starts with:

```ts
`${contextHeader}\n\n✅ Done`
```

   - the fallback status-only cleanup edit whose content is:

```ts
`${contextHeader}\n\n✅ Done — output continued below.`
```

4. Track the last successfully applied stream payload separately from attempted edit calls.
5. Drive finalization with:
   - `emitPartUpdated(...)`
   - `emitSessionIdle(...)`
   - `emitCompletion(...)`

### Pre-Fix Failure Shape

Before the fix, the test should demonstrate that:

- follow-up chunk sends succeed
- `✅ Done` is sent
- the original stream message was never successfully updated to a disabled terminal state
- the last successfully applied stream payload still shows an enabled interrupt button

### Post-Fix Expectation

After the fix, the test should assert that when both settlement edits fail:

- overflow chunks are **not** sent
- `✅ Done` is **not** sent
- a short warning follow-up is sent instead
- the code no longer pretends the original message was safely settled

## TDD Plan

1. Add or split regression tests first.
2. Run the targeted test file and confirm the new double-failure case fails under current behavior.
3. Implement the minimal fix in `src/services/executionService.ts`.
4. Re-run the targeted tests until they pass.
5. Run the TypeScript build.

## Minimal Code Change Design

Replace the boolean contract of `settleTerminalStreamMessage()` with an explicit discriminated result.

Recommended outcomes:

```ts
type TerminalStreamSettlementResult =
  | { kind: 'full' }
  | { kind: 'status_only' }
  | { kind: 'failed' };
```

### Required Behavior

- `full`
  - the original stream message now contains the final content with disabled buttons
  - `finalize()` should send only the remaining overflow chunks, then `✅ Done`

- `status_only`
  - the original stream message was at least cleaned up to a disabled terminal status line
  - `finalize()` should preserve existing fallback behavior by sending all chunks, then `✅ Done`

- `failed`
  - neither settlement edit succeeded
  - `finalize()` must **not** send overflow chunks or `✅ Done`
  - instead send one short warning follow-up, e.g. a message that the final response could not be safely posted because the terminal cleanup failed

### Why This Fix

This is the smallest safe change because it only strengthens the contract between:

- `settleTerminalStreamMessage()`
- the long-output success branch inside `finalize()`

It avoids unrelated refactors while removing the ambiguity that causes the bug.

## Verification Commands

Run these commands from the repository root:

```bash
npm test -- src/__tests__/executionService.test.ts
npm run build
```

## Pass/Fail QA Criteria

### Functional

1. A long final response with successful status-only cleanup still sends follow-up chunks normally.
2. A long final response with total settlement failure no longer sends follow-up chunks or `✅ Done`.
3. Existing interrupt terminal-state tests still pass.

### Observable

1. The targeted test file passes.
2. The build exits with code `0`.
3. The changed-file set stays limited to:
   - `docs/discord-long-output-terminal-settle-fix-plan.md`
   - `src/services/executionService.ts`
   - `src/__tests__/executionService.test.ts`

### Binary Pass/Fail

- PASS only if all targeted tests pass and the build passes.
- FAIL if the double-failure regression still allows fallback chunks plus `✅ Done` after total settlement failure.

## Atomic Commit Strategy

If a commit is requested later, use one atomic commit containing:

- the plan document
- the regression tests
- the localized `executionService.ts` fix

Recommended commit message:

```text
fix: distinguish terminal stream edit failures before chunk fallback
```
