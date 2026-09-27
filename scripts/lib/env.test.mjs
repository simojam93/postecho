import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, nodeIsRecentEnough, parseEnv, password, secret, webEnv } from "./env.mjs";

test("secrets are long, hex and never repeat", () => {
  const a = secret();
  const b = secret();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("a generated password is 12 url-safe characters", () => {
  assert.match(password(), /^[A-Za-z0-9_-]{12}$/);
});

test("the web env: the owner's password, fresh secrets, no DATABASE_URL (the local database)", () => {
  const env = parseEnv(webEnv({ adminPassword: "pw-1234", agentToken: "tok" }));
  assert.equal(env.ADMIN_PASSWORD, "pw-1234");
  assert.equal(env.AGENT_TOKEN, "tok");
  for (const key of ["SESSION_SECRET", "CAPTURE_TOKEN", "CRON_SECRET"]) assert.ok(env[key].length >= 32, key);
  assert.equal("DATABASE_URL" in env, false);
});

test("the agent env points at the local app with the same token", () => {
  assert.deepEqual(parseEnv(agentEnv({ agentToken: "tok" })), { POSTECHO_URL: "http://localhost:3000", AGENT_TOKEN: "tok", CLAUDE_BIN: "claude" });
});

test("parseEnv reads KEY=value lines, skips comments, keeps = inside values", () => {
  assert.deepEqual(parseEnv("# c\nA=1\n\nB=x=y\n"), { A: "1", B: "x=y" });
});

test("Node 22.9 or newer", () => {
  assert.equal(nodeIsRecentEnough("22.9.0"), true);
  assert.equal(nodeIsRecentEnough("25.8.1"), true);
  assert.equal(nodeIsRecentEnough("22.8.1"), false);
  assert.equal(nodeIsRecentEnough("20.19.0"), false);
});
