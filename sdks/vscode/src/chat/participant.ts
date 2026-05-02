import * as path from "node:path"
import * as vscode from "vscode"
import { supportsChatParticipantApi } from "./capabilities"
import { OpencodeClient, type PermissionRequest } from "./opencode-client"

export const CHAT_PARTICIPANT_ID = "opencode.chat"
export const OPENCODE_CHAT_MODEL_SETTING = "chatModel"

type RegisterParticipantOptions = {
  context: vscode.ExtensionContext
  client: OpencodeClient
  iconPath: vscode.IconPath
}

type FilePatch = {
  filePath: string
  patch: string
}

type ParsedHunk = {
  oldStart: number
  oldCount: number
  lines: string[]
}

export function registerOpencodeChatParticipant({ context, client, iconPath }: RegisterParticipantOptions) {
  if (!supportsChatParticipantApi()) return []

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, chatContext, response, token) => {
    const prompt = buildPrompt(request)
    const directory = resolveWorkspaceDirectory()
    const sessionContext = isNewSessionCommand(request.command) ? undefined : resolveSessionContext(chatContext.history)
    const model = resolveConfiguredModel() ?? resolveSelectedModel(request.model)

    response.progress("Connecting to OpenCode...")

    try {
      const result = await client.runPrompt({
        directory,
        prompt,
        sessionID: sessionContext?.sessionID,
        anchorAssistantMessageID: sessionContext?.assistantMessageID,
        model,
        token,
        onProgress: (message) => response.progress(message),
        onText: (chunk) => response.markdown(chunk),
        onPermissionAsk: async (permission, actions) => {
          if (permission.permission === "edit") {
            const patches = extractFilePatches(permission, directory)
            for (const patch of patches) {
              await emitTextEditPreview(response, patch)
            }
          }
          await actions.approve("once")
        },
      })

      if (result.text.trim().length === 0) {
        response.markdown("_No assistant text was returned._")
      }

      return {
        metadata: {
          sessionID: result.sessionID,
          assistantMessageID: result.assistantMessageID,
        },
      } satisfies vscode.ChatResult
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OpenCode error"
      response.markdown(`OpenCode request failed: ${message}`)

      return {
        errorDetails: { message },
      } satisfies vscode.ChatResult
    }
  })

  participant.iconPath = iconPath
  context.subscriptions.push(participant)
  return [participant]
}

async function emitTextEditPreview(response: vscode.ChatResponseStream, filePatch: FilePatch) {
  const uri = vscode.Uri.file(filePatch.filePath)
  const current = await readCurrentText(uri)
  const next = applyUnifiedPatch(current, filePatch.patch)
  if (next === undefined || next === current) return

  const lineCount = current.length === 0 ? 0 : current.split(/\r?\n/).length
  response.textEdit(uri, [vscode.TextEdit.replace(new vscode.Range(0, 0, lineCount, 0), next)])
}

async function readCurrentText(uri: vscode.Uri) {
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    return doc.getText()
  } catch {
    return ""
  }
}

function extractFilePatches(permission: PermissionRequest, directory?: string): FilePatch[] {
  const fromFiles = extractFromMetadataFiles(permission.metadata, directory)
  if (fromFiles.length > 0) return fromFiles

  const diff = asNonEmptyString(permission.metadata["diff"])
  if (!diff) return []

  const filepath =
    asNonEmptyString(permission.metadata["filepath"]) ??
    permission.patterns.find((item) => item.length > 0)

  if (!filepath || filepath.includes(",")) return []

  const resolved = resolveFilePath(filepath, directory)
  if (!resolved) return []

  return [{ filePath: resolved, patch: diff }]
}

function extractFromMetadataFiles(metadata: Record<string, unknown>, directory?: string): FilePatch[] {
  const files = metadata["files"]
  if (!Array.isArray(files)) return []

  const result: FilePatch[] = []
  for (const item of files) {
    const file = asRecord(item)
    if (!file) continue

    const patch = asNonEmptyString(file["patch"])
    const rawPath = asNonEmptyString(file["filePath"]) ?? asNonEmptyString(file["relativePath"])
    if (!patch || !rawPath) continue

    const filePath = resolveFilePath(rawPath, directory)
    if (!filePath) continue

    result.push({ filePath, patch })
  }

  return result
}

function resolveFilePath(rawPath: string, directory?: string) {
  if (path.isAbsolute(rawPath)) return rawPath
  if (directory) return path.join(directory, rawPath)
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return
  return path.join(folder.uri.fsPath, rawPath)
}

function applyUnifiedPatch(currentText: string, patch: string): string | undefined {
  const hunks = parseUnifiedHunks(patch)
  if (hunks.length === 0) return

  const normalizedCurrent = currentText.replace(/\r\n/g, "\n")
  const currentLines = normalizedCurrent.split("\n")
  const result: string[] = []
  let cursor = 0

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1)
    if (start < cursor) return

    result.push(...currentLines.slice(cursor, start))

    let sourceIndex = start
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue
      const prefix = line.slice(0, 1)
      const content = line.slice(1)

      if (prefix === " ") {
        result.push(content)
        sourceIndex += 1
        continue
      }

      if (prefix === "-") {
        sourceIndex += 1
        continue
      }

      if (prefix === "+") {
        result.push(content)
      }
    }

    cursor = sourceIndex
  }

  result.push(...currentLines.slice(cursor))
  const merged = result.join("\n")
  if (currentText.includes("\r\n")) return merged.replace(/\n/g, "\r\n")
  return merged
}

function parseUnifiedHunks(patch: string): ParsedHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  const hunks: ParsedHunk[] = []
  let index = 0

  while (index < lines.length) {
    const header = lines[index]
    const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header)
    if (!match) {
      index += 1
      continue
    }

    const oldStart = Number(match[1])
    const oldCount = match[2] ? Number(match[2]) : 1
    index += 1

    const hunkLines: string[] = []
    while (index < lines.length && !lines[index].startsWith("@@")) {
      hunkLines.push(lines[index])
      index += 1
    }

    hunks.push({ oldStart, oldCount, lines: hunkLines })
  }

  return hunks
}

function isNewSessionCommand(command: string | undefined) {
  return command === "new"
}

type SessionContext = {
  sessionID: string
  assistantMessageID?: string
}

function resolveSessionContext(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]) {
  const responses = history.filter((turn): turn is vscode.ChatResponseTurn => "result" in turn)
  const latestWithSession = responses.reverse().find((turn) => {
    const sessionID = turn.result.metadata?.["sessionID"]
    return typeof sessionID === "string" && sessionID.length > 0
  })

  const sessionID = latestWithSession?.result.metadata?.["sessionID"]
  if (typeof sessionID !== "string" || sessionID.length === 0) return

  const assistantMessageID = latestWithSession?.result.metadata?.["assistantMessageID"]
  return {
    sessionID,
    assistantMessageID: typeof assistantMessageID === "string" && assistantMessageID.length > 0 ? assistantMessageID : undefined,
  } satisfies SessionContext
}

function buildPrompt(request: vscode.ChatRequest) {
  const references = request.references
    .map((reference, order) => formatReference(reference, order + 1))
    .filter((line): line is string => typeof line === "string")

  if (references.length === 0) return request.prompt
  return [request.prompt, "", "Referenced context:", ...references].join("\n")
}

function formatReference(reference: vscode.ChatPromptReference, order: number) {
  const value = reference.value
  if (typeof value === "string") return `${order}. ${value}`
  if (value instanceof vscode.Uri) return `${order}. ${value.toString()}`
  if (isLocation(value)) return `${order}. ${value.uri.toString()}#L${value.range.start.line + 1}`
  return
}

function isLocation(value: unknown): value is vscode.Location {
  if (!value || typeof value !== "object") return false
  const candidate = value as { uri?: unknown; range?: unknown }
  return candidate.uri instanceof vscode.Uri && candidate.range instanceof vscode.Range
}

function resolveWorkspaceDirectory() {
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri
  if (activeEditorUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri)
    if (activeFolder) return activeFolder.uri.fsPath
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function resolveSelectedModel(model: vscode.LanguageModelChat | undefined) {
  if (!model) return
  const raw = model as unknown as Record<string, unknown>

  const vendor = asNonEmptyString(raw["vendor"])
  const family = asNonEmptyString(raw["family"])
  if (vendor && family) return { providerID: vendor, modelID: family }

  const id = asNonEmptyString(raw["id"])
  if (!id) return

  const split = id.split("/")
  if (split.length < 2) return

  const providerID = asNonEmptyString(split[0])
  const modelID = asNonEmptyString(split.slice(1).join("/"))
  if (!providerID || !modelID) return

  return { providerID, modelID }
}

function resolveConfiguredModel() {
  const value = vscode.workspace.getConfiguration("opencode").get<string>(OPENCODE_CHAT_MODEL_SETTING)
  if (!value) return

  const split = value.trim().split("/")
  if (split.length < 2) return

  const providerID = asNonEmptyString(split[0])
  const modelID = asNonEmptyString(split.slice(1).join("/"))
  if (!providerID || !modelID) return

  return { providerID, modelID }
}

function asNonEmptyString(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}
