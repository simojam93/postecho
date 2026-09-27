import { createHash, createHmac } from "node:crypto";
import { QstashError } from "@upstash/qstash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQstash, forgetMessage, getQstash, QSTASH_DISABLED_REASON, setQstashForTests, verifyQstashSignature, type QstashMessageClient, QSTASH_NOT_PUBLIC_REASON, isPublicBaseUrl } from "@/lib/qstash";

function fakeClient() {
  return {
    publishJSON: vi.fn(async () => ({ messageId: "msg_1" })),
    messages: { cancel: vi.fn(async () => ({ cancelled: 1 })) },
  } satisfies QstashMessageClient;
}

const TOKEN_ENV = {
  QSTASH_TOKEN: "qstash-token",
  QSTASH_URL: "https://qstash-eu-central-1.upstash.io",
  PUBLIC_BASE_URL: "https://postecho.example.com",
};

describe("createQstash", () => {
  it("is disabled when PUBLIC_BASE_URL is missing or not a public https URL — QStash cannot call localhost back", () => {
    const { PUBLIC_BASE_URL: _drop, ...noBase } = TOKEN_ENV;
    void _drop;
    expect(createQstash(noBase)).toEqual({ enabled: false, reason: QSTASH_NOT_PUBLIC_REASON });
    for (const bad of ["http://localhost:3210", "https://localhost", "https://127.0.0.1", "https://[::1]:3210", "https://10.0.0.5", "https://mac.local", "http://postecho.example.com", "not a url"]) {
      expect(createQstash({ ...noBase, PUBLIC_BASE_URL: bad }).enabled).toBe(false);
    }
    expect(isPublicBaseUrl("https://postecho.vercel.app")).toBe(true);
    expect(isPublicBaseUrl("https://postecho.vercel.app/")).toBe(true);
  });

  it("is disabled without QSTASH_TOKEN (blank counts as unset)", () => {
    expect(createQstash({})).toEqual({ enabled: false, reason: QSTASH_DISABLED_REASON });
    expect(createQstash({ QSTASH_TOKEN: "   " }).enabled).toBe(false);
  });

  it("publishes a JSON message to the url with notBefore in unix seconds, floored", async () => {
    const client = fakeClient();
    const qstash = createQstash(TOKEN_ENV, client);
    expect(qstash.enabled).toBe(true);
    if (!qstash.enabled) return;

    const id = await qstash.scheduleMessage({
      url: "https://app.test/api/publish/abc", notBeforeMs: 1_900_000_000_999, body: { id: "abc" },
    });
    expect(id).toBe("msg_1");
    expect(client.publishJSON).toHaveBeenCalledTimes(1);
    expect(client.publishJSON).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://app.test/api/publish/abc", body: { id: "abc" }, notBefore: 1_900_000_000,
    }));
  });

  it("sends an empty JSON object when no body is given", async () => {
    const client = fakeClient();
    const qstash = createQstash(TOKEN_ENV, client);
    if (!qstash.enabled) throw new Error("expected enabled");
    await qstash.scheduleMessage({ url: "https://app.test/x", notBeforeMs: 2_000_000_000_000 });
    expect(client.publishJSON).toHaveBeenCalledWith(expect.objectContaining({ body: {} }));
  });

  it("deletes through messages.cancel and treats a 404 as already gone", async () => {
    const client = fakeClient();
    const qstash = createQstash(TOKEN_ENV, client);
    if (!qstash.enabled) throw new Error("expected enabled");
    await qstash.deleteMessage("msg_1");
    expect(client.messages.cancel).toHaveBeenCalledWith("msg_1");

    client.messages.cancel.mockRejectedValueOnce(new QstashError("message not found", 404));
    await expect(qstash.deleteMessage("msg_gone")).resolves.toBeUndefined();

    client.messages.cancel.mockRejectedValueOnce(new QstashError("upstream down", 503));
    await expect(qstash.deleteMessage("msg_2")).rejects.toThrow("upstream down");
  });
});

describe("forgetMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips a null id and a disabled timer", async () => {
    const client = fakeClient();
    await forgetMessage(createQstash(TOKEN_ENV, client), null);
    await forgetMessage(createQstash({}, client), "msg_1");
    expect(client.messages.cancel).not.toHaveBeenCalled();
  });

  it("cancels the message, and only warns when that fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient();
    const qstash = createQstash(TOKEN_ENV, client);
    await forgetMessage(qstash, "msg_1");
    expect(client.messages.cancel).toHaveBeenCalledWith("msg_1");
    expect(warn).not.toHaveBeenCalled();

    client.messages.cancel.mockRejectedValueOnce(new QstashError("upstream down", 503));
    await expect(forgetMessage(qstash, "msg_2")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("msg_2");
  });
});

describe("getQstash", () => {
  afterEach(() => {
    setQstashForTests(null);
    vi.unstubAllEnvs();
  });

  it("reads the env per call and honors the test override", () => {
    vi.stubEnv("QSTASH_TOKEN", "");
    expect(getQstash().enabled).toBe(false);
    const fake = createQstash(TOKEN_ENV, fakeClient());
    setQstashForTests(fake);
    expect(getQstash()).toBe(fake);
    setQstashForTests(null);
    vi.stubEnv("QSTASH_TOKEN", "token");
    vi.stubEnv("PUBLIC_BASE_URL", "https://postecho.example.com");
    expect(getQstash().enabled).toBe(true);
  });
});

// A token exactly like QStash's: HS256 JWT, issuer "Upstash", `sub` = the
// delivery url, `body` = base64url(sha256(raw body)) — so these tests run
// the SDK's real Receiver, not a stand-in for it.
const b64url = (buf: Buffer) => buf.toString("base64url");
function signLikeQstash(
  { key, body, url, ...claims }: { key: string; body: string; url: string; exp?: number; nbf?: number },
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: "Upstash", sub: url, iat: now, nbf: claims.nbf ?? now - 5, exp: claims.exp ?? now + 300, jti: "jti-1",
    body: b64url(createHash("sha256").update(body).digest()),
  })));
  const signature = b64url(createHmac("sha256", key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

describe("verifyQstashSignature", () => {
  const keys = { QSTASH_CURRENT_SIGNING_KEY: "sig_current_key", QSTASH_NEXT_SIGNING_KEY: "sig_next_key" };
  const url = "https://app.test/api/publish/11111111-1111-4111-8111-111111111111";
  const body = JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" });

  it("accepts a token signed with the current key, and one signed with the next key (rotation)", async () => {
    const current = signLikeQstash({ key: keys.QSTASH_CURRENT_SIGNING_KEY, body, url });
    expect(await verifyQstashSignature({ signature: current, body, url }, keys)).toBe(true);
    const next = signLikeQstash({ key: keys.QSTASH_NEXT_SIGNING_KEY, body, url });
    expect(await verifyQstashSignature({ signature: next, body, url }, keys)).toBe(true);
  });

  it("rejects a wrong key, a tampered body, another url, an expired token and garbage", async () => {
    const other = signLikeQstash({ key: "sig_somebody_else", body, url });
    expect(await verifyQstashSignature({ signature: other, body, url }, keys)).toBe(false);

    const genuine = signLikeQstash({ key: keys.QSTASH_CURRENT_SIGNING_KEY, body, url });
    expect(await verifyQstashSignature({ signature: genuine, body: body + " ", url }, keys)).toBe(false);
    expect(await verifyQstashSignature({ signature: genuine, body, url: "https://app.test/api/publish/other" }, keys)).toBe(false);

    const expired = signLikeQstash({ key: keys.QSTASH_CURRENT_SIGNING_KEY, body, url, exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyQstashSignature({ signature: expired, body, url }, keys)).toBe(false);

    expect(await verifyQstashSignature({ signature: "not.a.jwt", body, url }, keys)).toBe(false);
    expect(await verifyQstashSignature({ signature: "", body, url }, keys)).toBe(false);
  });

  it("skips the url check when no url is given", async () => {
    const genuine = signLikeQstash({ key: keys.QSTASH_CURRENT_SIGNING_KEY, body, url });
    expect(await verifyQstashSignature({ signature: genuine, body }, keys)).toBe(true);
  });

  it("fails closed when the signing keys are not configured", async () => {
    const genuine = signLikeQstash({ key: keys.QSTASH_CURRENT_SIGNING_KEY, body, url });
    expect(await verifyQstashSignature({ signature: genuine, body, url }, {})).toBe(false);
    expect(await verifyQstashSignature({ signature: genuine, body, url }, { QSTASH_CURRENT_SIGNING_KEY: keys.QSTASH_CURRENT_SIGNING_KEY })).toBe(false);
  });

  it("uses an injected receiver and turns its throw into false", async () => {
    const receiver = { verify: vi.fn(async () => true) };
    expect(await verifyQstashSignature({ signature: "sig", body, url }, keys, receiver)).toBe(true);
    expect(receiver.verify).toHaveBeenCalledWith({ signature: "sig", body, url });
    receiver.verify.mockRejectedValueOnce(new Error("bad"));
    expect(await verifyQstashSignature({ signature: "sig", body, url }, keys, receiver)).toBe(false);
  });
});
