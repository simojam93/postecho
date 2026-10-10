import { beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));

const { agentServes } = await import("@/lib/agent-kinds");
const { getSetting, setSetting } = await import("@/lib/settings");

beforeEach(async () => { state.db = await createTestDb(); });

it("no heartbeat has listed the agent's kinds yet: nothing is blocked", async () => {
  expect(await getSetting(state.db as never, "agentKinds")).toBeNull();
  expect(await agentServes("repo_posts")).toBe(true);
});

it("serves a kind its last heartbeat listed, and not one it didn't", async () => {
  await setSetting(state.db as never, "agentKinds", ["video_ideas", "repo_posts"]);
  expect(await agentServes("repo_posts")).toBe(true);
  expect(await agentServes("pick_folder")).toBe(false);
});

it("an agent that serves nothing serves nothing", async () => {
  await setSetting(state.db as never, "agentKinds", []);
  expect(await agentServes("repo_posts")).toBe(false);
});
