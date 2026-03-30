import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBridgeCommandEnv } from "./spawn-runners.js";

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
});
