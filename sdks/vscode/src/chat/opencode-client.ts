import { spawn } from "node:child_process"
import { createServer } from "node:net"
import * as vscode from "vscode"
import { readProposalPayload, type ProposalFile } from "./external-edit"

type SessionInfo = {
  id: string
}

type PromptPartInput = {
  type: "text"
  text: string
}

type PromptAsyncBody = {
  parts: PromptPartInput[]
  executionMode: "propose"
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
  proposalsByPath: Map<string, ProposalFile>
  assistantText: string
}

type ServerState = {
  directory?: string
  port: number
  process: ReturnType<typeof spawn>
}

const SERVER_BOOT_TIMEOUT_MS = 15_000
const SERVER_POLL_INTERVAL_MS = 250

export type ProposePromptOptions = {
  directory?: string
  prompt: string
  sessionID?: string
  token: vscode.CancellationToken
  onProgress?: (message: string) => void
  onText?: (chunk: string) => void
}

export type ProposePromptResult = {
  sessionID: string
  text: string
  proposals: ProposalFile[]
}

export class OpencodeClient implements vscode.Disposable {
  private server?: ServerState

  constructor(private readonly output: vscode.OutputChannel) {}

  dispose() {
    this.stopServer()
  }

  async runProposePrompt(options: ProposePromptOptions): Promise<ProposePromptResult> {
    const baseUrl = await this.ensureServer(options.directory)
    const sessionID = options.sessionID ?? (await this.createSession(baseUrl, options.directory)).id

    const abortController = new AbortController()
    const tokenListener = options.token.onCancellationRequested(() => abortController.abort())

    const streamState: StreamState = {
      assistantMessageIDs: new Set<string>(),
      toolCallStatus: new Set<string>(),
      textByPartID: new Map<string, string>(),
      proposalsByPath: new Map<string, ProposalFile>(),
      assistantText: "",
    }

    options.onProgress?.("Sending request to OpenCode in propose mode...")
    await this.promptAsync(baseUrl, sessionID, options.prompt, options.directory)

    let done = false

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

        if (eventType === "session.idle") {
          done = true
          break
        }

        if (eventType === "session.error") {
          const message = firstString(properties?.["error"], properties?.["message"]) ?? "Session failed"
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

    fallback.proposals.forEach((file) => {
      streamState.proposalsByPath.set(file.file_path, file)
    })

    return {
      sessionID,
      text: streamState.assistantText,
      proposals: Array.from(streamState.proposalsByPath.values()),
    }
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
    options: ProposePromptOptions,
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

    const stateMetadata = toRecord(toolState?.["metadata"])
    const partMetadata = toRecord(part["metadata"])

    const proposal =
      readProposalPayload(stateMetadata?.["proposal"]) ??
      readProposalPayload(partMetadata?.["proposal"]) ??
      undefined

    if (!proposal) return

    proposal.files.forEach((file) => {
      state.proposalsByPath.set(file.file_path, file)
    })
  }

  private async fetchLatestAssistantMessage(baseUrl: string, sessionID: string, directory?: string) {
    const query = new URLSearchParams()
    query.set("limit", "30")
    if (directory) query.set("directory", directory)

    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/message?${query.toString()}`)
    if (!response.ok) {
      return {
        text: "",
        proposals: [] as ProposalFile[],
      }
    }

    const data = await response.json()
    if (!Array.isArray(data)) {
      return {
        text: "",
        proposals: [] as ProposalFile[],
      }
    }

    const assistants = data.filter((message) => {
      const info = toRecord(toRecord(message)?.["info"])
      return info?.["role"] === "assistant"
    })

    const latest = assistants.at(-1)
    if (!latest) {
      return {
        text: "",
        proposals: [] as ProposalFile[],
      }
    }

    const parts = toArray(toRecord(latest)?.["parts"])

    const text = parts
      .filter((part) => toRecord(part)?.["type"] === "text")
      .map((part) => asString(toRecord(part)?.["text"]) ?? "")
      .join("")

    const proposals = parts
      .flatMap((part) => {
        const typedPart = toRecord(part)
        if (!typedPart || typedPart["type"] !== "tool") return []

        const toolState = toRecord(typedPart["state"])
        if (toolState?.["status"] !== "completed") return []

        const metadata = toRecord(toolState["metadata"])
        const proposal = readProposalPayload(metadata?.["proposal"])
        if (!proposal) return []

        return proposal.files
      })
      .reduce((acc, file) => {
        acc.set(file.file_path, file)
        return acc
      }, new Map<string, ProposalFile>())

    return {
      text,
      proposals: Array.from(proposals.values()),
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

  private async promptAsync(baseUrl: string, sessionID: string, prompt: string, directory?: string) {
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)

    const body: PromptAsyncBody = {
      executionMode: "propose",
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

    const message = await response.text()
    throw new Error(`Failed to send prompt to OpenCode (${response.status}): ${message}`)
  }

  private async ensureServer(directory?: string) {
    if (this.server && this.server.directory === directory) {
      const healthy = await this.isHealthy(this.server.port)
      if (healthy) return this.baseUrl(this.server.port)
      this.stopServer()
    }

    const port = await pickAvailablePort()
    const process = spawn("opencode", ["serve", "--port", String(port)], {
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
      throw new Error("Unable to start OpenCode headless server. Verify `opencode` is installed and available in PATH.")
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
