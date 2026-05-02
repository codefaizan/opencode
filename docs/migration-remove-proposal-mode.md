# Migration Plan: Remove Proposal Mode, Use `workspaceEdit`

## Goal

- OpenCode applies changes directly (no more hold-then-apply)
- VSCode extension uses `workspaceEdit` to track applied changes for review UI (Accept/Undo per hunk)

## Current State

### Proposal Mode Flow (to be removed)

```
User request → OpenCode (propose mode) → Skip fs.write
                                           ↓
                               Returns proposal metadata
                                           ↓
                        VSCode extension receives proposals
                                           ↓
                        externalEdit holds edits, shows button
                                           ↓
                        User clicks Accept → callback applies to disk
                                           ↓
                        VSCode tracks for review
```

### New Flow (target)

```
User request → OpenCode (direct mode) → fs.write (changes applied to disk)
                                           ↓
                               Returns normal response
                                           ↓
                        VSCode extension reads new file content
                                           ↓
                        Builds WorkspaceEdit with changes
                                           ↓
                        response.workspaceEdit(edit)
                                           ↓
                        VSCode tracks pending edit
                                           ↓
                        User sees Accept/Undo per hunk in diff UI
```

---

## Scope

### Backend (`packages/opencode`)

| File/Module | Action |
|------------|--------|
| `src/session/proposed-files.ts` | **DELETE** - overlay abstraction no longer needed |
| `src/session/execution-mode.ts` | **DELETE** - execution mode concept removed |
| `src/tool/proposal.ts` | **DELETE** - proposal payload creation |
| `src/tool/write.ts` | Remove `proposal` metadata - return normal result |
| `src/tool/edit.ts` | Remove `proposal` metadata - return normal result |
| `src/tool/apply_patch.ts` | Remove `proposal` metadata - return normal result |
| `src/tool/read.ts` | Remove `proposal` mode check - always read from disk |
| `src/session/prompt.ts` | Remove `executionMode` from runtime, remove proposal branch |
| `src/tool/tool.ts` | Remove `executionMode`, `proposedFiles` from Context |

### VSCode Extension (`sdks/vscode`)

| File/Module | Action |
|------------|--------|
| `src/chat/external-edit.ts` | **REPLACE** with `workspaceEdit` approach |
| `src/chat/participant.ts` | Remove `executionMode` setting, remove fallback button UI |
| `src/chat/opencode-client.ts` | Remove `executionMode` from options |
| `src/chat/capabilities.ts` | Add `workspaceEdit` handler detection |
| `src/test/external-edit.test.ts` | **REWRITE** tests for new flow |
| `package.json` | Remove `executionMode` setting |

---

## Implementation Steps

### Phase 1: Backend Changes

#### 1.1 Delete Files

- `packages/opencode/src/session/proposed-files.ts`
- `packages/opencode/src/session/execution-mode.ts`
- `packages/opencode/src/tool/proposal.ts`

#### 1.2 Update Tools

**`packages/opencode/src/tool/write.ts`**

Changes:
- Remove imports: `SessionProposedFiles`, `Proposal`
- Remove mode check: `if (mode === "propose") {...}`
- Remove `proposal` from metadata return
- Always call `fs.write` (remove the else branch)

Before:
```typescript
if (mode === "propose") {
  SessionProposedFiles.setFile(proposedFiles!, filepath, params.content)
  return {
    title: path.relative(Instance.worktree, filepath),
    metadata: {
      proposal: Proposal.payload([...]),
    },
  }
}

yield* fs.writeWithDirs(filepath, params.content)
```

After:
```typescript
// Always apply directly
yield* fs.writeWithDirs(filepath, params.content)
yield* format.file(filepath)
yield* bus.publish(File.Event.Edited, { file: filepath })
return { title: ..., output: ... }
```

**`packages/opencode/src/tool/edit.ts`**

Same pattern - remove proposal branch, always apply edits directly.

**`packages/opencode/src/tool/apply_patch.ts`**

Same pattern - remove proposal branch, always apply patches directly.

**`packages/opencode/src/tool/read.ts`**

- Remove `SessionProposedFiles` import
- Remove mode check for overlay reading
- Always read from disk: `yield* fs.readFileString(filepath)`

#### 1.3 Update Context (`packages/opencode/src/tool/tool.ts`)

Changes:
- Remove `executionMode` from Context interface
- Remove `proposedFiles` from Context interface
- Remove `executionMode` export

Before:
```typescript
export interface Context {
  executionMode?: ExecutionMode
  proposedFiles?: SessionProposedFiles.Run
  // ...
}
```

After:
```typescript
export interface Context {
  // ... (remove executionMode, proposedFiles)
}
```

#### 1.4 Update Prompt (`packages/opencode/src/session/prompt.ts`)

Changes:
- Remove `executionMode` from `PromptRuntime`
- Remove `proposedFiles` from runtime
- Remove proposal mode branch in loop

Before:
```typescript
const runtime: PromptRuntime =
  executionMode === "propose"
    ? { executionMode, proposedFiles: SessionProposedFiles.create() }
    : { executionMode }
```

After:
```typescript
// No runtime needed for execution mode
const runtime: PromptRuntime = {}

// Or simplify further if only one mode
```

#### 1.5 Remove Exports

- `packages/opencode/src/session/index.ts` - remove exports of `execution-mode`, `proposed-files`
- `packages/opencode/src/tool/index.ts` - remove export of `proposal`

---

### Phase 2: VSCode Extension Changes

#### 2.1 Update Capabilities (`sdks/vscode/src/chat/capabilities.ts`)

Add workspaceEdit handler detection:

```typescript
type WorkspaceEditHandler = (edit: vscode.WorkspaceEdit) => void | Thenable<void>

type ChatResponseStreamWithWorkspaceEdit = vscode.ChatResponseStream & {
  workspaceEdit?: WorkspaceEditHandler
}

export function getWorkspaceEditHandler(stream: vscode.ChatResponseStream | undefined) {
  if (!stream) return
  const typed = stream as ChatResponseStreamWithWorkspaceEdit
  if (typeof typed.workspaceEdit !== "function") return
  return typed.workspaceEdit.bind(stream) as WorkspaceEditHandler
}
```

#### 2.2 Replace External Edit Logic (`sdks/vscode/src/chat/external-edit.ts`)

Rename and rewrite:

```typescript
// OLD: external-edit.ts (to be replaced)
// NEW: workspace-edit.ts

import * as vscode from "vscode"
import { getWorkspaceEditHandler } from "./capabilities"

export type EditFile = {
  operation: "set" | "delete"
  file_path: string
  uri: string
  new_content?: string
  diff?: string
  additions?: number
  deletions?: number
}

// Read current file content and build WorkspaceEdit
export async function buildWorkspaceEdits(
  files: readonly EditFile[],
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit()

  for (const file of files) {
    const uri = vscode.Uri.file(file.file_path)

    if (file.operation === "delete") {
      edit.deleteFile(uri)
      continue
    }

    const newContent = file.new_content ?? ""
    const exists = await vscode.workspace.fs.stat(uri).then(
      () => true,
      () => false,
    )

    if (!exists) {
      edit.createFile(uri, { ignoreIfExists: true })
      edit.insert(uri, new vscode.Position(0, 0), newContent)
    } else {
      const doc = await vscode.workspace.openTextDocument(uri)
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.positionAt(doc.getText().length),
      )
      edit.replace(uri, fullRange, newContent)
    }
  }

  return edit
}

export async function applyEditsAndTrack(
  response: vscode.ChatResponseStream | undefined,
  files: readonly EditFile[],
): Promise<{ files: number } | undefined> {
  if (files.length === 0) return

  const edit = await buildWorkspaceEdits(files)
  const workspaceEdit = getWorkspaceEditHandler(response)

  if (!workspaceEdit) {
    console.log("workspaceEdit not available - changes applied but not tracked")
    return { files: files.length }
  }

  await workspaceEdit(edit)
  return { files: files.length }
}
```

#### 2.3 Update Participant (`sdks/vscode/src/chat/participant.ts`)

Changes:
- Remove `OPENCODE_EXECUTION_MODE_SETTING`
- Remove `OPENCODE_PROPOSE_APPLY_STRATEGY_SETTING`
- Remove `resolveExecutionModeSetting()` function
- Remove `resolveProposeApplyStrategySetting()` function
- Simplify response handling - no mode check

Before:
```typescript
const executionMode = resolveExecutionModeSetting()

if (result.proposals.length > 0) {
  const wantsNativeReview =
    executionMode === "propose" && resolveProposeApplyStrategySetting() === "nativeReview"
  // ... conditional logic
}
```

After:
```typescript
// Always use workspaceEdit for tracking
if (result.proposals.length > 0) {
  await applyEditsAndTrack(response, result.proposals)
}
```

Remove the fallback button UI (lines ~145-165).

#### 2.4 Update OpenCode Client (`sdks/vscode/src/chat/opencode-client.ts`)

Changes:
- Remove `executionMode` from `CallOpenCodeOptions`
- Remove `executionMode` property in call options
- Update `CallResult` to remove `proposals` if not needed for tracking

```typescript
// Before
interface CallOpenCodeOptions {
  executionMode?: "direct" | "propose"
  // ...
}

// After - no executionMode
interface CallOpenCodeOptions {
  // executionMode removed
}
```

#### 2.5 Update Settings (`package.json`)

Remove settings:

```json
// Remove these from contributes.configuration:
{
  "key": "opencode.executionMode",
  "key": "opencode.proposeApplyStrategy",
}
```

---

### Phase 3: Tests

#### 3.1 Backend Tests

Update or remove tests in `packages/opencode/test/`:

| Test File | Action |
|----------|--------|
| `tool/write.test.ts` | Update - remove proposal mode tests |
| `tool/edit.test.ts` | Update - remove proposal mode tests |
| `tool/apply_patch.test.ts` | Update - remove proposal mode tests |
| `tool/read.test.ts` | Remove proposal mode overlay tests |
| `session/prompt-effect.test.ts` | Update - remove executionMode tests |

Example test change:

```typescript
// Before
it("writes in propose mode", async () => {
  const proposed = SessionProposedFiles.create()
  const result = await callWrite(params, {
    ...ctx,
    executionMode: "propose",
    proposedFiles: proposed,
  })
  expect(result.metadata.proposal?.mode).toBe("propose")
})

// After - remove these tests
it("writes file directly", async () => {
  const result = await callWrite(params, ctx)
  // Verify file was written
  expect(await fs.readFile(filepath)).toBe(content)
})
```

#### 3.2 VSCode Extension Tests

Rewrite `sdks/vscode/src/test/external-edit.test.ts` (rename to workspace-edit.test.ts):

```typescript
// Tests for new flow:
// - workspaceEdit handler detection
// - buildWorkspaceEdit creates correct edits
// - applies and tracks edits
// - graceful fallback when workspaceEdit unavailable
```

---

## Files to Delete

```
packages/opencode/src/session/proposed-files.ts
packages/opencode/src/session/execution-mode.ts
packages/opencode/src/tool/proposal.ts
sdks/vscode/src/chat/external-edit.ts  (replaced by workspace-edit.ts)
sdks/vscode/src/test/external-edit.test.ts
```

---

## Verification

After migration:

1. **Backend tests pass**: `bun test` in packages/opencode
2. **VSCode tests pass**: Test extension in VSCode
3. **Manual test**:
   - Open chat in VSCode
   - Ask OpenCode to edit a file
   - Changes apply immediately
   - Open file, verify Accept/Undo buttons appear in diff UI
   - Can Accept or Undo changes

---

## Rollback Plan

If issues occur:
- Keep git branch with all changes
- Can revert to `dev` branch for comparison
- Proposal mode code is in git history