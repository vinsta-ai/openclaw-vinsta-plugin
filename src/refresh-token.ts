import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  type StoredVinstaOAuthConfig,
  type ResolvedVinstaPluginConfig,
  updateVinstaPluginConfig,
} from "./config.js";
import { persistableOauthState, VinstaClient } from "./vinsta-client.js";

export type RefreshResult = {
  source: "stored" | "refresh_token" | "client_credentials";
  refreshed: boolean;
  expiresInMinutes: number;
  accessToken: string;
};

/**
 * Ensures a valid access token exists, refreshing if needed and persisting
 * the result to plugin config. Shared by keepalive, health_check, and
 * send_message to avoid divergent refresh logic.
 */
export async function refreshAndPersistToken(
  api: OpenClawPluginApi,
  config: ResolvedVinstaPluginConfig,
  client: VinstaClient,
): Promise<RefreshResult> {
  const auth = await client.ensureAccessToken(config.oauth);
  const refreshed = auth.source === "refresh_token" || auth.source === "client_credentials";

  if (refreshed) {
    const persisted = persistableOauthState(auth.tokens);
    await updateVinstaPluginConfig(api.runtime, (current) => ({
      ...current,
      oauth: {
        ...(current.oauth as StoredVinstaOAuthConfig | undefined),
        ...persisted,
        pendingState: undefined,
        pendingCodeVerifier: undefined,
        pendingCodeChallenge: undefined,
      },
    }));
  }

  return {
    source: auth.source,
    refreshed,
    expiresInMinutes: Math.floor(auth.tokens.expiresIn / 60),
    accessToken: auth.tokens.accessToken,
  };
}
