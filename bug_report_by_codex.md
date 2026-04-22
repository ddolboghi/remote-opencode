# Bug Report: Discord stream is terminalized while background work is still running

## Scope

- Investigated project: `remote-opencode`
- Non-scope: `opentrade` application code itself
- Symptom: when a Discord-triggered OpenCode run is attached to the `opentrade` directory and the parent session becomes idle while background work still exists, Discord flips to `Done` and the live stream stops even though work is not actually finished

## Conclusion

The root cause is in `remote-opencode`'s completion state machine, not in `opentrade`.

`remote-opencode` only keeps the run open if it can prove background work exists through one of these signals:

- structured SSE evidence: `subtask` / `agent` parts
- child-session discovery: `GET /session/:id/children`
- child-session status/message reconciliation

If that proof is missing, delayed, or temporarily unavailable, the parent session can still be finalized from weaker signals:

- parent session becomes `idle`
- parent busy-state checks remain `unknown`
- parent visible text looks stable enough to be treated as a final reply
- idle wait ceiling expires

Once that happens, `finalize()` posts `✅ Done` and then disconnects the SSE client, which makes Discord appear as if streaming completed successfully.

## Exact terminal path

Relevant files:

- `src/services/sseClient.ts`
- `src/services/executionService.ts`
- `src/services/sessionManager.ts`

Relevant functions:

- `SSEClient.handleMessage()` in [src/services/sseClient.ts](/home/siwoli/work/remote-opencode/src/services/sseClient.ts:125)
- `runPrompt()` state machine in [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:87)
- `scheduleIdleCheck()` in [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1152)
- `finalize()` in [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:630)
- `disconnectActiveSseClient()` in [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:456)
- `getSessionChildren()` in [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:104)
- `getSessionStatusMap()` in [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:158)
- `getSessionBusyState()` in [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:268)

The visible `Done` transition happens here:

1. Parent idle/completion is observed.
   - `session.idle`: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1355)
   - `session.status === idle`: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1367)
   - completion signal: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:615)
2. `scheduleIdleCheck()` decides the run is terminal.
   - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1152)
3. `finalize()` edits the representative Discord message to terminal state and sends `✅ Done`.
   - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:655)
   - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:675)
4. `disconnectActiveSseClient()` closes the SSE connection and clears it from the session manager.
   - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:665)
   - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:456)

That is why the Discord UI looks completed: the bot explicitly terminalizes the run and tears down streaming.

## Why background work can be missed

Background work is only treated as structurally real when one of the following happens:

- `onMessagePart()` receives `subtask` or `agent`
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:589)
- `refreshChildSessions()` discovers children from `/session/:id/children`
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:890)
  - [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:104)
- `refreshSessionStatuses()` can reconcile those children through `/session/status`
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:951)

If `/session/:id/children` returns empty or fails, `getSessionChildren()` silently returns `[]`.

- [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:113)
- [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:128)

If `/session/status` is unavailable, `getSessionStatusMap()` returns `{}` and `getSessionBusyState()` becomes `unknown`.

- [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:168)
- [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:171)
- [src/services/sessionManager.ts](/home/siwoli/work/remote-opencode/src/services/sessionManager.ts:268)

So real background work can exist while `remote-opencode` lacks enough structural evidence to keep waiting.

## Most likely false-positive path matching the symptom

The most likely match is the weak-background fallback path.

Weak background evidence is inferred from visible parent text such as `background task dispatched`.

- regex: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:20)
- detection in `onPartUpdated()`: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:551)
- background flag set here: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:564)

But if no child session is discovered, the code still has fallback terminalization branches:

- `canFinalizeFromVisibleText()`
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1073)
- `confirmStableWeakBackgroundMessage()`
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1091)
- weak-background finalization branch
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1241)
- generic fallback finalization branch
  - [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1262)

This means the state machine can do the following:

1. See weak evidence that background work was dispatched.
2. Fail to discover any child sessions.
3. Observe the parent as idle.
4. Decide the parent visible text is stable enough.
5. Call `finalize()`.
6. Post `✅ Done` and close SSE, even though real background work is still running elsewhere.

That aligns with the reported symptom: the main session appears to be doing nothing, Discord switches to `Done`, and streaming stops.

## Secondary false-positive paths

### 1. Unknown busy-state fallback

If the parent busy-state stays `unknown` for 3 checks, the run can be force-finalized.

- `MAX_UNKNOWN_BUSY_CHECKS = 3`: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:15)
- finalize on repeated unknown busy state: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1204)

If status endpoints are temporarily missing rather than truly terminal, this can also produce a premature `Done`.

### 2. Idle wait ceiling

There is a hard ceiling of 5 minutes for some idle waits.

- `MAX_IDLE_WAIT_MS = 300000`: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:12)
- unconditional finalize when ceiling is exceeded: [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1173)

If background work is real but untracked, this eventually terminalizes the Discord run anyway.

## Supporting evidence from tests

Current tests explicitly cover the risky area:

- weak background should not finish immediately:
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:671)
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:1723)
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:1780)
- child-aware blocking behavior:
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:696)
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:1159)
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:1204)
- unknown-busy forced finalization:
  - [src/__tests__/executionService.test.ts](/home/siwoli/work/remote-opencode/src/__tests__/executionService.test.ts:1875)

Important detail: these tests prove the code now delays some false positives, but they also prove that fallback finalization still exists when the system cannot structurally verify child/background completion.

## Commit history evidence

Recent history shows this exact area has already been patched multiple times:

- `5e53d34 fix: add backbround task dispatched to background evidence`
- `e6fe186 fix(execution): reconcile background child state safely`

This strongly supports the diagnosis that the bug class is not in Discord rendering itself, but in parent/child completion inference under incomplete background visibility.

## Practical root cause statement

The bug is a false-positive terminalization in `remote-opencode`:

- actual background work may still be running
- but `remote-opencode` cannot always prove that through child-session discovery or structured SSE
- once the parent looks idle and fallback heuristics think the visible parent text is settled, `scheduleIdleCheck()` moves to `finalize()`
- `finalize()` posts `✅ Done` and disconnects SSE

So the stream does not end because background work finished.
It ends because the Discord relay decided the parent run was terminal without having trustworthy evidence that all background work was complete.

## Verification performed

Ran:

```bash
npx vitest run src/__tests__/executionService.test.ts
```

Result:

- passed: `38` tests
- notable stderr evidence from the suite shows intentional fallback finalization paths are still active:
  - `stable_visible_text_with_idle_session`
  - `stable_parent_message_after_weak_background`
  - `stable_visible_text_after_unknown_busy_checks`

Those log reasons come directly from `logFallbackFinalize()` in [src/services/executionService.ts](/home/siwoli/work/remote-opencode/src/services/executionService.ts:1122) and confirm that fallback-based completion is part of the current design.
