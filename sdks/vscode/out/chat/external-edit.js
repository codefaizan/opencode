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
exports.resolveEffectiveProposalFiles = resolveEffectiveProposalFiles;
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
    const effective = await resolveEffectiveProposalFiles(merged);
    console.log("proposal effective summary:", {
        proposed: merged.length,
        applicable: effective.applicable.length,
        skipped: effective.skipped.length,
    });
    if (effective.applicable.length === 0) {
        return {
            method: "externalEdit",
            files: 0,
            skipped: effective.skipped.length,
        };
    }
    const edit = await buildWorkspaceEdit(effective.applicable);
    const targets = proposalTargets(effective.applicable);
    console.log("proposal target uris:", targets.map((target) => target.toString()));
    if (externalEdit.length >= 2) {
        for (const file of effective.applicable) {
            await externalEdit(toUri(file), async () => {
                await applyProposalToFileSystem(file);
            });
        }
    }
    else {
        await externalEdit(edit);
    }
    return {
        method: "externalEdit",
        files: effective.applicable.length,
        skipped: effective.skipped.length,
    };
}
async function resolveEffectiveProposalFiles(files) {
    const applicable = [];
    const skipped = [];
    for (const file of files) {
        const uri = toUri(file);
        const exists = await fileExists(uri);
        if (file.operation === "delete") {
            if (!exists) {
                skipped.push(file);
                continue;
            }
            applicable.push(file);
            continue;
        }
        const newContent = file.new_content ?? "";
        if (!exists) {
            applicable.push({
                ...file,
                new_content: newContent,
            });
            continue;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.getText() === newContent) {
            skipped.push(file);
            continue;
        }
        applicable.push({
            ...file,
            new_content: newContent,
        });
    }
    return {
        applicable,
        skipped,
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
        applyMinimalReplaceEdit(edit, uri, document, newContent);
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
    const fromPath = resolveUriFromFilePath(file.file_path);
    if (fromPath)
        return fromPath;
    if (file.uri.startsWith("file://")) {
        const parsed = vscode.Uri.parse(file.uri);
        if (parsed.scheme === "file" && parsed.fsPath.length > 0)
            return parsed;
    }
    return vscode.Uri.file(file.file_path);
}
function proposalTargets(files) {
    const unique = new Map();
    files.forEach((file) => {
        const uri = toUri(file);
        unique.set(uri.toString(), uri);
    });
    return Array.from(unique.values());
}
async function applyProposalToFileSystem(file) {
    const uri = toUri(file);
    if (file.operation === "delete") {
        await vscode.workspace.fs.delete(uri, {
            recursive: false,
            useTrash: false,
        });
        return;
    }
    const newContent = file.new_content ?? "";
    const edit = new vscode.WorkspaceEdit();
    const exists = await fileExists(uri);
    if (!exists) {
        const directory = vscode.Uri.file(path.dirname(uri.fsPath));
        await vscode.workspace.fs.createDirectory(directory);
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), newContent);
    }
    else {
        const document = await vscode.workspace.openTextDocument(uri);
        applyMinimalReplaceEdit(edit, uri, document, newContent);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error(`OpenCode could not apply proposed changes to ${uri.fsPath}.`);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const saved = await document.save();
    if (!saved) {
        throw new Error(`OpenCode could not save proposed changes to ${uri.fsPath}.`);
    }
}
function applyMinimalReplaceEdit(edit, uri, document, newContent) {
    const current = document.getText();
    if (current === newContent)
        return;
    const currentLength = current.length;
    const newLength = newContent.length;
    let prefixLength = 0;
    const sharedPrefixLimit = Math.min(currentLength, newLength);
    while (prefixLength < sharedPrefixLimit && current.charCodeAt(prefixLength) === newContent.charCodeAt(prefixLength)) {
        prefixLength += 1;
    }
    let suffixLength = 0;
    const sharedSuffixLimit = Math.min(currentLength - prefixLength, newLength - prefixLength);
    while (suffixLength < sharedSuffixLimit &&
        current.charCodeAt(currentLength - 1 - suffixLength) === newContent.charCodeAt(newLength - 1 - suffixLength)) {
        suffixLength += 1;
    }
    const currentStartOffset = prefixLength;
    const currentEndOffset = currentLength - suffixLength;
    const replacement = newContent.slice(prefixLength, newLength - suffixLength);
    const range = new vscode.Range(document.positionAt(currentStartOffset), document.positionAt(currentEndOffset));
    edit.replace(uri, range, replacement);
}
function fileExists(uri) {
    return vscode.workspace.fs.stat(uri).then(() => true, () => false);
}
function normalizePath(filePath) {
    return path.normalize(filePath);
}
function resolveUriFromFilePath(filePath) {
    if (path.isAbsolute(filePath))
        return vscode.Uri.file(filePath);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return;
    return vscode.Uri.file(path.join(folder.uri.fsPath, filePath));
}
//# sourceMappingURL=external-edit.js.map