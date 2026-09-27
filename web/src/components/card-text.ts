import { decodeEntities } from "@/lib/enrich";

/** Hacker News's own tag on a launch ("Show HN: …"): not part of what the card says (owner, 2026-09-27: "questo toglilo"). */
const HN_LAUNCH_TAG = /^(show|launch) hn:\s*/i;

/** A card's text as shown: entities decoded, a Show/Launch HN tag dropped. The saved text stays whole. */
export function cardText(content: string): string {
  return decodeEntities(content).replace(HN_LAUNCH_TAG, "");
}
