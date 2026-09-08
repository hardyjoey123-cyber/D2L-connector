import "dotenv/config";

export type AuthMethod = "oauth" | "apikey";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export interface ApiKeyConfig {
  appId: string;
  appKey: string;
  userId: string;
  userKey: string;
}

export interface Config {
  domain: string;
  authMethod: AuthMethod;
  oauth?: OAuthConfig;
  apiKey?: ApiKeyConfig;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for setup instructions.`
    );
  }
  return value;
}

function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

export function loadConfig(): Config {
  const domain = normalizeDomain(required("BRIGHTSPACE_DOMAIN"));
  const authMethod = (process.env.BRIGHTSPACE_AUTH_METHOD || "oauth")
    .trim()
    .toLowerCase() as AuthMethod;

  if (authMethod !== "oauth" && authMethod !== "apikey") {
    throw new Error(
      `Invalid BRIGHTSPACE_AUTH_METHOD "${authMethod}". Must be "oauth" or "apikey".`
    );
  }

  const config: Config = { domain, authMethod };

  if (authMethod === "oauth") {
    config.oauth = {
      clientId: required("BRIGHTSPACE_CLIENT_ID"),
      clientSecret: required("BRIGHTSPACE_CLIENT_SECRET"),
      refreshToken: required("BRIGHTSPACE_REFRESH_TOKEN"),
      authorizeUrl:
        process.env.BRIGHTSPACE_OAUTH_AUTHORIZE_URL ||
        "https://auth.brightspace.com/oauth2/auth",
      tokenUrl:
        process.env.BRIGHTSPACE_OAUTH_TOKEN_URL ||
        "https://auth.brightspace.com/core/connect/token",
      scope:
        process.env.BRIGHTSPACE_OAUTH_SCOPE ||
        "core:*:* content:toc:read enrollment:orgunit:read grades:gradeobject:read grades:gradevalue:read dropbox:folder:read dropbox:file:read",
    };
  } else {
    config.apiKey = {
      appId: required("BRIGHTSPACE_APP_ID"),
      appKey: required("BRIGHTSPACE_APP_KEY"),
      userId: required("BRIGHTSPACE_USER_ID"),
      userKey: required("BRIGHTSPACE_USER_KEY"),
    };
  }

  return config;
}
