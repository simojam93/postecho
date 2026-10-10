import { db } from "@/db";
import { getSetting } from "@/lib/settings";

/** What a route answers when the agent's last heartbeat didn't list the job's kind. */
export const UPDATE_AGENT_ERROR = "Update the agent: git pull, then restart npm run dev.";

/**
 * Whether the agent can do a job of this kind, from the kinds its last heartbeat listed
 * (settings' agentKinds). True when no heartbeat has listed them yet, so an unknown state never
 * blocks; false only when the list exists and lacks the kind.
 */
export async function agentServes(kind: string): Promise<boolean> {
  const kinds = await getSetting(db as never, "agentKinds");
  return !Array.isArray(kinds) || kinds.includes(kind);
}
