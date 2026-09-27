// npm run dev: the web app, then the agent once the app answers. Each line prefixed; Ctrl-C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];

function start(name, cwd, color) {
  // Windows finds npm as npm.cmd, which only a shell resolves.
  const child = spawn("npm", ["run", "dev"], { cwd: `${root}${cwd}`, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
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

async function waitForWeb(url = "http://localhost:3000/login", tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

start("web", "web", "\x1b[36m");
if (await waitForWeb()) {
  console.log("\x1b[32mPostEcho is running: http://localhost:3000\x1b[0m");
  start("agent", "agent", "\x1b[35m");
} else {
  console.log("The web app didn't answer on http://localhost:3000 in two minutes, so the agent wasn't started.");
}
