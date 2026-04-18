import * as assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import * as vscode from "vscode"
import {
  applyProposals,
  mergeProposalFiles,
  readProposalPayload,
  resolveEffectiveProposalFiles,
  summarizeProposalFiles,
  type ProposalFile,
} from "../chat/external-edit"

suite("external-edit", () => {
  test("readProposalPayload accepts valid propose payload", () => {
    const payload = readProposalPayload({
      mode: "propose",
      files: [
        {
          operation: "set",
          file_path: "/tmp/example.ts",
          uri: "file:///tmp/example.ts",
          new_content: "export const ok = true\n",
          additions: 1,
          deletions: 0,
        },
      ],
      stats: {
        files: 1,
        additions: 1,
        deletions: 0,
      },
    })

    assert.ok(payload)
    assert.equal(payload?.mode, "propose")
    assert.equal(payload?.files.length, 1)
    assert.equal(payload?.files[0].operation, "set")
    assert.equal(payload?.files[0].new_content, "export const ok = true\n")
  })

  test("readProposalPayload rejects malformed entries", () => {
    const payload = readProposalPayload({
      mode: "propose",
      files: [
        {
          operation: "set",
          file_path: "/tmp/example.ts",
          uri: "file:///tmp/example.ts",
        },
      ],
    })

    assert.equal(payload, undefined)
  })

  test("mergeProposalFiles keeps last file operation for same path", () => {
    const files: ProposalFile[] = [
      {
        operation: "set",
        file_path: "/tmp/feature.ts",
        uri: "file:///tmp/feature.ts",
        new_content: "first",
      },
      {
        operation: "set",
        file_path: "/tmp/feature.ts",
        uri: "file:///tmp/feature.ts",
        new_content: "second",
      },
    ]

    const merged = mergeProposalFiles(files)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].new_content, "second")
  })

  test("summarizeProposalFiles aggregates stats", () => {
    const summary = summarizeProposalFiles([
      {
        operation: "set",
        file_path: "/tmp/a.ts",
        uri: "file:///tmp/a.ts",
        new_content: "a",
        additions: 5,
        deletions: 1,
      },
      {
        operation: "delete",
        file_path: "/tmp/b.ts",
        uri: "file:///tmp/b.ts",
        additions: 0,
        deletions: 3,
      },
    ])

    assert.deepEqual(summary, {
      files: 2,
      additions: 5,
      deletions: 4,
    })
  })

  test("applyProposals is no-op without externalEdit support", async () => {
    const result = await applyProposals({} as unknown as vscode.ChatResponseStream, [
      {
        operation: "set",
        file_path: "/tmp/never-used.ts",
        uri: "file:///tmp/never-used.ts",
        new_content: "unused",
      },
    ])

    assert.equal(result, undefined)
  })

  test("applyProposals calls externalEdit when available", async () => {
    let called = false

    const response = {
      externalEdit: (edit: vscode.WorkspaceEdit) => {
        called = true
        assert.ok(edit)
      },
    } as unknown as vscode.ChatResponseStream

    const result = await applyProposals(response, [
      {
        operation: "set",
        file_path: "/tmp/external-edit.ts",
        uri: "file:///tmp/external-edit.ts",
        new_content: "export const external = true\n",
      },
    ])

    assert.ok(called)
    assert.equal(result?.method, "externalEdit")
    assert.equal(result?.files, 1)
    assert.equal(result?.skipped, 0)
  })

  test("resolveEffectiveProposalFiles skips unchanged set proposals", async () => {
    const filePath = path.join(os.tmpdir(), `opencode-noop-${randomUUID()}.md`)
    await writeFile(filePath, "hello world\n", "utf8")

    const result = await resolveEffectiveProposalFiles([
      {
        operation: "set",
        file_path: filePath,
        uri: vscode.Uri.file(filePath).toString(),
        new_content: "hello world\n",
      },
    ])

    assert.equal(result.applicable.length, 0)
    assert.equal(result.skipped.length, 1)

    await rm(filePath, { force: true })
  })

  test("applyProposals does not call externalEdit for no-op proposals", async () => {
    const filePath = path.join(os.tmpdir(), `opencode-noop-apply-${randomUUID()}.md`)
    await writeFile(filePath, "same\n", "utf8")

    let called = false

    const response = {
      externalEdit: (_edit: vscode.WorkspaceEdit) => {
        called = true
      },
    } as unknown as vscode.ChatResponseStream

    const result = await applyProposals(response, [
      {
        operation: "set",
        file_path: filePath,
        uri: vscode.Uri.file(filePath).toString(),
        new_content: "same\n",
      },
    ])

    assert.equal(called, false)
    assert.equal(result?.method, "externalEdit")
    assert.equal(result?.files, 0)
    assert.equal(result?.skipped, 1)

    await rm(filePath, { force: true })
  })

  test("applyProposals writes changes in arity-2 externalEdit callback", async () => {
    const filePath = path.join(os.tmpdir(), `opencode-external-arity2-${randomUUID()}.md`)
    await writeFile(filePath, "before\n", "utf8")

    let called = false

    const response = {
      externalEdit: async (_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
        called = true
        await callback()
        return "undo-stop-id"
      },
    } as unknown as vscode.ChatResponseStream

    const result = await applyProposals(response, [
      {
        operation: "set",
        file_path: filePath,
        uri: vscode.Uri.file(filePath).toString(),
        new_content: "after\n",
      },
    ])

    const content = await readFile(filePath, "utf8")
    assert.equal(called, true)
    assert.equal(content, "after\n")
    assert.equal(result?.method, "externalEdit")
    assert.equal(result?.files, 1)
    assert.equal(result?.skipped, 0)

    await rm(filePath, { force: true })
  })
})
