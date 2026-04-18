import * as vscode from "vscode"
import { OpencodeClient } from "./chat/opencode-client"
import { OPENCODE_CHAT_MODEL_SETTING, registerOpencodeChatParticipant } from "./chat/participant"

const TERMINAL_NAME = "opencode"
const SELECT_MODEL_COMMAND = "opencode.selectChatModel"
const OPENCODE_BINARY_PATH_SETTING = "binaryPath"

export function activate(context: vscode.ExtensionContext) {
  const iconPath = {
    light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
    dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
  }

  const chatOutput = vscode.window.createOutputChannel("opencode chat")
  const chatClient = new OpencodeClient(chatOutput)

  context.subscriptions.push(chatOutput, chatClient, ...registerOpencodeChatParticipant({
    context,
    client: chatClient,
    iconPath,
  }))

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal()
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    // An opencode terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  let addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    const terminal = vscode.window.activeTerminal
    if (!terminal) {
      return
    }

    if (terminal.name === TERMINAL_NAME) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
      terminal.show()
    }
  })

  const selectModelDisposable = vscode.commands.registerCommand(SELECT_MODEL_COMMAND, async () => {
    const directory = resolveWorkspaceDirectory()
    const result = await chatClient
      .listModels(directory)
      .then((models) => ({ models }))
      .catch((error) => ({ error }))

    if ("error" in result) {
      void vscode.window.showErrorMessage(errorMessage(result.error))
      return
    }

    if (result.models.length === 0) {
      void vscode.window.showWarningMessage("OpenCode returned no models. Verify your provider setup and try again.")
      return
    }

    const configuredModel = configuredChatModel()
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "Use VS Code model picker",
          detail: "Clear OpenCode model override",
          model: undefined,
        },
        ...result.models.map((model) => ({
          label: model,
          detail: model === configuredModel ? "Currently selected" : undefined,
          model,
        })),
      ],
      {
        title: "Select OpenCode Chat Model",
        placeHolder: "Choose a model from `opencode models`",
      },
    )

    if (!pick) return

    await vscode.workspace
      .getConfiguration("opencode")
      .update(OPENCODE_CHAT_MODEL_SETTING, pick.model, settingsTarget())

    const message = pick.model
      ? `OpenCode chat model set to ${pick.model}`
      : "OpenCode chat model override cleared. VS Code picker model will be used."
    void vscode.window.showInformationMessage(message)
  })

  context.subscriptions.push(openNewTerminalDisposable, openTerminalDisposable, addFilepathDisposable, selectModelDisposable)

  async function openTerminal() {
    // Create a new terminal in split screen
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath,
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
      },
    })

    terminal.show()
    const opencodeCommand = resolveOpencodeCommand()
    terminal.sendText(`${quoteForShell(opencodeCommand)} --port ${port}`)

    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    // Wait for the terminal to be ready
    let tries = 10
    let connected = false
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`http://localhost:${port}/app`)
        connected = true
        break
      } catch {}

      tries--
    } while (tries > 0)

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    })
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }

  function configuredChatModel() {
    const model = vscode.workspace.getConfiguration("opencode").get<string>(OPENCODE_CHAT_MODEL_SETTING)
    if (!model) return
    return model.trim() || undefined
  }

  function settingsTarget() {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      return vscode.ConfigurationTarget.Workspace
    }

    return vscode.ConfigurationTarget.Global
  }

  function resolveWorkspaceDirectory() {
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri
    if (activeEditorUri) {
      const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri)
      if (activeFolder) return activeFolder.uri.fsPath
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  function resolveOpencodeCommand() {
    const configured = vscode.workspace.getConfiguration("opencode").get<string>(OPENCODE_BINARY_PATH_SETTING)
    if (!configured) return "opencode"

    const trimmed = configured.trim()
    return trimmed.length > 0 ? trimmed : "opencode"
  }

  function quoteForShell(command: string) {
    if (/^[A-Za-z0-9_./\\:-]+$/.test(command)) return command
    return `"${command.replace(/"/g, '\\"')}"`
  }

  function errorMessage(error: unknown) {
    if (error instanceof Error && error.message.length > 0) return error.message
    return "Failed to load OpenCode models"
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}
