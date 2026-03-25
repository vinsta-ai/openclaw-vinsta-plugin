import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  normalizeAgentId,
  type OpenClawPluginApi,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk";

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
  stripVinstaPluginFromNotifyConfig,
  type NotificationAutomationState,
} from "./inbound-bridge-helpers.js";
import { maybeAutoUpdate, type MaybeAutoUpdateResult } from "./update-check.js";

type BridgeCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

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

async function runBridgeCommand(command: string, notification: VinstaNotification, handle: string) {
  return new Promise<BridgeCommandResult>((resolve, reject) => {
    const senderHandle = parseSenderHandle(notification);
    const automation = readNotificationAutomationState(notification);
    const payload = JSON.stringify(
      {
        notification,
        handle,
        senderHandle,
      },
      null,
      2,
    );
    const child = spawn(process.env.SHELL || "sh", ["-lc", command], {
      env: {
        ...process.env,
        VINSTA_HANDLE: handle,
        VINSTA_NOTIFICATION_ID: notification.id,
        VINSTA_NOTIFICATION_TYPE: notification.type,
        VINSTA_NOTIFICATION_TITLE: notification.title,
        VINSTA_NOTIFICATION_BODY: notification.body,
        VINSTA_MESSAGE_BODY: notification.body,
        VINSTA_FROM_HANDLE: senderHandle ?? "",
        VINSTA_AGENT_AUTO_STEP: automation ? String(automation.autoStep) : "",
        VINSTA_AGENT_AUTO_LIMIT: automation ? String(automation.autoLimit) : "",
        VINSTA_AGENT_APPROVAL_STATUS: automation?.approvalStatus ?? "",
        VINSTA_AGENT_STOP_REASON: automation?.stopReason ?? "",
        VINSTA_HUMAN_IN_THE_LOOP: automation?.humanInLoopEnabled ? "1" : "0",
        VINSTA_NOTIFICATION_JSON: payload,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode ?? 1,
      });
    });

    child.stdin.end(payload);
  });
}

async function runBridgeNotifyCommand(
  command: string,
  notification: VinstaNotification,
  handle: string,
) {
  return new Promise<BridgeCommandResult>((resolve, reject) => {
    const senderHandle = parseSenderHandle(notification);
    const automation = readNotificationAutomationState(notification);
    const payload = JSON.stringify(
      {
        notification,
        handle,
        senderHandle,
      },
      null,
      2,
    );
    const child = spawn(process.env.SHELL || "sh", ["-lc", command], {
      env: {
        ...process.env,
        VINSTA_HANDLE: handle,
        VINSTA_NOTIFICATION_ID: notification.id,
        VINSTA_NOTIFICATION_TYPE: notification.type,
        VINSTA_NOTIFICATION_TITLE: notification.title,
        VINSTA_NOTIFICATION_BODY: notification.body,
        VINSTA_MESSAGE_BODY: notification.body,
        VINSTA_FROM_HANDLE: senderHandle ?? "",
        VINSTA_AGENT_AUTO_STEP: automation ? String(automation.autoStep) : "",
        VINSTA_AGENT_AUTO_LIMIT: automation ? String(automation.autoLimit) : "",
        VINSTA_AGENT_APPROVAL_STATUS: automation?.approvalStatus ?? "",
        VINSTA_AGENT_STOP_REASON: automation?.stopReason ?? "",
        VINSTA_HUMAN_IN_THE_LOOP: automation?.humanInLoopEnabled ? "1" : "0",
        VINSTA_NOTIFICATION_JSON: payload,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode ?? 1,
      });
    });

    child.stdin.end(payload);
  });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function withNotifyConfigPath<T>(
  api: OpenClawPluginApi,
  runner: (configPath: string) => Promise<T>,
) {
  const currentConfig = api.runtime.config.loadConfig();
  const childConfig = stripVinstaPluginFromNotifyConfig(currentConfig);
  const tempDir = await mkdtemp(path.join(tmpdir(), "vinsta-openclaw-notify-"));
  const configPath = path.join(tempDir, "openclaw-notify.json");

  try {
    await writeFile(configPath, `${JSON.stringify(childConfig, null, 2)}\n`, "utf8");
    return await runner(configPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runOpenClawNativeNotifyTarget(input: {
  api: OpenClawPluginApi;
  channel: string;
  to: string;
  accountId?: string;
  text: string;
}) {
  const command = [
    "openclaw message send",
    `--channel ${shellQuote(input.channel)}`,
    ...(input.accountId ? [`--account ${shellQuote(input.accountId)}`] : []),
    `--target ${shellQuote(input.to)}`,
    `--message ${shellQuote(input.text)}`,
  ].join(" ");

  return withNotifyConfigPath(input.api, (configPath) => {
    return new Promise<BridgeCommandResult>((resolve, reject) => {
      const child = spawn(process.env.SHELL || "sh", ["-lc", command], {
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode ?? 1,
        });
      });
    });
  });
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
        ? `Thread with ${senderLabel} reached the ${automation.autoLimit}-turn auto-limit.`
        : `Thread with ${senderLabel} needs your approval before continuing.`;
    return `[vinsta] ${reason} Tell your agent to approve or reject this thread (notification_id: ${notification.id}).`;
  }

  const body = notification.body.trim();
  const maxLen = 500;
  const truncated = body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;

  if (body) {
    return `[vinsta] ${senderLabel}: ${truncated}`;
  }

  return `[vinsta] ${notification.title.trim()}`;
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
    `[vinsta] New ${notification.type.replace(/_/g, " ")} for @${config.handle}: ${notification.title}`,
  );
}

async function dispatchHumanNotification(
  api: OpenClawPluginApi,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  notification: VinstaNotification,
) {
  const sanitized = maybeSanitizeHumanNotificationForDelivery(
    notification,
    config.bridgeContentGuardEnabled,
    config.bridgeContentGuardCustomOutboundPatterns.length > 0
      ? config.bridgeContentGuardCustomOutboundPatterns
      : undefined,
  );
  const safeNotification = sanitized.notification as VinstaNotification;

  if (sanitized.redacted) {
    api.logger.info(
      `[vinsta] Content guard redacted owner summary for ${notification.id}: ${
        sanitized.reason ?? "matched an outbound guard pattern"
      }`,
    );
  }

  // Step 1: Explicit bridgeNotifyTargets
  if (await dispatchHumanNotificationViaOpenClaw(api, config, safeNotification)) {
    return;
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

    if (await dispatchHumanNotificationViaOpenClaw(api, originConfig, safeNotification)) {
      return;
    }
  }

  // Step 3: Auto-discover from OpenClaw channel config
  if (config.bridgeNotifyTargets.length === 0) {
    const discovered = discoverNotifyTargetsFromOpenClawConfig(
      api.runtime.config.loadConfig(),
    );

    if (discovered.length > 0) {
      const autoConfig = { ...config, bridgeNotifyTargets: discovered };

      if (await dispatchHumanNotificationViaOpenClaw(api, autoConfig, safeNotification)) {
        return;
      }
    }
  }

  // Step 4: Legacy bridgeNotifyCommand
  if (config.bridgeNotifyCommand) {
    try {
      const result = await runBridgeNotifyCommand(
        config.bridgeNotifyCommand,
        safeNotification,
        config.handle!,
      );

      if (result.exitCode !== 0) {
        api.logger.error(
          `[vinsta] Notification command failed for ${notification.id} with exit ${result.exitCode}${
            result.stderr ? `: ${result.stderr}` : ""
          }`,
        );
      } else {
        return;
      }
    } catch (error) {
      api.logger.error(
        `[vinsta] Failed to notify for ${notification.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  dispatchHumanNotificationToOpenClawUi(api, config, safeNotification);
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

    return {
      reply: typeof parsed.reply === "string" ? parsed.reply.trim() : undefined,
      notifyHuman: notifyHuman || undefined,
      archive: typeof parsed.archive === "boolean" ? parsed.archive : undefined,
    };
  } catch {
    return {
      reply: result.stdout,
    };
  }
}

function shouldUseNotifyBodyAsFinalSummary(
  notification: VinstaNotification,
  action: BridgeAction,
) {
  return notification.type === "notify" && !action.reply && action.archive !== true;
}

async function flushPendingCompletions(
  api: OpenClawPluginApi,
  client: VinstaClient,
  config: ReturnType<typeof resolveVinstaPluginConfig>,
  accessToken: string,
  pendingCompletions: Map<string, PendingBridgeCompletion>,
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
        await dispatchHumanNotification(api, config, completion.humanNotification);
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

async function processBridgeOnce(
  api: OpenClawPluginApi,
  inFlight: Set<string>,
  pendingCompletions: Map<string, PendingBridgeCompletion>,
  failedBridgeNotificationIds: Map<string, number>,
  observeNotifications?: (
    notifications: VinstaNotification[],
    config: ReturnType<typeof resolveVinstaPluginConfig>,
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
  );

  const payload = await client.listNotifications({
    accessToken: auth.tokens.accessToken,
    handle: config.handle,
  });
  const notified = observeNotifications
    ? await observeNotifications(payload.notifications, config)
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

    await dispatchHumanNotification(api, config, notification);
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

      // ── Post-approval: notify human and archive, do NOT re-run bridge command ──
      const claimAutomation = readNotificationAutomationState(claim.notification);
      if (claimAutomation?.approvalStatus === "approved") {
        commandCompleted = true;
        api.logger.info(
          `[vinsta] Notification ${notification.id} was approved — notifying human and archiving.`,
        );

        try {
          await client.completeBridgeNotification({
            notificationId: notification.id,
            claimedAt,
            accessToken: auth.tokens.accessToken,
            archive: true,
          });
          await dispatchHumanNotification(api, config, notification);
        } catch (error) {
          pendingCompletions.set(notification.id, {
            notificationId: notification.id,
            claimedAt,
            archive: true,
            humanNotification: notification,
          });
          api.logger.error(
            `[vinsta] Failed to complete approved notification ${notification.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        processed += 1;
        continue;
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
              await dispatchHumanNotification(api, config, blockedCompletion.humanNotification);
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
          const grantUrl = `${config.appUrl.replace(/\/$/, "")}/api/permissions/grant`;
          const grantResponse = await fetch(grantUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${auth.tokens.accessToken}`,
            },
            body: JSON.stringify({
              action: grantAction,
              senderHandle,
              capability: capability || undefined,
              notificationId: notification.id,
            }),
          });

          const grantResult = (await grantResponse.json()) as { message?: string; granted?: boolean };
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
            await dispatchHumanNotification(api, config, pendingCompletion.humanNotification);
          }

          api.logger.info(
            `[vinsta] Grant review for ${notification.id}: action=${grantAction}, granted=${grantResult.granted}`,
          );
        } catch (error) {
          api.logger.error(
            `[vinsta] Failed to process grant review ${notification.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
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
          await dispatchHumanNotification(api, config, pendingCompletion.humanNotification);
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
  const failedBridgeNotificationIds = new Map<string, number>();
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
  ) => {
    const sorted = [...notifications].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );

    if (!notificationsPrimed) {
      rememberNotificationIds(trackedNotificationIds, sorted);
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
      await dispatchHumanNotification(api, config, notification);
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

        if (updateResult.updateAvailable && updateResult.latestVersion) {
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
          await dispatchHumanNotification(api, config, notification);
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
