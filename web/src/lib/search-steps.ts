import type { WorkStep } from "@/components/work-progress";

/**
 * What a search is doing, as POST /api/search streams it: the link read
 * first when the input is one, then lib/scout-run.ts's rounds (search the
 * sources, rank what came back, look for more), the save, and the cards'
 * finishing touches. Client-safe: no server imports.
 */
export type SearchStep =
  | { step: "reading" }
  | { step: "searching"; round: number; sources: number }
  | { step: "ranking"; round: number; posts: number }
  | { step: "saving"; count: number }
  | { step: "summaries"; count: number }
  | { step: "scoring"; count: number };

/** The media type POST /api/search streams its steps as, one JSON object per line, when asked for it. */
export const SEARCH_STEPS_TYPE = "application/x-ndjson";

export const SEARCH_TYPICAL = "usually under a minute";

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function labelOf(step: SearchStep, done: boolean): string {
  switch (step.step) {
    case "reading":
      return done ? "Read the link" : "Reading the link";
    case "searching":
      if (step.round <= 1) return `${done ? "Searched" : "Searching"} ${plural(step.sources, "source")}`;
      return `${done ? "Looked" : "Looking"} for more, round ${step.round}`;
    case "ranking":
      return `${done ? "Ranked" : "Ranking"} ${plural(step.posts, "post")}`;
    case "saving":
      return `${done ? "Saved" : "Saving"} the best ${step.count}`;
    case "summaries":
      return `${done ? "Read" : "Reading"} the discussions behind ${step.count}`;
    case "scoring":
      return `${done ? "Checked" : "Checking"} how human each one reads`;
  }
}

/**
 * Adds a step to the ones so far. A later round is one line that moves on
 * ("Looking for more, round 3"), its ranking folded in, so four rounds don't
 * make eight lines.
 */
export function addSearchStep(steps: SearchStep[], next: SearchStep): SearchStep[] {
  if (next.step === "ranking" && next.round > 1) return steps;
  const last = steps.at(-1);
  if (next.step === "searching" && next.round > 1 && last?.step === "searching" && last.round > 1) return [...steps.slice(0, -1), next];
  return [...steps, next];
}

/** The steps so far as WorkProgress shows them: each one done once the next begins. */
export function searchSteps(steps: SearchStep[]): WorkStep[] {
  if (steps.length === 0) return [{ label: "Starting the search", done: false }];
  return steps.map((step, i) => {
    const done = i < steps.length - 1;
    return { label: labelOf(step, done), done };
  });
}

// POST /api/search's answer: the route's JSON body, whether it came whole or as the last streamed line.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SearchOutcome = { ok: boolean; status: number; body: any };

/**
 * POST /api/search, following its steps as they stream: `onSteps` hears the
 * steps so far each time one begins. The answer is the route's JSON either
 * way (an answer that isn't streamed, a 400 say, comes whole).
 */
export async function postSearch(
  input: { input: string; mode?: "trends" | "videos" },
  onSteps?: (steps: SearchStep[]) => void,
  fetcher: typeof fetch = fetch,
): Promise<SearchOutcome> {
  const res = await fetcher("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: SEARCH_STEPS_TYPE },
    body: JSON.stringify(input),
  });
  if (!res.body || !res.headers.get("content-type")?.includes(SEARCH_STEPS_TYPE)) {
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let steps: SearchStep[] = [];
  let done: { status: number; body: unknown } | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { step?: SearchStep; done?: { status: number; body: unknown } };
    if (message.step) {
      steps = addSearchStep(steps, message.step);
      onSteps?.(steps);
    } else if (message.done) {
      done = message.done;
    }
  };
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffered += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      take(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  }
  take(buffered + decoder.decode());
  const answer = done as { status: number; body: unknown } | null;
  if (!answer) return { ok: false, status: 502, body: { error: "The search stopped before it finished. Try again." } };
  return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, body: answer.body };
}
