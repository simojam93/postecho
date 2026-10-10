import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function call(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
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
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST");
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
