import { z } from "zod";

/** The models Settings › AI tools offers: aliases `claude --model` resolves to the latest of each. */
export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export function claudeModelOf(value: unknown): ClaudeModel | null {
  return (CLAUDE_MODELS as readonly unknown[]).includes(value) ? (value as ClaudeModel) : null;
}

/**
 * A claimed job, as returned by `GET /api/agent/jobs` (see
 * web/src/app/api/agent/jobs/route.ts's claimOne()). `payload` is kind-
 * specific and validated downstream by each handler/prompt builder, not
 * here — this client only speaks the outer envelope.
 */
export type Job = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  claimedAt: string;
};

/**
 * What a job handler produced. Mirrors the strict union `web/src/app/api/
 * agent/jobs/[id]/result/route.ts` expects: `claimedAt` is added by
 * postResult() itself (every handler already has it from the claimed Job),
 * never invented by the caller.
 */
export type JobOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** The tone/identity profile from `GET /api/agent/profile` — never includes notificationEmail or any other setting outside this allowlist. */
export type Profile = {
  identityName: string;
  identityHandle: string;
  toneExamplesX: string;
  toneExamplesLinkedin: string;
  toneForm: Record<string, unknown>;
  styleGuide: string;
  topics: string[];
  imageSpecs: string;
  /** The owner's enabled reference material (web's lib/library.ts), already within its budget. */
  references: Array<{ name: string; text: string }>;
};

const ProfileSchema = z.object({
  identityName: z.string().default(""),
  identityHandle: z.string().default(""),
  toneExamplesX: z.string().default(""),
  toneExamplesLinkedin: z.string().default(""),
  toneForm: z.record(z.string(), z.unknown()).default({}),
  styleGuide: z.string().default(""),
  topics: z.array(z.string()).default([]),
  imageSpecs: z.string().default(""),
  references: z.array(z.object({ name: z.string(), text: z.string() })).default([]),
});

export class ProtocolError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
  }
}

export type PostEchoClientOptions = {
  baseUrl: string;
  token: string;
  /** Injected for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Pulls the `{ error: string }` envelope this API always uses for failures
 * (see requireAgentToken and every route's catch block) out of a failed
 * response, falling back to the raw body so nothing is ever silently lost.
 */
async function describeFailure(res: Response, action: string): Promise<ProtocolError> {
  const text = await res.text().catch(() => "");
  let message = text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === "string") message = parsed.error;
    } catch {
      // Body wasn't JSON — keep the raw text.
    }
  }
  return new ProtocolError(`${action} failed: ${res.status}${message ? ` — ${message}` : ""}`, res.status);
}

export function createPostEchoClient(opts: PostEchoClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, opts.baseUrl);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${opts.token}`);
    if (init?.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetchImpl(url, { ...init, headers });
  }

  return {
    /** GET /api/agent/jobs?kinds=&wait= — one claimed job, or null on 204 (nothing queued within the wait window). */
    async claimJob(kinds: string[], waitSeconds: number): Promise<Job | null> {
      const qs = new URLSearchParams({ kinds: kinds.join(","), wait: String(waitSeconds) });
      const res = await request(`/api/agent/jobs?${qs.toString()}`);
      if (res.status === 204) return null;
      if (!res.ok) throw await describeFailure(res, "claimJob");
      const body = (await res.json()) as { job: Job };
      return body.job;
    },

    /**
     * POST /api/agent/jobs/:id/result — claimedAt must be the exact string
     * the claim response gave for this job; the server uses it as an
     * ownership token and 404s a report that doesn't match (see
     * jobs/[id]/result/route.ts).
     */
    async postResult(jobId: string, claimedAt: string, outcome: JobOutcome): Promise<void> {
      const body = outcome.ok
        ? { ok: true as const, result: outcome.result, claimedAt }
        : { ok: false as const, error: outcome.error, claimedAt };
      const res = await request(`/api/agent/jobs/${jobId}/result`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await describeFailure(res, "postResult");
    },

    /**
     * POST /api/agent/heartbeat — records "last seen" (the body is informational:
     * the server doesn't key off `kinds`). The answer carries the Claude model the
     * owner picked in Settings › AI tools (2026-09-26); null from an older web app
     * or for anything but a known alias, meaning no change.
     */
    async heartbeat(kinds: string[]): Promise<{ claudeModel: ClaudeModel | null }> {
      const res = await request(`/api/agent/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ kinds }),
      });
      if (!res.ok) throw await describeFailure(res, "heartbeat");
      const body = (await res.json().catch(() => null)) as { claudeModel?: unknown } | null;
      return { claudeModel: claudeModelOf(body?.claudeModel) };
    },

    /**
     * POST /api/agent/slop-check — Jev's AI-style verdict on `text`, run by
     * the web app with its own TypeSafe key (humanize loop, M3.6). Throws on
     * any failure, 503 (no key on the server) included: the loop treats a
     * throw as "no score" and stops after that round.
     */
    async slopCheck(text: string, platform?: "x" | "linkedin"): Promise<{ slopScore: number; verdict: string }> {
      const res = await request(`/api/agent/slop-check`, {
        method: "POST",
        body: JSON.stringify(platform ? { text, platform } : { text }),
      });
      if (!res.ok) throw await describeFailure(res, "slopCheck");
      const body = (await res.json()) as { slop?: { slopScore?: unknown; verdict?: unknown } };
      const slopScore = body.slop?.slopScore;
      const verdict = body.slop?.verdict;
      if (typeof slopScore !== "number" || typeof verdict !== "string") {
        throw new ProtocolError("slopCheck failed: malformed response");
      }
      return { slopScore, verdict };
    },

    /**
     * POST /api/agent/jobs/:id/progress — live progress for a claimed job
     * (which humanize round it's on), shown by the page while it polls. Same
     * claimedAt ownership echo as postResult.
     */
    async reportProgress(jobId: string, claimedAt: string, progress: Record<string, unknown>): Promise<void> {
      const res = await request(`/api/agent/jobs/${jobId}/progress`, {
        method: "POST",
        body: JSON.stringify({ claimedAt, progress }),
      });
      if (!res.ok) throw await describeFailure(res, "reportProgress");
    },

    /** GET /api/agent/profile — zod-defaulted so a brand-new install (every setting still unset) parses to an empty-but-well-typed profile instead of throwing. */
    async getProfile(): Promise<Profile> {
      const res = await request(`/api/agent/profile`);
      if (!res.ok) throw await describeFailure(res, "getProfile");
      return ProfileSchema.parse(await res.json());
    },
  };
}

export type PostEchoClient = ReturnType<typeof createPostEchoClient>;
