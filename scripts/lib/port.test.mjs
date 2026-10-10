import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { firstFreePort, portIsFree } from "./port.mjs";

function occupy(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, host }, () => resolve(server));
  });
}

test("a port taken on 127.0.0.1 alone counts as busy, so localhost never reaches another app", async () => {
  const server = await occupy(0, "127.0.0.1");
  const { port } = server.address();
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    server.close();
  }
});

test("the first free port skips the busy ones", async () => {
  const server = await occupy(0, "127.0.0.1");
  const { port } = server.address();
  try {
    const free = await firstFreePort(port);
    assert.ok(free > port);
    assert.equal(await portIsFree(free), true);
  } finally {
    server.close();
  }
});
