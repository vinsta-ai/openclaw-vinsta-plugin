import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResolvedVinstaPluginConfig } from "./config.js";
import { updateVinstaPluginConfig } from "./config.js";

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/vinsta-ai/openclaw-vinsta-plugin/releases/latest";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SUPPRESSION_MS = 24 * 60 * 60 * 1000; // 24 hours
const UPDATE_COMMAND_TIMEOUT_MS = 60_000;

export type CalendarVersion = {
  year: number;
  month: number;
  day: number;
  patch: number;
};

export type UpdateCheckResult = {
  available: boolean;
  latestVersion: string;
  currentVersion: string;
};

export type AutoUpdateResult = {
  success: boolean;
  message: string;
};

export type UpdateCheckCommandMode = {
  apply: boolean;
  prompt: boolean;
  exitCodeOnUpdate: boolean;
};

let cachedResult: UpdateCheckResult | null = null;
let cachedAt = 0;
let lastNotifiedAt = 0;

export function parseCalendarVersion(v: string): CalendarVersion | null {
  const match = v.replace(/^v/, "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    patch: match[4] ? Number(match[4]) : 0,
  };
}

export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseCalendarVersion(latest);
  const c = parseCalendarVersion(current);
  if (!l || !c) return false;

  if (l.year !== c.year) return l.year > c.year;
  if (l.month !== c.month) return l.month > c.month;
  if (l.day !== c.day) return l.day > c.day;
  return l.patch > c.patch;
}

export function formatUpdateNotice(latest: string, current: string): string {
  return `@openclaw/vinsta v${latest} is available (you have v${current}).`;
}

function getCurrentVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readInstallSource(api: OpenClawPluginApi) {
  const config = api.runtime.config.loadConfig() as {
    plugins?: {
      installs?: {
        vinsta?: {
          source?: string;
        };
      };
    };
  };

  const source = config.plugins?.installs?.vinsta?.source;
  return typeof source === "string" ? source : null;
}

export async function checkForUpdate(opts?: {
  force?: boolean;
}): Promise<UpdateCheckResult | null> {
  const now = Date.now();
  if (!opts?.force && cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as { tag_name?: string };
    const latestVersion = (data.tag_name ?? "").replace(/^v/, "");
    const currentVersion = getCurrentVersion();

    if (!parseCalendarVersion(latestVersion)) return null;

    const result: UpdateCheckResult = {
      available: isNewerVersion(latestVersion, currentVersion),
      latestVersion,
      currentVersion,
    };

    cachedResult = result;
    cachedAt = now;
    return result;
  } catch {
    return null;
  }
}

export async function performAutoUpdate(
  api: OpenClawPluginApi,
): Promise<AutoUpdateResult> {
  const installSource = readInstallSource(api);

  if (installSource !== "npm") {
    return {
      success: false,
      message:
        `Auto-update is only supported for npm-installed plugins. ` +
        `Current Vinsta install source: ${installSource ?? "unknown"}. ` +
        `Reinstall from the latest hosted tarball instead.`,
    };
  }

  try {
    const result = await api.runtime.system.runCommandWithTimeout(
      ["openclaw", "plugins", "update", "vinsta"],
      { timeoutMs: UPDATE_COMMAND_TIMEOUT_MS },
    );

    if (result.exitCode === 0) {
      return { success: true, message: "Plugin updated successfully. Restart OpenClaw to apply." };
    }

    return {
      success: false,
      message: `Update command exited with code ${result.exitCode}: ${result.stderr || result.stdout}`.trim(),
    };
  } catch (error) {
    return {
      success: false,
      message: `Update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function resolveUpdateCheckCommandMode(input: {
  apply?: boolean;
  yes?: boolean;
  noPrompt?: boolean;
  jsonOnly?: boolean;
  exitCodeOnUpdate?: boolean;
  isInteractive?: boolean;
}): UpdateCheckCommandMode {
  const apply = input.apply === true || input.yes === true;
  const prompt = !apply &&
    input.noPrompt !== true &&
    input.jsonOnly !== true &&
    input.isInteractive !== false;

  return {
    apply,
    prompt,
    exitCodeOnUpdate: input.exitCodeOnUpdate === true,
  };
}

function isSuppressed(config: ResolvedVinstaPluginConfig): boolean {
  if (Date.now() - lastNotifiedAt < SUPPRESSION_MS) return true;

  const lastCheck = config.lastUpdateCheckAt
    ? Date.parse(config.lastUpdateCheckAt)
    : NaN;
  if (Number.isFinite(lastCheck) && Date.now() - lastCheck < SUPPRESSION_MS) return true;

  return false;
}

async function markChecked(api: OpenClawPluginApi) {
  lastNotifiedAt = Date.now();
  await updateVinstaPluginConfig(api.runtime, (current) => ({
    ...current,
    lastUpdateCheckAt: new Date().toISOString(),
  }));
}

export type MaybeAutoUpdateResult = {
  checked: boolean;
  updateAvailable: boolean;
  autoUpdated: boolean;
  message?: string;
  latestVersion?: string;
  currentVersion?: string;
};

export async function maybeAutoUpdate(
  api: OpenClawPluginApi,
  config: ResolvedVinstaPluginConfig,
): Promise<MaybeAutoUpdateResult> {
  if (isSuppressed(config)) {
    return { checked: false, updateAvailable: false, autoUpdated: false };
  }

  const update = await checkForUpdate();
  if (!update || !update.available) {
    return { checked: true, updateAvailable: false, autoUpdated: false };
  }

  await markChecked(api);

  if (config.autoUpdate !== false) {
    const result = await performAutoUpdate(api);
    api.logger.info(`[vinsta] Auto-update: ${result.message}`);
    return {
      checked: true,
      updateAvailable: true,
      autoUpdated: result.success,
      message: result.message,
      latestVersion: update.latestVersion,
      currentVersion: update.currentVersion,
    };
  }

  api.logger.info(
    `[vinsta] ${formatUpdateNotice(update.latestVersion, update.currentVersion)} Run: openclaw plugins update vinsta`,
  );
  return {
    checked: true,
    updateAvailable: true,
    autoUpdated: false,
    message: formatUpdateNotice(update.latestVersion, update.currentVersion),
    latestVersion: update.latestVersion,
    currentVersion: update.currentVersion,
  };
}

// For testing: reset module-level cache
export function _resetForTesting() {
  cachedResult = null;
  cachedAt = 0;
  lastNotifiedAt = 0;
}
