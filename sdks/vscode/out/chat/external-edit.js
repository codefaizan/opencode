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
exports.readProposalPayload = readProposalPayload;
exports.mergeProposalFiles = mergeProposalFiles;
exports.applyProposals = applyProposals;
exports.buildWorkspaceEdit = buildWorkspaceEdit;
exports.summarizeProposalFiles = summarizeProposalFiles;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const capabilities_1 = require("./capabilities");
function readProposalPayload(value) {
    if (!value || typeof value !== "object")
        return;
    const maybePayload = value;
    if (maybePayload.mode !== "propose" || !Array.isArray(maybePayload.files))
        return;
    const files = maybePayload.files.filter((file) => {
        if (!file || typeof file !== "object")
            return false;
        const typed = file;
        if (typed.operation !== "set" && typed.operation !== "delete")
            return false;
        if (typeof typed.file_path !== "string" || typed.file_path.length === 0)
            return false;
        if (typeof typed.uri !== "string" || typed.uri.length === 0)
            return false;
        if (typed.operation === "set" && typeof typed.new_content !== "string")
            return false;
        return true;
    });
    if (files.length === 0)
        return;
    const stats = maybePayload.stats &&
        typeof maybePayload.stats === "object" &&
        typeof maybePayload.stats.files === "number" &&
        typeof maybePayload.stats.additions === "number" &&
        typeof maybePayload.stats.deletions === "number"
        ? maybePayload.stats
        : undefined;
    return {
        mode: "propose",
        files,
        stats,
    };
}
function mergeProposalFiles(files) {
    const byPath = new Map();
    files.forEach((file) => {
        const normalizedPath = normalizePath(file.file_path);
        byPath.set(normalizedPath, {
            ...file,
            file_path: normalizedPath,
        });
    });
    return Array.from(byPath.values());
}
async function applyProposals(response, files) {
    if (files.length === 0)
        return;
    const merged = mergeProposalFiles(files);
    const externalEdit = (0, capabilities_1.getExternalEditHandler)(response);
    if (!externalEdit)
        return;
    const edit = await buildWorkspaceEdit(merged);
    await externalEdit(edit);
    return {
        method: "externalEdit",
        files: merged.length,
    };
}
async function buildWorkspaceEdit(files) {
    const edit = new vscode.WorkspaceEdit();
    for (const file of files) {
        const uri = toUri(file);
        if (file.operation === "delete") {
            edit.deleteFile(uri, {
                ignoreIfNotExists: true,
            });
            continue;
        }
        const exists = await fileExists(uri);
        const newContent = file.new_content ?? "";
        if (!exists) {
            edit.createFile(uri, {
                ignoreIfExists: true,
            });
            edit.insert(uri, new vscode.Position(0, 0), newContent);
            continue;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
        edit.replace(uri, fullRange, newContent);
    }
    return edit;
}
function summarizeProposalFiles(files) {
    return {
        files: files.length,
        additions: files.reduce((count, file) => count + (file.additions ?? 0), 0),
        deletions: files.reduce((count, file) => count + (file.deletions ?? 0), 0),
    };
}
function toUri(file) {
    if (file.uri.startsWith("file://"))
        return vscode.Uri.parse(file.uri);
    return vscode.Uri.file(file.file_path);
}
function fileExists(uri) {
    return vscode.workspace.fs.stat(uri).then(() => true, () => false);
}
function normalizePath(filePath) {
    return path.normalize(filePath);
}
//# sourceMappingURL=external-edit.js.map