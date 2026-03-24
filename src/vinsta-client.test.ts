import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedVinstaPluginConfig } from "./config.js";
import { VinstaClient } from "./vinsta-client.js";

function buildConfig(
  overrides: Partial<ResolvedVinstaPluginConfig> = {},
): ResolvedVinstaPluginConfig {
  return {
    appUrl: "http://localhost:3000",
    handle: "joy",
    clientId: "client-123",
    clientSecret: undefined,
    redirectUri: "http://127.0.0.1:8787/callback",
    resource: undefined,
    scopes: ["agent:read", "agent:interact"],
    oauth: {},
    ...overrides,
  };
}

describe("VinstaClient", () => {
  it("builds a PKCE authorization request", async () => {
    const fetchMock = async (input: URL | RequestInfo) => {
      const url = String(input);

      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:3000",
            authorization_endpoint: "http://localhost:3000/oauth/authorize",
            token_endpoint: "http://localhost:3000/oauth/token",
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = new VinstaClient(buildConfig(), { fetch: fetchMock as typeof fetch });
    const request = await client.buildAuthorizationRequest();
    const url = new URL(request.url);

    assert.equal(url.pathname, "/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "client-123");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/callback");
    assert.equal(url.searchParams.get("handle"), "joy");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(request.codeVerifier.length > 20);
    assert.ok(request.codeChallenge.length > 20);
  });

  it("refreshes tokens before falling back to client credentials", async () => {
    let tokenRequests = 0;
    const fetchMock = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:3000",
            authorization_endpoint: "http://localhost:3000/oauth/authorize",
            token_endpoint: "http://localhost:3000/oauth/token",
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/oauth/token")) {
        tokenRequests += 1;
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(String(init?.body ?? ""));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "refresh-123");

        return new Response(
          JSON.stringify({
            access_token: "access-456",
            refresh_token: "refresh-789",
            expires_in: 3600,
            scope: "agent:read agent:interact",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = new VinstaClient(
      buildConfig({
        clientSecret: "secret-123",
        oauth: {
          refreshToken: "refresh-123",
        },
      }),
      { fetch: fetchMock as typeof fetch },
    );

    const result = await client.ensureAccessToken({
      refreshToken: "refresh-123",
    });

    assert.equal(tokenRequests, 1);
    assert.equal(result.source, "refresh_token");
    assert.equal(result.tokens.accessToken, "access-456");
    assert.equal(result.tokens.refreshToken, "refresh-789");
  });
});
