import { agentWakePort } from "@/lib/agent-wake";

/**
 * The page's side of a post's media (media from a repo, 2026-10-11): the files never leave the owner's
 * computer, so the page asks the agent's wake server on 127.0.0.1 for them, to show them in Finder and
 * to delete them (agent/src/wake-server.ts). Calls carry no credentials; a failure is just false.
 */
export const AGENT_PORT = agentWakePort(process.env.NEXT_PUBLIC_AGENT_WAKE_PORT);

/** The file as the wake server serves it. */
export function mediaUrl(port: number, draftId: string, file: string): string {
  return `http://127.0.0.1:${port}/media/${encodeURIComponent(draftId)}/${encodeURIComponent(file)}`;
}

/** Show in Finder: true when the agent did it. */
export async function revealMedia(port: number, draftId: string, file: string): Promise<boolean> {
  if (port === 0) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/media/reveal`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, file }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Deletes a removed file on the owner's computer. Best effort: the list on the draft is the truth. */
export async function deleteMediaFile(port: number, draftId: string, file: string): Promise<boolean> {
  if (port === 0) return false;
  try {
    const res = await fetch(mediaUrl(port, draftId, file), { method: "DELETE", mode: "cors", credentials: "omit" });
    return res.ok;
  } catch {
    return false;
  }
}
