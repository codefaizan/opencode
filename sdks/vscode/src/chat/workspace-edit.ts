import * as path from "node:path"
import * as vscode from "vscode"
import { getExternalEditHandler, getWorkspaceEditHandler } from "./capabilities"

export type EditFile = {
  operation: "set" | "delete"
  file_path: string
  uri: string
  new_content?: string
  diff?: string
  additions?: number
  deletions?: number
}

export type ApplyEditResult = {
  files: number
}

export async function applyEditsAndTrack(
  response: vscode.ChatResponseStream | undefined,
  files: readonly EditFile[],
): Promise<ApplyEditResult | undefined> {
  if (files.length === 0) return

  const workspaceEdit = getWorkspaceEditHandler(response)

  if (!workspaceEdit) {
    return { files: files.length }
  }

  // Build standard WorkspaceEdit
  const edit = new vscode.WorkspaceEdit()
  for (const file of files) {
    const uri = resolveUri(file.file_path, file.uri)
    if (file.operation === "delete") {
      edit.deleteFile(uri)
    } else if (file.new_content) {
      const doc = await vscode.workspace.openTextDocument(uri)
      const range = new vscode.Range(0, 0, doc.lineCount, 0)
      edit.replace(uri, range, file.new_content)
    }
  }

  try {
    await workspaceEdit(edit)
    return { files: files.length }
  } catch (e) {
    console.log("workspaceEdit error:", (e as Error).message)
  }

  // Fall back to externalEdit - just pass URIs, don't apply in callback
  try {
    const externalEdit = getExternalEditHandler(response)
    if (externalEdit) {
      const uris = files.map((f) => resolveUri(f.file_path, f.uri))
      console.log("trying externalEdit with uris:", uris.map(u => u.fsPath))
      const result = await externalEdit(uris, async () => {
        console.log("externalEdit callback invoked")
      })
      console.log("externalEdit result:", result)
      return { files: files.length }
    }
  } catch (e2) {
    console.log("externalEdit error:", (e2 as Error).message)
  }

  return { files: files.length }
}

export async function buildWorkspaceEdits(files: readonly EditFile[]): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit()

  for (const file of files) {
    try {
      const uri = resolveUri(file.file_path, file.uri)
      console.log("processing file:", uri.fsPath)

      if (file.operation === "delete") {
        edit.deleteFile(uri, { ignoreIfNotExists: true })
        continue
      }

      let newContent = file.new_content
      let exists = false
      try {
        exists = await fileExists(uri)
      } catch (e) {
        console.log("fileExists error:", e)
      }

      if (!exists) {
        if (!newContent) newContent = ""
        edit.createFile(uri, { ignoreIfExists: true })
        edit.insert(uri, new vscode.Position(0, 0), newContent)
        console.log("created new file:", uri.fsPath)
      } else {
        if (!newContent) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri)
            newContent = doc.getText()
            console.log("read existing content for:", uri.fsPath)
          } catch (e) {
            console.log("read error:", e)
            continue
          }
        }
        const document = await vscode.workspace.openTextDocument(uri)
        applyMinimalReplaceEdit(edit, uri, document, newContent)
        console.log("applied edit to:", uri.fsPath)
      }
    } catch (e) {
      console.log("edit error for", file.file_path, ":", e)
    }
  }

  return edit
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

function resolveUri(filePath: string, uriString: string): vscode.Uri {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath)

  if (uriString.startsWith("file://")) {
    const parsed = vscode.Uri.parse(uriString)
    if (parsed.scheme === "file" && parsed.fsPath.length > 0) return parsed
  }

  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return vscode.Uri.file(filePath)

  return vscode.Uri.file(path.join(folder.uri.fsPath, filePath))
}
