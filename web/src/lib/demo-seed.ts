import { drafts, ideas, kv, scheduledPosts } from "@/db/schema";
import { dayKeyOf, parseDayKey, romeToUtc, shiftDay } from "@/components/plan/plan-calendar";
import type { db as Db } from "@/db";

/**
 * The sample data behind `npm run demo` and the README's images (2026-09-27):
 * every screen filled with posts that read as real, all of it invented, with
 * fictional names, links on example.com and a made-up video. Fixed ids,
 * inserted with ON CONFLICT DO NOTHING, so a second run adds nothing and the
 * capture script knows which pages to open.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const DEMO_IDS = {
  video: id(10),
  takesIdea: id(30),
  chosenIdea: id(31),
  chosenDraft: id(53),
} as const;

const TOPIC = "design systems";
const human = (slopScore: number) => ({ slopScore, verdict: slopScore < 35 ? "human" : "borderline" });

/** Trends: what a search for "design systems" found, one per source, best first. */
const TRENDS: Array<{ kind: string; title: string | null; content: string; author: string; slug: string; rank: number; slop?: number }> = [
  { kind: "hackernews", title: "Show HN: Tokens.fyi – see which design tokens drifted between Figma and code", content: "We kept shipping buttons in three slightly different blues. Tokens.fyi reads your Figma variables and your CSS and lists every token that drifted, with the components that use it.", author: "mkowalski", slug: "tokens-fyi", rank: 91, slop: 14 },
  { kind: "x_post", title: null, content: "Our design system had 212 components. Usage data says 38 of them cover 94% of our screens. We're deprecating the rest this quarter, and so far nobody on the product side has noticed.", author: "@lena.builds", slug: "x/lena-212-components", rank: 88, slop: 18 },
  { kind: "devto", title: "How we cut UI review time in half with an eight-question checklist", content: "Every PR that touches the UI gets the same questions: states, empty data, long text, keyboard, contrast, motion, RTL and mobile. It sounds bureaucratic. Reviews went from 40 minutes to 18.", author: "priya-codes", slug: "devto/ui-review-checklist", rank: 84, slop: 26 },
  { kind: "github", title: "tinytokens: a 2 kB design token runtime", content: "Load tokens from JSON, theme with CSS variables, switch to dark mode without a re-render. No build step. 1.2k stars in its first week.", author: "tinytokens", slug: "github/tinytokens", rank: 79 },
  { kind: "bluesky", title: null, content: "The best design system docs have more \"don't do this\" examples than \"do this\" ones. Show me the mistake and I'll remember the rule.", author: "Ines Moreau", slug: "bluesky/dont-do-this", rank: 76, slop: 31 },
  { kind: "producthunt", title: "Figlint: lint your Figma files like code", content: "Catches detached instances, off-grid spacing and colors that aren't tokens before handoff. 400 upvotes on launch day.", author: "Figlint", slug: "producthunt/figlint", rank: 72 },
  { kind: "lobsters", title: "A design system is a product, not a project", content: "A project ends. A design system has users, a roadmap and support tickets. The teams that staff it like a product keep it alive; the rest rebuild it every two years.", author: "rgarcia", slug: "lobsters/ds-is-a-product", rank: 69, slop: 22 },
  { kind: "arxiv", title: "Measuring UI consistency at scale with component usage graphs", content: "Mapping 1.8M screen views to the components they render, we find that screens built from shared components get 23% fewer usability complaints than screens with local variants.", author: "Chen, Okafor and Lind", slug: "arxiv/ui-consistency", rank: 66 },
  { kind: "mastodon", title: null, content: "\"Accessible by default\" in a design system means someone did the boring work once so forty teams don't have to. Thank your system team this week.", author: "tomas", slug: "mastodon/thank-your-system-team", rank: 62, slop: 44 },
];

const VIDEO = {
  url: "https://www.youtube.com/watch?v=demo-design-systems",
  title: "How small teams keep a design system alive",
  author: "Product Talks",
};

/** The video's 12 ready posts, written as the owner's own ideas (2026-09-27: "come se fossero idee mie"). */
const VIDEO_POSTS: Array<{ content: string; rank: number; slop: number }> = [
  { content: "A design system isn't done when the components ship. It's done when a new designer can build a screen without asking anyone. Until then it's a library with good intentions.", rank: 93, slop: 12 },
  { content: "Count the components your product actually uses. We had 140. Real screens used 31. Every extra component is a promise to maintain something nobody asked for.", rank: 90, slop: 15 },
  { content: "The fastest way to kill adoption: make the system team the only people allowed to change it. Let product teams propose, review in public, merge every week.", rank: 88, slop: 20 },
  { content: "Docs nobody reads have one thing in common. They explain the component, not the decision. Write down why the button looks like that and people stop fighting it.", rank: 86, slop: 17 },
  { content: "Tokens first, components second. When colors and spacing have the same names in code and in Figma, half your consistency problems never happen.", rank: 84, slop: 24 },
  { content: "Three questions before adding a component: who asked for it, which screens need it this month, who maintains it next year. No answer to the third, no component.", rank: 82, slop: 19 },
  { content: "Small team? You don't need a design system team. You need one person who says no, one shared file and a changelog people actually read.", rank: 79, slop: 13 },
  { content: "Design debt compounds like tech debt, just quieter. Every one-off \"just this once\" button is a fork you'll pay for when the rebrand comes.", rank: 76, slop: 27 },
  { content: "Measure a design system by what it removes: fewer review comments, fewer custom styles, fewer \"which blue?\" messages. Dashboards are nice. Silence is better.", rank: 73, slop: 31 },
  { content: "The best component API is boring. Few props, clear defaults, no surprises. If people need the docs to use a button, the button is the problem.", rank: 70, slop: 22 },
  { content: "Stop versioning the whole system. Version components. Nobody should wait for 4.0 to get the one fix they need in the date picker.", rank: 66, slop: 29 },
  { content: "Design systems fail socially before they fail technically. Invite product designers to the reviews, credit what they bring, and they'll defend the system for you.", rank: 58, slop: 35 },
];

const TAKES = [
  { xText: "Most design system docs explain what a component does. The ones people actually read explain why it looks that way. Decisions stick. Specs get skimmed.", slop: 16 },
  { xText: "Write down the why. A button spec tells people how. The reason behind it, the research or the bug it fixed, is what stops the next team from \"improving\" it.", slop: 22 },
  { xText: "Your design system docs are probably too complete. Cut the prop tables, keep the three decisions that matter, and link to the code for the rest.", slop: 34 },
];

const CHOSEN_X = "Design reviews go better when the designer writes the questions: three things I want feedback on, two I've already decided. People stop redesigning your work and start helping with it.";
const CHOSEN_LINKEDIN = [
  "Design reviews go better when the designer writes the questions.",
  "",
  "For a long time my reviews felt like exams. I'd show the work, and everyone in the room would redesign it on the spot: a different layout here, another color there. I'd leave with twenty opinions and no decisions.",
  "",
  "What changed it was one slide at the start: three things I want feedback on, and two I've already decided. The decided ones come with the reason, so nobody has to guess.",
  "",
  "The room changes. People stop redesigning the work and start helping with it. Reviews got shorter, and the feedback got sharper, because everyone knew where it was needed.",
  "",
  "If your reviews feel like exams, try writing the questions yourself next time.",
].join("\n");

/** Posts already scheduled or out: the week in Calendar, To rate, and the Archive. */
const SCHEDULED: Array<{ title: string; xText: string; linkedinText?: string; x?: [number, string]; linkedin?: [number, string]; outcome?: "good" }> = [
  { title: "Tokens before components", xText: "Tokens before components. If spacing and colors don't share names between Figma and code, no component library will save you.", linkedinText: "Tokens before components.\n\nIf spacing and colors don't share names between Figma and code, no component library will save you. We spent a quarter building components on top of mismatched values, then another quarter fixing them. Start with the names.", x: [2, "10:00"], linkedin: [2, "09:00"] },
  { title: "One person who says no", xText: "The most useful role in a small design system isn't a designer or an engineer. It's the one person allowed to say no.", x: [4, "17:00"] },
  { title: "Reviews in public", xText: "Moved our design system reviews to a public channel. Twice the proposals in a month, and half of them came from people who'd never contributed before.", x: [-2, "17:30"] },
  { title: "Deprecating components", xText: "Deprecated 12 components last month. Zero complaints. The scariest part of a cleanup is always the one before you look at the usage data.", linkedinText: "We deprecated 12 components last month and nobody complained.\n\nThe scariest part of a cleanup is always the part before you look at the usage data. Once we did, the list almost wrote itself.", linkedin: [-4, "09:00"], outcome: "good" },
];

/** A Rome wall time `days` from `now`'s day, as the instant the database keeps. */
function romeAt(now: Date, days: number, time: string): Date {
  const { year, month, day } = parseDayKey(shiftDay(dayKeyOf(now), days));
  const [hour, minute] = time.split(":").map(Number);
  return romeToUtc({ year, month, day, hour, minute });
}

export async function seedDemo(db: typeof Db, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  const settings: Array<[string, unknown]> = [
    ["identityName", "Sam Rivera"],
    // Not a valid X handle on purpose, so it can't be anyone's.
    ["identityHandle", "samrivera.demo"],
    ["onboardedAt", at],
    ["seenHints", ["sources", "settings", "videos"]],
    ["agentLastHeartbeatAt", at],
    ["styleGuide", "Short sentences. One idea per post. Concrete numbers over adjectives. No hashtags, no emojis. Opinions stated plainly, with the reason."],
  ];
  await db.insert(kv).values(settings.map(([key, value]) => ({ key, value }))).onConflictDoNothing();

  await db.insert(ideas).values(TRENDS.map((t, i) => ({
    id: id(i + 1),
    url: `https://example.com/${t.slug}`,
    kind: t.kind as typeof ideas.$inferInsert.kind,
    title: t.title,
    content: t.content,
    author: t.author,
    source: "scout" as const,
    status: "new" as const,
    createdAt: new Date(now.getTime() - (i + 1) * 60_000),
    meta: {
      topic: TOPIC,
      sourceName: t.kind,
      rank: t.rank,
      quality: t.rank - 3,
      score: t.rank - 6,
      ...(t.slop !== undefined ? { aiStyle: { ...human(t.slop), at } } : {}),
    },
  }))).onConflictDoNothing();

  await db.insert(ideas).values({
    id: DEMO_IDS.video, url: VIDEO.url, kind: "youtube", title: VIDEO.title, author: VIDEO.author,
    source: "manual", status: "new", meta: { pastedAt: at },
  }).onConflictDoNothing();
  await db.insert(ideas).values(VIDEO_POSTS.map((post, order) => ({
    id: id(11 + order),
    kind: "video_idea" as const,
    title: null,
    content: post.content,
    author: VIDEO.author,
    source: "manual" as const,
    status: "new" as const,
    meta: {
      videoId: DEMO_IDS.video, videoTitle: VIDEO.title, order, format: "post", sourceName: "youtube",
      articleUrl: VIDEO.url, rank: post.rank, aiStyle: { ...human(post.slop), at },
    },
  }))).onConflictDoNothing();

  // Write: a note waiting for its pick, and an article with its version chosen.
  await db.insert(ideas).values([
    { id: DEMO_IDS.takesIdea, kind: "note", content: "Most design system docs explain components. The good ones explain decisions.", source: "manual", status: "used", meta: {} },
    {
      id: DEMO_IDS.chosenIdea, kind: "article", url: "https://example.com/articles/design-reviews-without-exams",
      title: "Design reviews that don't feel like exams", author: "Studio Notes", source: "manual", status: "used",
      content: "A design review works when the person presenting sets the questions. The article walks through a one-slide format: what you want feedback on, and what's already decided.",
      meta: { sourceName: "article" },
    },
  ]).onConflictDoNothing();
  const slopMeta = (platform: "x" | "linkedin", slopScore: number) => ({
    slop: { platform, ...human(slopScore), at },
    slopByPlatform: { [platform]: { ...human(slopScore), at } },
  });
  await db.insert(drafts).values(TAKES.map((take, i) => ({
    id: id(50 + i), ideaId: DEMO_IDS.takesIdea, xText: take.xText, status: "candidate" as const,
    meta: { voice: "mine", ...slopMeta("x", take.slop) },
  }))).onConflictDoNothing();
  await db.insert(drafts).values([
    {
      id: DEMO_IDS.chosenDraft, ideaId: DEMO_IDS.chosenIdea, xText: CHOSEN_X, linkedinText: CHOSEN_LINKEDIN, status: "kept",
      meta: {
        voice: "mine", xAtLinkedin: CHOSEN_X,
        slop: { platform: "x", ...human(14), at },
        slopByPlatform: { x: { ...human(14), at }, linkedin: { ...human(21), at } },
      },
    },
    { id: id(54), ideaId: DEMO_IDS.chosenIdea, xText: "Stop presenting design work and hoping for the right feedback. Tell the room what you need: the questions come first, the screens second.", status: "candidate", meta: { voice: "mine", ...slopMeta("x", 25) } },
    { id: id(55), ideaId: DEMO_IDS.chosenIdea, xText: "A design review isn't an exam. Bring the questions you want answered and the decisions you've already made, and people stop redesigning your work in the room.", status: "candidate", meta: { voice: "mine", ...slopMeta("x", 30) } },
  ]).onConflictDoNothing();

  // Calendar and the Archive: posts scheduled on X and LinkedIn, and some already out.
  for (const [i, post] of SCHEDULED.entries()) {
    const ideaId = id(40 + i);
    const draftId = id(60 + i);
    await db.insert(ideas).values({ id: ideaId, kind: "note", title: post.title, content: post.xText, source: "manual", status: "used", meta: {} }).onConflictDoNothing();
    await db.insert(drafts).values({ id: draftId, ideaId, xText: post.xText, linkedinText: post.linkedinText ?? null, status: "used", meta: { voice: "mine" } }).onConflictDoNothing();
    const rows = (["x", "linkedin"] as const).flatMap((platform, j) => {
      const when = post[platform];
      if (!when) return [];
      const publishAt = romeAt(now, when[0], when[1]);
      return [{
        id: id(70 + i * 2 + j), draftId, platform, text: platform === "x" ? post.xText : post.linkedinText ?? post.xText,
        publishAt, publishedAt: publishAt, status: "posted_manually" as const, postedBy: "manual" as const,
        ...(post.outcome && publishAt < now ? { outcome: post.outcome, ratedAt: now } : {}),
      }];
    });
    if (rows.length > 0) await db.insert(scheduledPosts).values(rows).onConflictDoNothing();
  }
}
