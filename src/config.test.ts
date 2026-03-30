import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBridgeNotifyTargets, resolveVinstaPluginConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginManifestPath = path.resolve(__dirname, "../openclaw.plugin.json");

describe("Vinsta bridge notify targets", () => {
  it("parses repeated notify target specs", () => {
    assert.deepStrictEqual(
      parseBridgeNotifyTargets(
        "channel=telegram,to=123456789;channel=whatsapp,to=+15555550123,accountId=work",
      ),
      [
        {
          channel: "telegram",
          to: "123456789",
          accountId: undefined,
        },
        {
          channel: "whatsapp",
          to: "+15555550123",
          accountId: "work",
        },
      ],
    );
  });

  it("reads notify targets from resolved config input", () => {
    const resolved = resolveVinstaPluginConfig({
      bridgeNotifyTargets: [
        {
          channel: "Telegram",
          to: "123456789",
        },
        {
          channel: "whatsapp",
          to: "+15555550123",
          accountId: "default",
        },
      ],
    });

    assert.deepStrictEqual(resolved.bridgeNotifyTargets, [
      {
        channel: "telegram",
        to: "123456789",
        accountId: undefined,
      },
      {
        channel: "whatsapp",
        to: "+15555550123",
        accountId: "default",
      },
    ]);
  });
});

describe("Vinsta content guard config", () => {
  it("reads custom content guard patterns from env strings", () => {
    const resolved = resolveVinstaPluginConfig(
      {},
      {
        VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_INBOUND_PATTERNS: "launch\\s*codes;seed\\s*phrase",
        VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_OUTBOUND_PATTERNS: "[\"AKIA[0-9A-Z]{16}\",\"BEGIN PRIVATE KEY\"]",
      },
    );

    assert.deepStrictEqual(resolved.bridgeContentGuardCustomInboundPatterns, [
      "launch\\s*codes",
      "seed\\s*phrase",
    ]);
    assert.deepStrictEqual(resolved.bridgeContentGuardCustomOutboundPatterns, [
      "AKIA[0-9A-Z]{16}",
      "BEGIN PRIVATE KEY",
    ]);
  });

  it("preserves single regex patterns that start with [ when env parsing falls back from JSON", () => {
    const resolved = resolveVinstaPluginConfig(
      {},
      {
        VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_INBOUND_PATTERNS: "[A-Z]{20}",
        VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_OUTBOUND_PATTERNS: "[0-9]{4}-[0-9]{4}",
      },
    );

    assert.deepStrictEqual(resolved.bridgeContentGuardCustomInboundPatterns, ["[A-Z]{20}"]);
    assert.deepStrictEqual(resolved.bridgeContentGuardCustomOutboundPatterns, [
      "[0-9]{4}-[0-9]{4}",
    ]);
  });
});

describe("Vinsta plugin manifest schema", () => {
  it("declares the persisted bridge and notify config fields", () => {
    const manifest = JSON.parse(readFileSync(pluginManifestPath, "utf8")) as {
      configSchema?: { properties?: Record<string, unknown> };
    };
    const properties = manifest.configSchema?.properties ?? {};

    for (const key of [
      "bridgeReplyPolicy",
      "lastNotifyChannel",
      "lastNotifyTarget",
      "lastNotifyAccountId",
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, key),
        `Expected openclaw.plugin.json to declare ${key}.`,
      );
    }
  });
});
