import type { VinstaBridgeNotifyTarget } from "./config.js";
import { screenOutbound } from "./content-guard.js";

type VinstaNotificationLike = {
  metadata?: Record<string, unknown> | null;
};

type HumanNotificationLike = {
  body: string;
};

type OpenClawNotifyConfigLike = {
  plugins?: {
    entries?: Record<string, unknown>;
    installs?: Record<string, unknown>;
    load?: {
      paths?: string[];
    };
  };
};

export type NotificationAutomationState = {
  autoStep: number;
  autoLimit: number;
  humanInLoopEnabled: boolean;
  approvalStatus: string | null;
  stopReason: string | null;
};

const REDACTED_HUMAN_NOTICE =
  "Sensitive content was withheld from this mirrored Vinsta notice. Review the full thread in Vinsta.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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

export function readNotificationAutomationState(
  notification: VinstaNotificationLike,
): NotificationAutomationState | null {
  const metadata = isRecord(notification.metadata) ? notification.metadata : null;
  const a2aThread = metadata && isRecord(metadata.a2aThread) ? metadata.a2aThread : null;

  if (!a2aThread) {
    return null;
  }

  return {
    autoStep: asPositiveInt(a2aThread.autoStep, 1),
    autoLimit: asPositiveInt(a2aThread.autoLimit, 6),
    humanInLoopEnabled: Boolean(a2aThread.humanInLoopEnabled),
    approvalStatus: asString(a2aThread.approvalStatus) || null,
    stopReason: asString(a2aThread.stopReason) || null,
  };
}

export function stripVinstaPluginFromNotifyConfig<T extends OpenClawNotifyConfigLike>(config: T): T {
  const next = structuredClone(config) as T;
  const installEntry =
    next.plugins?.installs && typeof next.plugins.installs.vinsta === "object"
      ? (next.plugins.installs.vinsta as Record<string, unknown>)
      : null;
  const candidatePaths = new Set(
    [installEntry?.installPath, installEntry?.sourcePath]
      .filter((value) => typeof value === "string")
      .map((value) => String(value)),
  );

  if (next.plugins?.entries && "vinsta" in next.plugins.entries) {
    delete next.plugins.entries.vinsta;
  }

  if (next.plugins?.installs && "vinsta" in next.plugins.installs) {
    delete next.plugins.installs.vinsta;
  }

  if (Array.isArray(next.plugins?.load?.paths)) {
    next.plugins.load.paths = next.plugins.load.paths.filter((entry) => {
      if (candidatePaths.has(entry)) {
        return false;
      }

      return !/openclaw-vinsta-plugin/i.test(entry);
    });
  }

  return next;
}

export function shouldSuppressFreshHumanNotificationForBridgeCommand(
  command: string | null | undefined,
) {
  const normalized = typeof command === "string" ? command.trim().toLowerCase() : "";

  if (!normalized) {
    return false;
  }

  return normalized.includes("run-openclaw-bridge.sh");
}

export function sanitizeHumanNotificationForDelivery<T extends HumanNotificationLike>(
  notification: T,
  customPatterns?: string[],
) {
  const outboundScreen = screenOutbound(notification.body, customPatterns);

  if (outboundScreen.allowed) {
    return {
      notification,
      redacted: false,
      reason: null,
    };
  }

  return {
    notification: {
      ...notification,
      body: REDACTED_HUMAN_NOTICE,
    } as T,
    redacted: true,
    reason: outboundScreen.reason ?? null,
  };
}

export function maybeSanitizeHumanNotificationForDelivery<T extends HumanNotificationLike>(
  notification: T,
  enabled: boolean,
  customPatterns?: string[],
) {
  if (!enabled) {
    return {
      notification,
      redacted: false,
      reason: null,
    };
  }

  return sanitizeHumanNotificationForDelivery(notification, customPatterns);
}

type OpenClawConfigLike = {
  channels?: Record<string, unknown>;
};

export function discoverNotifyTargetsFromOpenClawConfig(
  config: OpenClawConfigLike,
): VinstaBridgeNotifyTarget[] {
  const channels = config.channels;

  if (!isRecord(channels)) {
    return [];
  }

  const targets: VinstaBridgeNotifyTarget[] = [];

  for (const [channelName, channelValue] of Object.entries(channels)) {
    if (channelName === "defaults" || channelName === "modelByChannel" || !isRecord(channelValue)) {
      continue;
    }

    // Check top-level defaultTo / allowFrom
    const topTarget = extractOwnerTarget(channelValue);

    if (topTarget) {
      targets.push({ channel: channelName, to: topTarget });
      continue;
    }

    // Check per-account configs
    if (isRecord(channelValue.accounts)) {
      for (const [accountId, accountValue] of Object.entries(channelValue.accounts)) {
        if (!isRecord(accountValue)) {
          continue;
        }

        const accountTarget = extractOwnerTarget(accountValue);

        if (accountTarget) {
          targets.push({ channel: channelName, to: accountTarget, accountId });
          break;
        }
      }
    }
  }

  return targets;
}

function extractOwnerTarget(record: Record<string, unknown>): string | null {
  const defaultTo = asString(record.defaultTo);

  if (defaultTo) {
    return defaultTo;
  }

  const allowFrom = record.allowFrom;

  if (Array.isArray(allowFrom)) {
    const first = asString(allowFrom[0]);

    if (first && first !== "*") {
      return first;
    }
  }

  if (typeof allowFrom === "string") {
    const trimmed = allowFrom.trim();

    if (trimmed && trimmed !== "*") {
      return trimmed;
    }
  }

  return null;
}
