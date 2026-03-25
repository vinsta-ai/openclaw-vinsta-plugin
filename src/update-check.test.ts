import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import {
  parseCalendarVersion,
  isNewerVersion,
  formatUpdateNotice,
  checkForUpdate,
  _resetForTesting,
} from "./update-check.js";

describe("parseCalendarVersion", () => {
  it("parses a full calendar version", () => {
    assert.deepStrictEqual(parseCalendarVersion("2026.3.24-2"), {
      year: 2026,
      month: 3,
      day: 24,
      patch: 2,
    });
  });

  it("parses version without patch", () => {
    assert.deepStrictEqual(parseCalendarVersion("2026.3.24"), {
      year: 2026,
      month: 3,
      day: 24,
      patch: 0,
    });
  });

  it("strips leading v", () => {
    assert.deepStrictEqual(parseCalendarVersion("v2026.3.25-1"), {
      year: 2026,
      month: 3,
      day: 25,
      patch: 1,
    });
  });

  it("returns null for invalid strings", () => {
    assert.strictEqual(parseCalendarVersion("not-a-version"), null);
    assert.strictEqual(parseCalendarVersion("1.2.3"), null);
    assert.strictEqual(parseCalendarVersion(""), null);
  });
});

describe("isNewerVersion", () => {
  it("detects newer year", () => {
    assert.strictEqual(isNewerVersion("2027.1.1", "2026.12.31-9"), true);
  });

  it("detects newer month", () => {
    assert.strictEqual(isNewerVersion("2026.4.1", "2026.3.31-9"), true);
  });

  it("detects newer day", () => {
    assert.strictEqual(isNewerVersion("2026.3.25", "2026.3.24-2"), true);
  });

  it("detects newer patch", () => {
    assert.strictEqual(isNewerVersion("2026.3.24-3", "2026.3.24-2"), true);
  });

  it("returns false for same version", () => {
    assert.strictEqual(isNewerVersion("2026.3.24-2", "2026.3.24-2"), false);
  });

  it("returns false for older version", () => {
    assert.strictEqual(isNewerVersion("2026.3.23", "2026.3.24-2"), false);
  });

  it("returns false for unparseable versions", () => {
    assert.strictEqual(isNewerVersion("bad", "2026.3.24-2"), false);
    assert.strictEqual(isNewerVersion("2026.3.25", "bad"), false);
  });
});

describe("formatUpdateNotice", () => {
  it("formats a human-readable notice", () => {
    assert.strictEqual(
      formatUpdateNotice("2026.3.25-1", "2026.3.24-2"),
      "@openclaw/vinsta v2026.3.25-1 is available (you have v2026.3.24-2).",
    );
  });
});

describe("checkForUpdate", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    _resetForTesting();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null on fetch failure", async () => {
    globalThis.fetch = () => Promise.reject(new Error("network"));
    const result = await checkForUpdate({ force: true });
    assert.strictEqual(result, null);
  });

  it("returns null on non-ok response", async () => {
    globalThis.fetch = () =>
      Promise.resolve({ ok: false, json: async () => ({}) } as Response);
    const result = await checkForUpdate({ force: true });
    assert.strictEqual(result, null);
  });

  it("detects available update", async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ tag_name: "v2099.1.1-1" }),
      } as Response);
    const result = await checkForUpdate({ force: true });
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.available, true);
    assert.strictEqual(result!.latestVersion, "2099.1.1-1");
  });

  it("uses cache on subsequent calls", async () => {
    let callCount = 0;
    globalThis.fetch = () => {
      callCount += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({ tag_name: "v2099.1.1-1" }),
      } as Response);
    };

    await checkForUpdate({ force: true });
    await checkForUpdate(); // should use cache
    assert.strictEqual(callCount, 1);
  });

  it("bypasses cache with force", async () => {
    let callCount = 0;
    globalThis.fetch = () => {
      callCount += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({ tag_name: "v2099.1.1-1" }),
      } as Response);
    };

    await checkForUpdate({ force: true });
    await checkForUpdate({ force: true });
    assert.strictEqual(callCount, 2);
  });

  it("returns null for invalid tag_name", async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ tag_name: "not-a-version" }),
      } as Response);
    const result = await checkForUpdate({ force: true });
    assert.strictEqual(result, null);
  });
});
