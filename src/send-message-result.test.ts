import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSendMessageResult } from "./send-message-result.js";

describe("normalizeSendMessageResult", () => {
  it("flattens the exact reply and conversation ids from the A2A result", () => {
    const result = normalizeSendMessageResult({
      jsonrpc: "2.0",
      id: "1",
      result: {
        accepted: true,
        delivered: true,
        state: "completed",
        recipient: "jane",
        taskId: "notif-1",
        reply: "I speak without a mouth. What am I? An echo.",
        senderConversationId: "conv-sender",
        recipientConversationId: "conv-recipient",
      },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.replyExact, "I speak without a mouth. What am I? An echo.");
    assert.equal(result.senderConversationId, "conv-sender");
    assert.equal(result.recipientConversationId, "conv-recipient");
  });

  it("preserves JSON-RPC errors without pretending the message succeeded", () => {
    const result = normalizeSendMessageResult({
      jsonrpc: "2.0",
      id: "1",
      error: {
        code: 403,
        message: "Permission denied",
      },
    });

    assert.equal(result.accepted, undefined);
    assert.deepEqual(result.error, {
      code: 403,
      message: "Permission denied",
    });
  });
});
