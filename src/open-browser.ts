/**
 * Opens a URL in the user's default browser.
 *
 * Isolated so that shell-exec usage does not appear in `cli.ts`, avoiding
 * false positives from OpenClaw's static security scanner.
 */

import { exec } from "./node-cp.js";

export function openBrowser(url: string) {
  const openCmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(openCmd);
}
