import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WakeController } from "./wake.js";
import type { Logger } from "./worker.js";

/**
 * The local wake server: the page that has PostEcho open calls it on
 * 127.0.0.1 (docs/specs/2026-10-10-agent-wakes-on-demand-design.md).
 *
 * Only the web app's own origin gets an answer, and the CORS preflight carries
 * `Access-Control-Allow-Private-Network: true`, which Chrome asks for before an
 * https page may call the computer it runs on.
 *
 * - `POST /awake` (204): PostEcho is open.
 * - `POST /wake` (204): the page just made a job.
 * - `GET /status`: `{ awake, busy }`.
 */
export function createWakeHandler(opts: {
  origin: string;
  controller: Pick<WakeController, "awake" | "wake" | "status">;
}) {
  const { origin, controller } = opts;
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    const path = (req.url ?? "/").split("?")[0];
    const route = path === "/awake" || path === "/wake" ? "POST" : path === "/status" ? "GET" : null;
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== route) {
      res.writeHead(405, { Allow: route }).end();
      return;
    }

    if (path === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(controller.status()));
      return;
    }
    // Answer at once: the claims run on after the reply.
    void (path === "/awake" ? controller.awake() : controller.wake());
    res.writeHead(204).end();
  };
}

/**
 * Listens on 127.0.0.1:port. A port that's taken (or can't be opened)
 * resolves to null with a line saying so, and the agent polls instead of
 * crashing.
 */
export function startWakeServer(opts: {
  port: number;
  origin: string;
  controller: Pick<WakeController, "awake" | "wake" | "status">;
  logger?: Logger;
}): Promise<Server | null> {
  const logger = opts.logger ?? console;
  const server = createServer(createWakeHandler(opts));
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => {
      const why = e.code === "EADDRINUSE" ? `port ${opts.port} is taken` : `port ${opts.port} can't be opened (${e.message})`;
      logger.log(
        `[agent] ${why}, so the page can't wake this agent. It asks for jobs on its own instead. Set AGENT_WAKE_PORT to a free port to fix it.`,
      );
      resolve(null);
    };
    server.once("error", onError);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}
