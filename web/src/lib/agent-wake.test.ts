import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWakePort, startAgentWake, subscribeWakeFailed, wakeFailedNow, type WakeDocument, type WakeWindow } from "@/lib/agent-wake";

const ORIGIN = "https://postecho.example.com";

function fakePage({ visible = true, failWith }: { visible?: boolean; failWith?: Error } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const apiHeaders: Record<string, string> = {};
  const original = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url.startsWith("http://127.0.0.1")) {
      if (failWith) throw failWith;
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 201, headers: apiHeaders });
  });
  const listeners = new Map<string, () => void>();
  const doc: WakeDocument = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  const win: WakeWindow = {
    fetch: original as typeof fetch,
    location: { origin: ORIGIN, href: `${ORIGIN}/write` },
  };
  const wakeCalls = () => calls.filter((c) => c.url.startsWith("http://127.0.0.1")).map((c) => c.url);
  const setVisible = (v: boolean) => {
    (doc as { visibilityState: string }).visibilityState = v ? "visible" : "hidden";
    listeners.get("visibilitychange")?.();
  };
  return { win, doc, original, calls, wakeCalls, apiHeaders, setVisible, listeners };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const stops: Array<() => void> = [];
const start = (page: ReturnType<typeof fakePage>, port = 47321) => {
  const stop = startAgentWake({ port, win: page.win, doc: page.doc });
  stops.push(stop);
  return stop;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("agentWakePort", () => {
  it("defaults to 47321, keeps 0 to turn waking off, and ignores nonsense", () => {
    expect(agentWakePort(undefined)).toBe(47321);
    expect(agentWakePort("")).toBe(47321);
    expect(agentWakePort("0")).toBe(0);
    expect(agentWakePort("50000")).toBe(50000);
    expect(agentWakePort("abc")).toBe(47321);
    expect(agentWakePort("70000")).toBe(47321);
  });
});

describe("startAgentWake", () => {
  it("says the page is open on load, with a CORS call that carries no credentials", async () => {
    const page = fakePage();
    start(page);
    await settle();
    expect(page.wakeCalls()).toEqual(["http://127.0.0.1:47321/awake"]);
    expect(page.calls[0]!.init).toMatchObject({ method: "POST", mode: "cors", credentials: "omit" });
  });

  it("says it again every minute while visible, and when the page becomes visible", async () => {
    const page = fakePage();
    start(page);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(page.wakeCalls()).toHaveLength(3);
    page.setVisible(false);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(page.wakeCalls()).toHaveLength(3);
    page.setVisible(true);
    await settle();
    expect(page.wakeCalls()).toHaveLength(4);
  });

  it("wakes the agent after an /api/ response that made a job", async () => {
    const page = fakePage();
    start(page);
    await settle();
    page.apiHeaders["X-PostEcho-Job"] = "job-1";
    await page.win.fetch("/api/drafts/from-idea", { method: "POST" });
    await settle();
    expect(page.wakeCalls()).toEqual(["http://127.0.0.1:47321/awake", "http://127.0.0.1:47321/wake"]);
  });

  it("leaves other responses alone: no header, another origin, or not under /api/", async () => {
    const page = fakePage();
    start(page);
    await settle();
    await page.win.fetch("/api/settings");
    page.apiHeaders["X-PostEcho-Job"] = "job-1";
    await page.win.fetch("https://elsewhere.example.com/api/drafts");
    await page.win.fetch(`${ORIGIN}/write`);
    await settle();
    expect(page.wakeCalls()).toEqual(["http://127.0.0.1:47321/awake"]);
  });

  it("wraps fetch only once, however many times it starts", async () => {
    const page = fakePage();
    start(page)();
    start(page);
    await settle();
    page.apiHeaders["X-PostEcho-Job"] = "job-1";
    await page.win.fetch(new Request(`${ORIGIN}/api/repos/pick`, { method: "POST" }));
    await settle();
    expect(page.wakeCalls().filter((u) => u.endsWith("/wake"))).toHaveLength(1);
  });

  it("swallows a failed call quietly and remembers it until one works", async () => {
    const error = vi.spyOn(console, "error");
    const page = fakePage({ failWith: new TypeError("Failed to fetch") });
    const seen = vi.fn();
    const unsubscribe = subscribeWakeFailed(seen);
    start(page);
    await settle();
    expect(wakeFailedNow()).toBe(true);
    expect(seen).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    unsubscribe();

    const ok = fakePage();
    start(ok);
    await settle();
    expect(wakeFailedNow()).toBe(false);
  });

  it("does nothing with port 0", async () => {
    const page = fakePage();
    const fetchBefore = page.win.fetch;
    start(page, 0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(page.calls).toHaveLength(0);
    expect(page.win.fetch).toBe(fetchBefore);
  });

  it("stops its timer and listener when the shell unmounts", async () => {
    const page = fakePage();
    const stop = start(page);
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(page.wakeCalls()).toHaveLength(1);
    expect(page.listeners.has("visibilitychange")).toBe(false);
  });
});
