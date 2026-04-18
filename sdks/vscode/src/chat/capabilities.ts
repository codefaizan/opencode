import * as vscode from "vscode"

type ExternalEditHandler = {
  (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>): Thenable<string>
  (edit: vscode.WorkspaceEdit): void | Thenable<void>
}

type ChatResponseStreamWithExternalEdit = vscode.ChatResponseStream & {
  externalEdit?: ExternalEditHandler
}

export function supportsChatParticipantApi() {
  return typeof vscode.chat?.createChatParticipant === "function"
}

export function getExternalEditHandler(response: vscode.ChatResponseStream | undefined) {
  if (!response) return
  const stream = response as ChatResponseStreamWithExternalEdit
  if (typeof stream.externalEdit !== "function") return
  return stream.externalEdit.bind(stream) as ExternalEditHandler
}

export function externalEditCapabilityMessage(response: vscode.ChatResponseStream | undefined) {
  if (getExternalEditHandler(response)) {
    return "Native chat edit review is available."
  }
  return "Native chat edit review is unavailable in this VS Code runtime; falling back to standard workspace edits."
}
