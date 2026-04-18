## Plan: Chat-Native Propose Editing

Implement a modular, upstream-safe chat-native editing path where OpenCode generates structured edit proposals without writing to disk, and VS Code applies accepted edits via native chat editing UI (`externalEdit`) with per-hunk review. In propose mode, enforce a strict overlay invariant: per normalized path, store the final full file content (or a delete tombstone), never partial patches.

**Steps**
1. Phase 1 — Contract + mode plumbing (blocking)
   1. Add an optional execution mode contract (`direct | propose`) for session prompt inputs and default to `direct` for backward compatibility. *blocks all later steps*
   2. Define a shared proposal payload shape (per-file operation, target path/URI, full `new_content`, optional diff metadata, stats). *depends on 1*
   3. Thread execution mode from session route input through prompt loop/tool resolution into `Tool.Context`. *depends on 1*
2. Phase 2 — Proposed-file overlay model (blocking consistency layer)
   1. Add a session-scoped overlay service for a single propose run, keyed by normalized absolute paths. *depends on 1*
   2. Define overlay entry invariant:
      - Non-delete entry: full final file content string for that path.
      - Delete entry: tombstone marker.
      - Never store incremental hunks/patch fragments as source-of-truth.
      *depends on 2.1*
   3. Define deterministic resolver semantics: `overlay-first`, then filesystem fallback for missing paths in propose mode; direct mode remains filesystem-only. *depends on 2.1*
3. Phase 3 — Backend propose execution semantics
   1. Add shared helper modules for path normalization, overlay updates, and proposal record creation to avoid duplicated logic in tools. *depends on 1-2; parallel with 3.2 after helper skeleton exists*
   2. Update `write` tool propose path to compute final full content and set `overlay[path] = full_content` (no disk write). *depends on 2-3*
   3. Update `edit` tool propose path to resolve base via overlay-first resolver, compute final full content, and set `overlay[path] = full_content` (no disk write). *depends on 2-3*
   4. Explicitly normalize `apply_patch` in propose mode:
      - resolve each target file base from overlay-first resolver,
      - apply patch/hunks,
      - compute final full content per resulting path,
      - represent deletes as tombstones and moves as `delete(old)` + `set(new, full_content)`,
      - stage all per-file results first and commit overlay updates atomically per tool call (no partial overlay commit on failure).
      *depends on 2-3*
   5. Preserve direct mode behavior exactly as-is for terminal/web flows. *depends on 3.2-3.4*
4. Phase 4 — Lifecycle boundaries + move/rename rules
   1. Define exact overlay lifecycle per propose run:
      - start propose run: create empty overlay context,
      - during run: all mutating and dependent read operations use the same overlay,
      - end propose run (success, cancel, or error): discard overlay entirely.
      *depends on 2.1*
   2. Prohibit cross-turn persistence: do not reuse overlay across prompts/agent turns and do not persist it on disk. *depends on 4.1*
   3. Define move/rename semantics in propose mode:
      - `move A -> B`: resolve `A` via overlay-first resolver,
      - if source missing/tombstoned: fail with explicit error,
      - if target `B` exists (overlay or disk) and overwrite is not explicitly allowed: fail,
      - otherwise set `overlay[B] = source_full_content` and tombstone `A`.
      *depends on 2.2, 2.3*
5. Phase 5 — Read consistency in MVP; search deferred
   1. Update `read` tool (file + directory listing) to reflect overlay state in propose mode so `write -> read`, `edit -> read`, and `move/delete -> read/list` are consistent within the turn. *depends on 2-4*
   2. Ensure any internal file lookups used by edit/patch tooling use the same overlay resolver (single source of truth). *depends on 5.1*
   3. Defer full `glob`/`grep` overlay consistency to follow-up phase; document expected temporary staleness versus overlay in v1. *depends on 5.1*
6. Phase 6 — VS Code chat-native adapter (parallelizable after payload contract is stable)
   1. Add modular extension-side chat modules (participant registration, OpenCode session/event client, proposal-to-`externalEdit` adapter, capability/fallback checks) rather than expanding `extension.ts` monolithically. *depends on 1; best after 3 for final payload contract*
   2. Register a chat participant and send prompts to OpenCode using propose mode.
   3. Stream assistant text/tool progress into chat responses using existing event/session APIs.
   4. Collect proposed file edits and invoke one batched `externalEdit` call with `WorkspaceEdit` for multi-file review and per-hunk accept/reject.
   5. Keep terminal commands untouched and available.
7. Phase 7 — Packaging + compatibility + safeguards
   1. Update VS Code extension manifest/engine requirements for chat editing API availability.
   2. Add runtime capability checks and fallback behavior when chat editing APIs are unavailable.
   3. If API/schema changes require it, regenerate JS SDK artifacts.
8. Phase 8 — Testing + verification
   1. Add propose-mode unit tests for `write`, `edit`, `apply_patch` proving no disk writes and stable payload shape.
   2. Add invariant tests: overlay non-delete entries always contain full final file content; no patch-fragment storage.
   3. Add explicit consistency tests for propose sequences:
      - `write A -> read A` returns overlay full content while disk remains unchanged,
      - `write A -> edit A` uses overlay content as base,
      - `apply_patch` multi-file updates produce full overlay content entries,
      - `apply_patch` failure path leaves overlay unchanged (atomicity),
      - `move/delete -> read/list` reflects tombstone/new path state.
   4. Add lifecycle tests: overlay cleared at end of run; no carry-over into next prompt.
   5. Add move semantics tests: missing source error, target overwrite conflict behavior, successful move result.
   6. Add session-level tests for propose-mode prompt loop behavior and direct-mode regressions.
   7. Add extension smoke/integration tests (or minimal harness scaffolding) for chat participant + `externalEdit` invocation.

**Relevant files**
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/src/extension.ts` — keep terminal command behavior; add chat bootstrap wiring only.
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/package.json` — add chat participant contribution + VS Code engine/version updates.
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/src/chat/participant.ts` (new) — chat participant handler and response streaming orchestration.
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/src/chat/opencode-client.ts` (new) — OpenCode HTTP/SSE client wrapper for session + event calls.
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/src/chat/external-edit.ts` (new) — proposal batching and `externalEdit`/`WorkspaceEdit` integration.
- `/Users/faizanahmad/Personal/opencode/sdks/vscode/src/chat/capabilities.ts` (new) — feature detection/fallback guardrails.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/server/routes/instance/session.ts` — accept optional execution mode in prompt payload.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/session/prompt.ts` — propagate execution mode and run-scoped overlay context.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/tool.ts` — extend `Tool.Context` with propose-mode signal and overlay accessors.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/session/proposed-files.ts` (new) — run-scoped overlay store, resolver, tombstones, lifecycle helpers.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/proposal.ts` (new) — proposal payload builder/normalizer using full-content outputs.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/write.ts` — propose path writes full content to overlay.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/edit.ts` — overlay-first source reads and full-content overlay updates.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/apply_patch.ts` — patch-to-full-content normalization + overlay updates for add/update/delete/move.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/read.ts` — overlay-aware file and directory reads in propose mode.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/glob.ts` — follow-up phase target for overlay-aware path enumeration after MVP consistency ships.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/src/tool/grep.ts` — follow-up phase target for overlay-aware content matching after MVP consistency ships.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/test/tool/write.test.ts` — propose-mode tests.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/test/tool/edit.test.ts` — chain-consistency + overlay-base tests.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/test/tool/apply_patch.test.ts` — patch normalization + move/delete + multi-file consistency tests.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/test/tool/read.test.ts` (new or existing target) — overlay/read/list semantics tests.
- `/Users/faizanahmad/Personal/opencode/packages/opencode/test/session/prompt-effect.test.ts` — run lifecycle/no-carry-over and direct-mode regression coverage.
- `/Users/faizanahmad/Personal/opencode/packages/sdk/js/script/build.ts` — regenerate SDK if request schemas change.

**Verification**
1. In `/Users/faizanahmad/Personal/opencode/packages/opencode`, run `bun typecheck`.
2. In `/Users/faizanahmad/Personal/opencode/packages/opencode`, run targeted tests for modified areas: `bun test test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts test/tool/read.test.ts test/session/prompt-effect.test.ts`.
3. Verify explicitly in tests that propose mode stores full-content overlay entries and never mutates disk.
4. Verify lifecycle tests prove no overlay reuse across prompts/agent turns.
5. In `/Users/faizanahmad/Personal/opencode/sdks/vscode`, run `bun run check-types` and `bun run lint`.
6. If session/openapi contract changes, regenerate SDK via `/Users/faizanahmad/Personal/opencode/packages/sdk/js/script/build.ts`, then run `bun run typecheck` in `/Users/faizanahmad/Personal/opencode/packages/sdk/js`.
7. Manual smoke test in VS Code extension host:
   1. Prompt chat participant for a multi-file change.
   2. Confirm inline diffs render in chat editing UI.
   3. Accept/reject individual hunks and confirm only accepted buffer edits apply.
   4. Confirm files are not directly written during proposal generation.
   5. During one propose turn, confirm `write -> read`, `write -> edit`, and `move/delete -> read/list` operate on overlay state.
   6. Confirm existing terminal commands still work unchanged.

**Decisions**
- Use explicit backend propose mode (no filesystem writes during proposal phase).
- Overlay is run-scoped and stores final full file content per path (or tombstone), never patch fragments.
- `apply_patch` in propose mode is normalized to full-content overlay updates via overlay-first base resolution.
- Overlay lifecycle is strictly per propose run and is discarded at end of run; no cross-prompt reuse.
- Move semantics are explicit (`delete old` + `set new full content`) with defined missing-source and overwrite-conflict behavior.
- Require newer VS Code for full chat-native editing; keep runtime fallback behavior where unsupported.
- Included scope: chat-native proposals, multi-file batched edits, native per-hunk review, dual-mode coexistence, propose-turn file-state consistency.
- Excluded scope (this phase): acceptance analytics/ranking, custom diff renderer, terminal UX replacement, full `glob`/`grep` overlay consistency (follow-up phase, known temporary staleness).