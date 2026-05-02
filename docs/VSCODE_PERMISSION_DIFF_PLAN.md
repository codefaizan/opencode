# VS Code Post-Apply Review Plan (Default ON, Upstream-Friendly)

## Objective

Adopt a Copilot-style workflow in OpenChamber VS Code:

- do not block every edit with pre-apply permission cards,
- let the agent finish multi-file feature work in one run,
- review final edits in native VS Code SCM/diff with per-hunk keep/undo,
- keep existing session rollback (`revert`/`unrevert`) as full safety fallback.

## Final Product Behavior

In VS Code runtime:

1. Edit permissions are auto-approved (`once`) by default.
2. File edits are applied as the run proceeds.
3. User reviews aggregate changes after the run in SCM/diff.
4. Non-edit permissions continue normal ask flow.

No new permission card component is introduced.
No "Review in VS Code" button is required for core flow.

## Why this matches your requirement

Pre-apply preview forces one request at a time.
Post-apply review allows complete feature implementation, then hunk-by-hunk review across all changed files.

## Upstream-Friendly Rules

1. **Runtime-scoped change**
   - Apply only when `runtime.isVSCode === true`.
   - Web/Desktop behavior remains unchanged.

2. **Contract-preserving**
   - Keep `permission.asked` / `permission.replied` payload contracts unchanged.
   - Keep `respondToPermission(..., "once" | "always" | "reject")` semantics unchanged.

3. **Minimal surface area**
   - Implement in existing permission event path, no backend protocol change.
   - Avoid proposed VS Code chat APIs (`workspaceEdit`/`externalEdit`) as hard dependency.

4. **Deterministic guardrails**
   - Auto-approve only edit-like permission asks with edit metadata.
   - Leave bash/webfetch/task/etc. unchanged.

## Scope of Auto-Approve (Default ON)

Auto-approve when all conditions are true:

- runtime is VS Code,
- permission type is `edit`,
- metadata indicates file edit payload (`diff`/`patch`/`files`),
- request is not already handled.

Everything else uses existing ask-card flow.

## Implementation Plan

### 1) VS Code setting with default ON

- File: `openchamber/packages/vscode/package.json`
- Add setting:
  - key: `openchamber.vscode.postApplyEditReview`
  - type: `boolean`
  - default: `true`
  - description: "Auto-approve file edit permissions in VS Code and review changes after apply in SCM/diff."

### 2) Expose setting to UI runtime

- Files:
  - `openchamber/packages/vscode/src/bridge-config-runtime.ts`
  - `openchamber/packages/vscode/webview/api/settings.ts`
- Ensure UI permission handler can read this flag without polling-heavy behavior.

### 3) Wire auto-approve in permission event handling

- File: `openchamber/packages/ui/src/sync/sync-context.tsx`
- In `permission.asked` branch:
  - evaluate `isVSCode && postApplyEditReviewEnabled && isEligibleEditPermission(request)`.
  - if true: call `sessionActions.respondToPermission(sessionID, requestID, "once")`.
  - do not enqueue/show this request in pending permission cards.
  - keep existing per-session auto-accept logic unchanged; this is a VS Code runtime rule on top.

### 4) Keep existing review/rollback tools as-is

- User reviews in SCM/diff (native VS Code).
- Full rollback remains via existing session `revert`/`unrevert` paths.
- No new editor bridge protocol required for core behavior.

### 5) Optional low-noise review nudge (non-blocking)

- Optional: one-time per turn open/focus SCM (`workbench.view.scm`) after first applied edit.
- Keep disabled by default unless needed; do not steal focus repeatedly.

## Explicit Non-Goals

- No new backend endpoint.
- No migration of OpenChamber to chat participant proposed-edit APIs.
- No new custom diff manager.
- No change to permission policy for non-edit tools.

## Validation

### Type/build checks

- `bun run --cwd openchamber/packages/ui type-check`
- `bun run --cwd openchamber/packages/vscode type-check`
- `bun run --cwd openchamber/packages/vscode build`

### Manual checks

1. **Default ON**
   - In VS Code, edit permissions no longer block with ask cards.
   - Agent can perform complete multi-file feature edits in one run.

2. **Reviewability**
   - All changed files appear in SCM.
   - Per-hunk discard/keep works via native diff editor.

3. **Safety**
   - Session `revert` and `unrevert` still work.

4. **Isolation**
   - Bash/webfetch/task permissions still ask.
   - Web/Desktop runtime behavior unchanged.

5. **Setting fallback**
   - Turning setting off restores current pre-apply permission-card behavior for edits.

## Risks and Mitigations

- **Risk:** unintended auto-approval scope creep.
  - **Mitigation:** strict `permission === "edit"` + metadata guard.

- **Risk:** hidden behavior surprises users.
  - **Mitigation:** changelog + settings description + optional toast on first auto-approved edit in session.

- **Risk:** upstream merge conflicts in busy files.
  - **Mitigation:** keep logic localized to existing `permission.asked` branch and VS Code settings plumbing.

## Rollout

1. Land setting + guarded VS Code auto-approve.
2. Verify with multi-file feature generation workflow.
3. Document in VS Code README/CHANGELOG.
