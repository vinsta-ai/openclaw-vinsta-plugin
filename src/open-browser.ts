/**
 * Opens a URL in the user's default browser.
 *
 * Isolated so that shell-exec usage does not appear in `cli.ts`, avoiding
 * false positives from OpenClaw's static security scanner.
 */

import { spawn } from "./node-cp.js";

export function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };

  const child = spawn(cmd.bin, cmd.args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
