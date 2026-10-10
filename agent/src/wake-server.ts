import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { contentTypeOf, mediaFilePath } from "./media/paths.js";
import type { WakeController } from "./wake.js";
import type { Logger } from "./worker.js";

/** The post media the wake server hands the page (media from a repo, 2026-10-11). */
export type MediaRoutes = {
  /** ~/.postecho/media (media/paths.ts's MEDIA_DIR). */
  baseDir: string;
  /** Shows the file in Finder; `open -R` by default. */
  reveal?: (path: string) => Promise<void>;
  /** process.platform by default: reveal is macOS only. */
  platform?: NodeJS.Platform;
};

const revealInFinder = async (path: string) => {
  await promisify(execFile)("open", ["-R", path]);
};

/** A reveal request's body is two short strings; anything bigger isn't one. */
const MAX_BODY_BYTES = 4096;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); return; }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });
}

/** `/media/<draftId>/<file>` -> the file's path, or null for anything that isn't exactly that inside the media directory. */
function mediaPathOf(baseDir: string, path: string): string | null {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "media") return null;
  let draftId: string;
  let file: string;
  try {
    draftId = decodeURIComponent(parts[2]!);
    file = decodeURIComponent(parts[3]!);
  } catch {
    return null;
  }
  const full = mediaFilePath(baseDir, draftId, file);
  return full && contentTypeOf(full) ? full : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

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
 *
 * With `media` (media from a repo, 2026-10-11), a post's media files, which never leave this computer:
 *
 * - `GET /media/<draftId>/<file>`: the file, with its content type. The page loads it with
 *   crossorigin="anonymous", so the browser sends its Origin like any other call here.
 * - `DELETE /media/<draftId>/<file>` (204): the owner removed it.
 * - `POST /media/reveal` `{ draftId, file }` (204): shows it in Finder; 501 off macOS.
 *
 * Every media path is confined to the media directory (media/paths.ts): no `..`, no slash in a name, nothing
 * absolute; anything else is a 404.
 */
export function createWakeHandler(opts: {
  origin: string;
  controller: Pick<WakeController, "awake" | "wake" | "status">;
  media?: MediaRoutes;
}) {
  const { origin, controller, media } = opts;
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    const path = (req.url ?? "/").split("?")[0]!;
    if (media && path.startsWith("/media/")) {
      await handleMedia(media, path, req, res);
      return;
    }

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

async function handleMedia(media: MediaRoutes, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (path === "/media/reveal") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    const raw = await readBody(req);
    let body: { draftId?: unknown; file?: unknown };
    try {
      body = JSON.parse(raw ?? "") as typeof body;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if ((media.platform ?? process.platform) !== "darwin") { res.writeHead(501).end(); return; }
    const full = typeof body?.draftId === "string" && typeof body.file === "string"
      ? mediaFilePath(media.baseDir, body.draftId, body.file)
      : null;
    if (!full || !(await isFile(full))) { res.writeHead(404).end(); return; }
    try {
      await (media.reveal ?? revealInFinder)(full);
      res.writeHead(204).end();
    } catch {
      res.writeHead(500).end();
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "DELETE") { res.writeHead(405, { Allow: "GET, DELETE" }).end(); return; }
  const full = mediaPathOf(media.baseDir, path);
  if (!full || !(await isFile(full))) { res.writeHead(404).end(); return; }

  if (req.method === "DELETE") {
    await unlink(full);
    res.writeHead(204).end();
    return;
  }
  const { size } = await stat(full);
  res.writeHead(200, { "Content-Type": contentTypeOf(full)!, "Content-Length": String(size), "Cache-Control": "no-store" });
  createReadStream(full).pipe(res);
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
  media?: MediaRoutes;
  logger?: Logger;
}): Promise<Server | null> {
  const logger = opts.logger ?? console;
  const handle = createWakeHandler(opts);
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      logger.error(`[agent] wake server: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
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
