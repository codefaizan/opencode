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
exports.OPENCODE_ASSUME_EXTERNAL_REVIEW_WHEN_MODE_UNKNOWN_SETTING = exports.OPENCODE_PROPOSE_APPLY_STRATEGY_SETTING = exports.OPENCODE_EXECUTION_MODE_SETTING = exports.OPENCODE_CHAT_MODEL_SETTING = exports.APPLY_PROPOSED_EDITS_COMMAND = exports.CHAT_PARTICIPANT_ID = void 0;
exports.registerOpencodeChatParticipant = registerOpencodeChatParticipant;
const vscode = __importStar(require("vscode"));
const capabilities_1 = require("./capabilities");
const external_edit_1 = require("./external-edit");
exports.CHAT_PARTICIPANT_ID = "opencode.chat";
exports.APPLY_PROPOSED_EDITS_COMMAND = "opencode.applyProposedEdits";
exports.OPENCODE_CHAT_MODEL_SETTING = "chatModel";
exports.OPENCODE_EXECUTION_MODE_SETTING = "executionMode";
exports.OPENCODE_PROPOSE_APPLY_STRATEGY_SETTING = "proposeApplyStrategy";
exports.OPENCODE_ASSUME_EXTERNAL_REVIEW_WHEN_MODE_UNKNOWN_SETTING = "assumeExternalReviewWhenModeUnknown";
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
        const merged = (0, external_edit_1.mergeProposalFiles)(payload.files);
        const effective = await (0, external_edit_1.resolveEffectiveProposalFiles)(merged);
        if (effective.applicable.length === 0) {
            void vscode.window.showInformationMessage(`OpenCode detected no effective file changes to apply${effective.skipped.length > 0 ? ` (${effective.skipped.length} no-op proposal${effective.skipped.length === 1 ? "" : "s"} skipped)` : ""}.`);
            return;
        }
        const edit = await (0, external_edit_1.buildWorkspaceEdit)(effective.applicable);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            void vscode.window.showWarningMessage("OpenCode could not apply the proposed workspace edits.");
            return;
        }
        void vscode.window.showInformationMessage(`OpenCode applied ${effective.applicable.length} proposed file edit${effective.applicable.length === 1 ? "" : "s"}${effective.skipped.length > 0 ? ` (${effective.skipped.length} no-op proposal${effective.skipped.length === 1 ? "" : "s"} skipped)` : ""}.`);
    });
    if (!(0, capabilities_1.supportsChatParticipantApi)()) {
        return [applyDisposable];
    }
    const participant = vscode.chat.createChatParticipant(exports.CHAT_PARTICIPANT_ID, async (request, chatContext, response, token) => {
        const prompt = buildPrompt(request);
        const directory = resolveWorkspaceDirectory();
        const sessionContext = isNewSessionCommand(request.command)
            ? undefined
            : resolveSessionContext(chatContext.history);
        const model = resolveConfiguredModel() ?? resolveSelectedModel(request.model);
        const executionMode = resolveExecutionModeSetting();
        const chatMode = resolveChatModeInfo(request);
        const assumeExternalReviewWhenModeUnknown = resolveAssumeExternalReviewWhenModeUnknownSetting(context);
        console.log("stream keys:", Object.keys(response));
        const externalEdit = response.externalEdit;
        if (typeof externalEdit !== "function") {
            console.error("❌ externalEdit NOT available");
        }
        else {
            console.log("✅ externalEdit available");
            console.log("externalEdit arity:", externalEdit.length);
        }
        console.log("chat mode:", {
            name: chatMode.name ?? "unknown",
            isBuiltin: chatMode.isBuiltin ?? "unknown",
            location: chatMode.location ?? "unknown",
            supportsExternalReview: chatMode.supportsExternalReview,
            assumeExternalReviewWhenModeUnknown,
        });
        if (!chatMode.name) {
            const rawRequest = request;
            console.log("request keys:", Object.keys(rawRequest));
            console.log("mode hints:", {
                mode: previewValue(rawRequest["mode"]),
                modeInstructions: previewValue(rawRequest["modeInstructions"]),
                modeInstructions2: previewValue(rawRequest["modeInstructions2"]),
                location: previewValue(rawRequest["location"]),
                location2: previewValue(rawRequest["location2"]),
            });
        }
        response.progress("Connecting to OpenCode...");
        try {
            const result = await client.runProposePrompt({
                directory,
                prompt,
                sessionID: sessionContext?.sessionID,
                anchorAssistantMessageID: sessionContext?.assistantMessageID,
                model,
                executionMode,
                token,
                onProgress: (message) => response.progress(message),
                onText: (chunk) => response.markdown(chunk),
            });
            if (result.text.trim().length === 0) {
                response.markdown("_No assistant text was returned._");
            }
            if (result.proposals.length > 0) {
                const mergedProposals = (0, external_edit_1.mergeProposalFiles)(result.proposals);
                console.log("proposal preview:", result.proposals.slice(0, 3).map((proposal) => ({
                    operation: proposal.operation,
                    file_path: proposal.file_path,
                    uri: proposal.uri,
                    new_content_length: proposal.new_content?.length ?? 0,
                    additions: proposal.additions,
                    deletions: proposal.deletions,
                })));
                const summary = (0, external_edit_1.summarizeProposalFiles)(mergedProposals);
                const wantsNativeReview = executionMode === "propose" && resolveProposeApplyStrategySetting() === "nativeReview";
                const shouldUseNativeReview = wantsNativeReview &&
                    (chatMode.supportsExternalReview || (assumeExternalReviewWhenModeUnknown && !chatMode.name));
                if (!shouldUseNativeReview) {
                    const fallbackReason = wantsNativeReview && !chatMode.supportsExternalReview
                        ? !chatMode.name
                            ? `Native review requires an editing-capable chat mode (for example, **Edit**), but this VS Code request did not include mode metadata${chatMode.location ? ` (location: **${chatMode.location}**)` : ""}. Falling back to explicit apply. If you intentionally want a best-effort native-review attempt in unknown mode, set **opencode.assumeExternalReviewWhenModeUnknown** to **true**.`
                            : "Native review is only available in an editing-capable chat mode (for example, **Edit**). Falling back to explicit apply."
                        : undefined;
                    if (fallbackReason) {
                        response.markdown(fallbackReason);
                    }
                    response.markdown(`I prepared ${summary.files} proposed file edit${summary.files === 1 ? "" : "s"} (${summary.additions}+/${summary.deletions}-). Apply them explicitly with the button below.`);
                    response.button({
                        title: "Apply proposed edits",
                        command: exports.APPLY_PROPOSED_EDITS_COMMAND,
                        arguments: [result.proposals],
                    });
                }
                if (shouldUseNativeReview) {
                    try {
                        response.progress((0, capabilities_1.externalEditCapabilityMessage)(response));
                        const applied = await (0, external_edit_1.applyProposals)(response, result.proposals);
                        if (applied?.method === "externalEdit") {
                            if (applied.files === 0) {
                                response.progress(`No effective file content changes were detected in the latest proposal${applied.skipped > 0 ? ` (${applied.skipped} no-op file proposal${applied.skipped === 1 ? "" : "s"} skipped)` : ""}.`);
                            }
                            else {
                                response.progress(`Prepared ${applied.files} file edit${applied.files === 1 ? "" : "s"} for chat review${applied.skipped > 0 ? ` (${applied.skipped} no-op file proposal${applied.skipped === 1 ? "" : "s"} skipped)` : ""}. Review and accept/reject hunks in chat edit UI.`);
                            }
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
                    catch (error) {
                        const message = error instanceof Error ? error.message : "Unknown external edit error";
                        console.error("native external edit attach failed:", message);
                        response.markdown(`I prepared ${summary.files} proposed file edit${summary.files === 1 ? "" : "s"}, but attaching them to native chat edit review failed: ${message}`);
                        response.button({
                            title: "Apply proposed edits",
                            command: exports.APPLY_PROPOSED_EDITS_COMMAND,
                            arguments: [result.proposals],
                        });
                    }
                }
            }
            return {
                metadata: {
                    sessionID: result.sessionID,
                    assistantMessageID: result.assistantMessageID,
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
function resolveSessionContext(history) {
    const responses = history.filter((turn) => "result" in turn);
    const latestWithSession = responses.reverse().find((turn) => {
        const sessionID = turn.result.metadata?.["sessionID"];
        return typeof sessionID === "string" && sessionID.length > 0;
    });
    const sessionID = latestWithSession?.result.metadata?.["sessionID"];
    if (typeof sessionID !== "string" || sessionID.length === 0)
        return;
    const assistantMessageID = latestWithSession?.result.metadata?.["assistantMessageID"];
    return {
        sessionID,
        assistantMessageID: typeof assistantMessageID === "string" && assistantMessageID.length > 0 ? assistantMessageID : undefined,
    };
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
function resolveSelectedModel(model) {
    if (!model)
        return;
    const raw = model;
    const vendor = asNonEmptyString(raw["vendor"]);
    const family = asNonEmptyString(raw["family"]);
    if (vendor && family) {
        return {
            providerID: vendor,
            modelID: family,
        };
    }
    const id = asNonEmptyString(raw["id"]);
    if (!id)
        return;
    const split = id.split("/");
    if (split.length < 2)
        return;
    const providerID = asNonEmptyString(split[0]);
    const modelID = asNonEmptyString(split.slice(1).join("/"));
    if (!providerID || !modelID)
        return;
    return {
        providerID,
        modelID,
    };
}
function resolveConfiguredModel() {
    const value = vscode.workspace.getConfiguration("opencode").get(exports.OPENCODE_CHAT_MODEL_SETTING);
    if (!value)
        return;
    const split = value.trim().split("/");
    if (split.length < 2)
        return;
    const providerID = asNonEmptyString(split[0]);
    const modelID = asNonEmptyString(split.slice(1).join("/"));
    if (!providerID || !modelID)
        return;
    return {
        providerID,
        modelID,
    };
}
function resolveExecutionModeSetting() {
    const mode = vscode.workspace.getConfiguration("opencode").get(exports.OPENCODE_EXECUTION_MODE_SETTING);
    if (mode === "direct")
        return "direct";
    return "propose";
}
function resolveProposeApplyStrategySetting() {
    const strategy = vscode.workspace.getConfiguration("opencode").get(exports.OPENCODE_PROPOSE_APPLY_STRATEGY_SETTING);
    if (strategy === "manualApply")
        return "manualApply";
    return "nativeReview";
}
function resolveAssumeExternalReviewWhenModeUnknownSetting(context) {
    const config = vscode.workspace.getConfiguration("opencode");
    const inspection = config.inspect(exports.OPENCODE_ASSUME_EXTERNAL_REVIEW_WHEN_MODE_UNKNOWN_SETTING);
    const isExplicitlyConfigured = inspection?.globalValue !== undefined ||
        inspection?.workspaceValue !== undefined ||
        inspection?.workspaceFolderValue !== undefined;
    if (isExplicitlyConfigured) {
        return config.get(exports.OPENCODE_ASSUME_EXTERNAL_REVIEW_WHEN_MODE_UNKNOWN_SETTING) === true;
    }
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        return true;
    }
    return false;
}
function resolveChatModeInfo(request) {
    const raw = request;
    const modeInstructions2 = asRecord(raw.modeInstructions2);
    const modeNameObject = asRecord(modeInstructions2?.["name"]);
    const modeObject = asRecord(raw.mode);
    const name = asNonEmptyString(modeInstructions2?.["name"]) ??
        asNonEmptyString(modeNameObject?.["name"]) ??
        asNonEmptyString(modeNameObject?.["value"]) ??
        asNonEmptyString(raw.mode) ??
        asNonEmptyString(modeObject?.["name"]) ??
        extractModeKeyword(raw.modeInstructions) ??
        extractModeKeyword(modeInstructions2?.["content"]) ??
        extractModeKeyword(raw.location2) ??
        extractModeKeyword(raw.location);
    const normalized = name?.toLowerCase();
    const metadata = asRecord(modeInstructions2?.["metadata"]);
    const location = resolveChatLocationName(raw.location2) ?? resolveChatLocationName(raw.location);
    const metadataSaysEditing = isTruthyMetadataFlag(metadata?.["supportsEditing"]) ||
        isTruthyMetadataFlag(metadata?.["supportsEdits"]) ||
        isTruthyMetadataFlag(metadata?.["editing"]) ||
        isTruthyMetadataFlag(metadata?.["chatEditing"]) ||
        isTruthyMetadataFlag(metadata?.["supportsExternalReview"]) ||
        isTruthyMetadataFlag(metadata?.["chatExternalReview"]) ||
        isTruthyMetadataFlag(metadata?.["chatReview"]) ||
        isTruthyMetadataFlag(metadata?.["isEditing"]);
    const nameSuggestsEditing = normalized?.includes("edit") === true ||
        normalized?.includes("chat-editing") === true ||
        normalized?.includes("editing") === true;
    const locationSuggestsEditing = location === "editor";
    const editedFileEventsSuggestEditing = Array.isArray(raw.editedFileEvents) && raw.editedFileEvents.length > 0;
    const isBuiltinFlag = modeInstructions2?.["isBuiltin"];
    const isBuiltin = isBuiltinFlag === true
        ? true
        : isBuiltinFlag === false
            ? false
            : normalized === "edit" || normalized === "ask" || normalized === "agent"
                ? true
                : undefined;
    return {
        name,
        isBuiltin,
        location,
        supportsExternalReview: metadataSaysEditing ||
            nameSuggestsEditing ||
            locationSuggestsEditing ||
            editedFileEventsSuggestEditing,
    };
}
function resolveChatLocationName(value) {
    if (typeof value === "number") {
        if (value === 1)
            return "panel";
        if (value === 2)
            return "terminal";
        if (value === 3)
            return "notebook";
        if (value === 4)
            return "editor";
        return;
    }
    const text = asNonEmptyString(value)?.toLowerCase();
    if (!text)
        return;
    if (text === "panel" || text === "terminal" || text === "notebook" || text === "editor")
        return text;
}
function asNonEmptyString(value) {
    if (typeof value !== "string")
        return;
    const trimmed = value.trim();
    if (!trimmed)
        return;
    return trimmed;
}
function asRecord(value) {
    if (!value || typeof value !== "object")
        return;
    return value;
}
function extractModeKeyword(value) {
    const record = asRecord(value);
    const nestedValue = asRecord(record?.["value"]);
    const text = asNonEmptyString(value) ??
        asNonEmptyString(record?.["name"]) ??
        asNonEmptyString(record?.["mode"]) ??
        asNonEmptyString(record?.["id"]) ??
        asNonEmptyString(record?.["kind"]) ??
        asNonEmptyString(record?.["title"]) ??
        asNonEmptyString(record?.["description"]) ??
        asNonEmptyString(record?.["content"]) ??
        asNonEmptyString(record?.["value"]) ??
        asNonEmptyString(nestedValue?.["name"]);
    if (!text)
        return;
    if (/\b(edit|editing|chat-editing|chat editing|edits?)\b/i.test(text))
        return "edit";
    if (/\bagent\b/i.test(text))
        return "agent";
    if (/\bask\b/i.test(text))
        return "ask";
}
function isTruthyMetadataFlag(value) {
    if (value === true)
        return true;
    if (typeof value !== "string")
        return false;
    return /^(true|1|yes|on)$/i.test(value.trim());
}
function previewValue(value) {
    if (value === undefined || value === null)
        return value;
    if (typeof value === "string")
        return value.slice(0, 180);
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return { type: "array", length: value.length };
    const record = asRecord(value);
    if (!record)
        return typeof value;
    return {
        type: "object",
        keys: Object.keys(record).slice(0, 12),
        name: asNonEmptyString(record["name"]),
        mode: asNonEmptyString(record["mode"]),
        id: asNonEmptyString(record["id"]),
        kind: asNonEmptyString(record["kind"]),
        content: asNonEmptyString(record["content"])?.slice(0, 120),
    };
}
//# sourceMappingURL=participant.js.map