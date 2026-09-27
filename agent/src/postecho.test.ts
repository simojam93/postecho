import { describe, expect, it, vi } from "vitest";
import { createPostEchoClient, ProtocolError } from "./postecho.js";

const BASE_URL = "http://localhost:3210";
const TOKEN = "test-agent-token";

function client(fetchImpl: typeof fetch) {
  return createPostEchoClient({ baseUrl: BASE_URL, token: TOKEN, fetchImpl });
}

describe("createPostEchoClient", () => {
  describe("claimJob", () => {
    it("sends the bearer token and kinds/wait query, returns the job on 200", async () => {
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            job: {
              id: "job-1",
              kind: "generate_from_video",
              payload: { url: "https://youtu.be/abc" },
              createdAt: "2026-09-21T00:00:00.000Z",
              claimedAt: "2026-09-21T00:00:01.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const job = await client(fetchImpl).claimJob(["generate_from_video", "revise_draft"], 25);

      expect(job?.id).toBe("job-1");
      expect(job?.kind).toBe("generate_from_video");
      expect(job?.payload).toEqual({ url: "https://youtu.be/abc" });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      const calledUrl = new URL(String(url));
      expect(calledUrl.pathname).toBe("/api/agent/jobs");
      expect(calledUrl.searchParams.get("kinds")).toBe("generate_from_video,revise_draft");
      expect(calledUrl.searchParams.get("wait")).toBe("25");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    });

    it("returns null on 204 (nothing queued)", async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
      const job = await client(fetchImpl).claimJob(["generate_from_video"], 0);
      expect(job).toBeNull();
    });

    it("throws a ProtocolError surfacing the server's error message on failure", async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      );
      await expect(client(fetchImpl).claimJob(["generate_from_video"], 0)).rejects.toMatchObject({
        name: "ProtocolError",
        status: 400,
        message: expect.stringContaining("bad request"),
      });
    });
  });

  describe("postResult", () => {
    it("posts an ok:true body with the exact claimedAt echoed back", async () => {
      let capturedBody: unknown;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 200 });
      });

      await client(fetchImpl).postResult("job-1", "2026-09-21T00:00:01.000Z", {
        ok: true,
        result: { drafts: [{ xText: "hello" }] },
      });

      expect(capturedBody).toEqual({
        ok: true,
        result: { drafts: [{ xText: "hello" }] },
        claimedAt: "2026-09-21T00:00:01.000Z",
      });
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toContain("/api/agent/jobs/job-1/result");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    });

    it("posts an ok:false body with the error message and claimedAt echoed", async () => {
      let capturedBody: unknown;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 200 });
      });

      await client(fetchImpl).postResult("job-1", "2026-09-21T00:00:01.000Z", {
        ok: false,
        error: "transcript unavailable — paste it in the app",
      });

      expect(capturedBody).toEqual({
        ok: false,
        error: "transcript unavailable — paste it in the app",
        claimedAt: "2026-09-21T00:00:01.000Z",
      });
    });

    it("throws a ProtocolError surfacing the server's error message on failure", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "not found or not claimed" }), { status: 404 }),
      );
      await expect(
        client(fetchImpl).postResult("job-1", "stale", { ok: true, result: {} }),
      ).rejects.toMatchObject({
        name: "ProtocolError",
        status: 404,
        message: expect.stringContaining("not found or not claimed"),
      });
    });
  });

  describe("heartbeat", () => {
    it("posts the served kinds and resolves on 200", async () => {
      let capturedBody: unknown;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      await client(fetchImpl).heartbeat(["generate_from_video", "revise_draft"]);
      expect(capturedBody).toEqual({ kinds: ["generate_from_video", "revise_draft"] });
    });

    it("reads back the Claude model the owner picked, and only a known one (2026-09-26)", async () => {
      const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
      expect(await client(answer({ ok: true, claudeModel: "opus" })).heartbeat(["revise_draft"])).toEqual({ claudeModel: "opus" });
      expect(await client(answer({ ok: true })).heartbeat(["revise_draft"])).toEqual({ claudeModel: null });
      expect(await client(answer({ ok: true, claudeModel: "gpt-5" })).heartbeat(["revise_draft"])).toEqual({ claudeModel: null });
    });

    it("throws a ProtocolError on failure", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
      await expect(client(fetchImpl).heartbeat(["revise_draft"])).rejects.toMatchObject({
        name: "ProtocolError",
        status: 401,
      });
    });
  });

  describe("getProfile", () => {
    it("returns the parsed profile shape", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              identityName: "Simone",
              identityHandle: "@simone",
              toneExamplesX: "example one",
              toneExamplesLinkedin: "",
              toneForm: { hashtags: "no" },
              styleGuide: "be concrete",
              topics: ["ai", "indie hacking"],
              imageSpecs: "16:9, minimalist",
            }),
            { status: 200 },
          ),
      );

      const profile = await client(fetchImpl).getProfile();
      expect(profile).toEqual({
        identityName: "Simone",
        identityHandle: "@simone",
        toneExamplesX: "example one",
        toneExamplesLinkedin: "",
        toneForm: { hashtags: "no" },
        styleGuide: "be concrete",
        topics: ["ai", "indie hacking"],
        imageSpecs: "16:9, minimalist",
        references: [],
      });
    });

    it("defaults missing fields instead of throwing", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
      const profile = await client(fetchImpl).getProfile();
      expect(profile).toEqual({
        identityName: "",
        identityHandle: "",
        toneExamplesX: "",
        toneExamplesLinkedin: "",
        toneForm: {},
        styleGuide: "",
        topics: [],
        imageSpecs: "",
        references: [],
      });
    });

    it("throws a ProtocolError on failure", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
      await expect(client(fetchImpl).getProfile()).rejects.toMatchObject({
        name: "ProtocolError",
        status: 401,
      });
    });
  });

  describe("slopCheck / reportProgress (humanize loop, M3.6)", () => {
    it("slopCheck posts the text (and platform when given) and returns Jev's verdict", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ slop: { slopScore: 42, verdict: "borderline", confidence: 0.8 } }), { status: 200 }));
      const out = await client(fetchImpl).slopCheck("some text", "x");
      expect(out).toEqual({ slopScore: 42, verdict: "borderline" });
      const [url, init] = fetchImpl.mock.calls[0]! as unknown as [URL, RequestInit];
      expect(new URL(String(url)).pathname).toBe("/api/agent/slop-check");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ text: "some text", platform: "x" });
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

      await client(fetchImpl).slopCheck("plain");
      expect(JSON.parse(String((fetchImpl.mock.calls[1]! as unknown as [URL, RequestInit])[1].body))).toEqual({ text: "plain" });
    });

    it("slopCheck throws on 503 and on a malformed body", async () => {
      const unavailable = vi.fn(async () => new Response(JSON.stringify({ error: "slop check disabled" }), { status: 503 }));
      await expect(client(unavailable).slopCheck("t")).rejects.toThrow(/slopCheck failed: 503/);
      const malformed = vi.fn(async () => new Response(JSON.stringify({ slop: { verdict: "human" } }), { status: 200 }));
      await expect(client(malformed).slopCheck("t")).rejects.toThrow(/malformed/);
    });

    it("reportProgress posts the claimedAt echo and the progress to the job's progress endpoint", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await client(fetchImpl).reportProgress("job-9", "2026-09-23T10:00:00.000Z", { kind: "humanize", round: 2 });
      const [url, init] = fetchImpl.mock.calls[0]! as unknown as [URL, RequestInit];
      expect(new URL(String(url)).pathname).toBe("/api/agent/jobs/job-9/progress");
      expect(JSON.parse(String(init.body))).toEqual({ claimedAt: "2026-09-23T10:00:00.000Z", progress: { kind: "humanize", round: 2 } });

      const gone = vi.fn(async () => new Response(JSON.stringify({ error: "not found or not claimed" }), { status: 404 }));
      await expect(client(gone).reportProgress("job-9", "x", {})).rejects.toThrow(/reportProgress failed: 404/);
    });
  });
});
