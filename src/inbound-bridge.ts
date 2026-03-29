import {
  normalizeAgentId,
  type OpenClawPluginApi,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk";
import {
  type BridgeCommandResult,
  runBridgeCommand,
  runBridgeNotifyCommand,
  runOpenClawNativeNotifyTarget,
} from "./spawn-runners.js";

/** Resolves the main session key from the OpenClaw config.
 *  Replaces the removed `resolveMainSessionKey` export from openclaw/plugin-sdk. */
function resolveMainSessionKey(cfg: unknown): string {
  const config = cfg as {
    session?: { scope?: string; mainKey?: string };
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  };
  if (config?.session?.scope === "global") return "global";
  const agents = config?.agents?.list ?? [];
  const agentId = normalizeAgentId(
    agents.find((a) => a?.default)?.id ?? agents[0]?.id ?? "main",
  );
  const mainKey = (config?.session?.mainKey ?? "").trim().toLowerCase() || "main";
  return `agent:${agentId}:${mainKey}`;
}
import {
  readVinstaPluginEntry,
  resolveVinstaPluginConfig,
  type StoredVinstaOAuthConfig,
  updateVinstaPluginConfig,
} from "./config.js";
import {
  persistableOauthState,
  type VinstaNotification,
  VinstaClient,
} from "./vinsta-client.js";
import { screenInbound, screenOutbound } from "./content-guard.js";
import {
  discoverNotifyTargetsFromOpenClawConfig,
  maybeSanitizeHumanNotificationForDelivery,
  readNotificationAutomationState,
  shouldSuppressFreshHumanNotificationForBridgeCommand,
} from "./inbound-bridge-helpers.js";
import { maybeAutoUpdate, type MaybeAutoUpdateResult } from "./update-check.js";

type BridgeAction = {
  reply?: string;
  notifyHuman?: string;
  archive?: boolean;
};

type PendingBridgeCompletion = {
  notificationId: string;
  claimedAt: string;
  reply?: string;
  archive: boolean;
  humanNotification?: VinstaNotification;
};

type BridgeStatus = {
  active: boolean;
  processed: number;
  notified: number;
  handle: string | null;
  unreadCount?: number;
};

const bridgeClaimTtlMs = 15 * 60_000;
const bridgeFailureRetryDelayMs = 60_000;
const bridgeStreamReconnectMs = 2_000;
const maxTrackedNotifications = 512;
const replyRateLimitWindow = 5 * 60_000; // 5 minutes
const replyRateLimitMax = 3; // max replies per sender in window
const inboundNotifyRateLimitWindow = 10 * 60_000; // 10 minutes
const inboundNotifyRateLimitMax = 3; // max human notifications per sender in window

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseSenderHandle(notification: VinstaNotification) {
  if (notification.senderHandle) {
    return notification.senderHandle.replace(/^@/, "").trim().toLowerCase();
  }

  const match = notification.title.match(/@([a-z0-9-]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isBridgeActionableNotification(
  notification: VinstaNotification,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
) {
  if (!config.bridgeCommand || notification.archivedAt) {
    return false;
  }

  const automation = readNotificationAutomationState(notification);

  if (automation?.approvalStatus === "pending" || automation?.stopReason === "human_rejected") {
    return false;
  }

  // Human-in-the-loop: not bridge-actionable unless explicitly approved
  if (
    automation?.humanInLoopEnabled &&
    automation.approvalStatus !== "approved" &&
    automation.approvalStatus !== "not_required"
  ) {
    return false;
  }

  if (notification.type === "question") {
    return true;
  }

  // Review notifications with grant variant (capability-denied prompts) are bridge-actionable
  if (notification.type === "review" && notification.actionRequest?.variant === "grant") {
    return true;
  }

  if (notification.type !== "notify") {
    return false;
  }

  const senderHandle = parseSenderHandle(notification);

  if (!senderHandle || senderHandle === config.handle) {
    return false;
  }

  return /^(reply|new message) from @/i.test(notification.title);
}

function buildHumanSummaryNotification(input: {
  original: VinstaNotification;
  handle: string;
  summary: string;
}) {
  const senderHandle = parseSenderHandle(input.original);
  const title = senderHandle
    ? `Final update from @${senderHandle}`
    : `Final update for @${input.handle}`;

  return {
    id: `bridge-summary-${input.original.id}`,
    recipientId: input.handle,
    senderId: input.original.senderId,
    senderHandle,
    type: "notify",
    title,
    body: input.summary.trim(),
    createdAt: new Date().toISOString(),
    readAt: null,
    bridgeClaimedAt: null,
    archivedAt: null,
  } satisfies VinstaNotification;
}

async function persistResolvedOauth(api: OpenClawPluginApi, oauth: StoredVinstaOAuthConfig) {
  await updateVinstaPluginConfig(api.runtime, (current) => ({
    ...current,
    oauth: {
      ...(current.oauth ?? {}),
      ...oauth,
      pendingState: undefined,
      pendingCodeVerifier: undefined,
      pendingCodeChallenge: undefined,
    },
  }));
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rememberNotificationIds(
  trackedNotificationIds: Set<string>,
  notifications: VinstaNotification[],
) {
  for (const notification of notifications) {
    rememberNotificationId(trackedNotificationIds, notification.id);
  }
}

function rememberNotificationId(trackedNotificationIds: Set<string>, notificationId: string) {
  trackedNotificationIds.add(notificationId);

  while (trackedNotificationIds.size > maxTrackedNotifications) {
    const oldest = trackedNotificationIds.values().next().value;

    if (!oldest) {
      break;
    }

    trackedNotificationIds.delete(oldest);
  }
}

function rememberBridgeRetryDelay(
  retryDelays: Map<string, number>,
  notificationId: string,
  retryAt: number,
) {
  retryDelays.set(notificationId, retryAt);

  while (retryDelays.size > maxTrackedNotifications) {
    const oldest = retryDelays.keys().next().value;

    if (!oldest) {
      break;
    }

    retryDelays.delete(oldest);
  }
}

function shouldDeferBridgeRetry(retryDelays: Map<string, number>, notificationId: string) {
  const retryAt = retryDelays.get(notificationId);

  if (!retryAt) {
    return false;
  }

  if (retryAt <= Date.now()) {
    retryDelays.delete(notificationId);
    return false;
  }

  return true;
}

function isRateLimited(
  timestamps: Map<string, number[]>,
  key: string,
  windowMs: number,
  max: number,
) {
  const now = Date.now();
  const entries = timestamps.get(key);
  if (!entries) return false;
  const recent = entries.filter((t) => t > now - windowMs);
  timestamps.set(key, recent);
  return recent.length >= max;
}

function recordTimestamp(
  timestamps: Map<string, number[]>,
  key: string,
) {
  const entries = timestamps.get(key) ?? [];
  entries.push(Date.now());
  timestamps.set(key, entries);
}

function buildVinstaThreadsUrl(config: ReturnType<typeof resolveVinstaPluginConfig>) {
  const base = config.appUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    view: "threads",
  });

  if (config.handle) {
    params.set("handle", config.handle);
  }

  return `${base}/messages?${params.toString()}`;
}

function formatHumanNotificationText(
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
) {
  const automation = readNotificationAutomationState(notification);
  const sender = parseSenderHandle(notification);
  const senderLabel = sender ? `@${sender}` : "Someone";

  if (automation?.approvalStatus === "pending") {
    const reason =
      automation.stopReason === "auto_turn_limit"
        ? `The conversation with ${senderLabel} reached ${automation.autoLimit} automatic turns.`
        : `The conversation with ${senderLabel} needs your approval to continue.`;
    const body = notification.body.trim();
    const preview = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    const previewLine = preview ? `\n\nLatest message: "${preview}"` : "";
    const threadsUrl = buildVinstaThreadsUrl(config);
    return `[Vinsta notice - no reply needed] ${reason}${previewLine}\n\nReview in Messages → Agent threads: ${threadsUrl}`;
  }

  const body = notification.body.trim();
  const maxLen = 500;
  const truncated = body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;

  if (body) {
    return `[Vinsta notice - no reply needed] ${senderLabel}: ${truncated}`;
  }

  return `[Vinsta notice - no reply needed] ${notification.title.trim()}`;
}

async function dispatchHumanNotificationViaOpenClaw(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
) {
  if (config.bridgeNotifyTargets.length === 0) {
    return false;
  }

  const text = formatHumanNotificationText(config, notification);
  let delivered = 0;

  for (const target of config.bridgeNotifyTargets) {
    try {
      const result = await runOpenClawNativeNotifyTarget({
        api,
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        text,
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || `exit ${result.exitCode}`);
      }

      delivered += 1;
    } catch (error) {
      api.logger.error(
        `[vinsta] Failed to notify ${target.channel}:${target.to} for ${notification.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return delivered > 0;
}

function dispatchHumanNotificationToOpenClawUi(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
) {
  const cfg = api.runtime.config.loadConfig();
  const sessionKey = resolveMainSessionKey(cfg);
  const text = formatHumanNotificationText(config, notification);

  api.runtime.system.enqueueSystemEvent(text, {
    sessionKey,
    contextKey: `vinsta:${notification.id}`,
  });
  api.logger.info(
    `[vinsta] Dispatched ${notification.id} (${notification.type.replace(/_/g, " ")}) for @${config.handle}: ${notification.title}`,
  );
}

async function dispatchHumanNotificationToExternalChannel(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
) {
  // Step 1: Explicit bridgeNotifyTargets
  if (await dispatchHumanNotificationViaOpenClaw(api, config, notification)) {
    return true;
  }

  // Step 2: Saved origin channel from last tool invocation
  if (
    config.bridgeNotifyTargets.length === 0 &&
    config.lastNotifyChannel &&
    config.lastNotifyTarget
  ) {
    const originTarget = [
      {
        channel: config.lastNotifyChannel,
        to: config.lastNotifyTarget,
        accountId: config.lastNotifyAccountId,
      },
    ];
    const originConfig = { ...config, bridgeNotifyTargets: originTarget };

    if (await dispatchHumanNotificationViaOpenClaw(api, originConfig, notification)) {
      return true;
    }
  }

  // Step 3: Auto-discover from OpenClaw channel config
  if (config.bridgeNotifyTargets.length === 0) {
    const discovered = discoverNotifyTargetsFromOpenClawConfig(
      api.runtime.config.loadConfig(),
    );

    if (discovered.length > 0) {
      const autoConfig = { ...config, bridgeNotifyTargets: discovered };

      if (await dispatchHumanNotificationViaOpenClaw(api, autoConfig, notification)) {
        return true;
      }
    }
  }

  // Step 4: Legacy bridgeNotifyCommand
  if (config.bridgeNotifyCommand) {
    try {
      const result = await runBridgeNotifyCommand(
        config.bridgeNotifyCommand,
        notification,
        config.handle!,
      );

      if (result.exitCode !== 0) {
        api.logger.error(
          `[vinsta] Notification command failed for ${notification.id} with exit ${result.exitCode}${
            result.stderr ? `: ${result.stderr}` : ""
          }`,
        );
      } else {
        return true;
      }
    } catch (error) {
      api.logger.error(
        `[vinsta] Failed to notify for ${notification.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return false;
}

async function dispatchHumanNotification(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
  options?: { externalOnly?: boolean; uiOnly?: boolean },
) {
  // The OpenClaw UI always gets the unredacted notification — the owner
  // should see the full content of their own notifications.
  if (!options?.externalOnly) {
    dispatchHumanNotificationToOpenClawUi(api, config, notification);
  }

  // External channels (iMessage, Telegram, etc.) get a content-guarded
  // version to avoid leaking secrets over less-secure transports.
  if (!options?.uiOnly) {
    const sanitized = maybeSanitizeHumanNotificationForDelivery(
      notification,
      config.bridgeContentGuardEnabled,
      config.bridgeContentGuardCustomOutboundPatterns.length > 0
        ? config.bridgeContentGuardCustomOutboundPatterns
        : undefined,
    );

    if (sanitized.redacted) {
      api.logger.info(
        `[vinsta] Content guard redacted external notification for ${notification.id}: ${
          sanitized.reason ?? "matched an outbound guard pattern"
        }`,
      );
    }

    await dispatchHumanNotificationToExternalChannel(
      api,
      config,
      sanitized.notification as VinstaNotification,
    );
  }
}

const noReplySignals = new Set([
  "no_reply",
  "no reply",
  "noreply",
  "skip",
  "ignore",
  "pass",
  "none",
  "",
]);

function isNoReplySignal(text: string) {
  return noReplySignals.has(text.trim().toLowerCase());
}

function parseBridgeAction(result: BridgeCommandResult): BridgeAction {
  if (!result.stdout) {
    return {};
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      reply?: unknown;
      notifyHuman?: unknown;
      notify_human?: unknown;
      archive?: unknown;
    };
    const notifyHuman =
      typeof parsed.notifyHuman === "string"
        ? parsed.notifyHuman.trim()
        : typeof parsed.notify_human === "string"
          ? parsed.notify_human.trim()
          : undefined;

    const rawReply = typeof parsed.reply === "string" ? parsed.reply.trim() : undefined;

    return {
      reply: rawReply && !isNoReplySignal(rawReply) ? rawReply : undefined,
      notifyHuman: notifyHuman || undefined,
      archive: typeof parsed.archive === "boolean" ? parsed.archive : undefined,
    };
  } catch {
    if (isNoReplySignal(result.stdout)) {
      return { archive: true };
    }

    return {
      reply: result.stdout,
    };
  }
}

function shouldUseNotifyBodyAsFinalSummary(
  notification: VinstaNotification,
  action: BridgeAction,
) {
  // Only use the notification body as a human summary if the agent explicitly
  // set archive to false (meaning "don't archive, show this to the human").
  // If archive is undefined or true, the agent didn't ask to surface it.
  return notification.type === "notify" && !action.reply && action.archive === false;
}

async function flushPendingCompletions(
  api: OpenClawPluginApi,
  client: VinstaClient,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  accessToken: string,
  pendingCompletions: Map<string, PendingBridgeCompletion>,
  dispatchedNotificationIds: Set<string>,
) {
  for (const completion of pendingCompletions.values()) {
    try {
      await client.completeBridgeNotification({
        notificationId: completion.notificationId,
        claimedAt: completion.claimedAt,
        accessToken,
        reply: completion.reply,
        archive: completion.archive,
      });
      if (completion.humanNotification) {
        await dedupDispatchHumanNotification(api, config, completion.humanNotification, dispatchedNotificationIds);
      }
      pendingCompletions.delete(completion.notificationId);
    } catch (error) {
      api.logger.error(
        `[vinsta] Failed to complete pending notification ${completion.notificationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function dedupDispatchHumanNotification(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
  dispatchedIds: Set<string>,
  options?: { externalOnly?: boolean; uiOnly?: boolean },
) {
  if (dispatchedIds.has(notification.id)) {
    return;
  }
  dispatchedIds.add(notification.id);
  while (dispatchedIds.size > maxTrackedNotifications) {
    const oldest = dispatchedIds.values().next().value;
    if (!oldest) break;
    dispatchedIds.delete(oldest);
  }
  await dispatchHumanNotification(api, config, notification, options);
}

async function processBridgeOnce(
  api: OpenClawPluginApi,
  inFlight: Set<string>,
  pendingCompletions: Map<string, PendingBridgeCompletion>,
  failedBridgeNotificationIds: Map<string, number>,
  dispatchedNotificationIds: Set<string>,
  senderReplyTimestamps: Map<string, number[]>,
  senderNotifyTimestamps: Map<string, number[]>,
  primedNotificationIds: Set<string>,
  observeNotifications?: (
    notifications: VinstaNotification[],
    config: ReturnType<typeof resolveVinstaPluginConfig>,
    ctx?: { client: VinstaClient; accessToken: string },
  ) => Promise<number> | number,
): Promise<BridgeStatus> {
  const current = readVinstaPluginEntry(api.runtime.config.loadConfig());
  const config = resolveVinstaPluginConfig(current, process.env);

  if (!config.bridgeEnabled || !config.handle) {
    return {
      active: false,
      processed: 0,
      notified: 0,
      handle: config.handle ?? null,
    };
  }

  const client = new VinstaClient(config);
  const auth = await client.ensureAccessToken(config.oauth);

  if (auth.source === "refresh_token") {
    await persistResolvedOauth(api, persistableOauthState(auth.tokens));
  }

  await flushPendingCompletions(
    api,
    client,
    config,
    auth.tokens.accessToken,
    pendingCompletions,
    dispatchedNotificationIds,
  );

  const payload = await client.listNotifications({
    accessToken: auth.tokens.accessToken,
    handle: config.handle,
  });
  const notified = observeNotifications
    ? await observeNotifications(payload.notifications, config, { client, accessToken: auth.tokens.accessToken })
    : 0;

  const surfaceBridgeFailure = async (notification: VinstaNotification, claimedAt: string) => {
    rememberBridgeRetryDelay(
      failedBridgeNotificationIds,
      notification.id,
      Date.now() + bridgeFailureRetryDelayMs,
    );

    try {
      await client.releaseNotification({
        notificationId: notification.id,
        claimedAt,
        accessToken: auth.tokens.accessToken,
      });
    } catch (error) {
      api.logger.error(
        `[vinsta] Failed to release notification ${notification.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await dedupDispatchHumanNotification(api, config, notification, dispatchedNotificationIds);
  };

  if (!config.bridgeCommand) {
    return {
      active: true,
      processed: 0,
      notified,
      handle: config.handle,
      unreadCount: payload.unreadCount,
    };
  }

  const candidates = payload.notifications
    .filter((notification) => {
      // Skip notifications that existed before the bridge started (priming guard)
      if (primedNotificationIds.has(notification.id)) {
        return false;
      }

      if (shouldDeferBridgeRetry(failedBridgeNotificationIds, notification.id)) {
        return false;
      }

      if (!isBridgeActionableNotification(notification, config)) {
        return false;
      }

      if (!notification.readAt) {
        return true;
      }

      if (!notification.bridgeClaimedAt) {
        return false;
      }

      const claimedAt = Date.parse(notification.bridgeClaimedAt);
      return Number.isFinite(claimedAt) && claimedAt <= Date.now() - bridgeClaimTtlMs;
    })
    .filter((notification) => !inFlight.has(notification.id))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  let processed = 0;

  for (const notification of candidates) {
    // ── Per-sender bridge rate limiter: skip processing entirely if rate-limited ──
    const candidateSender = parseSenderHandle(notification);
    if (candidateSender && isRateLimited(senderReplyTimestamps, candidateSender, replyRateLimitWindow, replyRateLimitMax)) {
      api.logger.info(
        `[vinsta] Skipping bridge processing for rate-limited sender @${candidateSender} (${notification.id})`,
      );
      // Claim and archive immediately — no bridge command, no reply
      try {
        const claim = await client.claimNotification({
          notificationId: notification.id,
          accessToken: auth.tokens.accessToken,
        });
        if (claim.claimed && claim.notification.readAt) {
          await client.completeBridgeNotification({
            notificationId: notification.id,
            claimedAt: claim.notification.readAt,
            accessToken: auth.tokens.accessToken,
            reply: undefined,
            archive: true,
          });
        }
      } catch (error) {
        api.logger.warn(
          `[vinsta] Failed to archive rate-limited notification ${notification.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Notify human if still under the notify limit
      if (!isRateLimited(senderNotifyTimestamps, candidateSender, inboundNotifyRateLimitWindow, inboundNotifyRateLimitMax)) {
        recordTimestamp(senderNotifyTimestamps, candidateSender);
        await dedupDispatchHumanNotification(
          api, config,
          buildHumanSummaryNotification({ original: notification, handle: config.handle, summary: notification.body.trim() }),
          dispatchedNotificationIds,
        );
      }
      continue;
    }

    inFlight.add(notification.id);
    let claimedAt: string | null = null;
    let commandCompleted = false;

    try {
      const claim = await client.claimNotification({
        notificationId: notification.id,
        accessToken: auth.tokens.accessToken,
      });

      if (!claim.claimed) {
        continue;
      }

      claimedAt = claim.notification.readAt ?? null;

      if (!claimedAt) {
        api.logger.error(
          `[vinsta] Notification ${notification.id} was claimed without a read timestamp.`,
        );
        await client.releaseNotification({
          notificationId: notification.id,
          claimedAt: claim.notification.readAt ?? "",
          accessToken: auth.tokens.accessToken,
        });
        continue;
      }

      // ── After-claim race guard: release if approval is now pending ──
      const claimAutomation = readNotificationAutomationState(claim.notification);
      if (claimAutomation?.approvalStatus === "pending" || claimAutomation?.stopReason === "human_rejected") {
        api.logger.info(
          `[vinsta] Notification ${notification.id} requires approval — releasing claim.`,
        );
        await client.releaseNotification({
          notificationId: notification.id,
          claimedAt,
          accessToken: auth.tokens.accessToken,
        });
        await dedupDispatchHumanNotification(api, config, claim.notification, dispatchedNotificationIds);
        continue;
      }

      // ── Human-in-the-loop gate: if enabled and not yet approved, release to human ──
      if (
        claimAutomation?.humanInLoopEnabled &&
        claimAutomation.approvalStatus !== "approved" &&
        claimAutomation.approvalStatus !== "not_required"
      ) {
        api.logger.info(
          `[vinsta] Notification ${notification.id} has human-in-the-loop enabled — releasing to human.`,
        );
        await client.releaseNotification({
          notificationId: notification.id,
          claimedAt,
          accessToken: auth.tokens.accessToken,
        });
        await dedupDispatchHumanNotification(api, config, claim.notification, dispatchedNotificationIds);
        continue;
      }

      // ── After approval: re-run the bridge command so the agent actually replies ──
      if (claimAutomation?.approvalStatus === "approved") {
        api.logger.info(
          `[vinsta] Notification ${notification.id} was approved — running bridge command.`,
        );
        // Fall through to normal bridge command execution below
      }

      // ── Inbound content screening ──
      if (config.bridgeContentGuardEnabled) {
        const inboundScreen = screenInbound(
          notification.body,
          config.bridgeContentGuardCustomInboundPatterns.length > 0
            ? config.bridgeContentGuardCustomInboundPatterns
            : undefined,
        );

        if (!inboundScreen.allowed) {
          api.logger.info(
            `[vinsta] Content guard blocked inbound ${notification.id}: ${inboundScreen.reason}`,
          );
          commandCompleted = true;
          const blockedCompletion: PendingBridgeCompletion = {
            notificationId: notification.id,
            claimedAt,
            reply: config.bridgeAutoReply ? config.bridgeContentGuardBlockMessage : undefined,
            archive: Boolean(config.bridgeArchiveOnSuccess),
            humanNotification: buildHumanSummaryNotification({
              original: notification,
              handle: config.handle,
              summary: `Blocked by content guard: ${inboundScreen.reason}`,
            }),
          };

          try {
            await client.completeBridgeNotification({
              notificationId: blockedCompletion.notificationId,
              claimedAt: blockedCompletion.claimedAt,
              accessToken: auth.tokens.accessToken,
              reply: blockedCompletion.reply,
              archive: blockedCompletion.archive,
            });
            if (blockedCompletion.humanNotification) {
              await dedupDispatchHumanNotification(api, config, blockedCompletion.humanNotification, dispatchedNotificationIds);
            }
          } catch (error) {
            pendingCompletions.set(notification.id, blockedCompletion);
            api.logger.error(
              `[vinsta] Failed to complete blocked notification ${notification.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
          processed += 1;
          continue;
        }
      }

      // ── Special handling for capability-denied review notifications ──
      const isGrantReview =
        notification.type === "review" &&
        (notification as any).actionRequest?.variant === "grant";

      if (isGrantReview) {
        const senderHandle = parseSenderHandle(notification) ?? "unknown";
        const capability = (notification.metadata as any)?.capability ?? "";
        const capLabel = (notification.metadata as any)?.capabilityLabel ?? capability;

        // Build a prompt that presents clear choices to the user's agent
        const grantPrompt: VinstaNotification = {
          ...notification,
          body:
            `${notification.body}\n\n` +
            `How would you like to handle this? Reply with ONLY one of these options:\n` +
            `1. "permit always" — upgrade their trust tier so this capability is always allowed\n` +
            `2. "permit once" — allow this one time without changing their trust tier\n` +
            `3. "deny" — decline and keep current permissions\n\n` +
            `Reply with just the option text (e.g. "permit always").`,
        };

        const result = await runBridgeCommand(
          config.bridgeCommand,
          grantPrompt,
          config.handle,
        );

        if (result.exitCode !== 0) {
          await surfaceBridgeFailure(notification, claimedAt);
          api.logger.error(
            `[vinsta] Grant review command failed for ${notification.id} with exit ${result.exitCode}`,
          );
          continue;
        }

        commandCompleted = true;

        // Parse the agent's choice from the bridge response
        const rawAction = parseBridgeAction(result);
        const responseText = (rawAction.reply ?? result.stdout ?? "").toLowerCase().trim();

        let grantAction: "permit_always" | "permit_once" | "deny" = "deny";
        if (responseText.includes("permit always") || responseText.includes("always")) {
          grantAction = "permit_always";
        } else if (
          responseText.includes("permit once") ||
          responseText.includes("one time") ||
          responseText.includes("this time") ||
          responseText.includes("once")
        ) {
          grantAction = "permit_once";
        }

        // Call the grant API
        try {
          const grantResult = await client.grantPermission({
            accessToken: auth.tokens.accessToken,
            action: grantAction,
            senderHandle,
            capability: capability || undefined,
            notificationId: notification.id,
          });
          const humanSummary = grantResult.message ?? `Permission ${grantAction.replace(/_/g, " ")} for @${senderHandle}.`;

          const pendingCompletion: PendingBridgeCompletion = {
            notificationId: notification.id,
            claimedAt,
            reply: undefined,
            archive: true,
            humanNotification: buildHumanSummaryNotification({
              original: notification,
              handle: config.handle,
              summary: humanSummary,
            }),
          };

          await client.completeBridgeNotification({
            notificationId: notification.id,
            claimedAt,
            accessToken: auth.tokens.accessToken,
            reply: undefined,
            archive: true,
          });
          if (pendingCompletion.humanNotification) {
            await dedupDispatchHumanNotification(api, config, pendingCompletion.humanNotification, dispatchedNotificationIds);
          }

          api.logger.info(
            `[vinsta] Grant review for ${notification.id}: action=${grantAction}, granted=${grantResult.granted}`,
          );
        } catch (error) {
          await surfaceBridgeFailure(notification, claimedAt);
          api.logger.error(
            `[vinsta] Failed to process grant review ${notification.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }

        processed += 1;
        continue;
      }

      const result = await runBridgeCommand(
        config.bridgeCommand,
        notification,
        config.handle,
      );

      if (result.exitCode !== 0) {
        await surfaceBridgeFailure(notification, claimedAt);
        api.logger.error(
          `[vinsta] Command failed for ${notification.id} with exit ${result.exitCode}${
            result.stderr ? `: ${result.stderr}` : ""
          }`,
        );
        continue;
      }

      commandCompleted = true;
      const action = parseBridgeAction(result);

      // ── Outbound content screening ──
      if (config.bridgeContentGuardEnabled && action.reply) {
        const outboundScreen = screenOutbound(
          action.reply,
          config.bridgeContentGuardCustomOutboundPatterns.length > 0
            ? config.bridgeContentGuardCustomOutboundPatterns
            : undefined,
        );

        if (!outboundScreen.allowed) {
          api.logger.info(
            `[vinsta] Content guard blocked outbound for ${notification.id}: ${outboundScreen.reason}`,
          );
          action.reply = config.bridgeContentGuardBlockMessage;
          action.notifyHuman = `Outbound reply blocked by content guard: ${outboundScreen.reason}`;
        }
      }
      // ── Per-sender reply rate limiter (prevents agent ping-pong loops) ──
      const sender = parseSenderHandle(notification);
      if (action.reply && sender && isRateLimited(senderReplyTimestamps, sender, replyRateLimitWindow, replyRateLimitMax)) {
        api.logger.info(
          `[vinsta] Rate-limited reply to @${sender} for ${notification.id} (>${replyRateLimitMax} replies in ${replyRateLimitWindow / 60_000}m)`,
        );
        action.reply = undefined;
        if (!action.notifyHuman) {
          action.notifyHuman = notification.body.trim();
        }
      }
      if (action.reply && sender) {
        recordTimestamp(senderReplyTimestamps, sender);
      }

      const finalOwnerSummary =
        action.notifyHuman ||
        (shouldUseNotifyBodyAsFinalSummary(notification, action)
          ? notification.body.trim()
          : undefined);
      const pendingCompletion: PendingBridgeCompletion = {
        notificationId: notification.id,
        claimedAt,
        reply:
          config.bridgeAutoReply && action.reply
            ? action.reply
            : undefined,
        archive: Boolean(action.archive ?? config.bridgeArchiveOnSuccess),
        humanNotification: finalOwnerSummary
          ? buildHumanSummaryNotification({
              original: notification,
              handle: config.handle,
              summary: finalOwnerSummary,
            })
          : undefined,
      };

      try {
        await client.completeBridgeNotification({
          notificationId: notification.id,
          claimedAt,
          accessToken: auth.tokens.accessToken,
          reply: pendingCompletion.reply,
          archive: pendingCompletion.archive,
        });
        if (pendingCompletion.humanNotification) {
          const completionSender = parseSenderHandle(notification);
          if (completionSender && isRateLimited(senderNotifyTimestamps, completionSender, inboundNotifyRateLimitWindow, inboundNotifyRateLimitMax)) {
            api.logger.info(
              `[vinsta] Rate-limited bridge notification from @${completionSender} for ${notification.id}`,
            );
          } else {
            if (completionSender) recordTimestamp(senderNotifyTimestamps, completionSender);
            await dedupDispatchHumanNotification(api, config, pendingCompletion.humanNotification, dispatchedNotificationIds);
          }
        }
      } catch (error) {
        pendingCompletions.set(notification.id, pendingCompletion);
        api.logger.error(
          `[vinsta] Failed to finalize notification ${notification.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      processed += 1;
    } catch (error) {
      if (claimedAt && !commandCompleted) {
        await surfaceBridgeFailure(notification, claimedAt);
      }

      api.logger.error(
        `[vinsta] ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight.delete(notification.id);
    }
  }

  return {
    active: true,
    processed,
    notified,
    handle: config.handle,
    unreadCount: payload.unreadCount,
  };
}

export function createVinstaInboundBridge(api: OpenClawPluginApi) {
  const inFlight = new Set<string>();
  const pendingCompletions = new Map<string, PendingBridgeCompletion>();
  const trackedNotificationIds = new Set<string>();
  const dispatchedNotificationIds = new Set<string>();
  const failedBridgeNotificationIds = new Map<string, number>();
  const senderReplyTimestamps = new Map<string, number[]>();
  const senderNotifyTimestamps = new Map<string, number[]>();
  const primedNotificationIds = new Set<string>();
  let lastDispatchedUpdateVersion: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let streamAbortController: AbortController | null = null;
  let streamTask: Promise<void> | null = null;
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let notificationsPrimed = false;
  let lastStatus: BridgeStatus = {
    active: false,
    processed: 0,
    notified: 0,
    handle: null,
  };

  const observeNotifications = async (
    notifications: VinstaNotification[],
    config: ReturnType<typeof resolveVinstaPluginConfig>,
    ctx?: { client: VinstaClient; accessToken: string },
  ) => {
    const sorted = [...notifications].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );

    if (!notificationsPrimed) {
      rememberNotificationIds(trackedNotificationIds, sorted);
      for (const n of sorted) primedNotificationIds.add(n.id);
      notificationsPrimed = true;
      return 0;
    }

    const freshNotifications = sorted.filter(
      (notification) => !notification.archivedAt && !trackedNotificationIds.has(notification.id),
    );

    rememberNotificationIds(trackedNotificationIds, sorted);

    const bridgeOwnsInitialHumanAlert = shouldSuppressFreshHumanNotificationForBridgeCommand(
      config.bridgeCommand,
    );

    for (const notification of freshNotifications) {
      const handledSilentlyByBridge =
        bridgeOwnsInitialHumanAlert && isBridgeActionableNotification(notification, config);

      if (handledSilentlyByBridge) {
        continue;
      }

      // ── Per-sender inbound notification rate limiter ──
      const sender = parseSenderHandle(notification);
      if (sender && isRateLimited(senderNotifyTimestamps, sender, inboundNotifyRateLimitWindow, inboundNotifyRateLimitMax)) {
        api.logger.info(
          `[vinsta] Rate-limited inbound notification from @${sender} for ${notification.id} (>${inboundNotifyRateLimitMax} in ${inboundNotifyRateLimitWindow / 60_000}m)`,
        );
      } else {
        if (sender) {
          recordTimestamp(senderNotifyTimestamps, sender);
        }

        // Cross-instance dedup: if another instance already dispatched externally,
        // only show in the local OpenClaw UI to avoid duplicate external delivery.
        if (notification.readAt) {
          await dedupDispatchHumanNotification(api, config, notification, dispatchedNotificationIds, { uiOnly: true });
        } else {
          await dedupDispatchHumanNotification(api, config, notification, dispatchedNotificationIds);
        }
      }

      // Archive after dispatch (or rate-limit skip) so it never reappears
      if (ctx && !notification.archivedAt) {
        try {
          await ctx.client.updateNotification({
            notificationId: notification.id,
            action: "archive",
            accessToken: ctx.accessToken,
          });
        } catch (error) {
          api.logger.warn(
            `[vinsta] Failed to archive notification ${notification.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return freshNotifications.length;
  };

  const runCycle = async () => {
    if (stopped) {
      return lastStatus;
    }

    if (running) {
      rerunRequested = true;
      return lastStatus;
    }

    running = true;

    try {
      do {
        rerunRequested = false;
        lastStatus = await processBridgeOnce(
          api,
          inFlight,
          pendingCompletions,
          failedBridgeNotificationIds,
          dispatchedNotificationIds,
          senderReplyTimestamps,
          senderNotifyTimestamps,
          primedNotificationIds,
          observeNotifications,
        );

        if (lastStatus.active && lastStatus.notified > 0) {
          api.logger.info(
            `[vinsta] Observed ${lastStatus.notified} new Vinsta inbox event(s) for @${lastStatus.handle}.`,
          );
        }

        if (lastStatus.active && lastStatus.processed > 0) {
          api.logger.info(
            `[vinsta] Processed ${lastStatus.processed} inbound notification(s) for @${lastStatus.handle}.`,
          );
        }
      } while (rerunRequested && !stopped);

      // Check for plugin updates after processing bridge work
      try {
        const current = readVinstaPluginEntry(api.runtime.config.loadConfig());
        const config = resolveVinstaPluginConfig(current, process.env);
        const updateResult = await maybeAutoUpdate(api, config);

        if (updateResult.updateAvailable && updateResult.latestVersion && lastDispatchedUpdateVersion !== updateResult.latestVersion) {
          lastDispatchedUpdateVersion = updateResult.latestVersion;
          const notification: VinstaNotification = {
            id: `plugin-update-${updateResult.latestVersion}`,
            recipientId: config.handle ?? "",
            senderId: "system",
            senderHandle: null,
            type: "notify",
            title: updateResult.autoUpdated
              ? `@openclaw/vinsta has been updated to v${updateResult.latestVersion}. Restart OpenClaw to apply.`
              : `@openclaw/vinsta v${updateResult.latestVersion} is available. Run: openclaw plugins update vinsta`,
            body: "",
            createdAt: new Date().toISOString(),
            readAt: null,
            bridgeClaimedAt: null,
            archivedAt: null,
          };
          await dedupDispatchHumanNotification(api, config, notification, dispatchedNotificationIds);
        }
      } catch (err) {
        api.logger.error(
          `[vinsta] Update check in bridge failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (error) {
      api.logger.error(
        `[vinsta] ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      running = false;
    }

    return lastStatus;
  };

  const schedule = async (delayMs: number) => {
    if (stopped || timer) {
      return;
    }

    timer = setTimeout(async () => {
      timer = null;

      try {
        await runCycle();
      } catch {
        // Polling is best-effort while the stream is unavailable.
      } finally {
        const current = resolveVinstaPluginConfig(
          readVinstaPluginEntry(api.runtime.config.loadConfig()),
          process.env,
        );

        if (!streamAbortController) {
          await schedule(current.bridgePollIntervalMs);
        }
      }
    }, delayMs);

    timer.unref?.();
  };

  const watchStream = async () => {
    while (!stopped) {
      const current = resolveVinstaPluginConfig(
        readVinstaPluginEntry(api.runtime.config.loadConfig()),
        process.env,
      );

      if (!current.bridgeEnabled || !current.handle) {
        return;
      }

      const client = new VinstaClient(current);

      try {
        const auth = await client.ensureAccessToken(current.oauth);

        if (auth.source === "refresh_token") {
          await persistResolvedOauth(api, persistableOauthState(auth.tokens));
        }

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        streamAbortController = new AbortController();

        await client.streamNotifications({
          accessToken: auth.tokens.accessToken,
          handle: current.handle,
          signal: streamAbortController.signal,
          onEvent: async (event) => {
            if (event.type === "snapshot" || event.type === "notification") {
              await runCycle();
            }
          },
        });
      } catch (error) {
        if (stopped) {
          return;
        }

        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        ) {
          return;
        }

        api.logger.error(
          `[vinsta] Notifications stream disconnected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        await schedule(0);
      } finally {
        streamAbortController = null;
      }

      if (!stopped) {
        await sleep(bridgeStreamReconnectMs);
      }
    }
  };

  const service: OpenClawPluginService = {
    id: "vinsta-inbound-bridge",
    start: async () => {
      const config = resolveVinstaPluginConfig(
        readVinstaPluginEntry(api.runtime.config.loadConfig()),
        process.env,
      );

      if (!config.bridgeEnabled) {
        return;
      }

      stopped = false;
      notificationsPrimed = false;
      trackedNotificationIds.clear();
      dispatchedNotificationIds.clear();
      primedNotificationIds.clear();
      lastDispatchedUpdateVersion = null;

      try {
        await runCycle();
      } catch {
        await schedule(0);
      }

      streamTask = watchStream();
    },
    stop: async () => {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      streamAbortController?.abort();
      streamAbortController = null;
      await streamTask?.catch(() => undefined);
      streamTask = null;
    },
  };

  return {
    service,
    runOnce: async () => runCycle(),
  };
}
