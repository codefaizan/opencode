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
    });
});
//# sourceMappingURL=external-edit.test.js.map