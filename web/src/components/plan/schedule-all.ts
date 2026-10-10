/**
 * Schedule all's sequence (schedule in a row, 2026-10-10) as pure state — no React, no fetch,
 * unit-tested in schedule-all.test.ts. One step per platform still to schedule, X before LinkedIn,
 * post by post in the list's order; recording a time moves on, Skip leaves the rest of the post, Stop
 * ends it. What was recorded stays recorded whatever comes after.
 */
import type { PlanPlatform } from "./plan-calendar";

/** A ready post as the sequence takes it: its texts, the platforms left, and its time in the list. */
export type SequencePost = {
  draftId: string;
  xText: string | null;
  linkedinText: string | null;
  platforms: PlanPlatform[];
  /** UTC ISO; null when no posting time was free. */
  time: string | null;
};

export type SequenceStep = { post: number; draftId: string; platform: PlanPlatform; text: string; time: string | null };
export type Recorded = { draftId: string; platform: PlanPlatform; publishAt: string };

export type SequenceState = {
  steps: SequenceStep[];
  /** How many posts the sequence goes over. */
  posts: number;
  /** The step on screen; steps.length once past the last. */
  at: number;
  recorded: Recorded[];
  stopped: boolean;
};

export type SequenceAction = { type: "recorded"; publishAt: string } | { type: "skip" } | { type: "stop" };

const ORDER: PlanPlatform[] = ["x", "linkedin"];

export function startSequence(posts: SequencePost[]): SequenceState {
  const steps = posts.flatMap((post, index) => ORDER
    .filter((platform) => post.platforms.includes(platform))
    .map((platform) => ({
      post: index, draftId: post.draftId, platform, time: post.time,
      text: (platform === "x" ? post.xText : post.linkedinText) ?? "",
    })));
  return { steps, posts: posts.length, at: 0, recorded: [], stopped: false };
}

export function sequenceReducer(state: SequenceState, action: SequenceAction): SequenceState {
  const step = state.steps[state.at];
  if (state.stopped || !step) return state;
  switch (action.type) {
    case "recorded":
      return {
        ...state,
        at: state.at + 1,
        recorded: [...state.recorded, { draftId: step.draftId, platform: step.platform, publishAt: action.publishAt }],
      };
    case "skip": {
      const next = state.steps.findIndex((s, i) => i > state.at && s.post !== step.post);
      return { ...state, at: next === -1 ? state.steps.length : next };
    }
    case "stop":
      return { ...state, stopped: true };
  }
}

export function sequenceDone(state: SequenceState): boolean {
  return state.stopped || state.at >= state.steps.length;
}

/** How many posts got at least one platform scheduled. */
export function scheduledCount(state: SequenceState): number {
  return new Set(state.recorded.map((r) => r.draftId)).size;
}
