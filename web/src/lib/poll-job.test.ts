import { afterEach, describe, expect, it, vi } from "vitest";
import { pollJob } from "@/lib/poll-job";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("pollJob", () => {
  it("returns immediately when the first poll is already done", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [{ id: "j1", status: "done", result: { ok: true } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const job = await pollJob("j1", { intervalMs: 0 });
    expect(job).toMatchObject({ id: "j1", status: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs?id=j1");
  });

  it("keeps polling while queued/claimed, then resolves once failed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ id: "j1", status: "queued", result: null }] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ id: "j1", status: "claimed", result: null }] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ id: "j1", status: "failed", result: { error: "boom" } }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const job = await pollJob("j1", { intervalMs: 0 });
    expect(job.status).toBe("failed");
    expect(job.result).toEqual({ error: "boom" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws when a poll request itself fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "internal error" }, false));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(pollJob("j1", { intervalMs: 0 })).rejects.toThrow();
  });

  it("supports a custom isDone predicate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [{ id: "j1", status: "claimed", result: null }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const job = await pollJob("j1", { intervalMs: 0, isDone: (j) => j.status === "claimed" });
    expect(job.status).toBe("claimed");
  });

  it("keeps polling when no job is returned yet (empty jobs array)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ id: "j1", status: "done", result: null }] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const job = await pollJob("j1", { intervalMs: 0 });
    expect(job.status).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("onPoll sees every row, the in-flight ones included (a Humanize's live round)", async () => {
    const rows = [
      { id: "j1", status: "claimed", result: { progress: { round: 1 } } },
      { id: "j1", status: "claimed", result: { progress: { round: 2 } } },
      { id: "j1", status: "done", result: { text: "t" } },
    ];
    const fetchMock = vi.fn();
    for (const row of rows) fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [row] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const seen: unknown[] = [];
    const job = await pollJob("j1", { intervalMs: 0, onPoll: (j) => seen.push(j.result) });
    expect(job.status).toBe("done");
    expect(seen).toEqual([{ progress: { round: 1 } }, { progress: { round: 2 } }, { text: "t" }]);
  });

  it("an aborted signal stops polling with an AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return jsonResponse({ jobs: [{ id: "j1", status: "claimed", result: null }] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(pollJob("j1", { intervalMs: 50, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs?id=j1", { signal: controller.signal });
  });
});
