import { spawn } from "node:child_process"
import { createServer } from "node:net"
import * as vscode from "vscode"

type SessionInfo = {
  id: string
}

type PromptPartInput = {
  type: "text"
  text: string
}

type PromptAsyncBody = {
  parts: PromptPartInput[]
  model?: {
    providerID: string
    modelID: string
  }
}

type GlobalEvent = {
  payload?: {
    type?: string
    properties?: Record<string, unknown>
  }
}

type StreamState = {
  assistantMessageIDs: Set<string>
  toolCallStatus: Set<string>
  textByPartID: Map<string, string>
  assistantText: string
}

type ServerState = {
  directory?: string
  port: number
  process: ReturnType<typeof spawn>
}

const SERVER_BOOT_TIMEOUT_MS = 15_000
const SERVER_POLL_INTERVAL_MS = 250
const OPENCODE_BINARY_PATH_SETTING = "binaryPath"

export type PromptOptions = {
  directory?: string
  prompt: string
  sessionID?: string
  anchorAssistantMessageID?: string
  model?: {
    providerID: string
    modelID: string
  }
  token: vscode.CancellationToken
  onProgress?: (message: string) => void
  onText?: (chunk: string) => void
  onPermissionAsk?: (request: PermissionRequest, actions: PermissionActions) => Promise<void> | void
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

export type PermissionActions = {
  approve: (mode?: "once" | "always") => Promise<void>
  reject: (message?: string) => Promise<void>
}

export type EditFile = {
  operation: "set" | "delete"
  file_path: string
  uri: string
  new_content?: string
  additions?: number
  deletions?: number
}

export type PromptResult = {
  sessionID: string
  assistantMessageID?: string
  text: string
  metadata: {
    files?: EditFile[]
  }
}

export function shouldRevertSessionForSync(options: {
  sessionID?: string
  anchorAssistantMessageID?: string
  latestAssistantMessageID?: string
}) {
  if (!options.sessionID) return false
  if (!options.anchorAssistantMessageID) return false
  if (!options.latestAssistantMessageID) return false
  return options.anchorAssistantMessageID !== options.latestAssistantMessageID
}

export class OpencodeClient implements vscode.Disposable {
  private server?: ServerState
  private readonly configSubscription: vscode.Disposable

  constructor(private readonly output: vscode.OutputChannel) {
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`opencode.${OPENCODE_BINARY_PATH_SETTING}`)) return
      this.stopServer()
    })
  }

  dispose() {
    this.configSubscription.dispose()
    this.stopServer()
  }

  async runPrompt(options: PromptOptions): Promise<PromptResult> {
    const baseUrl = await this.ensureServer(options.directory)
    const sessionID = options.sessionID
      ? await this.resolveSynchronizedSession({
          baseUrl,
          directory: options.directory,
          sessionID: options.sessionID,
          anchorAssistantMessageID: options.anchorAssistantMessageID,
          onProgress: options.onProgress,
        })
      : (await this.createSession(baseUrl, options.directory)).id

    const abortController = new AbortController()
    const tokenListener = options.token.onCancellationRequested(() => abortController.abort())

    const streamState: StreamState = {
      assistantMessageIDs: new Set<string>(),
      toolCallStatus: new Set<string>(),
      textByPartID: new Map<string, string>(),
      assistantText: "",
    }

    options.onProgress?.(`Sending request to OpenCode${formatModelSuffix(options.model)}...`)
    await this.promptAsync(
      baseUrl,
      sessionID,
      options.prompt,
      options.directory,
      options.model,
    )

    let done = false
    const handledPermissionRequests = new Set<string>()

    try {
      for await (const event of this.globalEvents(baseUrl, abortController.signal)) {
        if (options.token.isCancellationRequested) {
          abortController.abort()
          break
        }

        const eventType = event.payload?.type
        const properties = toRecord(event.payload?.properties)
        const eventSessionID = sessionIDFromProperties(properties)

        if (!eventType || eventSessionID !== sessionID) continue

        if (eventType === "permission.asked") {
          const request = permissionRequestFromProperties(properties)
          if (!request || handledPermissionRequests.has(request.id)) continue
          handledPermissionRequests.add(request.id)

          const actions: PermissionActions = {
            approve: (mode = "once") => this.replyPermission(baseUrl, request.id, mode, options.directory),
            reject: (message) => this.replyPermission(baseUrl, request.id, "reject", options.directory, message),
          }

          if (options.onPermissionAsk) {
            await options.onPermissionAsk(request, actions)
            continue
          }

          await actions.approve("once")
          continue
        }

        if (eventType === "session.idle") {
          done = true
          break
        }

        if (eventType === "session.error") {
          const message = extractSessionErrorMessage(properties) ?? "Session failed"
          throw new Error(message)
        }

        if (eventType === "message.updated") {
          this.captureAssistantMessage(properties, streamState)
          continue
        }

        if (eventType === "message.part.updated") {
          this.captureMessagePart(properties, streamState, options)
        }
      }
    } finally {
      abortController.abort()
      tokenListener.dispose()
    }

    if (!done && !options.token.isCancellationRequested) {
      options.onProgress?.("Waiting for final response snapshot...")
    }

    const fallback = await this.fetchLatestAssistantMessage(baseUrl, sessionID, options.directory)
    if (fallback.text.length > streamState.assistantText.length) {
      const delta = fallback.text.slice(streamState.assistantText.length)
      if (delta.length > 0) options.onText?.(delta)
      streamState.assistantText = fallback.text
    }

    return {
      sessionID,
      assistantMessageID: fallback.assistantMessageID,
      text: streamState.assistantText,
      metadata: {
        files: fallback.files,
      },
    }
  }

  private async resolveSynchronizedSession(input: {
    baseUrl: string
    directory?: string
    sessionID: string
    anchorAssistantMessageID?: string
    onProgress?: (message: string) => void
  }) {
    if (!input.anchorAssistantMessageID) return input.sessionID

    const latest = await this.fetchLatestAssistantMessage(input.baseUrl, input.sessionID, input.directory)
    if (
      !shouldRevertSessionForSync({
        sessionID: input.sessionID,
        anchorAssistantMessageID: input.anchorAssistantMessageID,
        latestAssistantMessageID: latest.assistantMessageID,
      })
    ) {
      return input.sessionID
    }

    input.onProgress?.("Detected resend from an earlier turn; syncing by reverting the current session timeline...")
    await this.revertSession(input.baseUrl, input.sessionID, input.anchorAssistantMessageID, input.directory)
    return input.sessionID
  }

  async listModels(directory?: string) {
    const output = await execOpencodeCommand(["models"], directory)
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line): line is string => line.length > 0)
      .filter((line, index, all) => all.indexOf(line) === index)
  }

  private captureAssistantMessage(properties: Record<string, unknown> | undefined, state: StreamState) {
    const info = toRecord(properties?.["info"])
    if (!info) return
    if (info["role"] !== "assistant") return

    const id = asString(info["id"])
    if (!id) return

    state.assistantMessageIDs.add(id)
  }

  private captureMessagePart(
    properties: Record<string, unknown> | undefined,
    state: StreamState,
    options: PromptOptions,
  ) {
    const part = toRecord(properties?.["part"])
    if (!part) return

    const messageID = asString(part["messageID"])
    if (!messageID || !state.assistantMessageIDs.has(messageID)) return

    const partType = asString(part["type"])
    if (!partType) return

    if (partType === "text") {
      const partID = asString(part["id"])
      const text = asString(part["text"])
      if (!partID || !text) return

      const previous = state.textByPartID.get(partID) ?? ""
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text

      state.textByPartID.set(partID, text)

      if (delta.length > 0) {
        state.assistantText += delta
        options.onText?.(delta)
      }

      return
    }

    if (partType !== "tool") return

    const tool = asString(part["tool"])
    const callID = asString(part["callID"])
    const toolState = toRecord(part["state"])

    const status = asString(toolState?.["status"])
    if (tool && callID && status) {
      const statusKey = `${callID}:${status}`
      if (!state.toolCallStatus.has(statusKey)) {
        options.onProgress?.(`${tool} (${status})`)
        state.toolCallStatus.add(statusKey)
      }
    }

    if (status !== "completed") return
  }

  private async fetchLatestAssistantMessage(baseUrl: string, sessionID: string, directory?: string) {
    const query = new URLSearchParams()
    query.set("limit", "30")
    if (directory) query.set("directory", directory)

    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/message?${query.toString()}`)
    if (!response.ok) {
      return {
        assistantMessageID: undefined,
        text: "",
        files: [] as EditFile[],
      }
    }

    const data = await response.json()
    if (!Array.isArray(data)) {
      return {
        assistantMessageID: undefined,
        text: "",
        files: [] as EditFile[],
      }
    }

    const assistants = data.filter((message) => {
      const info = toRecord(toRecord(message)?.["info"])
      return info?.["role"] === "assistant"
    })

    const latest = assistants.at(-1)
    if (!latest) {
      return {
        assistantMessageID: undefined,
        text: "",
        files: [] as EditFile[],
      }
    }

    const parts = toArray(toRecord(latest)?.["parts"])
    const assistantMessageID = asString(toRecord(toRecord(latest)?.["info"])?.["id"])

    const text = parts
      .filter((part) => toRecord(part)?.["type"] === "text")
      .map((part) => asString(toRecord(part)?.["text"]) ?? "")
      .join("")

    const editedFiles: EditFile[] = []

    for (const part of parts) {
      const typedPart = toRecord(part)
      if (!typedPart || typedPart["type"] !== "tool") continue

      const toolState = toRecord(typedPart["state"])
      if (toolState?.["status"] !== "completed") continue

      const metadata = toRecord(toolState["metadata"])
      const edited = metadata?.["editedFiles"]
      if (Array.isArray(edited)) {
        for (const file of edited) {
          const f = file as Record<string, unknown>
          if (typeof f["filePath"] === "string") {
            editedFiles.push({
              operation: "set",
              file_path: f["filePath"] as string,
              uri: f["filePath"] as string,
              new_content: typeof f["newContent"] === "string" ? (f["newContent"] as string) : undefined,
              additions: typeof f["additions"] === "number" ? f["additions"] : undefined,
              deletions: typeof f["deletions"] === "number" ? f["deletions"] : undefined,
            })
          }
        }
      }
    }

    return {
      assistantMessageID,
      text,
      files: editedFiles,
    }
  }

  private async revertSession(baseUrl: string, sessionID: string, messageID: string, directory?: string) {
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)

    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/revert?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageID }),
    })

    if (!response.ok) {
      throw new Error(`Failed to revert OpenCode session (${response.status})`)
    }
  }

  private async replyPermission(
    baseUrl: string,
    requestID: string,
    reply: "once" | "always" | "reject",
    directory?: string,
    message?: string,
  ) {
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)

    const response = await fetch(`${baseUrl}/permission/${encodeURIComponent(requestID)}/reply?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
    })

    if (!response.ok) {
      throw new Error(`Failed to reply to permission request (${response.status})`)
    }
  }

  private async createSession(baseUrl: string, directory?: string): Promise<SessionInfo> {
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)

    const response = await fetch(`${baseUrl}/session?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      throw new Error(`Failed to create OpenCode session (${response.status})`)
    }

    const json = await response.json()
    const id = asString(toRecord(json)?.["id"])

    if (!id) throw new Error("OpenCode session response was missing an id")

    return { id }
  }

  private async promptAsync(
    baseUrl: string,
    sessionID: string,
    prompt: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
  ) {
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)

    const body: PromptAsyncBody = {
      model,
      parts: [
        {
          type: "text",
          text: prompt,
        },
      ],
    }

    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (response.status === 204) return

    const raw = await response.text()
    const details = parseErrorMessage(raw)
    throw new Error(`Failed to send prompt to OpenCode (${response.status}): ${details}`)
  }

  private async ensureServer(directory?: string) {
    if (this.server && this.server.directory === directory) {
      const healthy = await this.isHealthy(this.server.port)
      if (healthy) return this.baseUrl(this.server.port)
      this.stopServer()
    }

    const port = await pickAvailablePort()
    const process = spawn(resolveOpencodeCommand(), ["serve", "--port", String(port)], {
      cwd: directory,
      env: {
        ...processEnv(),
        OPENCODE_CALLER: "vscode",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    process.stdout.on("data", (chunk: Buffer) => {
      this.output.appendLine(chunk.toString("utf8").trimEnd())
    })

    process.stderr.on("data", (chunk: Buffer) => {
      this.output.appendLine(chunk.toString("utf8").trimEnd())
    })

    this.server = {
      directory,
      port,
      process,
    }

    const started = await this.waitForServer(port, process)
    if (!started) {
      this.stopServer()
      throw new Error("Unable to start OpenCode headless server. Verify OpenCode is installed and configure `opencode.binaryPath` if needed.")
    }

    this.output.appendLine(`OpenCode server ready on ${this.baseUrl(port)}`)
    return this.baseUrl(port)
  }

  private baseUrl(port: number) {
    return `http://127.0.0.1:${port}`
  }

  private async waitForServer(port: number, child: ReturnType<typeof spawn>) {
    const start = Date.now()

    while (Date.now() - start < SERVER_BOOT_TIMEOUT_MS) {
      if (child.exitCode !== null) return false

      const healthy = await this.isHealthy(port)
      if (healthy) return true

      await delay(SERVER_POLL_INTERVAL_MS)
    }

    return false
  }

  private isHealthy(port: number) {
    return fetch(`${this.baseUrl(port)}/global/health`)
      .then((response) => response.ok)
      .catch(() => false)
  }

  private stopServer() {
    if (!this.server) return

    this.server.process.kill()
    this.server = undefined
  }

  private async *globalEvents(baseUrl: string, signal: AbortSignal): AsyncGenerator<GlobalEvent> {
    const response = await fetch(`${baseUrl}/global/event`, {
      headers: {
        Accept: "text/event-stream",
      },
      signal,
    })

    if (!response.ok) {
      throw new Error(`Failed to subscribe to OpenCode events (${response.status})`)
    }

    if (!response.body) {
      throw new Error("OpenCode event stream is unavailable")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder("utf-8")

    let buffer = ""

    while (true) {
      const result = await reader.read()
      if (result.done) break

      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n")

      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")

        if (data.length > 0) {
          const parsed = safeJsonParse(data)
          if (parsed) {
            yield parsed as GlobalEvent
          }
        }

        boundary = buffer.indexOf("\n\n")
      }
    }
  }
}

function sessionIDFromProperties(properties: Record<string, unknown> | undefined) {
  return asString(properties?.["sessionID"])
}

function permissionRequestFromProperties(properties: Record<string, unknown> | undefined): PermissionRequest | undefined {
  if (!properties) return

  const id = asString(properties["id"])
  const sessionID = asString(properties["sessionID"])
  const permission = asString(properties["permission"])
  if (!id || !sessionID || !permission) return

  const patterns = toArray(properties["patterns"]).flatMap((item) => (typeof item === "string" ? [item] : []))
  const always = toArray(properties["always"]).flatMap((item) => (typeof item === "string" ? [item] : []))
  const metadata = toRecord(properties["metadata"]) ?? {}

  return {
    id,
    sessionID,
    permission,
    patterns,
    always,
    metadata,
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function toRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

function toArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function formatModelSuffix(model: { providerID: string; modelID: string } | undefined) {
  if (!model) return ""
  return ` with ${model.providerID}/${model.modelID}`
}

function parseErrorMessage(raw: string) {
  if (!raw) return "Unknown error"

  const parsed = safeJsonParse(raw)
  if (!parsed) return raw

  return (
    extractSessionErrorMessage(toRecord(parsed)) ??
    firstString(toRecord(parsed)?.["error"], toRecord(parsed)?.["message"]) ??
    raw
  )
}

function extractSessionErrorMessage(properties: Record<string, unknown> | undefined) {
  const direct = firstString(properties?.["message"])
  if (direct) return direct

  const error = properties?.["error"]
  if (typeof error === "string") return error

  const errorRecord = toRecord(error)
  if (!errorRecord) return

  const nested = toRecord(errorRecord["error"])
  const message =
    firstString(
      errorRecord["message"],
      errorRecord["code"],
      nested?.["message"],
      nested?.["code"],
      nested?.["type"],
    ) ?? undefined

  return message
}

function processEnv() {
  return typeof process !== "undefined" ? process.env : {}
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to determine an available localhost port")))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

function execOpencodeCommand(args: string[], directory?: string) {
  return new Promise<string>((resolve, reject) => {
    const command = resolveOpencodeCommand()
    const process = spawn(command, args, {
      cwd: directory,
      env: {
        ...processEnv(),
        OPENCODE_CALLER: "vscode",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    process.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })

    process.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    process.on("error", reject)

    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      const details = stderr.trim() || stdout.trim() || `exit code ${String(code)}`
      reject(new Error(`Failed to run \`${command} ${args.join(" ")}\`: ${details}`))
    })
  })
}

function resolveOpencodeCommand() {
  const configured = vscode.workspace.getConfiguration("opencode").get<string>(OPENCODE_BINARY_PATH_SETTING)
  if (!configured) return "opencode"

  const trimmed = configured.trim()
  return trimmed.length > 0 ? trimmed : "opencode"
}
