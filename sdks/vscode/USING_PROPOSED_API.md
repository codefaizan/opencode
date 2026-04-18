# Using VS Code Proposed API in this extension

This guide explains how to use VS Code's **Proposed API** for local extension development.

> Based on the official VS Code Proposed API docs, Insiders guidance, and the `proposed-api-sample` workflow.

Proposed APIs are **unstable**, available in **VS Code Insiders**, and extensions using them **cannot be published to the Marketplace**.

## 1) What needs to be configured in the extension

### `package.json`

Add valid proposal names under `enabledApiProposals`.

For this extension, use the chat participant proposal additions:

```json
"enabledApiProposals": [
  "chatParticipantAdditions"
]
```

### Download proposal typings

From `sdks/vscode`:

```bash
bun run proposed-api:sync
```

This command:

- downloads `vscode.proposed.<proposal>.d.ts` files for proposals listed in `package.json`
- moves them into `src/types/` (inside this package's TypeScript root)

If you want to run the raw download only:

```bash
bun run proposed-api:download
```

### Compatibility (if typings conflict)

If you hit type incompatibility between `@types/vscode` and proposal typings:

1. Remove dependency on `@types/vscode` and run:

   ```bash
   npx @vscode/dts main
   ```

2. Or keep `@types/vscode@<version>` and fetch proposal typings from a matching tag/branch:

   ```bash
   npx @vscode/dts dev <git-tag-or-branch>
   ```

## 2) What users do in VS Code Insiders to use the feature

1. Install and run **VS Code Insiders**.
2. Install your extension (for example, from VSIX).
3. Enable proposed API for this extension ID:

   - `sst-dev.opencode`

   One-time launch example:

   ```bash
   code-insiders /Users/faizanahmad/Personal/opencode --enable-proposed-api=sst-dev.opencode
   ```

4. For persistent enablement in Insiders:

   - Run **Preferences: Configure Runtime Arguments**
   - Add to `.vscode-insiders/argv.json`:

   ```json
   {
     "enable-proposed-api": ["sst-dev.opencode"]
   }
   ```

5. Restart VS Code Insiders.

### Troubleshooting: `Language model unavailable`

If chat shows `Language model unavailable` (even in Insiders), VS Code could not resolve a chat model for the request.

Do this in the chat UI:

1. Open the model picker in chat and select any available model.
2. If no models are listed, sign in/enable your chat model provider (for example, Copilot) so VS Code has at least one model.

Note: `opencode.chatModel` controls which model OpenCode sends to the backend, but VS Code still requires a resolved chat model at request time.

### Can this be bypassed for users without Copilot?

Short answer: not from extension code when using the native VS Code chat participant surface.

Current chat participant request handling in VS Code resolves a chat model before invoking participant handlers. If no model is available, VS Code throws `Language model unavailable` before the extension can handle the request.

Practical options for non-Copilot users:

1. Use another VS Code-compatible chat model provider so the model picker has at least one model.
2. Expose OpenCode through a non-chat UI path (for example, command palette/webview/terminal integration) that does not depend on VS Code chat model resolution.

### Optional: force explicit apply in `propose` mode

If you don't want proposed edits to attach to native chat edit review automatically, set:

```json
"opencode.proposeApplyStrategy": "manualApply"
```

This keeps `opencode.executionMode` on `propose` but always uses the explicit **Apply proposed edits** button flow.

## Quick checklist

- [ ] Extension has valid `enabledApiProposals` entries
- [ ] `bun run proposed-api:sync` completed
- [ ] Running in VS Code Insiders
- [ ] Proposed API enabled for `sst-dev.opencode`
- [ ] Insiders restarted after runtime-arg changes
