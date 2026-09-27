import { describe, expect, it } from "vitest";
import { addSearchStep, postSearch, searchSteps, type SearchStep } from "@/lib/search-steps";

describe("searchSteps", () => {
  it("each step done once the next begins, in plain words", () => {
    const steps: SearchStep[] = [
      { step: "reading" },
      { step: "searching", round: 1, sources: 8 },
      { step: "ranking", round: 1, posts: 96 },
      { step: "saving", count: 20 },
    ];
    expect(searchSteps(steps)).toEqual([
      { label: "Read the link", done: true },
      { label: "Searched 8 sources", done: true },
      { label: "Ranked 96 posts", done: true },
      { label: "Saving the best 20", done: false },
    ]);
    expect(searchSteps([])).toEqual([{ label: "Starting the search", done: false }]);
    expect(searchSteps([{ step: "searching", round: 1, sources: 1 }])).toEqual([{ label: "Searching 1 source", done: false }]);
  });

  it("later rounds are one line that moves on, their ranking folded in", () => {
    let steps: SearchStep[] = [];
    for (const next of [
      { step: "searching", round: 1, sources: 8 },
      { step: "ranking", round: 1, posts: 96 },
      { step: "searching", round: 2, sources: 6 },
      { step: "ranking", round: 2, posts: 40 },
      { step: "searching", round: 3, sources: 4 },
    ] as SearchStep[]) steps = addSearchStep(steps, next);
    expect(searchSteps(steps).map((s) => s.label)).toEqual(["Searched 8 sources", "Ranked 96 posts", "Looking for more, round 3"]);
  });
});

function streamed(lines: string[], split = 7): Response {
  const text = lines.join("\n") + "\n";
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Chunks that cut lines in two, as a network does.
      for (let i = 0; i < text.length; i += split) controller.enqueue(encoder.encode(text.slice(i, i + split)));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

describe("postSearch", () => {
  it("follows the streamed steps and returns the answer at the end", async () => {
    const heard: string[][] = [];
    const fetcher = (async () => streamed([
      JSON.stringify({ step: { step: "searching", round: 1, sources: 3 } }),
      JSON.stringify({ step: { step: "ranking", round: 1, posts: 12 } }),
      JSON.stringify({ done: { status: 201, body: { query: "q" } } }),
    ])) as unknown as typeof fetch;
    const out = await postSearch({ input: "q" }, (steps) => heard.push(searchSteps(steps).map((s) => s.label)), fetcher);
    expect(out).toEqual({ ok: true, status: 201, body: { query: "q" } });
    expect(heard).toEqual([["Searching 3 sources"], ["Searched 3 sources", "Ranking 12 posts"]]);
  });

  it("an answer that isn't streamed comes whole; a stream that stops early is a failure", async () => {
    const whole = (async () => Response.json({ error: "bad request" }, { status: 400 })) as unknown as typeof fetch;
    expect(await postSearch({ input: "q" }, undefined, whole)).toEqual({ ok: false, status: 400, body: { error: "bad request" } });
    const cut = (async () => streamed([JSON.stringify({ step: { step: "reading" } })])) as unknown as typeof fetch;
    expect(await postSearch({ input: "q" }, undefined, cut)).toMatchObject({ ok: false, status: 502 });
  });
});
