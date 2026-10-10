// npm run dev: the web app, then the agent once the app answers. Each line prefixed; Ctrl-C stops both.
// The app takes the first free port from PORT (3000), and the agent is pointed at that port, so another program
// already on 3000 can't swallow the agent's requests and leave every job waiting.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstFreePort } from "./lib/port.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];

function start(name, cwd, color, { args = [], env = {} } = {}) {
  // Windows finds npm as npm.cmd, which only a shell resolves.
  const child = spawn("npm", ["run", "dev", ...args], {
    cwd: `${root}${cwd}`,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const prefix = `${color}${name.padEnd(5)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let rest = "";
    stream.on("data", (buf) => {
      const lines = (rest + buf.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    stopAll();
    process.exitCode = code ?? 0;
  });
  children.push(child);
}

function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

/** True once PostEcho itself answers: its login page, not just any server on the port. */
async function waitForWeb(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.status < 500 && (await response.text()).includes("PostEcho")) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

const wanted = Number(process.env.PORT) || 3000;
const port = await firstFreePort(wanted);
const url = `http://localhost:${port}`;
if (port !== wanted) console.log(`Port ${wanted} is taken by another program, so PostEcho uses ${port}.`);

start("web", "web", "\x1b[36m", { args: ["--", "-p", String(port)] });
if (await waitForWeb(`${url}/login`)) {
  console.log(`\x1b[32mPostEcho is running: ${url}\x1b[0m`);
  start("agent", "agent", "\x1b[35m", { env: { POSTECHO_URL: url } });
} else {
  console.log(`The web app didn't answer on ${url} in two minutes, so the agent wasn't started.`);
}
