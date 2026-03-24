import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  buildVinstaStatus,
  resolveVinstaPluginConfig,
} from "./config.js";
import {
  readContacts,
  removeContact,
  searchContacts,
  upsertContact,
  writeContacts,
} from "./contacts.js";
import { refreshAndPersistToken } from "./refresh-token.js";
import { VinstaClient } from "./vinsta-client.js";

const actionValues = [
  "discover",
  "resolve",
  "inspect_card",
  "send_message",
  "auth_status",
  "health_check",
  "list_contacts",
  "save_contact",
  "remove_contact",
  "search_contacts",
] as const;

const vinstaToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...actionValues],
      description: "Vinsta action to perform.",
    },
    query: {
      type: "string",
      description: "Search query for discovery.",
    },
    handle: {
      type: "string",
      description: "Target handle for resolve or inspect_card.",
    },
    limit: {
      type: "number",
      description: "Optional discover result limit.",
    },
    to: {
      type: "string",
      description: "Recipient handle for send_message.",
    },
    text: {
      type: "string",
      description: "Message body for send_message.",
    },
    verify: {
      type: "boolean",
      description: "Verify signed agent card proof.",
    },
    name: {
      type: "string",
      description: "Contact display name for save_contact.",
    },
    nickname: {
      type: "string",
      description: "Contact nickname or relationship label for save_contact.",
    },
    notes: {
      type: "string",
      description: "Free-text notes for save_contact.",
    },
  },
  required: ["action"],
} as const;

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function createVinstaTool(api: OpenClawPluginApi) {
  return {
    name: "vinsta",
    description:
      "Use Vinsta for agent discovery, identity resolution, signed agent card inspection, authenticated A2A messaging, connection health checks, and local contact management. Use health_check to verify authentication is working and the bridge is always-on. Use list_contacts, save_contact, remove_contact, and search_contacts to manage a local contacts directory.",
    parameters: vinstaToolParameters,
    async execute(_id: string, params: Record<string, unknown>) {
      const config = resolveVinstaPluginConfig(api.pluginConfig, process.env);
      const client = new VinstaClient(config);
      const action = readString(params.action);

      if (action === "discover") {
        const query = readString(params.query);
        if (!query) {
          throw new Error("query required");
        }

        return jsonResult(
          await client.discover(
            query,
            typeof params.limit === "number" ? params.limit : undefined,
          ),
        );
      }

      if (action === "resolve") {
        const handle = readString(params.handle);
        if (!handle) {
          throw new Error("handle required");
        }

        return jsonResult(await client.resolve(handle));
      }

      if (action === "inspect_card") {
        const handle = readString(params.handle);
        if (!handle) {
          throw new Error("handle required");
        }

        return jsonResult(
          await client.getAgentCard(handle, {
            verify: typeof params.verify === "boolean" ? params.verify : true,
          }),
        );
      }

      if (action === "auth_status") {
        return jsonResult(buildVinstaStatus(config));
      }

      if (action === "send_message") {
        const to = readString(params.to);
        const text = readString(params.text);
        if (!to || !text) {
          throw new Error("to and text are required");
        }

        const result = await refreshAndPersistToken(api, config, client);

        const response = await client.sendMessage({
          to,
          text,
          accessToken: result.accessToken,
        });

        return jsonResult({
          authSource: result.source,
          response,
        });
      }

      if (action === "health_check") {
        const issues: string[] = [];
        const fixed: string[] = [];
        const status = buildVinstaStatus(config);

        // 1. Check basic configuration
        if (!config.handle) {
          issues.push("No handle configured. Run: openclaw vinsta configure --handle <your-handle>");
        }
        if (!config.clientId) {
          issues.push("No client ID configured. Generate setup commands from the Vinsta dashboard.");
        }
        if (status.authMode === "none") {
          issues.push("No authentication configured. Need either client_secret (confidential) or redirect_uri (PKCE).");
        }

        // 2. Try to ensure a valid token (auto-refreshes if needed)
        let tokenStatus = "missing";
        let tokenSource: string | null = null;
        if (status.authMode !== "none") {
          try {
            const result = await refreshAndPersistToken(api, config, client);
            tokenStatus = "valid";
            tokenSource = result.source;
            if (result.refreshed) {
              fixed.push(`Token refreshed via ${result.source} (expires in ${result.expiresInMinutes}m)`);
            }
          } catch (err) {
            tokenStatus = "expired_or_invalid";
            issues.push(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 3. Verify handle resolves on the network
        let handleResolvable = false;
        if (config.handle) {
          try {
            await client.resolve(config.handle);
            handleResolvable = true;
          } catch {
            issues.push(`Handle @${config.handle} could not be resolved on Vinsta. It may not be published yet.`);
          }
        }

        // 4. Check bridge configuration for always-on
        if (!config.bridgeEnabled) {
          issues.push("Bridge is disabled. Inbound messages will not be received. Enable with: openclaw vinsta configure --bridge-enabled");
        }
        if (config.bridgeEnabled && !config.bridgeCommand) {
          issues.push("Bridge is enabled but no bridge command is set. Configure with: openclaw vinsta configure --bridge-command <command>");
        }
        if (config.bridgeEnabled && !config.bridgeAutoReply) {
          issues.push("Bridge auto-reply is off. Agent replies will not be sent back automatically. Enable with: openclaw vinsta configure --bridge-auto-reply");
        }

        // 5. Test connectivity with a discovery call if authenticated
        let connectivityOk = false;
        if (tokenStatus === "valid") {
          try {
            await client.discover("vinsta", 1);
            connectivityOk = true;
          } catch {
            issues.push("Authenticated API call failed. The token may lack required scopes.");
          }
        }

        const healthy = issues.length === 0 && tokenStatus === "valid" && handleResolvable && connectivityOk;

        return jsonResult({
          healthy,
          handle: config.handle ?? null,
          authMode: status.authMode,
          tokenStatus,
          tokenSource,
          handleResolvable,
          bridgeEnabled: config.bridgeEnabled,
          bridgeAutoReply: config.bridgeAutoReply,
          bridgeArchiveOnSuccess: config.bridgeArchiveOnSuccess,
          connectivityOk,
          expiresAt: status.expiresAt,
          expiresInSeconds: status.expiresInSeconds,
          issues,
          fixed,
        });
      }

      if (action === "list_contacts") {
        const contacts = await readContacts();
        return jsonResult(contacts);
      }

      if (action === "save_contact") {
        const handle = readString(params.handle);
        if (!handle) {
          throw new Error("handle required");
        }

        const contacts = await readContacts();
        const updated = upsertContact(contacts, {
          handle,
          name: readString(params.name) || undefined,
          nickname: readString(params.nickname) || undefined,
          notes: readString(params.notes) || undefined,
        });
        await writeContacts(updated);

        const saved = updated.find(
          (c) => c.handle === handle.toLowerCase().replace(/^@/, ""),
        );
        return jsonResult(saved);
      }

      if (action === "remove_contact") {
        const handle = readString(params.handle);
        if (!handle) {
          throw new Error("handle required");
        }

        const contacts = await readContacts();
        const updated = removeContact(contacts, handle);
        await writeContacts(updated);
        return jsonResult({ removed: handle, remaining: updated.length });
      }

      if (action === "search_contacts") {
        const query = readString(params.query);
        if (!query) {
          throw new Error("query required");
        }

        const contacts = await readContacts();
        return jsonResult(searchContacts(contacts, query));
      }

      throw new Error(`Unsupported vinsta action: ${action}`);
    },
  };
}
