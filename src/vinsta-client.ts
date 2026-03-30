import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifyMessage,
} from "node:crypto";
import type { ResolvedVinstaPluginConfig, StoredVinstaOAuthConfig } from "./config.js";

type FetchImpl = typeof fetch;
type NodeJsonWebKey = import("node:crypto").JsonWebKey;

type AgentCardSignature = {
  protected: string;
  signature: string;
  header: {
    kid: string;
  };
};

type AgentCard = {
  name: string;
  description: string;
  version: string;
  provider: {
    organization: string;
    url: string;
  };
  capabilities: Record<string, unknown>;
  supportedInterfaces: Array<{
    url: string;
    transport: string;
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<Record<string, unknown>>;
  securitySchemes: Record<string, unknown>;
  securityRequirements: Array<Record<string, string[]>>;
  signatures?: AgentCardSignature[];
};

type MessageSignaturesDirectory = {
  keys: Array<{
    kid: string;
    kty: "OKP";
    crv: "Ed25519";
    x: string;
    alg?: "EdDSA";
    use?: "sig";
  }>;
  currentKid: string;
  nextKid?: string;
};

type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type OAuthTokenSource = "stored" | "refresh_token" | "client_credentials";

export type VinstaOAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  scope: string[];
  scopeString: string;
  expiresIn: number;
  expiresAt: number;
};

export type VinstaAuthRequest = {
  url: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  metadata: OAuthAuthorizationServerMetadata;
};

export type VinstaEnsureTokenResult = {
  source: OAuthTokenSource;
  tokens: VinstaOAuthTokenSet;
};

type VinstaConnectionConfig = {
  handle: string;
  did: string;
  profileUrl: string;
  resolveUrl: string;
  didDocumentUrl: string;
  agentCardUrl: string;
  a2aUrl: string;
  mcpUrl: string;
  messageSignaturesUrl: string;
  delegationUrl: string;
  oauth: {
    metadataUrl: string;
    authorizationUrl: string;
    tokenUrl: string;
    revocationUrl: string;
    scopes: string[];
    grantTypes: string[];
    codeChallengeMethods: string[];
  };
};

type DiscoverResult = {
  items: Array<Record<string, unknown>>;
  query: string;
  total: number;
  mode?: string;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

export type VinstaNotification = {
  id: string;
  recipientId: string;
  senderId?: string;
  senderHandle?: string | null;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  bridgeClaimedAt?: string | null;
  archivedAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

type NotificationListResponse = {
  handle: string;
  notifications: VinstaNotification[];
  unreadCount: number;
  authMode?: string;
};

type NotificationMutationResponse = {
  notification: VinstaNotification;
  authMode?: string;
};

export type VinstaNotificationStreamEvent = {
  type: "snapshot" | "notification" | "heartbeat";
  handle: string;
  unread: number;
  latestNotificationId?: string | null;
  authMode?: string;
  timestamp: string;
};

type VerifyCardResult = {
  card: AgentCard;
  verified: boolean;
  signatures: number;
};

const tokenRefreshWindowMs = 60_000;

const encode = (value: string) => Buffer.from(value).toString("base64url");

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(null);
}

function stripSignatures(card: AgentCard): Omit<AgentCard, "signatures"> {
  const { signatures: _signatures, ...unsignedCard } = card;
  return unsignedCard;
}

function normalizeHandle(handle: string) {
  return handle.replace(/^@/, "").trim().toLowerCase();
}

function normalizeScopes(scopes: string[] | string | undefined, fallback: string[] = []) {
  if (Array.isArray(scopes)) {
    return scopes.map((item) => item.trim()).filter(Boolean);
  }

  if (typeof scopes === "string") {
    return scopes
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [...fallback];
}

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function randomBase64Url(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function parseStoredTokenSet(stored: StoredVinstaOAuthConfig) {
  if (!stored.accessToken) {
    return null;
  }

  const expiresAt = stored.expiresAt ? Date.parse(stored.expiresAt) : NaN;

  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    tokenType: "Bearer" as const,
    scope: [],
    scopeString: "",
    expiresIn: Number.isFinite(expiresAt)
      ? Math.max(Math.floor((expiresAt - Date.now()) / 1000), 0)
      : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

function serializeTokens(tokens: VinstaOAuthTokenSet): StoredVinstaOAuthConfig {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  };
}

function parseTokenResponse(data: OAuthTokenResponse): VinstaOAuthTokenSet {
  if (!data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "OAuth token response was incomplete.");
  }

  const expiresIn =
    typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  const scope = normalizeScopes(data.scope);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: "Bearer",
    scope,
    scopeString: scope.join(" "),
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function withBearerHeaders(accessToken?: string, headers?: HeadersInit) {
  const result = new Headers(headers);

  if (accessToken) {
    result.set("authorization", `Bearer ${accessToken}`);
  }

  return result;
}

function parseSsePayload(buffer: string) {
  const frames: string[] = [];
  let remaining = buffer;

  for (;;) {
    const boundary = remaining.indexOf("\n\n");

    if (boundary === -1) {
      break;
    }

    frames.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary + 2);
  }

  return { frames, remaining };
}

async function fetchJson<T>(fetchImpl: FetchImpl, input: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(input, init);

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      if (body) {
        // Try to extract a human-readable message from JSON-RPC error responses
        try {
          const parsed = JSON.parse(body);
          const rpcMessage = parsed?.error?.message ?? parsed?.message;
          if (typeof rpcMessage === "string" && rpcMessage) {
            detail = `: ${rpcMessage}`;
          } else {
            detail = `: ${body.length > 300 ? body.slice(0, 300) + "…" : body}`;
          }
        } catch {
          detail = `: ${body.length > 300 ? body.slice(0, 300) + "…" : body}`;
        }
      }
    } catch {}
    throw new Error(`Request failed (${response.status})${detail}`);
  }

  return response.json() as Promise<T>;
}

async function fetchOAuthToken(
  fetchImpl: FetchImpl,
  url: string,
  params: URLSearchParams,
  options: { clientId: string; clientSecret?: string },
) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });

  if (options.clientSecret) {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
    );
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: params,
  });
  const payload = (await response.json().catch(() => null)) as OAuthTokenResponse | null;

  if (!response.ok || !payload) {
    throw new Error(
      payload?.error_description ?? payload?.error ?? `OAuth token request failed (${response.status}).`,
    );
  }

  return parseTokenResponse(payload);
}

function verifySignedAgentCard(card: AgentCard, directory: MessageSignaturesDirectory) {
  const encodedPayload = encode(canonicalize(stripSignatures(card)));

  return (card.signatures ?? []).some((signature) => {
    const key = directory.keys.find((candidate) => candidate.kid === signature.header.kid);

    if (!key) {
      return false;
    }

    return verifyMessage(
      null,
      Buffer.from(`${signature.protected}.${encodedPayload}`),
      createPublicKey({
        key: {
          kty: key.kty,
          crv: key.crv,
          x: key.x,
        } satisfies NodeJsonWebKey,
        format: "jwk",
      }),
      Buffer.from(signature.signature, "base64url"),
    );
  });
}

export class VinstaClient {
  private readonly fetchImpl: FetchImpl;
  private metadataPromise: Promise<OAuthAuthorizationServerMetadata> | null = null;
  private readonly connectionCache = new Map<string, Promise<VinstaConnectionConfig>>();

  constructor(
    private readonly config: ResolvedVinstaPluginConfig,
    options: {
      fetch?: FetchImpl;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private buildUrl(pathname: string) {
    return `${this.config.appUrl.replace(/\/$/, "")}${pathname}`;
  }

  async discover(query: string, limit?: number) {
    const url = new URL(this.buildUrl("/api/discover"));
    url.searchParams.set("q", query);

    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      url.searchParams.set("limit", String(Math.floor(limit)));
    }

    return fetchJson<DiscoverResult>(this.fetchImpl, url.toString());
  }

  async resolve(handle: string) {
    return fetchJson<Record<string, unknown>>(
      this.fetchImpl,
      this.buildUrl(`/api/resolve/${normalizeHandle(handle)}`),
    );
  }

  async getConnection(handle: string) {
    const normalized = normalizeHandle(handle);

    if (!this.connectionCache.has(normalized)) {
      this.connectionCache.set(
        normalized,
        fetchJson<VinstaConnectionConfig>(
          this.fetchImpl,
          this.buildUrl(`/api/agents/${normalized}/connect`),
        ),
      );
    }

    return this.connectionCache.get(normalized)!;
  }

  async getOAuthMetadata() {
    if (!this.metadataPromise) {
      this.metadataPromise = fetchJson<OAuthAuthorizationServerMetadata>(
        this.fetchImpl,
        this.buildUrl("/.well-known/oauth-authorization-server"),
      );
    }

    return this.metadataPromise;
  }

  async getAgentCard(handle: string, options: { verify?: boolean } = {}): Promise<VerifyCardResult> {
    const connection = await this.getConnection(handle);
    const card = await fetchJson<AgentCard>(this.fetchImpl, connection.agentCardUrl);
    let verified = false;

    if (options.verify ?? true) {
      const directory = await fetchJson<MessageSignaturesDirectory>(
        this.fetchImpl,
        connection.messageSignaturesUrl,
      );
      verified = verifySignedAgentCard(card, directory);

      if (!verified) {
        throw new Error(`Agent card signature verification failed for ${connection.handle}`);
      }
    }

    return {
      card,
      verified,
      signatures: card.signatures?.length ?? 0,
    };
  }

  async buildAuthorizationRequest(): Promise<VinstaAuthRequest> {
    if (!this.config.clientId || !this.config.redirectUri) {
      throw new Error("Vinsta PKCE flow requires clientId and redirectUri.");
    }

    const metadata = await this.getOAuthMetadata();
    const state = randomBase64Url(24);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const url = new URL(metadata.authorization_endpoint);

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    if (this.config.handle) {
      url.searchParams.set("handle", normalizeHandle(this.config.handle));
    }

    if (this.config.resource) {
      url.searchParams.set("resource", this.config.resource);
    }

    return {
      url: url.toString(),
      state,
      codeVerifier,
      codeChallenge,
      metadata,
    };
  }

  async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier: string;
  }) {
    if (!this.config.clientId || !this.config.redirectUri) {
      throw new Error("Vinsta PKCE exchange requires clientId and redirectUri.");
    }

    const metadata = await this.getOAuthMetadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
    });

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    return fetchOAuthToken(this.fetchImpl, metadata.token_endpoint, body, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
  }

  async refreshTokens(refreshToken: string) {
    if (!this.config.clientId) {
      throw new Error("Vinsta refresh flow requires clientId.");
    }

    const metadata = await this.getOAuthMetadata();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    return fetchOAuthToken(this.fetchImpl, metadata.token_endpoint, body, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
  }

  async issueClientCredentialsToken() {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error("Vinsta client credentials flow requires clientId and clientSecret.");
    }

    const metadata = await this.getOAuthMetadata();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      scope: this.config.scopes.join(" "),
    });

    body.set("client_secret", this.config.clientSecret);

    if (this.config.resource) {
      body.set("resource", this.config.resource);
    }

    return fetchOAuthToken(this.fetchImpl, metadata.token_endpoint, body, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
  }

  async ensureAccessToken(storedOAuth: StoredVinstaOAuthConfig): Promise<VinstaEnsureTokenResult> {
    const stored = parseStoredTokenSet(storedOAuth);

    if (stored?.accessToken && stored.expiresAt > Date.now() + tokenRefreshWindowMs) {
      return {
        source: "stored",
        tokens: stored,
      };
    }

    if (storedOAuth.refreshToken) {
      return {
        source: "refresh_token",
        tokens: await this.refreshTokens(storedOAuth.refreshToken),
      };
    }

    if (this.config.clientSecret) {
      return {
        source: "client_credentials",
        tokens: await this.issueClientCredentialsToken(),
      };
    }

    throw new Error(
      "No active Vinsta OAuth session. Configure a confidential client secret or complete the PKCE flow first.",
    );
  }

  async sendMessage(params: {
    to: string;
    text: string;
    from?: string;
    accessToken?: string;
  }) {
    const sender = params.from ?? this.config.handle;

    if (!sender) {
      throw new Error("Vinsta send requires a configured sender handle.");
    }

    const connection = await this.getConnection(sender);

    return fetchJson<JsonRpcResponse>(this.fetchImpl, connection.a2aUrl, {
      method: "POST",
      headers: withBearerHeaders(params.accessToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `openclaw-${Date.now()}`,
        method: "message/send",
        params: {
          to: normalizeHandle(params.to),
          from: normalizeHandle(sender),
          message: {
            role: "user",
            parts: [
              {
                type: "text",
                text: params.text,
              },
            ],
          },
        },
      }),
    });
  }

  async listNotifications(params: {
    accessToken: string;
    handle?: string;
  }) {
    const url = new URL(this.buildUrl("/api/notifications"));

    if (params.handle) {
      url.searchParams.set("handle", normalizeHandle(params.handle));
    } else if (this.config.handle) {
      url.searchParams.set("handle", normalizeHandle(this.config.handle));
    }

    return fetchJson<NotificationListResponse>(this.fetchImpl, url.toString(), {
      headers: withBearerHeaders(params.accessToken),
    });
  }

  async streamNotifications(params: {
    accessToken: string;
    handle?: string;
    signal?: AbortSignal;
    onEvent: (event: VinstaNotificationStreamEvent) => void | Promise<void>;
  }) {
    const url = new URL(this.buildUrl("/api/notifications/stream"));

    if (params.handle) {
      url.searchParams.set("handle", normalizeHandle(params.handle));
    } else if (this.config.handle) {
      url.searchParams.set("handle", normalizeHandle(this.config.handle));
    }

    const response = await this.fetchImpl(url.toString(), {
      headers: withBearerHeaders(params.accessToken, {
        accept: "text/event-stream",
        "cache-control": "no-cache",
      }),
      signal: params.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to open notifications stream (${response.status} ${response.statusText})`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const MAX_SSE_BUFFER = 1_048_576; // 1 MB

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });

        // Guard against unbounded buffer growth (e.g. server never sends \n\n)
        if (buffered.length > MAX_SSE_BUFFER) {
          buffered = "";
          continue;
        }

        const parsed = parseSsePayload(buffered);
        buffered = parsed.remaining;

        for (const frame of parsed.frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (!data) {
            continue;
          }

          let event: VinstaNotificationStreamEvent;
          try {
            event = JSON.parse(data) as VinstaNotificationStreamEvent;
          } catch {
            // Skip malformed SSE frames rather than breaking the stream
            continue;
          }
          await params.onEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async updateNotification(params: {
    notificationId: string;
    action: "read" | "archive";
    accessToken: string;
  }) {
    return fetchJson<NotificationMutationResponse>(
      this.fetchImpl,
      this.buildUrl(`/api/notifications/${params.notificationId}`),
      {
        method: "PATCH",
        headers: withBearerHeaders(params.accessToken, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          action: params.action,
        }),
      },
    );
  }

  async claimNotification(params: { notificationId: string; accessToken: string }) {
    const response = await this.fetchImpl(
      this.buildUrl(`/api/notifications/${params.notificationId}`),
      {
        method: "PATCH",
        headers: withBearerHeaders(params.accessToken, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({ action: "claim" }),
      },
    );

    if (response.status === 409) {
      return { claimed: false as const };
    }

    if (!response.ok) {
      throw new Error(
        `Failed to claim notification (${response.status} ${response.statusText})`,
      );
    }

    return {
      claimed: true as const,
      ...((await response.json()) as NotificationMutationResponse),
    };
  }

  async releaseNotification(params: {
    notificationId: string;
    claimedAt: string;
    accessToken: string;
  }) {
    const response = await this.fetchImpl(
      this.buildUrl(`/api/notifications/${params.notificationId}`),
      {
        method: "PATCH",
        headers: withBearerHeaders(params.accessToken, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          action: "release",
          claimedAt: params.claimedAt,
        }),
      },
    );

    if (response.status === 409) {
      return { released: false as const };
    }

    if (!response.ok) {
      throw new Error(
        `Failed to release notification (${response.status} ${response.statusText})`,
      );
    }

    return {
      released: true as const,
      ...((await response.json()) as NotificationMutationResponse),
    };
  }

  async updateThreadApproval(params: {
    notificationId: string;
    decision: "approve" | "reject";
    accessToken: string;
  }) {
    return fetchJson<NotificationMutationResponse>(
      this.fetchImpl,
      this.buildUrl(`/api/notifications/${params.notificationId}`),
      {
        method: "PATCH",
        headers: withBearerHeaders(params.accessToken, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          action: "update_approval",
          decision: params.decision,
        }),
      },
    );
  }

  async completeBridgeNotification(params: {
    notificationId: string;
    claimedAt: string;
    accessToken: string;
    reply?: string;
    archive?: boolean;
  }) {
    return fetchJson<NotificationMutationResponse>(
      this.fetchImpl,
      this.buildUrl(`/api/notifications/${params.notificationId}`),
      {
        method: "PATCH",
        headers: withBearerHeaders(params.accessToken, {
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          action: "bridge_complete",
          claimedAt: params.claimedAt,
          reply: params.reply,
          archive: params.archive ?? false,
        }),
      },
    );
  }

  async grantPermission(params: {
    accessToken: string;
    action: string;
    senderHandle: string;
    capability?: string;
    notificationId?: string;
  }) {
    return fetchJson<{ message?: string; granted?: boolean }>(
      this.fetchImpl,
      this.buildUrl("/api/permissions/grant"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.accessToken}`,
        },
        body: JSON.stringify({
          action: params.action,
          senderHandle: params.senderHandle,
          capability: params.capability || undefined,
          notificationId: params.notificationId,
        }),
      },
    );
  }
}

export function persistableOauthState(tokens: VinstaOAuthTokenSet) {
  return serializeTokens(tokens);
}
