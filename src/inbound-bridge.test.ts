import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maybeSanitizeHumanNotificationForDelivery,
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
