import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import {
  readVinstaPluginEntry,
  resolveVinstaPluginConfig,
} from "./config.js";
import { VinstaClient } from "./vinsta-client.js";
import { refreshAndPersistToken } from "./refresh-token.js";

const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000; // refresh if < 10 min left

function log(message: string) {
  console.error(`[vinsta-keepalive] ${message}`);
}

export function createVinstaKeepalive(api: OpenClawPluginApi): OpenClawPluginService {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runCheck() {
    const config = resolveVinstaPluginConfig(
      readVinstaPluginEntry(api.runtime.config.loadConfig()),
      process.env,
    );

    if (!config.handle || !config.clientId) {
      return;
    }

    const oauth = config.oauth ?? {};
    const expiresAt = oauth.expiresAt ? Date.parse(oauth.expiresAt) : NaN;
    const needsRefresh =
      !oauth.accessToken ||
      !Number.isFinite(expiresAt) ||
      expiresAt - Date.now() < TOKEN_REFRESH_WINDOW_MS;

    if (needsRefresh && (config.clientSecret || oauth.refreshToken)) {
      try {
        const client = new VinstaClient(config);
        const result = await refreshAndPersistToken(api, config, client);
        if (result.refreshed) {
          log(`Token refreshed via ${result.source}, expires in ${result.expiresInMinutes}m`);
        }
      } catch (err) {
        log(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async function loop() {
    if (stopped) return;

    try {
      await runCheck();
    } catch (err) {
      log(`Keepalive check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!stopped) {
      timer = setTimeout(() => { void loop(); }, KEEPALIVE_INTERVAL_MS);
    }
  }

  return {
    id: "vinsta-keepalive",
    start: async () => {
      stopped = false;
      timer = setTimeout(() => { void loop(); }, 5_000);
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
