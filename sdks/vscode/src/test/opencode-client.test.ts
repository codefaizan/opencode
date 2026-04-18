import * as assert from "node:assert"
import { shouldRevertSessionForSync } from "../chat/opencode-client"

suite("opencode-client", () => {
  test("does not revert without session", () => {
    assert.equal(
      shouldRevertSessionForSync({
        sessionID: undefined,
        anchorAssistantMessageID: "assistant-anchor",
        latestAssistantMessageID: "assistant-latest",
      }),
      false,
    )
  })

  test("does not revert when anchor is missing", () => {
    assert.equal(
      shouldRevertSessionForSync({
        sessionID: "session-1",
        anchorAssistantMessageID: undefined,
        latestAssistantMessageID: "assistant-latest",
      }),
      false,
    )
  })

  test("does not revert when latest assistant is missing", () => {
    assert.equal(
      shouldRevertSessionForSync({
        sessionID: "session-1",
        anchorAssistantMessageID: "assistant-anchor",
        latestAssistantMessageID: undefined,
      }),
      false,
    )
  })

  test("does not revert when anchor matches latest", () => {
    assert.equal(
      shouldRevertSessionForSync({
        sessionID: "session-1",
        anchorAssistantMessageID: "assistant-42",
        latestAssistantMessageID: "assistant-42",
      }),
      false,
    )
  })

  test("reverts when anchor differs from latest", () => {
    assert.equal(
      shouldRevertSessionForSync({
        sessionID: "session-1",
        anchorAssistantMessageID: "assistant-5",
        latestAssistantMessageID: "assistant-9",
      }),
      true,
    )
  })
})
