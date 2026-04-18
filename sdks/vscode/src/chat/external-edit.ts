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
  skipped: number
}

export type EffectiveProposalFiles = {
  applicable: ProposalFile[]
  skipped: ProposalFile[]
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
  response: vscode.ChatResponseStream | undefined,
  files: readonly ProposalFile[],
): Promise<ApplyProposalResult | undefined> {
  if (files.length === 0) return

  const merged = mergeProposalFiles(files)
  const externalEdit = getExternalEditHandler(response)
  if (!externalEdit) return

  const effective = await resolveEffectiveProposalFiles(merged)
  console.log("proposal effective summary:", {
    proposed: merged.length,
    applicable: effective.applicable.length,
    skipped: effective.skipped.length,
  })

  if (effective.applicable.length === 0) {
    return {
      method: "externalEdit",
      files: 0,
      skipped: effective.skipped.length,
    }
  }

  const edit = await buildWorkspaceEdit(effective.applicable)
  const targets = proposalTargets(effective.applicable)
  console.log(
    "proposal target uris:",
    targets.map((target) => target.toString()),
  )

  if (externalEdit.length >= 2) {
    for (const file of effective.applicable) {
      await (externalEdit as unknown as (
        target: vscode.Uri | vscode.Uri[],
        callback: () => Thenable<unknown>,
      ) => Thenable<string>)(toUri(file), async () => {
        await applyProposalToFileSystem(file)
      })
    }
  } else {
    await (externalEdit as unknown as (edit: vscode.WorkspaceEdit) => void | Thenable<void>)(edit)
  }

  return {
    method: "externalEdit",
    files: effective.applicable.length,
    skipped: effective.skipped.length,
  }
}

export async function resolveEffectiveProposalFiles(files: readonly ProposalFile[]): Promise<EffectiveProposalFiles> {
  const applicable: ProposalFile[] = []
  const skipped: ProposalFile[] = []

  for (const file of files) {
    const uri = toUri(file)
    const exists = await fileExists(uri)

    if (file.operation === "delete") {
      if (!exists) {
        skipped.push(file)
        continue
      }

      applicable.push(file)
      continue
    }

    const newContent = file.new_content ?? ""

    if (!exists) {
      applicable.push({
        ...file,
        new_content: newContent,
      })
      continue
    }

    const document = await vscode.workspace.openTextDocument(uri)
    if (document.getText() === newContent) {
      skipped.push(file)
      continue
    }

    applicable.push({
      ...file,
      new_content: newContent,
    })
  }

  return {
    applicable,
    skipped,
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
    applyMinimalReplaceEdit(edit, uri, document, newContent)
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
  const fromPath = resolveUriFromFilePath(file.file_path)
  if (fromPath) return fromPath

  if (file.uri.startsWith("file://")) {
    const parsed = vscode.Uri.parse(file.uri)
    if (parsed.scheme === "file" && parsed.fsPath.length > 0) return parsed
  }

  return vscode.Uri.file(file.file_path)
}

function proposalTargets(files: readonly ProposalFile[]) {
  const unique = new Map<string, vscode.Uri>()
  files.forEach((file) => {
    const uri = toUri(file)
    unique.set(uri.toString(), uri)
  })
  return Array.from(unique.values())
}

async function applyProposalToFileSystem(file: ProposalFile) {
  const uri = toUri(file)

  if (file.operation === "delete") {
    await vscode.workspace.fs.delete(uri, {
      recursive: false,
      useTrash: false,
    })
    return
  }

  const newContent = file.new_content ?? ""
  const edit = new vscode.WorkspaceEdit()
  const exists = await fileExists(uri)

  if (!exists) {
    const directory = vscode.Uri.file(path.dirname(uri.fsPath))
    await vscode.workspace.fs.createDirectory(directory)
    edit.createFile(uri, { ignoreIfExists: true })
    edit.insert(uri, new vscode.Position(0, 0), newContent)
  } else {
    const document = await vscode.workspace.openTextDocument(uri)
    applyMinimalReplaceEdit(edit, uri, document, newContent)
  }

  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) {
    throw new Error(`OpenCode could not apply proposed changes to ${uri.fsPath}.`)
  }

  const document = await vscode.workspace.openTextDocument(uri)
  const saved = await document.save()
  if (!saved) {
    throw new Error(`OpenCode could not save proposed changes to ${uri.fsPath}.`)
  }
}

function applyMinimalReplaceEdit(
  edit: vscode.WorkspaceEdit,
  uri: vscode.Uri,
  document: vscode.TextDocument,
  newContent: string,
) {
  const current = document.getText()
  if (current === newContent) return

  const currentLength = current.length
  const newLength = newContent.length

  let prefixLength = 0
  const sharedPrefixLimit = Math.min(currentLength, newLength)
  while (prefixLength < sharedPrefixLimit && current.charCodeAt(prefixLength) === newContent.charCodeAt(prefixLength)) {
    prefixLength += 1
  }

  let suffixLength = 0
  const sharedSuffixLimit = Math.min(currentLength - prefixLength, newLength - prefixLength)
  while (
    suffixLength < sharedSuffixLimit &&
    current.charCodeAt(currentLength - 1 - suffixLength) === newContent.charCodeAt(newLength - 1 - suffixLength)
  ) {
    suffixLength += 1
  }

  const currentStartOffset = prefixLength
  const currentEndOffset = currentLength - suffixLength
  const replacement = newContent.slice(prefixLength, newLength - suffixLength)

  const range = new vscode.Range(document.positionAt(currentStartOffset), document.positionAt(currentEndOffset))
  edit.replace(uri, range, replacement)
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

function resolveUriFromFilePath(filePath: string) {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath)

  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return

  return vscode.Uri.file(path.join(folder.uri.fsPath, filePath))
}
