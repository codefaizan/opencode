"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpencodeClient = void 0;
const node_child_process_1 = require("node:child_process");
const node_net_1 = require("node:net");
const external_edit_1 = require("./external-edit");
const SERVER_BOOT_TIMEOUT_MS = 15_000;
const SERVER_POLL_INTERVAL_MS = 250;
class OpencodeClient {
    output;
    server;
    constructor(output) {
        this.output = output;
    }
    dispose() {
        this.stopServer();
    }
    async runProposePrompt(options) {
        const baseUrl = await this.ensureServer(options.directory);
        const sessionID = options.sessionID ?? (await this.createSession(baseUrl, options.directory)).id;
        const abortController = new AbortController();
        const tokenListener = options.token.onCancellationRequested(() => abortController.abort());
        const streamState = {
            assistantMessageIDs: new Set(),
            toolCallStatus: new Set(),
            textByPartID: new Map(),
            proposalsByPath: new Map(),
            assistantText: "",
        };
        options.onProgress?.("Sending request to OpenCode in propose mode...");
        await this.promptAsync(baseUrl, sessionID, options.prompt, options.directory);
        let done = false;
        try {
            for await (const event of this.globalEvents(baseUrl, abortController.signal)) {
                if (options.token.isCancellationRequested) {
                    abortController.abort();
                    break;
                }
                const eventType = event.payload?.type;
                const properties = toRecord(event.payload?.properties);
                const eventSessionID = sessionIDFromProperties(properties);
                if (!eventType || eventSessionID !== sessionID)
                    continue;
                if (eventType === "session.idle") {
                    done = true;
                    break;
                }
                if (eventType === "session.error") {
                    const message = firstString(properties?.["error"], properties?.["message"]) ?? "Session failed";
                    throw new Error(message);
                }
                if (eventType === "message.updated") {
                    this.captureAssistantMessage(properties, streamState);
                    continue;
                }
                if (eventType === "message.part.updated") {
                    this.captureMessagePart(properties, streamState, options);
                }
            }
        }
        finally {
            abortController.abort();
            tokenListener.dispose();
        }
        if (!done && !options.token.isCancellationRequested) {
            options.onProgress?.("Waiting for final response snapshot...");
        }
        const fallback = await this.fetchLatestAssistantMessage(baseUrl, sessionID, options.directory);
        if (fallback.text.length > streamState.assistantText.length) {
            const delta = fallback.text.slice(streamState.assistantText.length);
            if (delta.length > 0)
                options.onText?.(delta);
            streamState.assistantText = fallback.text;
        }
        fallback.proposals.forEach((file) => {
            streamState.proposalsByPath.set(file.file_path, file);
        });
        return {
            sessionID,
            text: streamState.assistantText,
            proposals: Array.from(streamState.proposalsByPath.values()),
        };
    }
    captureAssistantMessage(properties, state) {
        const info = toRecord(properties?.["info"]);
        if (!info)
            return;
        if (info["role"] !== "assistant")
            return;
        const id = asString(info["id"]);
        if (!id)
            return;
        state.assistantMessageIDs.add(id);
    }
    captureMessagePart(properties, state, options) {
        const part = toRecord(properties?.["part"]);
        if (!part)
            return;
        const messageID = asString(part["messageID"]);
        if (!messageID || !state.assistantMessageIDs.has(messageID))
            return;
        const partType = asString(part["type"]);
        if (!partType)
            return;
        if (partType === "text") {
            const partID = asString(part["id"]);
            const text = asString(part["text"]);
            if (!partID || !text)
                return;
            const previous = state.textByPartID.get(partID) ?? "";
            const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
            state.textByPartID.set(partID, text);
            if (delta.length > 0) {
                state.assistantText += delta;
                options.onText?.(delta);
            }
            return;
        }
        if (partType !== "tool")
            return;
        const tool = asString(part["tool"]);
        const callID = asString(part["callID"]);
        const toolState = toRecord(part["state"]);
        const status = asString(toolState?.["status"]);
        if (tool && callID && status) {
            const statusKey = `${callID}:${status}`;
            if (!state.toolCallStatus.has(statusKey)) {
                options.onProgress?.(`${tool} (${status})`);
                state.toolCallStatus.add(statusKey);
            }
        }
        if (status !== "completed")
            return;
        const stateMetadata = toRecord(toolState?.["metadata"]);
        const partMetadata = toRecord(part["metadata"]);
        const proposal = (0, external_edit_1.readProposalPayload)(stateMetadata?.["proposal"]) ??
            (0, external_edit_1.readProposalPayload)(partMetadata?.["proposal"]) ??
            undefined;
        if (!proposal)
            return;
        proposal.files.forEach((file) => {
            state.proposalsByPath.set(file.file_path, file);
        });
    }
    async fetchLatestAssistantMessage(baseUrl, sessionID, directory) {
        const query = new URLSearchParams();
        query.set("limit", "30");
        if (directory)
            query.set("directory", directory);
        const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/message?${query.toString()}`);
        if (!response.ok) {
            return {
                text: "",
                proposals: [],
            };
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
            return {
                text: "",
                proposals: [],
            };
        }
        const assistants = data.filter((message) => {
            const info = toRecord(toRecord(message)?.["info"]);
            return info?.["role"] === "assistant";
        });
        const latest = assistants.at(-1);
        if (!latest) {
            return {
                text: "",
                proposals: [],
            };
        }
        const parts = toArray(toRecord(latest)?.["parts"]);
        const text = parts
            .filter((part) => toRecord(part)?.["type"] === "text")
            .map((part) => asString(toRecord(part)?.["text"]) ?? "")
            .join("");
        const proposals = parts
            .flatMap((part) => {
            const typedPart = toRecord(part);
            if (!typedPart || typedPart["type"] !== "tool")
                return [];
            const toolState = toRecord(typedPart["state"]);
            if (toolState?.["status"] !== "completed")
                return [];
            const metadata = toRecord(toolState["metadata"]);
            const proposal = (0, external_edit_1.readProposalPayload)(metadata?.["proposal"]);
            if (!proposal)
                return [];
            return proposal.files;
        })
            .reduce((acc, file) => {
            acc.set(file.file_path, file);
            return acc;
        }, new Map());
        return {
            text,
            proposals: Array.from(proposals.values()),
        };
    }
    async createSession(baseUrl, directory) {
        const query = new URLSearchParams();
        if (directory)
            query.set("directory", directory);
        const response = await fetch(`${baseUrl}/session?${query.toString()}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            throw new Error(`Failed to create OpenCode session (${response.status})`);
        }
        const json = await response.json();
        const id = asString(toRecord(json)?.["id"]);
        if (!id)
            throw new Error("OpenCode session response was missing an id");
        return { id };
    }
    async promptAsync(baseUrl, sessionID, prompt, directory) {
        const query = new URLSearchParams();
        if (directory)
            query.set("directory", directory);
        const body = {
            executionMode: "propose",
            parts: [
                {
                    type: "text",
                    text: prompt,
                },
            ],
        };
        const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async?${query.toString()}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        if (response.status === 204)
            return;
        const message = await response.text();
        throw new Error(`Failed to send prompt to OpenCode (${response.status}): ${message}`);
    }
    async ensureServer(directory) {
        if (this.server && this.server.directory === directory) {
            const healthy = await this.isHealthy(this.server.port);
            if (healthy)
                return this.baseUrl(this.server.port);
            this.stopServer();
        }
        const port = await pickAvailablePort();
        const process = (0, node_child_process_1.spawn)("opencode", ["serve", "--port", String(port)], {
            cwd: directory,
            env: {
                ...processEnv(),
                OPENCODE_CALLER: "vscode",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        process.stdout.on("data", (chunk) => {
            this.output.appendLine(chunk.toString("utf8").trimEnd());
        });
        process.stderr.on("data", (chunk) => {
            this.output.appendLine(chunk.toString("utf8").trimEnd());
        });
        this.server = {
            directory,
            port,
            process,
        };
        const started = await this.waitForServer(port, process);
        if (!started) {
            this.stopServer();
            throw new Error("Unable to start OpenCode headless server. Verify `opencode` is installed and available in PATH.");
        }
        this.output.appendLine(`OpenCode server ready on ${this.baseUrl(port)}`);
        return this.baseUrl(port);
    }
    baseUrl(port) {
        return `http://127.0.0.1:${port}`;
    }
    async waitForServer(port, child) {
        const start = Date.now();
        while (Date.now() - start < SERVER_BOOT_TIMEOUT_MS) {
            if (child.exitCode !== null)
                return false;
            const healthy = await this.isHealthy(port);
            if (healthy)
                return true;
            await delay(SERVER_POLL_INTERVAL_MS);
        }
        return false;
    }
    isHealthy(port) {
        return fetch(`${this.baseUrl(port)}/global/health`)
            .then((response) => response.ok)
            .catch(() => false);
    }
    stopServer() {
        if (!this.server)
            return;
        this.server.process.kill();
        this.server = undefined;
    }
    async *globalEvents(baseUrl, signal) {
        const response = await fetch(`${baseUrl}/global/event`, {
            headers: {
                Accept: "text/event-stream",
            },
            signal,
        });
        if (!response.ok) {
            throw new Error(`Failed to subscribe to OpenCode events (${response.status})`);
        }
        if (!response.body) {
            throw new Error("OpenCode event stream is unavailable");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
            const result = await reader.read();
            if (result.done)
                break;
            buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
                const rawEvent = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = rawEvent
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (data.length > 0) {
                    const parsed = safeJsonParse(data);
                    if (parsed) {
                        yield parsed;
                    }
                }
                boundary = buffer.indexOf("\n\n");
            }
        }
    }
}
exports.OpencodeClient = OpencodeClient;
function sessionIDFromProperties(properties) {
    return asString(properties?.["sessionID"]);
}
function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function toRecord(value) {
    if (!value || typeof value !== "object")
        return;
    return value;
}
function toArray(value) {
    if (!Array.isArray(value))
        return [];
    return value;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function firstString(...values) {
    return values.find((value) => typeof value === "string" && value.length > 0);
}
function processEnv() {
    return typeof process !== "undefined" ? process.env : {};
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function pickAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = (0, node_net_1.createServer)();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => reject(new Error("Unable to determine an available localhost port")));
                return;
            }
            const port = address.port;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}
//# sourceMappingURL=opencode-client.js.map