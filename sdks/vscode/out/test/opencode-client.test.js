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
const opencode_client_1 = require("../chat/opencode-client");
suite("opencode-client", () => {
    test("does not revert without session", () => {
        assert.equal((0, opencode_client_1.shouldRevertSessionForSync)({
            sessionID: undefined,
            anchorAssistantMessageID: "assistant-anchor",
            latestAssistantMessageID: "assistant-latest",
        }), false);
    });
    test("does not revert when anchor is missing", () => {
        assert.equal((0, opencode_client_1.shouldRevertSessionForSync)({
            sessionID: "session-1",
            anchorAssistantMessageID: undefined,
            latestAssistantMessageID: "assistant-latest",
        }), false);
    });
    test("does not revert when latest assistant is missing", () => {
        assert.equal((0, opencode_client_1.shouldRevertSessionForSync)({
            sessionID: "session-1",
            anchorAssistantMessageID: "assistant-anchor",
            latestAssistantMessageID: undefined,
        }), false);
    });
    test("does not revert when anchor matches latest", () => {
        assert.equal((0, opencode_client_1.shouldRevertSessionForSync)({
            sessionID: "session-1",
            anchorAssistantMessageID: "assistant-42",
            latestAssistantMessageID: "assistant-42",
        }), false);
    });
    test("reverts when anchor differs from latest", () => {
        assert.equal((0, opencode_client_1.shouldRevertSessionForSync)({
            sessionID: "session-1",
            anchorAssistantMessageID: "assistant-5",
            latestAssistantMessageID: "assistant-9",
        }), true);
    });
});
//# sourceMappingURL=opencode-client.test.js.map