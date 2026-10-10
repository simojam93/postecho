// The port a screenshot or video job runs the owner's app on, and stopping it afterwards (live, 2026-10-11).
import { execFile } from "node:child_process";
import { createServer } from "node:net";

/** A port nothing listens on: the system picks one. */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

/** The PIDs listening on a port, from lsof's terse output. */
export function pidsFrom(lsofOutput: string): number[] {
  return [...new Set(lsofOutput.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0))];
}

/**
 * Stops what still listens on the job's own port, the app it started, if Claude left it running. Only that
 * port, which the agent picked free for this job, so nothing else of the owner's is touched.
 */
export async function stopLocalPort(port: number): Promise<void> {
  const output = await new Promise<string>((resolve) => {
    execFile("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], (_err, stdout) => resolve(stdout ?? ""));
  });
  for (const pid of pidsFrom(output)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
