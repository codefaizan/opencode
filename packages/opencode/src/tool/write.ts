import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionProposedFiles } from "@/session/proposed-files"
import { Proposal } from "./proposal"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
      }),
      execute: (
        params: { content: string; filePath: string },
        ctx: Tool.Context,
      ): Effect.Effect<
        Tool.ExecuteResult<{
          diagnostics: Record<string, Record<string, any>[]>
          filepath: string
          exists: boolean
          proposal?: Proposal.ProposalPayload
        }>
      > =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(Instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          const mode = Tool.executionMode(ctx)
          const proposedFiles = ctx.proposedFiles
          if (mode === "propose" && !proposedFiles) {
            throw new Error("Propose mode requires proposedFiles context")
          }

          const exists =
            mode === "propose"
              ? yield* SessionProposedFiles.exists(proposedFiles, fs, filepath)
              : yield* fs.existsSafe(filepath)
          const contentOld = exists
            ? mode === "propose"
              ? yield* SessionProposedFiles.readFileString(proposedFiles, fs, filepath).pipe(
                  Effect.catch(() => Effect.succeed("")),
                )
              : yield* fs.readFileString(filepath)
            : ""

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(Instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, params.content)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }

          if (mode === "propose") {
            SessionProposedFiles.setFile(proposedFiles!, filepath, params.content)
            return {
              title: path.relative(Instance.worktree, filepath),
              metadata: {
                diagnostics: {},
                filepath,
                exists,
                proposal: Proposal.payload([
                  Proposal.setFile({
                    filePath: filepath,
                    newContent: params.content,
                    diff,
                    additions,
                    deletions,
                  }),
                ]),
              },
              output: "Proposed file update successfully.",
            }
          }

          yield* fs.writeWithDirs(filepath, params.content)
          yield* format.file(filepath)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, true)
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
              proposal: undefined,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
