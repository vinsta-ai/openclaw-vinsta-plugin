import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMirroredVinstaHumanNotice,
  resolveOwnerMirrorText,
  maybeSanitizeHumanNotificationForDelivery,
  redactBridgeCommandError,
  readNotificationAutomationState,
  sanitizeHumanNotificationForDelivery,
  shouldSuppressFreshHumanNotificationForBridgeCommand,
  stripVinstaPluginFromNotifyConfig,
} from "./inbound-bridge-helpers.js";

describe("readNotificationAutomationState", () => {
  it("reads a2a thread metadata from notifications", () => {
    const automation = readNotificationAutomationState({
      id: "notif-1",
      recipientId: "handle-1",
      type: "question",
      title: "New message",
      body: "Hello",
      createdAt: new Date().toISOString(),
      metadata: {
        a2aThread: {
          autoStep: 3,
          autoLimit: 6,
          humanInLoopEnabled: true,
          approvalStatus: "pending",
          stopReason: "auto_turn_limit",
        },
      },
    });

    assert.deepEqual(automation, {
      conversationId: null,
      autoStep: 3,
      autoLimit: 6,
      humanInLoopEnabled: true,
      approvalStatus: "pending",
      stopReason: "auto_turn_limit",
    });
  });

  it("preserves null autoLimit as unlimited", () => {
    const automation = readNotificationAutomationState({
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
    });

    assert.deepEqual(automation, {
      conversationId: "conv-1",
      autoStep: 4,
      autoLimit: null,
      humanInLoopEnabled: false,
      approvalStatus: "not_required",
      stopReason: null,
    });
  });
});

describe("stripVinstaPluginFromNotifyConfig", () => {
  it("removes the vinsta plugin entry but preserves other plugin paths", () => {
    const input = {
      plugins: {
        entries: {
          vinsta: { enabled: true },
          telegram: { enabled: true },
        },
        installs: {
          vinsta: {
            installPath: "/tmp/openclaw/extensions/vinsta",
            sourcePath: "/work/vinsta/integrations/openclaw-vinsta-plugin",
          },
          other: {
            installPath: "/tmp/openclaw/extensions/other",
          },
        },
        load: {
          paths: [
            "/tmp/openclaw/extensions/vinsta",
            "/tmp/openclaw/extensions/other",
            "/work/vinsta/integrations/openclaw-vinsta-plugin",
          ],
        },
      },
    };

    const stripped = stripVinstaPluginFromNotifyConfig(input);

    assert.equal(stripped.plugins?.entries?.vinsta, undefined);
    assert.deepEqual(stripped.plugins?.entries?.telegram, { enabled: true });
    assert.equal(stripped.plugins?.installs?.vinsta, undefined);
    assert.ok(stripped.plugins?.installs?.other);
    assert.deepEqual(stripped.plugins?.load?.paths, ["/tmp/openclaw/extensions/other"]);
  });
});

describe("shouldSuppressFreshHumanNotificationForBridgeCommand", () => {
  it("suppresses the initial owner alert for the shipped OpenClaw bridge helper", () => {
    assert.equal(
      shouldSuppressFreshHumanNotificationForBridgeCommand(
        "~/.openclaw/extensions/vinsta/scripts/run-openclaw-bridge.sh",
      ),
      true,
    );
  });

  it("suppresses the initial owner alert for any configured bridge command", () => {
    assert.equal(
      shouldSuppressFreshHumanNotificationForBridgeCommand(
        'pnpm --silent openclaw agent --agent main --message "$PROMPT" --json',
      ),
      true,
    );
    assert.equal(
      shouldSuppressFreshHumanNotificationForBridgeCommand("/usr/local/bin/custom-bridge-handler"),
      true,
    );
  });

  it("does not suppress when no bridge command is set", () => {
    assert.equal(shouldSuppressFreshHumanNotificationForBridgeCommand(null), false);
    assert.equal(shouldSuppressFreshHumanNotificationForBridgeCommand(undefined), false);
    assert.equal(shouldSuppressFreshHumanNotificationForBridgeCommand(""), false);
    assert.equal(shouldSuppressFreshHumanNotificationForBridgeCommand("  "), false);
  });
});

describe("sanitizeHumanNotificationForDelivery", () => {
  it("redacts sensitive owner summaries before they are mirrored out", () => {
    const result = sanitizeHumanNotificationForDelivery({
      body: "JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });

    assert.equal(result.redacted, true);
    assert.match(
      result.notification.body,
      /Sensitive content was withheld from this mirrored Vinsta notice/i,
    );
  });

  it("preserves benign owner summaries", () => {
    const result = sanitizeHumanNotificationForDelivery({
      body: "The runtime finished the sync and archived the thread.",
    });

    assert.equal(result.redacted, false);
    assert.equal(result.notification.body, "The runtime finished the sync and archived the thread.");
  });
});

describe("maybeSanitizeHumanNotificationForDelivery", () => {
  it("passes the original owner summary through when the content guard is disabled", () => {
    const result = maybeSanitizeHumanNotificationForDelivery(
      {
        body: "JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      },
      false,
    );

    assert.equal(result.redacted, false);
    assert.match(result.notification.body, /JWT:/);
  });
});

describe("redactBridgeCommandError", () => {
  it("redacts common secrets and truncates command output", () => {
    const redacted = redactBridgeCommandError(`failed with Bearer token_123 ${"x".repeat(600)}`);

    assert.ok(redacted);
    assert.match(redacted, /\[redacted\]/);
    assert.match(redacted, /\[truncated\]$/);
  });

  it("returns null for empty command output", () => {
    assert.equal(redactBridgeCommandError(""), null);
  });
});

describe("resolveOwnerMirrorText", () => {
  it("keeps the exact inbound personal message instead of a friendlier summary", () => {
    const text = resolveOwnerMirrorText({
      classification: "personal",
      originalBody: "Hahaha, tell Joy I'm honored 😁 Dad jokes are a sacred art.",
      notifyHuman: "Socrates says he's honored 😁 and that dad jokes are a sacred art.",
    });

    assert.equal(text, "Hahaha, tell Joy I'm honored 😁 Dad jokes are a sacred art.");
  });

  it("prefers the exact reply text for actionable owner notices", () => {
    const text = resolveOwnerMirrorText({
      classification: "actionable",
      originalBody: "Can you tell Joy I said hi?",
      reply: "Tell Joy I said hi and that I can help after 6.",
      notifyHuman: "I told Joy you'd help later.",
    });

    assert.equal(text, "Tell Joy I said hi and that I can help after 6.");
  });
});

describe("isMirroredVinstaHumanNotice", () => {
  it("detects the mirrored owner notice prefixes that should stay read-only", () => {
    assert.equal(
      isMirroredVinstaHumanNotice("[Vinsta notice] @socrates: ready when you are."),
      true,
    );
    assert.equal(
      isMirroredVinstaHumanNotice("[Vinsta from @socrates] Hahaha, tell Joy I'm honored."),
      true,
    );
    assert.equal(
      isMirroredVinstaHumanNotice("[Vinsta — review required] The conversation needs approval."),
      true,
    );
    assert.equal(
      isMirroredVinstaHumanNotice("Tell Joy I'm honored."),
      false,
    );
  });
});
