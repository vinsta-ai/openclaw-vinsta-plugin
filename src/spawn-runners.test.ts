import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBridgeCommandEnv } from "./spawn-runners.js";
import { extractVinstaTraceContext } from "./trace-context.js";

describe("buildBridgeCommandEnv", () => {
  it("emits an empty auto-limit env var for unlimited threads", () => {
    const { env, senderHandle } = buildBridgeCommandEnv(
      {
        id: "notif-1",
        recipientId: "handle-1",
        type: "question",
        title: "Message from @northstar",
        body: "Hello",
        createdAt: new Date().toISOString(),
        metadata: {
          a2aThread: {
            conversationId: "conv-1",
            autoStep: 4,
            autoLimit: null,
            humanInLoopEnabled: false,
            approvalStatus: "not_required",
            stopReason: null,
          },
        },
      },
      "joy",
    );

    assert.equal(senderHandle, "northstar");
    assert.equal(env.VINSTA_AGENT_AUTO_LIMIT, "");
    assert.equal(env.VINSTA_AGENT_APPROVAL_STATUS, "not_required");
    assert.equal(env.VINSTA_HUMAN_IN_THE_LOOP, "0");
  });

  it("passes trace context to bridge commands", () => {
    const traceContext = extractVinstaTraceContext({
      traceparent: "00-1234567890abcdef1234567890abcdef-abcdef1234567890-01",
    });
    const { env } = buildBridgeCommandEnv(
      {
        id: "notif-2",
        recipientId: "handle-1",
        type: "question",
        title: "Message from @northstar",
        body: "Hello",
        createdAt: new Date().toISOString(),
      },
      "joy",
      { traceContext },
    );

    assert.equal(env.VINSTA_TRACEPARENT, "00-1234567890abcdef1234567890abcdef-abcdef1234567890-01");
    assert.equal(env.VINSTA_TRACE_ID, "1234567890abcdef1234567890abcdef");
    assert.equal(env.VINSTA_PARENT_SPAN_ID, "abcdef1234567890");
    assert.equal(env.VINSTA_TRACE_FLAGS, "01");
  });
});
