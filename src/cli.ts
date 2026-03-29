import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  buildVinstaStatus,
  parseBridgeNotifyTarget,
  readVinstaPluginEntry,
  resolveVinstaPluginConfig,
  type StoredVinstaOAuthConfig,
  type VinstaBridgeNotifyTarget,
  type VinstaPluginConfig,
  updateVinstaPluginConfig,
} from "./config.js";
import { parseAuthorizationCallbackUrl } from "./oauth-callback.js";
import { persistableOauthState, VinstaClient } from "./vinsta-client.js";
import { checkForUpdate, formatUpdateNotice, performAutoUpdate } from "./update-check.js";

type BridgeController = {
  runOnce: () => Promise<unknown>;
};

function printJson(payload: unknown) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScopes(values: string[] | undefined) {
  return (values ?? []).map((item) => item.trim()).filter(Boolean);
}

function collectRepeatedString(value: string, previous: string[] = []) {
  return [...previous, value];
}

function parseNotifyTargetOptions(values: string[] | undefined): VinstaBridgeNotifyTarget[] {
  return (values ?? []).map((value) => {
    const parsed = parseBridgeNotifyTarget(value);

    if (!parsed) {
      throw new Error(
        `Invalid --bridge-notify-target value: ${value}. Use channel=<id>,to=<target>[,accountId=<id>].`,
      );
    }

    return parsed;
  });
}

function mergedPluginConfig(api: OpenClawPluginApi) {
  return resolveVinstaPluginConfig(
    readVinstaPluginEntry(api.runtime.config.loadConfig()),
    process.env,
  );
}

async function persistOauth(api: OpenClawPluginApi, oauth: StoredVinstaOAuthConfig) {
  await updateVinstaPluginConfig(api.runtime, (current) => ({
    ...current,
    oauth: {
      ...(current.oauth as StoredVinstaOAuthConfig | undefined),
      ...oauth,
    },
  }));
}

async function persistResolvedOauth(
  api: OpenClawPluginApi,
  stored: StoredVinstaOAuthConfig,
) {
  await persistOauth(api, {
    ...stored,
    pendingState: undefined,
    pendingCodeVerifier: undefined,
    pendingCodeChallenge: undefined,
  });
}

export function registerVinstaCli(params: {
  program: Command;
  api: OpenClawPluginApi;
  bridge: BridgeController;
}) {
  const { program, api, bridge } = params;
  const root = program.command("vinsta").description("Vinsta identity and network utilities");

  root
    .command("status")
    .description("Show current Vinsta plugin status")
    .action(async () => {
      const status = buildVinstaStatus(mergedPluginConfig(api));
      const cached = await checkForUpdate();
      printJson({
        ...status,
        ...(cached?.available
          ? { updateAvailable: cached.latestVersion, currentVersion: cached.currentVersion }
          : {}),
      });
    });

  root
    .command("check-update")
    .description("Check for a newer version of the @openclaw/vinsta plugin")
    .action(async () => {
      const result = await checkForUpdate({ force: true });
      if (!result) {
        printJson({ error: "Unable to check for updates. GitHub API may be unreachable." });
        return;
      }
      if (!result.available) {
        printJson({ upToDate: true, currentVersion: result.currentVersion });
        return;
      }
      process.stderr.write(`${formatUpdateNotice(result.latestVersion, result.currentVersion)}\n`);
      printJson({
        updateAvailable: true,
        latestVersion: result.latestVersion,
        currentVersion: result.currentVersion,
      });

      // Interactive prompt: ask whether to update now
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question("Update now? [Y/n] ", (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase());
        });
      });

      if (answer === "" || answer === "y" || answer === "yes") {
        process.stderr.write("Updating...\n");
        const updateResult = await performAutoUpdate(api);
        printJson(updateResult);
      }
    });

  root
    .command("configure")
    .description("Persist Vinsta plugin settings into OpenClaw config")
    .option("--app-url <url>", "Vinsta base URL")
    .option("--handle <handle>", "OpenClaw's linked Vinsta handle")
    .option("--client-id <id>", "Vinsta OAuth client id")
    .option("--client-secret <secret>", "Vinsta OAuth client secret")
    .option("--redirect-uri <uri>", "OAuth redirect URI for PKCE clients")
    .option("--resource <resource>", "Optional OAuth resource")
    .option("--scope <scope...>", "OAuth scopes")
    .option("--bridge-enabled", "Enable the local inbound Vinsta bridge", false)
    .option("--bridge-disabled", "Disable the local inbound Vinsta bridge", false)
    .option("--bridge-command <command>", "Local shell command to run for inbound Vinsta messages")
    .option(
      "--bridge-notify-target <target>",
      "Repeatable OpenClaw-native notify route: channel=<id>,to=<target>[,accountId=<id>]",
      collectRepeatedString,
      [],
    )
    .option(
      "--bridge-notify-command <command>",
      "Optional legacy shell fallback for new Vinsta inbox events; prefer --bridge-notify-target when possible",
    )
    .option("--clear-bridge-notify-targets", "Remove stored OpenClaw-native notify routes", false)
    .option("--bridge-poll-interval-ms <ms>", "Polling interval for the inbound Vinsta bridge")
    .option("--bridge-auto-reply", "Send command stdout back to the sender automatically")
    .option("--bridge-no-auto-reply", "Do not auto-reply from command stdout")
    .option("--bridge-archive-on-success", "Archive handled inbox items after the bridge command succeeds")
    .option("--bridge-no-archive-on-success", "Mark handled inbox items read instead of archiving them")
    .option("--access-token <token>", "Pre-issued OAuth access token")
    .option("--refresh-token <token>", "Pre-issued OAuth refresh token")
    .option("--clear-client-secret", "Remove the stored client secret", false)
    .option("--clear-tokens", "Remove stored access/refresh tokens", false)
    .action(
      async (options: {
        appUrl?: string;
        handle?: string;
        clientId?: string;
        clientSecret?: string;
        redirectUri?: string;
        resource?: string;
        scope?: string[];
        accessToken?: string;
        refreshToken?: string;
        bridgeEnabled?: boolean;
        bridgeDisabled?: boolean;
        bridgeCommand?: string;
        bridgeNotifyTarget?: string[];
        bridgeNotifyCommand?: string;
        clearBridgeNotifyTargets?: boolean;
        bridgePollIntervalMs?: string;
        bridgeAutoReply?: boolean;
        bridgeNoAutoReply?: boolean;
        bridgeArchiveOnSuccess?: boolean;
        bridgeNoArchiveOnSuccess?: boolean;
        clearClientSecret?: boolean;
        clearTokens?: boolean;
      }) => {
        const notifyTargets = parseNotifyTargetOptions(options.bridgeNotifyTarget);

        const updated = await updateVinstaPluginConfig(api.runtime, (current) => {
          const next: VinstaPluginConfig = { ...current };
          const nextOauth = { ...(current.oauth as StoredVinstaOAuthConfig | undefined) };

          if (options.appUrl) {
            next.appUrl = options.appUrl;
          }
          if (options.handle) {
            next.handle = options.handle.replace(/^@/, "").trim().toLowerCase();
          }
          if (options.clientId) {
            next.clientId = options.clientId;
          }
          if (options.clientSecret) {
            next.clientSecret = options.clientSecret;
          }
          if (options.redirectUri) {
            next.redirectUri = options.redirectUri;
          }
          if (options.resource) {
            next.resource = options.resource;
          }
          if (options.scope?.length) {
            next.scopes = normalizeScopes(options.scope);
          }
          if (options.bridgeEnabled) {
            next.bridgeEnabled = true;
          }
          if (options.bridgeDisabled) {
            next.bridgeEnabled = false;
          }
          if (options.bridgeCommand) {
            next.bridgeCommand = options.bridgeCommand;
          }
          if (notifyTargets.length > 0) {
            next.bridgeNotifyTargets = notifyTargets;
          }
          if (options.bridgeNotifyCommand) {
            next.bridgeNotifyCommand = options.bridgeNotifyCommand;
          }
          if (options.clearBridgeNotifyTargets) {
            next.bridgeNotifyTargets = [];
          }
          if (options.bridgePollIntervalMs) {
            const parsed = Number.parseInt(options.bridgePollIntervalMs, 10);

            if (Number.isFinite(parsed) && parsed > 0) {
              next.bridgePollIntervalMs = parsed;
            }
          }
          if (options.bridgeAutoReply) {
            next.bridgeAutoReply = true;
          }
          if (options.bridgeNoAutoReply) {
            next.bridgeAutoReply = false;
          }
          if (options.bridgeArchiveOnSuccess) {
            next.bridgeArchiveOnSuccess = true;
          }
          if (options.bridgeNoArchiveOnSuccess) {
            next.bridgeArchiveOnSuccess = false;
          }
          if (options.accessToken) {
            nextOauth.accessToken = options.accessToken;
            nextOauth.expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
          }
          if (options.refreshToken) {
            nextOauth.refreshToken = options.refreshToken;
          }
          if (options.clearClientSecret) {
            next.clientSecret = undefined;
          }
          if (options.clearTokens) {
            nextOauth.accessToken = undefined;
            nextOauth.refreshToken = undefined;
            nextOauth.expiresAt = undefined;
            nextOauth.pendingState = undefined;
            nextOauth.pendingCodeVerifier = undefined;
            nextOauth.pendingCodeChallenge = undefined;
          }

          next.oauth = nextOauth;
          return next;
        });

        printJson(buildVinstaStatus(resolveVinstaPluginConfig(updated, process.env)));
      },
    );

  root
    .command("login")
    .description("Open the browser to complete Vinsta OAuth login automatically")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .option("--timeout <seconds>", "Timeout in seconds (default: 120)", "120")
    .action(async (options: { browser?: boolean; timeout?: string }) => {
      const config = mergedPluginConfig(api);
      const client = new VinstaClient(config);
      const request = await client.buildAuthorizationRequest();

      await persistOauth(api, {
        pendingState: request.state,
        pendingCodeVerifier: request.codeVerifier,
        pendingCodeChallenge: request.codeChallenge,
      });

      const redirectUri = config.redirectUri ?? "http://127.0.0.1:8787/callback";
      const parsedUri = new URL(redirectUri);
      const port = Number.parseInt(parsedUri.port || "8787", 10);
      const callbackPath = parsedUri.pathname;
      const timeoutMs = (Number.parseInt(options.timeout ?? "120", 10) || 120) * 1000;

      const { createServer } = await import("node:http");
      const { exec } = await import("node:child_process");

      const result = await new Promise<{ code: string; state: string }>((resolve, reject) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

          if (url.pathname !== callbackPath) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDescription = url.searchParams.get("error_description");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

          if (error) {
            res.end(
              "<html><body style=\"font-family:system-ui;text-align:center;padding:60px\">" +
              `<h1>Authorization failed</h1><p>${errorDescription || error}</p>` +
              "<p>You can close this tab.</p></body></html>",
            );
            clearTimeout(timer);
            server.close();
            reject(new Error(errorDescription || error));
          } else if (code) {
            res.end(
              "<html><body style=\"font-family:system-ui;text-align:center;padding:60px\">" +
              "<h1>Vinsta connected!</h1>" +
              "<p>You can close this tab and return to your terminal.</p></body></html>",
            );
            clearTimeout(timer);
            server.close();
            resolve({ code, state: state ?? "" });
          } else {
            res.end(
              "<html><body style=\"font-family:system-ui;text-align:center;padding:60px\">" +
              "<h1>Missing authorization code</h1>" +
              "<p>You can close this tab.</p></body></html>",
            );
            clearTimeout(timer);
            server.close();
            reject(new Error("Callback did not include an authorization code."));
          }
        });

        const timer = setTimeout(() => {
          server.close();
          reject(new Error("Login timed out waiting for browser callback."));
        }, timeoutMs);

        server.listen(port, "127.0.0.1", () => {
          if (options.browser !== false) {
            const openCmd =
              process.platform === "darwin"
                ? `open "${request.url}"`
                : process.platform === "win32"
                  ? `start "" "${request.url}"`
                  : `xdg-open "${request.url}"`;
            exec(openCmd);
            process.stderr.write(
              `Opening browser for Vinsta login...\nIf the browser didn't open, visit:\n${request.url}\n`,
            );
          } else {
            process.stderr.write(`Open this URL to log in:\n${request.url}\n`);
          }
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (err.code === "EADDRINUSE") {
            reject(new Error(`Port ${port} is already in use. Stop the other process or use a different redirect URI.`));
          } else {
            reject(err);
          }
        });
      });

      if (!request.state || !result.state || request.state !== result.state) {
        throw new Error("Returned state does not match the pending auth request.");
      }

      const tokens = await client.exchangeAuthorizationCode({
        code: result.code,
        codeVerifier: request.codeVerifier,
      });

      await persistResolvedOauth(api, persistableOauthState(tokens));

      printJson({
        success: true,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        hasRefreshToken: Boolean(tokens.refreshToken),
      });
    });

  root
    .command("auth-url")
    .description("Generate a Vinsta OAuth authorization URL and persist the PKCE verifier")
    .action(async () => {
      const config = mergedPluginConfig(api);
      const client = new VinstaClient(config);
      const request = await client.buildAuthorizationRequest();

      await persistOauth(api, {
        pendingState: request.state,
        pendingCodeVerifier: request.codeVerifier,
        pendingCodeChallenge: request.codeChallenge,
      });

      printJson({
        url: request.url,
        state: request.state,
        redirectUri: config.redirectUri ?? null,
        handle: config.handle ?? null,
        scopes: config.scopes,
      });
    });

  root
    .command("exchange")
    .description("Exchange a returned Vinsta authorization code for stored tokens")
    .option("--code <code>", "Authorization code returned by Vinsta")
    .option("--url <url>", "Full callback URL returned by Vinsta")
    .option("--state <state>", "State returned by Vinsta")
    .action(async (options: { code?: string; url?: string; state?: string }) => {
      const current = readVinstaPluginEntry(api.runtime.config.loadConfig());
      const config = resolveVinstaPluginConfig(current, process.env);
      const expectedState = readString(current.oauth?.pendingState);
      const codeVerifier = readString(current.oauth?.pendingCodeVerifier);
      const callback = options.url ? parseAuthorizationCallbackUrl(options.url) : null;
      const code = readString(options.code) || callback?.code || "";
      const returnedState = readString(options.state) || callback?.state || "";

      if (!codeVerifier) {
        throw new Error("No pending PKCE verifier found. Run `openclaw vinsta auth-url` first.");
      }

      if (callback?.error) {
        throw new Error(callback.errorDescription ?? callback.error);
      }

      if (!code) {
        throw new Error("Provide either `--code` or `--url` with a returned authorization code.");
      }

      if (expectedState && returnedState && expectedState !== returnedState) {
        throw new Error("Returned state does not match the pending Vinsta auth request.");
      }

      const client = new VinstaClient(config);
      const tokens = await client.exchangeAuthorizationCode({
        code,
        codeVerifier,
      });

      await persistResolvedOauth(api, persistableOauthState(tokens));

      printJson({
        tokenType: tokens.tokenType,
        scope: tokens.scope,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        hasRefreshToken: Boolean(tokens.refreshToken),
        source: callback ? "callback_url" : "code",
      });
    });

  root
    .command("clear-auth")
    .description("Clear stored Vinsta tokens and pending PKCE state")
    .action(async () => {
      await persistOauth(api, {
        accessToken: undefined,
        refreshToken: undefined,
        expiresAt: undefined,
        pendingState: undefined,
        pendingCodeVerifier: undefined,
        pendingCodeChallenge: undefined,
      });
      printJson({ cleared: true });
    });

  root
    .command("discover")
    .description("Search the Vinsta directory")
    .requiredOption("--query <query>", "Search query")
    .option("--limit <n>", "Optional limit")
    .action(async (options: { query: string; limit?: string }) => {
      const client = new VinstaClient(mergedPluginConfig(api));
      const limit = options.limit ? Number(options.limit) : undefined;
      printJson(
        await client.discover(options.query, Number.isFinite(limit) ? limit : undefined),
      );
    });

  root
    .command("resolve")
    .description("Resolve a Vinsta handle")
    .argument("<handle>", "Handle to resolve")
    .action(async (handle: string) => {
      const client = new VinstaClient(mergedPluginConfig(api));
      printJson(await client.resolve(handle));
    });

  root
    .command("card")
    .description("Fetch and verify a signed Vinsta agent card")
    .argument("<handle>", "Handle to inspect")
    .option("--no-verify", "Skip signature verification")
    .action(async (handle: string, options: { verify?: boolean }) => {
      const client = new VinstaClient(mergedPluginConfig(api));
      printJson(
        await client.getAgentCard(handle, {
          verify: options.verify ?? true,
        }),
      );
    });

  root
    .command("send")
    .description("Send an A2A message through Vinsta from the configured handle")
    .requiredOption("--to <handle>", "Recipient handle")
    .requiredOption("--text <text>", "Message body")
    .action(async (options: { to: string; text: string }) => {
      const current = readVinstaPluginEntry(api.runtime.config.loadConfig());
      const config = resolveVinstaPluginConfig(current, process.env);
      const client = new VinstaClient(config);
      const auth = await client.ensureAccessToken(config.oauth);

      if (auth.source === "refresh_token") {
        await persistResolvedOauth(api, persistableOauthState(auth.tokens));
      }

      printJson(
        await client.sendMessage({
          to: options.to,
          text: options.text,
          accessToken: auth.tokens.accessToken,
        }),
      );
    });

  const bridgeRoot = root
    .command("bridge")
    .description("Run or inspect the local inbound Vinsta bridge");

  bridgeRoot
    .command("status")
    .description("Show the current inbound bridge configuration")
    .action(() => {
      const config = mergedPluginConfig(api);
      printJson({
        enabled: config.bridgeEnabled,
        command: config.bridgeCommand ?? null,
        notifyTargets: config.bridgeNotifyTargets,
        notifyCommand: config.bridgeNotifyCommand ?? null,
        pollIntervalMs: config.bridgePollIntervalMs,
        autoReply: config.bridgeAutoReply,
        archiveOnSuccess: config.bridgeArchiveOnSuccess,
        handle: config.handle ?? null,
      });
    });

  bridgeRoot
    .command("run-once")
    .description("Poll Vinsta once and process any unread inbound messages locally")
    .action(async () => {
      printJson(await bridge.runOnce());
    });

  bridgeRoot
    .command("watch")
    .description("Continuously poll Vinsta and hand inbound messages to a local command")
    .option("--interval-ms <ms>", "Override the polling interval for this foreground run")
    .action(async (options: { intervalMs?: string }) => {
      let intervalOverrideMs: number | null = null;

      if (options.intervalMs) {
        const parsed = Number.parseInt(options.intervalMs, 10);

        if (Number.isFinite(parsed) && parsed > 0) {
          intervalOverrideMs = parsed;
        }
      }

      printJson({
        watching: true,
        hint: "Use Ctrl+C to stop. Configure --bridge-command and --bridge-enabled first.",
      });

      for (;;) {
        printJson(await bridge.runOnce());
        const config = resolveVinstaPluginConfig(
          readVinstaPluginEntry(api.runtime.config.loadConfig()),
          process.env,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, intervalOverrideMs ?? config.bridgePollIntervalMs),
        );
      }
    });
}
