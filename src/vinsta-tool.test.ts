import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vinstaToolPath = path.resolve(__dirname, "./vinsta-tool.ts");

describe("createVinstaTool", () => {
  it("builds tool JSON results locally instead of depending on version-specific SDK helper exports", () => {
    const source = readFileSync(vinstaToolPath, "utf8");

    assert.match(
      source,
      /function buildJsonResult\(payload: unknown\)/,
    );
    assert.doesNotMatch(
      source,
      /import\s+\{\s*jsonResult\s*\}\s+from\s+"openclaw\/plugin-sdk"/,
    );
    assert.doesNotMatch(
      source,
      /import\s+\{\s*jsonResult\s*\}\s+from\s+"openclaw\/plugin-sdk\/agent-runtime"/,
    );
  });
});
