import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyJobs, DONE_SHOWN_MS, POLL_MS, refreshWork, resetWork, TAB_OF_KIND, trackWork, workSnapshot } from "./work-status";

beforeEach(() => { vi.useFakeTimers(); resetWork(); });
afterEach(() => { resetWork(); vi.useRealTimers(); });

describe("the sidebar's work marks (2026-09-27: \"un charging che poi diventa un tick verde… resta un secondo e poi scompare\")", () => {
  it("a search: working on Find Ideas while it runs, then ✓ for a moment, then nothing", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const search = trackWork("find", new Promise<{ ok: boolean }>((resolve) => { finish = resolve; }), (r) => r.ok);
    expect(workSnapshot()).toEqual({ find: "running", write: null });
    finish({ ok: true });
    await search;
    expect(workSnapshot()).toEqual({ find: "done", write: null });
    await vi.advanceTimersByTimeAsync(DONE_SHOWN_MS + 50);
    expect(workSnapshot()).toEqual({ find: null, write: null });
  });

  it("a search that fails says so for a moment, not ✓", async () => {
    await trackWork("find", Promise.resolve({ ok: false }), (r) => r.ok);
    expect(workSnapshot().find).toBe("failed");
    await expect(trackWork("find", Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(workSnapshot().find).toBe("failed");
  });

  it("a job on the Mac: working on its tab while queued or running, then ✓ or ! once it ends", () => {
    applyJobs([{ id: "a", kind: "revise_draft", status: "claimed" }, { id: "b", kind: "video_ideas", status: "queued" }, { id: "c", kind: "learn_style", status: "claimed" }]);
    expect(workSnapshot()).toEqual({ find: "running", write: "running" });
    applyJobs([{ id: "a", kind: "revise_draft", status: "done" }, { id: "b", kind: "video_ideas", status: "failed" }]);
    expect(workSnapshot()).toEqual({ find: "failed", write: "done" });
  });

  it("a repo's posts work on Create posts (2026-10-10)", () => {
    expect(TAB_OF_KIND.repo_posts).toBe("find");
  });

  it("stays working while another job on the tab still runs; a job never seen running shows nothing", () => {
    applyJobs([{ id: "a", kind: "generate_from_idea", status: "claimed" }, { id: "b", kind: "revise_draft", status: "queued" }]);
    applyJobs([{ id: "a", kind: "generate_from_idea", status: "done" }, { id: "b", kind: "revise_draft", status: "claimed" }]);
    expect(workSnapshot().write).toBe("running");
    resetWork();
    applyJobs([{ id: "z", kind: "revise_draft", status: "done" }]);
    expect(workSnapshot().write).toBeNull();
  });

  it("reads again every few seconds while something runs, and stops once nothing does", async () => {
    const replies = [
      [{ id: "a", kind: "video_ideas", status: "claimed" }],
      [{ id: "a", kind: "video_ideas", status: "done" }],
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jobs: replies.shift() ?? [] })));
    await refreshWork(fetcher as never);
    expect(workSnapshot().find).toBe("running");
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(workSnapshot().find).toBe("done");
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
