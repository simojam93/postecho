import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dismissFirstSearch, FIRST_SEARCH_EVENT, getFirstSearch, IDEAS_CHANGED_EVENT, missingSources, runFirstSearch, type FirstSearch } from "./first-search";
import { FirstSearchNotice } from "./first-search-banner";

// The store talks through window events: an EventTarget stands in for window in the node test env.
beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => { dismissFirstSearch(); vi.unstubAllGlobals(); });

const perSource = {
  hackernews: { status: "ok", inserted: 4 },
  bluesky: { status: "disabled", inserted: 0 },
  youtube: { status: "disabled", inserted: 0 },
  x_post: { status: "disabled", inserted: 0 },
};
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("the welcome's first search, followed in Find Ideas (2026-09-27)", () => {
  it("searching, then what it found and the sources it had no key for; Find Ideas reloads", async () => {
    const seen: string[] = [];
    window.addEventListener(FIRST_SEARCH_EVENT, () => seen.push(getFirstSearch()?.status ?? "none"));
    const reloads = vi.fn();
    window.addEventListener(IDEAS_CHANGED_EVENT, reloads);
    await runFirstSearch("YC interesting posts", answer(200, {
      query: "YC interesting posts",
      scout: { candidates: 90, judged: 90, inserted: 7, skippedDuplicates: 1, perSource },
    }));
    expect(seen).toEqual(["searching", "done"]);
    expect(getFirstSearch()).toMatchObject({ status: "done", found: 8, unranked: false, missingSources: ["Bluesky", "YouTube", "X"] });
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("says when the posts were saved without Jev, and when the search failed", async () => {
    await runFirstSearch("q", answer(200, { query: "q", scout: { candidates: 30, judged: 0, inserted: 20, skippedDuplicates: 0, note: "unranked: TYPESAFE_API_KEY not set" } }));
    expect(getFirstSearch()).toMatchObject({ status: "done", found: 20, unranked: true });
    await runFirstSearch("q", answer(500, { error: "boom" }));
    expect(getFirstSearch()).toEqual({ status: "failed", topic: "q" });
  });

  it("names only the sources that were skipped for a key", () => {
    expect(missingSources(perSource as never)).toEqual(["Bluesky", "YouTube", "X"]);
    expect(missingSources(undefined)).toEqual([]);
  });
});

describe("Find Ideas' line about it (2026-09-27: \"il suggerimento mi toglie il show more\")", () => {
  const render = (search: FirstSearch) => renderToStaticMarkup(createElement(FirstSearchNotice, { search }));

  it("while it runs: the moving bar and its steps so far", () => {
    const html = render({ status: "searching", topic: "YC interesting posts", steps: [{ step: "searching", round: 1, sources: 6 }], startedAt: 0 });
    expect(html).toContain("Searching 6 sources");
    expect(html).toContain("usually under a minute");
    expect(html).toContain("postecho-progress");
  });

  it("then nothing, so the cards and Show more keep their place; only what needs doing", () => {
    expect(render({ status: "done", topic: "q", found: 8, message: "", unranked: false, missingSources: ["X"] })).toBe("");
    const noJev = render({ status: "done", topic: "q", found: 20, message: "", unranked: true, missingSources: [] });
    expect(noJev).toContain("These posts are unranked");
    expect(noJev).toContain(">Connect Jev</a>");
    expect(render({ status: "done", topic: "q", found: 0, message: "No posts found for “q” — try different words.", unranked: false, missingSources: [] })).toContain("No posts found");
    expect(render({ status: "failed", topic: "q" })).toContain("didn&#x27;t work");
  });
});
