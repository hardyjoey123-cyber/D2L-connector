/**
 * OAuth plumbing for a remote MCP server that guards itself with a token.
 *
 * The Claude API's MCP connector can only send a token it is handed, so
 * something local has to obtain one. This is that: discovery, dynamic client
 * registration, the authorization code exchange, and refresh. It is deliberately
 * generic — nothing here names a particular broker.
 */

export interface OAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
  pkceMethods: string[];
}

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

const TIMEOUT_MS = 20_000;

/**
 * Every standard place authorization server metadata can live.
 *
 * For an issuer carrying a path, RFC 8414 inserts the well-known segment at the
 * root and appends the path, while OpenID Connect appends the well-known to the
 * issuer instead. They are different URLs, and checking only one turns a
 * correctly-published document into a 404 that looks like an answer.
 */
export function metadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  const candidates = [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/oauth-authorization-server`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
  if (path) {
    candidates.push(`${origin}/.well-known/oauth-authorization-server`);
    candidates.push(`${origin}/.well-known/openid-configuration`);
  }
  return [...new Set(candidates)];
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pulls the metadata URL out of a `Bearer resource_metadata="…"` challenge. */
export function resourceMetadataUrl(challenge: string): string | null {
  return /resource_metadata="([^"]+)"/i.exec(challenge)?.[1] ?? null;
}

/** Asks the MCP endpoint, unauthenticated, what it wants. */
export async function challengeFor(mcpUrl: string): Promise<string | null> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "jarvis", version: "1.0" },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 401 && response.status !== 403) return null;
  return response.headers.get("www-authenticate");
}

export async function discover(mcpUrl: string): Promise<OAuthConfig> {
  const challenge = await challengeFor(mcpUrl);
  if (!challenge) throw new Error("The server did not ask for a token, so there is nothing to set up.");

  const metadataUrl = resourceMetadataUrl(challenge);
  if (!metadataUrl) throw new Error("The server's challenge names no metadata URL.");

  const resource = await getJson(metadataUrl);
  if (!resource) throw new Error(`Could not read ${metadataUrl}`);

  const servers = Array.isArray(resource.authorization_servers)
    ? (resource.authorization_servers as string[])
    : [];
  const issuer = servers[0];
  if (!issuer) throw new Error("No authorization server is advertised.");

  let config: Record<string, unknown> | null = null;
  for (const candidate of metadataCandidates(issuer)) {
    config = await getJson(candidate);
    if (config) break;
  }
  if (!config) throw new Error("No authorization server metadata was published anywhere standard.");

  const authorizationEndpoint = config.authorization_endpoint as string | undefined;
  const tokenEndpoint = config.token_endpoint as string | undefined;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("The authorization server does not advertise the endpoints needed to sign in.");
  }

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: config.registration_endpoint as string | undefined,
    scopes: Array.isArray(resource.scopes_supported)
      ? (resource.scopes_supported as string[])
      : Array.isArray(config.scopes_supported)
        ? (config.scopes_supported as string[])
        : [],
    pkceMethods: Array.isArray(config.code_challenge_methods_supported)
      ? (config.code_challenge_methods_supported as string[])
      : [],
  };
}

/** RFC 7591 dynamic client registration. */
export async function registerClient(
  config: OAuthConfig,
  redirectUri: string,
  clientName: string
): Promise<ClientCredentials> {
  if (!config.registrationEndpoint) {
    throw new Error("This service does not allow clients to register, so no token can be obtained.");
  }

  const response = await fetch(config.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(config.scopes.length ? { scope: config.scopes.join(" ") } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body?.client_id) {
    throw new Error(
      `Registration was refused (HTTP ${response.status})` +
        (body ? `: ${JSON.stringify(body).slice(0, 200)}` : "")
    );
  }
  return {
    clientId: body.client_id as string,
    clientSecret: (body.client_secret as string | undefined) ?? undefined,
  };
}

function toTokenSet(body: Record<string, unknown>, fallbackRefresh?: string): TokenSet {
  const accessToken = body.access_token as string | undefined;
  if (!accessToken) throw new Error("The token response contained no access token.");
  // Default an hour when the server doesn't say; refresh is driven by this.
  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken,
    refreshToken: (body.refresh_token as string | undefined) ?? fallbackRefresh,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    scope: body.scope as string | undefined,
  };
}

async function postForm(
  tokenEndpoint: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    throw new Error(
      `Token request failed (HTTP ${response.status})` +
        (body ? `: ${JSON.stringify(body).slice(0, 200)}` : "")
    );
  }
  return body;
}

export async function exchangeCode(
  config: OAuthConfig,
  client: ClientCredentials,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(config.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    })
  );
}

export async function refreshTokens(
  tokenEndpoint: string,
  client: ClientCredentials,
  refreshToken: string
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
    // Servers that rotate refresh tokens send a new one; those that don't
    // expect the original to keep working.
    refreshToken
  );
}
