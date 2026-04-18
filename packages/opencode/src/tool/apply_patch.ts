import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import { SessionProposedFiles } from "@/session/proposed-files"
import { Proposal } from "./proposal"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (params: z.infer<typeof PatchParams>, ctx: Tool.Context) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }
      const mode = Tool.executionMode(ctx)
      const proposedFiles = ctx.proposedFiles
      if (mode === "propose" && !proposedFiles) {
        return yield* Effect.fail(new Error("Propose mode requires proposedFiles context"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
      }> = []
      const stagedOverlayChanges: Array<
        | {
            type: "set"
            filePath: string
            content: string
          }
        | {
            type: "delete"
            filePath: string
          }
      > = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(Instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent =
              mode === "propose"
                ? (yield* SessionProposedFiles.readFileString(proposedFiles, afs, filePath).pipe(
                    Effect.catch(() => Effect.succeed("")),
                  ))
                : ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: "add",
              diff,
              additions,
              deletions,
            })

            if (mode === "propose") {
              stagedOverlayChanges.push({
                type: "set",
                filePath,
                content: newContent,
              })
            }

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            const oldContent =
              mode === "propose"
                ? yield* SessionProposedFiles.readFileString(proposedFiles, afs, filePath).pipe(
                    Effect.catch(() =>
                      Effect.fail(new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)),
                    ),
                  )
                : yield* Effect.gen(function* () {
                    const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                    if (!stats || stats.type === "Directory") {
                      return yield* Effect.fail(
                        new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
                      )
                    }
                    return yield* afs.readFileString(filePath)
                  })
            let newContent = oldContent

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromSource(filePath, oldContent, hunk.chunks)
              newContent = fileUpdate.content
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            if (mode === "propose") {
              if (movePath) {
                const source = SessionProposedFiles.normalizePath(filePath)
                const target = SessionProposedFiles.normalizePath(movePath)
                if (source !== target && (yield* SessionProposedFiles.exists(proposedFiles, afs, movePath))) {
                  return yield* Effect.fail(
                    new Error(`apply_patch verification failed: Target already exists for move: ${movePath}`),
                  )
                }
                stagedOverlayChanges.push({
                  type: "delete",
                  filePath,
                })
                stagedOverlayChanges.push({
                  type: "set",
                  filePath: movePath,
                  content: newContent,
                })
              } else {
                stagedOverlayChanges.push({
                  type: "set",
                  filePath,
                  content: newContent,
                })
              }
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const contentToDelete =
              mode === "propose"
                ? yield* SessionProposedFiles.readFileString(proposedFiles, afs, filePath).pipe(
                    Effect.catch((error) =>
                      Effect.fail(new Error(`apply_patch verification failed: ${String(error)}`)),
                    ),
                  )
                : yield* afs
                    .readFileString(filePath)
                    .pipe(
                      Effect.catch((error) =>
                        Effect.fail(new Error(`apply_patch verification failed: ${String(error)}`)),
                      ),
                    )
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
            })

            if (mode === "propose") {
              stagedOverlayChanges.push({
                type: "delete",
                filePath,
              })
            }

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      if (mode === "propose") {
        for (const staged of stagedOverlayChanges) {
          if (staged.type === "delete") {
            SessionProposedFiles.setDelete(proposedFiles!, staged.filePath)
            continue
          }
          SessionProposedFiles.setFile(proposedFiles!, staged.filePath, staged.content)
        }
      }

      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of mode === "propose" ? [] : fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)

            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)

              yield* afs.writeWithDirs(change.movePath!, change.newContent)
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          yield* format.file(edited)
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of mode === "propose" ? [] : updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of mode === "propose" ? [] : fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, true)
      }
      const diagnostics = mode === "propose" ? {} : yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (mode === "propose") continue
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      const proposalFiles =
        mode === "propose"
          ? fileChanges.flatMap((change) => {
              if (change.type === "delete") {
                return [
                  Proposal.deleteFile({
                    filePath: change.filePath,
                    diff: change.diff,
                    additions: change.additions,
                    deletions: change.deletions,
                  }),
                ]
              }
              if (change.type === "move") {
                return [
                  Proposal.deleteFile({
                    filePath: change.filePath,
                    diff: change.diff,
                    additions: change.additions,
                    deletions: change.deletions,
                  }),
                  Proposal.setFile({
                    filePath: change.movePath!,
                    newContent: change.newContent,
                    diff: change.diff,
                    additions: change.additions,
                    deletions: change.deletions,
                  }),
                ]
              }
              return [
                Proposal.setFile({
                  filePath: change.filePath,
                  newContent: change.newContent,
                  diff: change.diff,
                  additions: change.additions,
                  deletions: change.deletions,
                }),
              ]
            })
          : undefined

      return {
        title: mode === "propose" ? "Proposed patch changes" : output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
          ...(proposalFiles ? { proposal: Proposal.payload(proposalFiles) } : {}),
        },
        output: mode === "propose" ? `Success. Proposed updates for ${fileChanges.length} files.` : output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: PatchParams,
      execute: (params: z.infer<typeof PatchParams>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
