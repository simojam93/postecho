import { randomBytes } from "node:crypto";

/** A random token, hex. */
export const secret = (bytes = 24) => randomBytes(bytes).toString("hex");

/** A password to log in with, when the owner doesn't type one: 12 url-safe characters. */
export const password = () => randomBytes(9).toString("base64url");

/** KEY=value lines, comments and blanks skipped; a value may contain "=". */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at > 0) env[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return env;
}

/** web/.env.local for a local install: no DATABASE_URL, so the app uses the PGlite database in web/.pglite. */
export function webEnv({ adminPassword, agentToken }) {
  return [
    "# Written by npm run setup. No DATABASE_URL: the app uses the local database in web/.pglite.",
    `ADMIN_PASSWORD=${adminPassword}`,
    `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
    `AGENT_TOKEN=${agentToken}`,
    `CAPTURE_TOKEN=${secret()}`,
    `CRON_SECRET=${secret()}`,
    "# Optional: TYPESAFE_API_KEY for Jev, and the keys of the extra sources (see .env.example).",
    "",
  ].join("\n");
}

/** agent/.env: the local app, the token it shares with it, Claude Code on the PATH. */
export function agentEnv({ agentToken, url = "http://localhost:3000" }) {
  return [`POSTECHO_URL=${url}`, `AGENT_TOKEN=${agentToken}`, "CLAUDE_BIN=claude", ""].join("\n");
}

/** The agent runs with `--env-file-if-exists`, which needs Node 22.9. */
export function nodeIsRecentEnough(version, [major, minor] = [22, 9]) {
  const [a, b] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}
