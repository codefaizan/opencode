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
const assert = __importStar(require("node:assert"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const vscode = __importStar(require("vscode"));
const external_edit_1 = require("../chat/external-edit");
suite("external-edit", () => {
    test("readProposalPayload accepts valid propose payload", () => {
        const payload = (0, external_edit_1.readProposalPayload)({
            mode: "propose",
            files: [
                {
                    operation: "set",
                    file_path: "/tmp/example.ts",
                    uri: "file:///tmp/example.ts",
                    new_content: "export const ok = true\n",
                    additions: 1,
                    deletions: 0,
                },
            ],
            stats: {
                files: 1,
                additions: 1,
                deletions: 0,
            },
        });
        assert.ok(payload);
        assert.equal(payload?.mode, "propose");
        assert.equal(payload?.files.length, 1);
        assert.equal(payload?.files[0].operation, "set");
        assert.equal(payload?.files[0].new_content, "export const ok = true\n");
    });
    test("readProposalPayload rejects malformed entries", () => {
        const payload = (0, external_edit_1.readProposalPayload)({
            mode: "propose",
            files: [
                {
                    operation: "set",
                    file_path: "/tmp/example.ts",
                    uri: "file:///tmp/example.ts",
                },
            ],
        });
        assert.equal(payload, undefined);
    });
    test("mergeProposalFiles keeps last file operation for same path", () => {
        const files = [
            {
                operation: "set",
                file_path: "/tmp/feature.ts",
                uri: "file:///tmp/feature.ts",
                new_content: "first",
            },
            {
                operation: "set",
                file_path: "/tmp/feature.ts",
                uri: "file:///tmp/feature.ts",
                new_content: "second",
            },
        ];
        const merged = (0, external_edit_1.mergeProposalFiles)(files);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].new_content, "second");
    });
    test("summarizeProposalFiles aggregates stats", () => {
        const summary = (0, external_edit_1.summarizeProposalFiles)([
            {
                operation: "set",
                file_path: "/tmp/a.ts",
                uri: "file:///tmp/a.ts",
                new_content: "a",
                additions: 5,
                deletions: 1,
            },
            {
                operation: "delete",
                file_path: "/tmp/b.ts",
                uri: "file:///tmp/b.ts",
                additions: 0,
                deletions: 3,
            },
        ]);
        assert.deepEqual(summary, {
            files: 2,
            additions: 5,
            deletions: 4,
        });
    });
    test("applyProposals is no-op without externalEdit support", async () => {
        const result = await (0, external_edit_1.applyProposals)({}, [
            {
                operation: "set",
                file_path: "/tmp/never-used.ts",
                uri: "file:///tmp/never-used.ts",
                new_content: "unused",
            },
        ]);
        assert.equal(result, undefined);
    });
    test("applyProposals calls externalEdit when available", async () => {
        let called = false;
        const response = {
            externalEdit: (edit) => {
                called = true;
                assert.ok(edit);
            },
        };
        const result = await (0, external_edit_1.applyProposals)(response, [
            {
                operation: "set",
                file_path: "/tmp/external-edit.ts",
                uri: "file:///tmp/external-edit.ts",
                new_content: "export const external = true\n",
            },
        ]);
        assert.ok(called);
        assert.equal(result?.method, "externalEdit");
        assert.equal(result?.files, 1);
        assert.equal(result?.skipped, 0);
    });
    test("resolveEffectiveProposalFiles skips unchanged set proposals", async () => {
        const filePath = path.join(os.tmpdir(), `opencode-noop-${(0, node_crypto_1.randomUUID)()}.md`);
        await (0, promises_1.writeFile)(filePath, "hello world\n", "utf8");
        const result = await (0, external_edit_1.resolveEffectiveProposalFiles)([
            {
                operation: "set",
                file_path: filePath,
                uri: vscode.Uri.file(filePath).toString(),
                new_content: "hello world\n",
            },
        ]);
        assert.equal(result.applicable.length, 0);
        assert.equal(result.skipped.length, 1);
        await (0, promises_1.rm)(filePath, { force: true });
    });
    test("applyProposals does not call externalEdit for no-op proposals", async () => {
        const filePath = path.join(os.tmpdir(), `opencode-noop-apply-${(0, node_crypto_1.randomUUID)()}.md`);
        await (0, promises_1.writeFile)(filePath, "same\n", "utf8");
        let called = false;
        const response = {
            externalEdit: (_edit) => {
                called = true;
            },
        };
        const result = await (0, external_edit_1.applyProposals)(response, [
            {
                operation: "set",
                file_path: filePath,
                uri: vscode.Uri.file(filePath).toString(),
                new_content: "same\n",
            },
        ]);
        assert.equal(called, false);
        assert.equal(result?.method, "externalEdit");
        assert.equal(result?.files, 0);
        assert.equal(result?.skipped, 1);
        await (0, promises_1.rm)(filePath, { force: true });
    });
    test("applyProposals writes changes in arity-2 externalEdit callback", async () => {
        const filePath = path.join(os.tmpdir(), `opencode-external-arity2-${(0, node_crypto_1.randomUUID)()}.md`);
        await (0, promises_1.writeFile)(filePath, "before\n", "utf8");
        let called = false;
        const response = {
            externalEdit: async (_target, callback) => {
                called = true;
                await callback();
                return "undo-stop-id";
            },
        };
        const result = await (0, external_edit_1.applyProposals)(response, [
            {
                operation: "set",
                file_path: filePath,
                uri: vscode.Uri.file(filePath).toString(),
                new_content: "after\n",
            },
        ]);
        const content = await (0, promises_1.readFile)(filePath, "utf8");
        assert.equal(called, true);
        assert.equal(content, "after\n");
        assert.equal(result?.method, "externalEdit");
        assert.equal(result?.files, 1);
        assert.equal(result?.skipped, 0);
        await (0, promises_1.rm)(filePath, { force: true });
    });
    test("applyProposals calls arity-2 externalEdit once per file", async () => {
        const firstPath = path.join(os.tmpdir(), `opencode-external-multi-1-${(0, node_crypto_1.randomUUID)()}.md`);
        const secondPath = path.join(os.tmpdir(), `opencode-external-multi-2-${(0, node_crypto_1.randomUUID)()}.md`);
        await (0, promises_1.writeFile)(firstPath, "one-before\n", "utf8");
        await (0, promises_1.writeFile)(secondPath, "two-before\n", "utf8");
        const targets = [];
        const response = {
            externalEdit: async (target, callback) => {
                if (Array.isArray(target)) {
                    targets.push(...target.map((item) => item.toString()));
                }
                else {
                    targets.push(target.toString());
                }
                await callback();
                return "undo-stop-id";
            },
        };
        const result = await (0, external_edit_1.applyProposals)(response, [
            {
                operation: "set",
                file_path: firstPath,
                uri: vscode.Uri.file(firstPath).toString(),
                new_content: "one-after\n",
            },
            {
                operation: "set",
                file_path: secondPath,
                uri: vscode.Uri.file(secondPath).toString(),
                new_content: "two-after\n",
            },
        ]);
        const firstContent = await (0, promises_1.readFile)(firstPath, "utf8");
        const secondContent = await (0, promises_1.readFile)(secondPath, "utf8");
        assert.deepEqual(targets.sort(), [vscode.Uri.file(firstPath).toString(), vscode.Uri.file(secondPath).toString()].sort());
        assert.equal(firstContent, "one-after\n");
        assert.equal(secondContent, "two-after\n");
        assert.equal(result?.method, "externalEdit");
        assert.equal(result?.files, 2);
        assert.equal(result?.skipped, 0);
        await (0, promises_1.rm)(firstPath, { force: true });
        await (0, promises_1.rm)(secondPath, { force: true });
    });
});
//# sourceMappingURL=external-edit.test.js.map