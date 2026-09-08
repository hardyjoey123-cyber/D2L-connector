import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Walks up from `startDir` to find the directory containing package.json.
 * Needed because this file's own location differs between dev (src/config.ts)
 * and the compiled build (dist/src/config.js) — searching for package.json
 * finds the true project root either way, rather than hardcoding a depth.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

// Resolve paths relative to the project root, not process.cwd() — MCP
// clients commonly spawn this server from an arbitrary working directory,
// so relying on cwd would silently fail to find .env or a relative session
// state path.
export const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: path.join(projectRoot, ".env") });

export type AuthMethod = "oauth" | "apikey" | "session";

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

export interface SessionConfig {
  /** Path to a Playwright storageState.json produced by `npm run auth:session`. */
  statePath: string;
}

export interface Config {
  domain: string;
  authMethod: AuthMethod;
  oauth?: OAuthConfig;
  apiKey?: ApiKeyConfig;
  session?: SessionConfig;
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

  if (authMethod !== "oauth" && authMethod !== "apikey" && authMethod !== "session") {
    throw new Error(
      `Invalid BRIGHTSPACE_AUTH_METHOD "${authMethod}". Must be "oauth", "apikey", or "session".`
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
  } else if (authMethod === "apikey") {
    config.apiKey = {
      appId: required("BRIGHTSPACE_APP_ID"),
      appKey: required("BRIGHTSPACE_APP_KEY"),
      userId: required("BRIGHTSPACE_USER_ID"),
      userKey: required("BRIGHTSPACE_USER_KEY"),
    };
  } else {
    const rawStatePath = process.env.BRIGHTSPACE_SESSION_STATE_PATH || ".auth/storageState.json";
    config.session = {
      statePath: path.isAbsolute(rawStatePath) ? rawStatePath : path.join(projectRoot, rawStatePath),
    };
  }

  return config;
}
