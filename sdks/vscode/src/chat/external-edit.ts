import * as path from "node:path"
import * as vscode from "vscode"
import { getExternalEditHandler } from "./capabilities"

export type ProposalFile = {
  operation: "set" | "delete"
  file_path: string
  uri: string
  new_content?: string
  diff?: string
  additions?: number
  deletions?: number
}

export type ProposalPayload = {
  mode: "propose"
  files: ProposalFile[]
  stats?: {
    files: number
    additions: number
    deletions: number
  }
}

export type ApplyProposalResult = {
  method: "externalEdit"
  files: number
}

export function readProposalPayload(value: unknown) {
  if (!value || typeof value !== "object") return

  const maybePayload = value as Partial<ProposalPayload>
  if (maybePayload.mode !== "propose" || !Array.isArray(maybePayload.files)) return

  const files = maybePayload.files.filter((file): file is ProposalFile => {
    if (!file || typeof file !== "object") return false

    const typed = file as Partial<ProposalFile>
    if (typed.operation !== "set" && typed.operation !== "delete") return false
    if (typeof typed.file_path !== "string" || typed.file_path.length === 0) return false
    if (typeof typed.uri !== "string" || typed.uri.length === 0) return false
    if (typed.operation === "set" && typeof typed.new_content !== "string") return false
    return true
  })

  if (files.length === 0) return

  const stats =
    maybePayload.stats &&
    typeof maybePayload.stats === "object" &&
    typeof maybePayload.stats.files === "number" &&
    typeof maybePayload.stats.additions === "number" &&
    typeof maybePayload.stats.deletions === "number"
      ? maybePayload.stats
      : undefined

  return {
    mode: "propose" as const,
    files,
    stats,
  }
}

export function mergeProposalFiles(files: readonly ProposalFile[]) {
  const byPath = new Map<string, ProposalFile>()

  files.forEach((file) => {
    const normalizedPath = normalizePath(file.file_path)
    byPath.set(normalizedPath, {
      ...file,
      file_path: normalizedPath,
    })
  })

  return Array.from(byPath.values())
}

export async function applyProposals(
  response: vscode.ChatResponseStream,
  files: readonly ProposalFile[],
): Promise<ApplyProposalResult | undefined> {
  if (files.length === 0) return

  const merged = mergeProposalFiles(files)
  const externalEdit = getExternalEditHandler(response)
  if (!externalEdit) return

  const edit = await buildWorkspaceEdit(merged)
  await externalEdit(edit)

  return {
    method: "externalEdit",
    files: merged.length,
  }
}

export async function buildWorkspaceEdit(files: readonly ProposalFile[]) {
  const edit = new vscode.WorkspaceEdit()

  for (const file of files) {
    const uri = toUri(file)

    if (file.operation === "delete") {
      edit.deleteFile(uri, {
        ignoreIfNotExists: true,
      })
      continue
    }

    const exists = await fileExists(uri)
    const newContent = file.new_content ?? ""

    if (!exists) {
      edit.createFile(uri, {
        ignoreIfExists: true,
      })
      edit.insert(uri, new vscode.Position(0, 0), newContent)
      continue
    }

    const document = await vscode.workspace.openTextDocument(uri)
    const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length))
    edit.replace(uri, fullRange, newContent)
  }

  return edit
}

export function summarizeProposalFiles(files: readonly ProposalFile[]) {
  return {
    files: files.length,
    additions: files.reduce((count, file) => count + (file.additions ?? 0), 0),
    deletions: files.reduce((count, file) => count + (file.deletions ?? 0), 0),
  }
}

function toUri(file: ProposalFile) {
  if (file.uri.startsWith("file://")) return vscode.Uri.parse(file.uri)
  return vscode.Uri.file(file.file_path)
}

function fileExists(uri: vscode.Uri) {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  )
}

function normalizePath(filePath: string) {
  return path.normalize(filePath)
}
