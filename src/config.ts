import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

export type VinstaBridgeNotifyTarget = {
  channel: string;
  to: string;
  accountId?: string;
};

export type StoredVinstaOAuthConfig = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  pendingState?: string;
  pendingCodeVerifier?: string;
  pendingCodeChallenge?: string;
};

export type VinstaPluginConfig = {
  appUrl?: string;
  handle?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  resource?: string;
  scopes?: string[];
  bridgeEnabled?: boolean;
  bridgeCommand?: string;
  bridgeNotifyTargets?: VinstaBridgeNotifyTarget[];
  bridgeNotifyCommand?: string;
  bridgePollIntervalMs?: number;
  bridgeAutoReply?: boolean;
  bridgeReplyPolicy?: "actionable-only" | "all" | "none";
  bridgeArchiveOnSuccess?: boolean;
  bridgeContentGuardEnabled?: boolean;
  bridgeContentGuardCustomInboundPatterns?: string[];
  bridgeContentGuardCustomOutboundPatterns?: string[];
  bridgeContentGuardBlockMessage?: string;
  autoUpdate?: boolean;
  lastUpdateCheckAt?: string;
  lastNotifyChannel?: string;
  lastNotifyTarget?: string;
  lastNotifyAccountId?: string;
  oauth?: StoredVinstaOAuthConfig;
};

export type ResolvedVinstaPluginConfig = {
  appUrl: string;
  handle?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  resource?: string;
  scopes: string[];
  bridgeEnabled: boolean;
  bridgeCommand?: string;
  bridgeNotifyTargets: VinstaBridgeNotifyTarget[];
  bridgeNotifyCommand?: string;
  bridgePollIntervalMs: number;
  bridgeAutoReply: boolean;
  bridgeReplyPolicy: "actionable-only" | "all" | "none";
  bridgeArchiveOnSuccess: boolean;
  bridgeContentGuardEnabled: boolean;
  bridgeContentGuardCustomInboundPatterns: string[];
  bridgeContentGuardCustomOutboundPatterns: string[];
  bridgeContentGuardBlockMessage: string;
  autoUpdate: boolean;
  lastUpdateCheckAt?: string;
  lastNotifyChannel?: string;
  lastNotifyTarget?: string;
  lastNotifyAccountId?: string;
  oauth: StoredVinstaOAuthConfig;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean);
}

function parseStringList(value: unknown) {
  if (Array.isArray(value)) {
    return asStringArray(value);
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      return asStringArray(JSON.parse(trimmed));
    } catch {
      // Preserve single regexes like "[A-Z]{20}" instead of dropping them as failed JSON.
    }
  }

  return trimmed
    .split(/[\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asPositiveInt(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function asLowerString(value: unknown) {
  return asString(value).toLowerCase();
}

const DEFAULT_BRIDGE_COMMAND =
  'openclaw agent --message "From @${VINSTA_FROM_HANDLE} on Vinsta: ${VINSTA_MESSAGE_BODY}" --session-id "vinsta.${VINSTA_FROM_HANDLE}"';

function withDefaultAppUrl(value: string) {
  const normalized = value.replace(/\/$/, "");
  return normalized || "https://www.vinsta.ai";
}

function normalizeHandle(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/^@/, "").trim().toLowerCase();
  return normalized || undefined;
}

function readEnvString(env: NodeJS.ProcessEnv, key: string) {
  return asString(env[key]);
}

function dedupeBridgeNotifyTargets(targets: VinstaBridgeNotifyTarget[]) {
  const seen = new Set<string>();
  const deduped: VinstaBridgeNotifyTarget[] = [];

  for (const target of targets) {
    const key = `${target.channel}\u0000${target.to}\u0000${target.accountId ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

export function parseBridgeNotifyTarget(value: unknown): VinstaBridgeNotifyTarget | null {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("{")) {
      try {
        return parseBridgeNotifyTarget(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }

    const record: Record<string, unknown> = {};
    let sawKeyValue = false;

    for (const entry of trimmed.split(",")) {
      const item = entry.trim();

      if (!item) {
        continue;
      }

      const separatorIndex = item.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      sawKeyValue = true;
      const key = item.slice(0, separatorIndex).trim().toLowerCase();
      const mappedKey = key === "account" || key === "accountid" ? "accountId" : key;
      record[mappedKey] = item.slice(separatorIndex + 1).trim();
    }

    if (sawKeyValue) {
      return parseBridgeNotifyTarget(record);
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex > 0) {
      return parseBridgeNotifyTarget({
        channel: trimmed.slice(0, separatorIndex),
        to: trimmed.slice(separatorIndex + 1),
      });
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const channel = asLowerString(value.channel);
  const to = asString(value.to);
  const accountId = asString(value.accountId ?? value.account_id) || undefined;

  if (!channel || !to) {
    return null;
  }

  return {
    channel,
    to,
    accountId,
  };
}

export function parseBridgeNotifyTargets(value: unknown): VinstaBridgeNotifyTarget[] {
  if (Array.isArray(value)) {
    return dedupeBridgeNotifyTargets(
      value
        .map((item) => parseBridgeNotifyTarget(item))
        .filter((item): item is VinstaBridgeNotifyTarget => Boolean(item)),
    );
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith("[")) {
      try {
        return parseBridgeNotifyTargets(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }

    if (trimmed.startsWith("{")) {
      const single = parseBridgeNotifyTarget(trimmed);
      return single ? [single] : [];
    }

    return dedupeBridgeNotifyTargets(
      trimmed
        .split(/[;\n]+/)
        .map((item) => parseBridgeNotifyTarget(item))
        .filter((item): item is VinstaBridgeNotifyTarget => Boolean(item)),
    );
  }

  const single = parseBridgeNotifyTarget(value);
  return single ? [single] : [];
}

export function readVinstaPluginEntry(config: OpenClawConfig): VinstaPluginConfig {
  const entry = config.plugins?.entries?.vinsta;
  return isRecord(entry?.config) ? (entry.config as VinstaPluginConfig) : {};
}

export function resolveVinstaPluginConfig(
  input?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedVinstaPluginConfig {
  const oauth = isRecord(input?.oauth) ? input.oauth : {};
  const envScopes = readEnvString(env, "VINSTA_SCOPES")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const scopes = asStringArray(input?.scopes);

  const bridgeEnabled =
    asBoolean(input?.bridgeEnabled) ??
    (readEnvString(env, "VINSTA_BRIDGE_ENABLED").toLowerCase() === "true");

  return {
    appUrl: withDefaultAppUrl(asString(input?.appUrl) || readEnvString(env, "VINSTA_APP_URL")),
    handle: normalizeHandle(asString(input?.handle) || readEnvString(env, "VINSTA_HANDLE")),
    clientId: asString(input?.clientId) || readEnvString(env, "VINSTA_CLIENT_ID") || undefined,
    clientSecret:
      asString(input?.clientSecret) || readEnvString(env, "VINSTA_CLIENT_SECRET") || undefined,
    redirectUri:
      asString(input?.redirectUri) || readEnvString(env, "VINSTA_REDIRECT_URI") || undefined,
    resource: asString(input?.resource) || readEnvString(env, "VINSTA_RESOURCE") || undefined,
    scopes:
      scopes.length > 0
        ? scopes
        : envScopes.length > 0
          ? envScopes
          : ["agent:read", "agent:interact"],
    bridgeEnabled,
    bridgeCommand:
      asString(input?.bridgeCommand) || readEnvString(env, "VINSTA_BRIDGE_COMMAND") ||
      (bridgeEnabled ? DEFAULT_BRIDGE_COMMAND : undefined),
    bridgeNotifyTargets: parseBridgeNotifyTargets(
      input?.bridgeNotifyTargets ?? readEnvString(env, "VINSTA_BRIDGE_NOTIFY_TARGETS"),
    ),
    bridgeNotifyCommand:
      asString(input?.bridgeNotifyCommand) ||
      readEnvString(env, "VINSTA_BRIDGE_NOTIFY_COMMAND") ||
      undefined,
    bridgePollIntervalMs: asPositiveInt(
      input?.bridgePollIntervalMs ?? readEnvString(env, "VINSTA_BRIDGE_POLL_INTERVAL_MS"),
      15_000,
    ),
    bridgeAutoReply:
      asBoolean(input?.bridgeAutoReply) ??
      (readEnvString(env, "VINSTA_BRIDGE_AUTO_REPLY")
        ? readEnvString(env, "VINSTA_BRIDGE_AUTO_REPLY").toLowerCase() === "true"
        : true),
    bridgeReplyPolicy:
      (asString(input?.bridgeReplyPolicy) || readEnvString(env, "VINSTA_BRIDGE_REPLY_POLICY") || "actionable-only") as
        "actionable-only" | "all" | "none",
    bridgeArchiveOnSuccess:
      asBoolean(input?.bridgeArchiveOnSuccess) ??
      (readEnvString(env, "VINSTA_BRIDGE_ARCHIVE_ON_SUCCESS")
        ? readEnvString(env, "VINSTA_BRIDGE_ARCHIVE_ON_SUCCESS").toLowerCase() === "true"
        : true),
    bridgeContentGuardEnabled:
      asBoolean(input?.bridgeContentGuardEnabled) ??
      (readEnvString(env, "VINSTA_BRIDGE_CONTENT_GUARD_ENABLED")
        ? readEnvString(env, "VINSTA_BRIDGE_CONTENT_GUARD_ENABLED").toLowerCase() !== "false"
        : true),
    bridgeContentGuardCustomInboundPatterns: parseStringList(
      input?.bridgeContentGuardCustomInboundPatterns ??
        readEnvString(env, "VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_INBOUND_PATTERNS"),
    ),
    bridgeContentGuardCustomOutboundPatterns: parseStringList(
      input?.bridgeContentGuardCustomOutboundPatterns ??
        readEnvString(env, "VINSTA_BRIDGE_CONTENT_GUARD_CUSTOM_OUTBOUND_PATTERNS"),
    ),
    bridgeContentGuardBlockMessage:
      asString(input?.bridgeContentGuardBlockMessage) ||
      readEnvString(env, "VINSTA_BRIDGE_CONTENT_GUARD_BLOCK_MESSAGE") ||
      "I'm not able to help with that request.",
    autoUpdate:
      asBoolean(input?.autoUpdate) ?? true,
    lastUpdateCheckAt: asString(input?.lastUpdateCheckAt) || undefined,
    lastNotifyChannel: asLowerString(input?.lastNotifyChannel) || undefined,
    lastNotifyTarget: asString(input?.lastNotifyTarget) || undefined,
    lastNotifyAccountId: asString(input?.lastNotifyAccountId) || undefined,
    oauth: {
      accessToken:
        asString(oauth.accessToken) || readEnvString(env, "VINSTA_ACCESS_TOKEN") || undefined,
      refreshToken:
        asString(oauth.refreshToken) || readEnvString(env, "VINSTA_REFRESH_TOKEN") || undefined,
      expiresAt:
        asString(oauth.expiresAt) || readEnvString(env, "VINSTA_TOKEN_EXPIRES_AT") || undefined,
      pendingState: asString(oauth.pendingState) || undefined,
      pendingCodeVerifier: asString(oauth.pendingCodeVerifier) || undefined,
      pendingCodeChallenge: asString(oauth.pendingCodeChallenge) || undefined,
    },
  };
}

export function buildVinstaStatus(config: ResolvedVinstaPluginConfig) {
  const expiresAt = config.oauth.expiresAt ? Date.parse(config.oauth.expiresAt) : NaN;
  const expiresAtIso = Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null;
  const expiresInSeconds =
    Number.isFinite(expiresAt) ? Math.max(Math.floor((expiresAt - Date.now()) / 1000), 0) : null;

  return {
    appUrl: config.appUrl,
    handle: config.handle ?? null,
    clientId: config.clientId ?? null,
    redirectUri: config.redirectUri ?? null,
    resource: config.resource ?? null,
    scopes: config.scopes,
    authMode: config.clientSecret
      ? "confidential"
      : config.clientId && config.redirectUri
        ? "pkce"
        : "none",
    bridgeEnabled: config.bridgeEnabled,
    bridgeCommand: config.bridgeCommand ?? null,
    bridgeNotifyTargets: config.bridgeNotifyTargets,
    bridgeNotifyCommand: config.bridgeNotifyCommand ?? null,
    bridgePollIntervalMs: config.bridgePollIntervalMs,
    bridgeAutoReply: config.bridgeAutoReply,
    bridgeReplyPolicy: config.bridgeReplyPolicy,
    bridgeArchiveOnSuccess: config.bridgeArchiveOnSuccess,
    bridgeContentGuardEnabled: config.bridgeContentGuardEnabled,
    bridgeContentGuardCustomInboundPatternCount: config.bridgeContentGuardCustomInboundPatterns.length,
    bridgeContentGuardCustomOutboundPatternCount: config.bridgeContentGuardCustomOutboundPatterns.length,
    autoUpdate: config.autoUpdate,
    hasClientSecret: Boolean(config.clientSecret),
    hasAccessToken: Boolean(config.oauth.accessToken),
    hasRefreshToken: Boolean(config.oauth.refreshToken),
    hasPendingPkce: Boolean(config.oauth.pendingState && config.oauth.pendingCodeVerifier),
    expiresAt: expiresAtIso,
    expiresInSeconds,
  };
}

export async function updateVinstaPluginConfig(
  runtime: PluginRuntime,
  updater: (current: VinstaPluginConfig) => VinstaPluginConfig,
) {
  const config = runtime.config.loadConfig();
  const next = structuredClone(config) as OpenClawConfig;

  next.plugins ??= {};
  next.plugins.entries ??= {};

  const currentEntry = next.plugins.entries.vinsta ?? {};
  const currentConfig = isRecord(currentEntry.config)
    ? (currentEntry.config as VinstaPluginConfig)
    : {};
  const updatedConfig = updater(currentConfig);

  next.plugins.entries.vinsta = {
    ...currentEntry,
    enabled: true,
    config: updatedConfig as Record<string, unknown>,
  };

  await runtime.config.writeConfigFile(next);
  return updatedConfig;
}
