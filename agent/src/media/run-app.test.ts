import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { freeLocalPort, pidsFrom } from "./run-app.js";

describe("the app's own port (live, 2026-10-11)", () => {
  it("finds a port nothing listens on", async () => {
    const port = await freeLocalPort();
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1" }, () => server.close(() => resolve()));
    });
  });

  it("reads lsof's PIDs once each, skipping blanks", () => {
    expect(pidsFrom("123\n456\n123\n\n")).toEqual([123, 456]);
    expect(pidsFrom("")).toEqual([]);
  });
});
