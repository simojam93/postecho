import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWakeServer } from "./wake-server.js";

const ORIGIN = "https://postecho.example.com";
const quiet = { log: vi.fn(), error: vi.fn() };

function fakeController() {
  return {
    awake: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    status: vi.fn(() => ({ awake: true, busy: false })),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(controller = fakeController()) {
  const server = await startWakeServer({ port: 0, origin: ORIGIN, controller, logger: quiet });
  if (!server) throw new Error("did not listen");
  servers.push(server);
  return { controller, port: (server.address() as AddressInfo).port, server };
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the wake server", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { server } = await start();
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("answers the preflight with the CORS and Private Network Access headers", async () => {
    const { port } = await start();
    const res = await call(port, "OPTIONS", "/wake", {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-private-network": "true",
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE");
    expect(res.headers["access-control-allow-headers"]).toBe("content-type");
    expect(res.headers["access-control-allow-private-network"]).toBe("true");
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("POST /awake and POST /wake answer 204 and reach the controller", async () => {
    const { controller, port } = await start();
    const awake = await call(port, "POST", "/awake", { origin: ORIGIN });
    expect(awake.status).toBe(204);
    expect(awake.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(controller.awake).toHaveBeenCalledTimes(1);
    const wake = await call(port, "POST", "/wake", { origin: ORIGIN });
    expect(wake.status).toBe(204);
    expect(controller.wake).toHaveBeenCalledTimes(1);
  });

  it("GET /status says whether the agent is awake and busy", async () => {
    const { port } = await start();
    const res = await call(port, "GET", "/status", { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ awake: true, busy: false });
  });

  it("refuses any other origin, or none, with 403 and no CORS headers", async () => {
    const { controller, port } = await start();
    const others: Array<Record<string, string>> = [{ origin: "https://evil.example.com" }, { origin: "https://postecho.example.com:444" }, {}];
    for (const headers of others) {
      const res = await call(port, "POST", "/wake", headers);
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const preflight = await call(port, "OPTIONS", "/wake", { origin: "https://evil.example.com" });
    expect(preflight.status).toBe(403);
    expect(controller.wake).not.toHaveBeenCalled();
  });

  it("answers 404 for another path and 405 for a wrong method", async () => {
    const { port } = await start();
    expect((await call(port, "POST", "/other", { origin: ORIGIN })).status).toBe(404);
    expect((await call(port, "GET", "/wake", { origin: ORIGIN })).status).toBe(405);
  });

  it("resolves to null with a clear line when the port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    servers.push(taken);
    const port = (taken.address() as AddressInfo).port;
    quiet.log.mockClear();
    const server = await startWakeServer({ port, origin: ORIGIN, controller: fakeController(), logger: quiet });
    expect(server).toBeNull();
    expect(quiet.log.mock.calls.flat().join("\n")).toContain(`port ${port} is taken`);
  });
});

describe("the media routes (media from a repo, 2026-10-11)", () => {
  const DRAFT = "6f1c2a3e-1b2c-4d5e-8f90-123456789abc";
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "postecho-wake-media-"));
    await mkdir(join(base, DRAFT));
    await writeFile(join(base, DRAFT, "card-ab.png"), "PNGDATA");
    await writeFile(join(base, "secret.png"), "SECRET");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function startMedia(platform: NodeJS.Platform = "darwin") {
    const reveal = vi.fn(async (_path: string) => {});
    const server = await startWakeServer({ port: 0, origin: ORIGIN, controller: fakeController(), logger: quiet, media: { baseDir: base, reveal, platform } });
    if (!server) throw new Error("did not listen");
    servers.push(server);
    return { port: (server.address() as AddressInfo).port, reveal };
  }

  it("GET /media/<draftId>/<file> serves the file with its content type, to the app's origin only", async () => {
    const { port } = await startMedia();
    const res = await call(port, "GET", `/media/${DRAFT}/card-ab.png`, { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.body).toBe("PNGDATA");
    expect((await call(port, "GET", `/media/${DRAFT}/card-ab.png`, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await call(port, "GET", `/media/${DRAFT}/card-ab.png`)).status).toBe(403);
  });

  it("answers 404 for a missing file and never leaves the media directory", async () => {
    const { port } = await startMedia();
    expect((await call(port, "GET", `/media/${DRAFT}/nope.png`, { origin: ORIGIN })).status).toBe(404);
    for (const path of [
      `/media/${DRAFT}/../secret.png`, `/media/${DRAFT}/..%2Fsecret.png`, `/media/${DRAFT}/%2e%2e%2fsecret.png`,
      `/media/..%2F/secret.png`, `/media/${DRAFT}/a/b.png`, `/media/${DRAFT}/%2Fetc%2Fpasswd`, `/media/${DRAFT}/%E0%A4%A`,
      `/media/${DRAFT}/notes.txt`,
    ]) {
      const res = await call(port, "GET", path, { origin: ORIGIN });
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain("SECRET");
    }
  });

  it("DELETE /media/<draftId>/<file> removes it", async () => {
    const { port } = await startMedia();
    expect((await call(port, "DELETE", `/media/${DRAFT}/card-ab.png`, { origin: ORIGIN })).status).toBe(204);
    expect(await readdir(join(base, DRAFT))).toEqual([]);
    expect((await call(port, "DELETE", `/media/${DRAFT}/card-ab.png`, { origin: ORIGIN })).status).toBe(404);
    expect((await call(port, "DELETE", `/media/${DRAFT}/..%2Fsecret.png`, { origin: ORIGIN })).status).toBe(404);
    expect(await readdir(base)).toContain("secret.png");
  });

  it("POST /media/reveal shows the file in Finder, and answers 501 elsewhere than macOS", async () => {
    const { port, reveal } = await startMedia();
    const json = { origin: ORIGIN, "content-type": "application/json" };
    expect((await call(port, "POST", "/media/reveal", json, JSON.stringify({ draftId: DRAFT, file: "card-ab.png" }))).status).toBe(204);
    expect(reveal).toHaveBeenCalledWith(join(base, DRAFT, "card-ab.png"));
    expect((await call(port, "POST", "/media/reveal", json, JSON.stringify({ draftId: DRAFT, file: "../secret.png" }))).status).toBe(404);
    expect((await call(port, "POST", "/media/reveal", json, JSON.stringify({ draftId: DRAFT, file: "gone.png" }))).status).toBe(404);
    expect((await call(port, "POST", "/media/reveal", json, "not json")).status).toBe(400);
    expect(reveal).toHaveBeenCalledTimes(1);

    const linux = await startMedia("linux");
    expect((await call(linux.port, "POST", "/media/reveal", json, JSON.stringify({ draftId: DRAFT, file: "card-ab.png" }))).status).toBe(501);
    expect(linux.reveal).not.toHaveBeenCalled();
  });

  it("answers 405 for a wrong method on a media path", async () => {
    const { port } = await startMedia();
    expect((await call(port, "POST", `/media/${DRAFT}/card-ab.png`, { origin: ORIGIN })).status).toBe(405);
    expect((await call(port, "GET", "/media/reveal", { origin: ORIGIN })).status).toBe(405);
  });
});
