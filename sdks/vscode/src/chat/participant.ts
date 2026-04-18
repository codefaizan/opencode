import * as vscode from "vscode"
import { externalEditCapabilityMessage, supportsChatParticipantApi } from "./capabilities"
import { applyProposals, buildWorkspaceEdit, readProposalPayload, summarizeProposalFiles, type ProposalFile } from "./external-edit"
import { OpencodeClient } from "./opencode-client"

export const CHAT_PARTICIPANT_ID = "opencode.chat"
export const APPLY_PROPOSED_EDITS_COMMAND = "opencode.applyProposedEdits"

type RegisterParticipantOptions = {
  context: vscode.ExtensionContext
  client: OpencodeClient
  iconPath: vscode.IconPath
}

export function registerOpencodeChatParticipant({ context, client, iconPath }: RegisterParticipantOptions) {
  const applyDisposable = vscode.commands.registerCommand(APPLY_PROPOSED_EDITS_COMMAND, async (files: unknown) => {
    const payload = readProposalPayload({
      mode: "propose",
      files: Array.isArray(files) ? files : [],
    })

    if (!payload || payload.files.length === 0) {
      void vscode.window.showWarningMessage("OpenCode did not receive valid proposed edits to apply.")
      return
    }

    const edit = await buildWorkspaceEdit(payload.files)
    const applied = await vscode.workspace.applyEdit(edit)

    if (!applied) {
      void vscode.window.showWarningMessage("OpenCode could not apply the proposed workspace edits.")
      return
    }

    void vscode.window.showInformationMessage(
      `OpenCode applied ${payload.files.length} proposed file edit${payload.files.length === 1 ? "" : "s"}.`,
    )
  })

  if (!supportsChatParticipantApi()) {
    return [applyDisposable]
  }

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, async (request, chatContext, response, token) => {
    const prompt = buildPrompt(request)
    const directory = resolveWorkspaceDirectory()
    const sessionID = isNewSessionCommand(request.command) ? undefined : resolveSessionID(chatContext.history)

    response.progress("Connecting to OpenCode...")

    try {
      const result = await client.runProposePrompt({
        directory,
        prompt,
        sessionID,
        token,
        onProgress: (message) => response.progress(message),
        onText: (chunk) => response.markdown(chunk),
      })

      if (result.text.trim().length === 0) {
        response.markdown("_No assistant text was returned._")
      }

      if (result.proposals.length > 0) {
        response.progress(externalEditCapabilityMessage(response))

        const applied = await applyProposals(response, result.proposals)
        const summary = summarizeProposalFiles(result.proposals)

        if (applied?.method === "externalEdit") {
          response.progress(
            `Prepared ${summary.files} file edit${summary.files === 1 ? "" : "s"} (${summary.additions}+/${summary.deletions}-). Review and accept/reject hunks in chat edit UI.`,
          )
        }

        if (!applied) {
          response.markdown(
            "I prepared edits, but native chat edit review isn't available here. You can still apply the proposed changes with the button below.",
          )
          response.button({
            title: "Apply proposed edits",
            command: APPLY_PROPOSED_EDITS_COMMAND,
            arguments: [result.proposals],
          })
        }
      }

      return {
        metadata: {
          sessionID: result.sessionID,
          proposals: result.proposals.length,
        },
      } satisfies vscode.ChatResult
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OpenCode error"
      response.markdown(`OpenCode request failed: ${message}`)

      return {
        errorDetails: {
          message,
        },
      } satisfies vscode.ChatResult
    }
  })

  participant.iconPath = iconPath

  context.subscriptions.push(participant)

  return [applyDisposable, participant]
}

function isNewSessionCommand(command: string | undefined) {
  return command === "new"
}

function resolveSessionID(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]) {
  const responses = history.filter((turn): turn is vscode.ChatResponseTurn => "result" in turn)
  const latestWithSession = responses.reverse().find((turn) => {
    const sessionID = turn.result.metadata?.["sessionID"]
    return typeof sessionID === "string" && sessionID.length > 0
  })

  const value = latestWithSession?.result.metadata?.["sessionID"]
  return typeof value === "string" ? value : undefined
}

function buildPrompt(request: vscode.ChatRequest) {
  const references = request.references
    .map((reference, index) => formatReference(reference, index + 1))
    .filter((line): line is string => typeof line === "string")

  if (references.length === 0) return request.prompt

  return [request.prompt, "", "Referenced context:", ...references].join("\n")
}

function formatReference(reference: vscode.ChatPromptReference, order: number) {
  const value = reference.value

  if (typeof value === "string") {
    return `${order}. ${value}`
  }

  if (value instanceof vscode.Uri) {
    return `${order}. ${value.toString()}`
  }

  if (isLocation(value)) {
    const line = value.range.start.line + 1
    return `${order}. ${value.uri.toString()}#L${line}`
  }

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
