"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPLY_PROPOSED_EDITS_COMMAND = exports.CHAT_PARTICIPANT_ID = void 0;
exports.registerOpencodeChatParticipant = registerOpencodeChatParticipant;
const vscode = __importStar(require("vscode"));
const capabilities_1 = require("./capabilities");
const external_edit_1 = require("./external-edit");
exports.CHAT_PARTICIPANT_ID = "opencode.chat";
exports.APPLY_PROPOSED_EDITS_COMMAND = "opencode.applyProposedEdits";
function registerOpencodeChatParticipant({ context, client, iconPath }) {
    const applyDisposable = vscode.commands.registerCommand(exports.APPLY_PROPOSED_EDITS_COMMAND, async (files) => {
        const payload = (0, external_edit_1.readProposalPayload)({
            mode: "propose",
            files: Array.isArray(files) ? files : [],
        });
        if (!payload || payload.files.length === 0) {
            void vscode.window.showWarningMessage("OpenCode did not receive valid proposed edits to apply.");
            return;
        }
        const edit = await (0, external_edit_1.buildWorkspaceEdit)(payload.files);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            void vscode.window.showWarningMessage("OpenCode could not apply the proposed workspace edits.");
            return;
        }
        void vscode.window.showInformationMessage(`OpenCode applied ${payload.files.length} proposed file edit${payload.files.length === 1 ? "" : "s"}.`);
    });
    if (!(0, capabilities_1.supportsChatParticipantApi)()) {
        return [applyDisposable];
    }
    const participant = vscode.chat.createChatParticipant(exports.CHAT_PARTICIPANT_ID, async (request, chatContext, response, token) => {
        const prompt = buildPrompt(request);
        const directory = resolveWorkspaceDirectory();
        const sessionID = isNewSessionCommand(request.command) ? undefined : resolveSessionID(chatContext.history);
        response.progress("Connecting to OpenCode...");
        try {
            const result = await client.runProposePrompt({
                directory,
                prompt,
                sessionID,
                token,
                onProgress: (message) => response.progress(message),
                onText: (chunk) => response.markdown(chunk),
            });
            if (result.text.trim().length === 0) {
                response.markdown("_No assistant text was returned._");
            }
            if (result.proposals.length > 0) {
                response.progress((0, capabilities_1.externalEditCapabilityMessage)(response));
                const applied = await (0, external_edit_1.applyProposals)(response, result.proposals);
                const summary = (0, external_edit_1.summarizeProposalFiles)(result.proposals);
                if (applied?.method === "externalEdit") {
                    response.progress(`Prepared ${summary.files} file edit${summary.files === 1 ? "" : "s"} (${summary.additions}+/${summary.deletions}-). Review and accept/reject hunks in chat edit UI.`);
                }
                if (!applied) {
                    response.markdown("I prepared edits, but native chat edit review isn't available here. You can still apply the proposed changes with the button below.");
                    response.button({
                        title: "Apply proposed edits",
                        command: exports.APPLY_PROPOSED_EDITS_COMMAND,
                        arguments: [result.proposals],
                    });
                }
            }
            return {
                metadata: {
                    sessionID: result.sessionID,
                    proposals: result.proposals.length,
                },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown OpenCode error";
            response.markdown(`OpenCode request failed: ${message}`);
            return {
                errorDetails: {
                    message,
                },
            };
        }
    });
    participant.iconPath = iconPath;
    context.subscriptions.push(participant);
    return [applyDisposable, participant];
}
function isNewSessionCommand(command) {
    return command === "new";
}
function resolveSessionID(history) {
    const responses = history.filter((turn) => "result" in turn);
    const latestWithSession = responses.reverse().find((turn) => {
        const sessionID = turn.result.metadata?.["sessionID"];
        return typeof sessionID === "string" && sessionID.length > 0;
    });
    const value = latestWithSession?.result.metadata?.["sessionID"];
    return typeof value === "string" ? value : undefined;
}
function buildPrompt(request) {
    const references = request.references
        .map((reference, index) => formatReference(reference, index + 1))
        .filter((line) => typeof line === "string");
    if (references.length === 0)
        return request.prompt;
    return [request.prompt, "", "Referenced context:", ...references].join("\n");
}
function formatReference(reference, order) {
    const value = reference.value;
    if (typeof value === "string") {
        return `${order}. ${value}`;
    }
    if (value instanceof vscode.Uri) {
        return `${order}. ${value.toString()}`;
    }
    if (isLocation(value)) {
        const line = value.range.start.line + 1;
        return `${order}. ${value.uri.toString()}#L${line}`;
    }
    return;
}
function isLocation(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return candidate.uri instanceof vscode.Uri && candidate.range instanceof vscode.Range;
}
function resolveWorkspaceDirectory() {
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
        if (activeFolder)
            return activeFolder.uri.fsPath;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
//# sourceMappingURL=participant.js.map