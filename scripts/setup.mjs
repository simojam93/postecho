// npm run setup: everything a local install needs, once. It never overwrites an env file that exists.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentEnv, nodeIsRecentEnough, parseEnv, password, secret, webEnv } from "./lib/env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}web`;
const agent = `${root}agent`;
const say = (line = "") => console.log(line);
// Windows finds npm and claude as .cmd files, which only a shell resolves.
const shell = process.platform === "win32";

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) {
    say(`\n✗ ${cmd} ${args.join(" ")} failed in ${cwd}`);
    process.exit(result.status ?? 1);
  }
}

/** Typed with * shown when there's a terminal; Enter alone, or no terminal, means a generated one. */
async function askPassword() {
  if (!process.stdin.isTTY) return null;
  process.stdout.write("Choose a password to log in (Enter for a generated one): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let typed = "";
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return typed || null;
      }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") {
        if (typed) { typed = typed.slice(0, -1); process.stdout.write("\b \b"); }
        continue;
      }
      typed += ch;
      process.stdout.write("*");
    }
  }
  return typed || null;
}

if (!nodeIsRecentEnough(process.versions.node)) {
  say(`PostEcho needs Node 22.9 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}
if (spawnSync("claude", ["--version"], { stdio: "ignore", shell }).status !== 0) {
  say("! Claude Code isn't installed, or isn't on the PATH. The app runs, but nothing gets written until it is:");
  say("  https://docs.claude.com/en/docs/claude-code/overview\n");
}

say("Installing the web app and the agent…");
run("npm", ["install"], web);
run("npm", ["install"], agent);

const webEnvPath = `${web}/.env.local`;
const agentEnvPath = `${agent}/.env`;
let agentToken = existsSync(webEnvPath) ? parseEnv(readFileSync(webEnvPath, "utf8")).AGENT_TOKEN : undefined;
if (existsSync(webEnvPath)) {
  say("Kept your web/.env.local.");
} else {
  const typed = await askPassword();
  const adminPassword = typed ?? password();
  agentToken = secret();
  writeFileSync(webEnvPath, webEnv({ adminPassword, agentToken }), { mode: 0o600 });
  say(typed ? "Saved your password in web/.env.local." : `Your password: ${adminPassword}  (it's in web/.env.local: change it there)`);
}
if (existsSync(agentEnvPath)) {
  say("Kept your agent/.env.");
} else {
  writeFileSync(agentEnvPath, agentEnv({ agentToken: agentToken ?? secret() }), { mode: 0o600 });
  say("Wrote agent/.env.");
}

say("Preparing the local database…");
run("npm", ["run", "db:migrate:dev"], web);

say("\nDone. Next:");
say("  npm run demo   sample data to look around (optional)");
say("  npm run dev    then open http://localhost:3000");
