# Local Dev Install (Alongside Website Install)

Use this when you want to test your modified VS Code extension **and** modified backend without uninstalling the website-installed `opencode`.

## 1) Build local backend binary

```bash
cd /Users/faizanahmad/Personal/opencode/packages/opencode
bun install
bun run build --single
```

If this command fails, `dist/` will not exist yet. Fix the error and rerun.

Find the built binary:

```bash
cd /Users/faizanahmad/Personal/opencode/packages/opencode
ls -la dist/opencode-darwin-arm64/bin/opencode
```

Expected macOS Apple Silicon path:

```bash
/Users/faizanahmad/Personal/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

## 2) Create a dev-only PATH shim (keeps website install intact)

```bash
mkdir -p ~/.opencode-dev/bin
ln -sf /Users/faizanahmad/Personal/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode ~/.opencode-dev/bin/opencode
```

Verify which binary is used when dev PATH is active:

```bash
PATH="$HOME/.opencode-dev/bin:$PATH" which opencode
PATH="$HOME/.opencode-dev/bin:$PATH" opencode --version
```

## 3) Build VS Code extension VSIX

```bash
cd /Users/faizanahmad/Personal/opencode/sdks/vscode
bun install
npx @vscode/vsce package --no-git-tag-version --no-update-package-json --no-dependencies --skip-license -o dist/opencode.vsix 1.4.9
```

If you want a plain build artifact without packaging, either command works now:

```bash
bun run build
# or
bun run compile
```

## 4) Install VSIX locally

```bash
code --install-extension /Users/faizanahmad/Personal/opencode/sdks/vscode/dist/opencode.vsix --force
```

## 5) Start VS Code so extension uses local backend

Always launch VS Code from a shell with dev PATH prepended:

```bash
PATH="$HOME/.opencode-dev/bin:$PATH" code /Users/faizanahmad/Personal/opencode
```

This ensures extension `spawn("opencode", ...)` resolves to your local binary first.

## 6) Quick sanity checks

In VS Code:

1. Open Chat panel.
2. Use `@opencode`.
3. Run **`opencode: Select Chat Model`** from the Command Palette to pick from `opencode models`.
4. (Optional) clear the override with **Use VS Code model picker** in that command.
5. Send a prompt.

If you want edits applied immediately (instead of the "Apply proposed edits" button flow), set **`opencode.executionMode`** to **`direct`** in workspace settings.

If you want `propose` mode to **always** require explicit apply (even in Insiders), set:

- **`opencode.proposeApplyStrategy`** = **`manualApply`**

If VS Code does not expose chat mode metadata to the extension (logs show `chat mode: {name: 'unknown', ...}`), and you still want to **attempt** native review, set:

- **`opencode.assumeExternalReviewWhenModeUnknown`** = **`true`**

⚠️ This is a best-effort fallback. In non-editing contexts, VS Code may apply edits directly instead of showing per-hunk review.

In Extension Development Host (F5), this fallback is now attempted by default when mode is unknown. Set **`opencode.assumeExternalReviewWhenModeUnknown`** to **`false`** if you want to force explicit manual apply in that case.

If you want native per-hunk chat review, use an editing-capable chat mode (for example, **Edit**) when invoking `@opencode`. In non-editing modes, OpenCode will fall back to explicit **Apply proposed edits** to avoid unintended direct writes.

Note: Copilot-style inline **per-hunk** accept/reject chat edit UI is only available when the current VS Code runtime exposes the native chat external-edit capability to extensions. If unavailable, OpenCode falls back to:

- **`propose`**: explicit **Apply proposed edits** button
- **`direct`**: edits applied immediately to the workspace

If behavior looks old, verify PATH again:

```bash
PATH="$HOME/.opencode-dev/bin:$PATH" which opencode
```

## 6.1) Run with F5 (Extension Development Host)

From `sdks/vscode`:

```bash
bun install
```

Then in VS Code:

1. Open **Run and Debug**.
2. Choose **Run Extension (Insiders + Proposed API)** for chat edit review testing.
3. Press **F5**.

Notes:

- F5 already runs the pre-launch compile task (`bun: compile`).
- You do **not** need to run `bun run build` before pressing F5, but it is available if you want to prebuild manually.

## 7) If chat is stuck on "Sending request..."

This usually means backend prompt execution failed or is blocked (not PATH).

### A) Check backend can execute a prompt

```bash
PATH="$HOME/.opencode-dev/bin:$PATH" opencode run "Reply with just: OK" --format json --print-logs
```

If this hangs or prints provider errors, fix provider/model access first.

### B) Common failure: quota exceeded (HTTP 429)

If logs contain `quota exceeded` / `statusCode: 429`, the selected provider/model cannot run right now.

Fix options:

1. Pick a different model/provider in chat model picker.
2. Re-auth/connect provider in opencode (`/connect` in TUI, or your normal provider auth flow).
3. Use a model you know is available in your opencode config.

### C) Validate server health separately

```bash
PATH="$HOME/.opencode-dev/bin:$PATH" opencode serve --port 4099
curl -sf http://127.0.0.1:4099/global/health
```

If health is OK but prompts fail, the issue is provider/model execution, not server startup.

## Optional: revert to website-installed backend anytime

Just launch VS Code normally (without PATH prepend), or remove the shim:

```bash
rm -f ~/.opencode-dev/bin/opencode
```
