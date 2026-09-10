/** Minimal test reporting, and a sandbox so tests never touch a real session. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
let checks = 0;

export function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

export function section(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

export function report(): never {
  console.log(
    failures === 0
      ? `\nVERDICT: ${checks} checks passed.`
      : `\nVERDICT: ${failures} of ${checks} checks failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Runs the rest of the test in a throwaway directory holding a fake saved
 * session. Everything that resolves from cwd — the account token, the rulebook,
 * the trade log — then lands there instead of on top of the real thing.
 */
export function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  fs.mkdirSync(path.join(dir, ".auth"));
  fs.writeFileSync(
    path.join(dir, ".auth", "account.json"),
    JSON.stringify({
      mcpUrl: "http://127.0.0.1:1",
      clientId: "test",
      tokenEndpoint: "http://127.0.0.1:1/token",
      accessToken: "test-token",
      refreshToken: "test-refresh",
      // Far enough out that no refresh is attempted mid-test.
      expiresAt: Date.now() + 86_400_000,
    })
  );
  process.chdir(dir);
  return dir;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
