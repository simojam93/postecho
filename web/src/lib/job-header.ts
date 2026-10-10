/**
 * The header a route sets when the owner's request created a job. The app
 * shell's fetch wrapper (components/agent-waker.tsx) sees it and wakes the
 * agent on the owner's computer, so no component needs to know about the agent
 * (docs/specs/2026-10-10-agent-wakes-on-demand-design.md).
 */
export const JOB_HEADER = "X-PostEcho-Job";

/** A 201 JSON answer for a request that created the job `jobId`. */
export function jobCreated(body: unknown, jobId: string): Response {
  return Response.json(body, { status: 201, headers: { [JOB_HEADER]: jobId } });
}
