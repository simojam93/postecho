import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_BASE_URL, markPostedSig, markPostedUrl, postPageUrl, publicBaseUrl, publisherFor, publishWebhookUrl,
  verifyMarkPostedSig,
} from "@/lib/publishers";
import { escapeHtml, renderDueEmail, subjectPreview } from "@/lib/publishers/email";
import * as linkedin from "@/lib/publishers/linkedin";
import * as x from "@/lib/publishers/x";

const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = { SESSION_SECRET: "test-secret-test-secret-test-secret!" };

describe("composer urls", () => {
  it("X: the official intent with the text url-encoded", () => {
    expect(x.composerUrl("hello world & #tag / 100%")).toBe(
      "https://x.com/intent/post?text=hello%20world%20%26%20%23tag%20%2F%20100%25",
    );
    expect(x.composerUrl("two\nlines")).toBe("https://x.com/intent/post?text=two%0Alines");
  });

  it("X refuses more than 280 characters, accepts exactly 280", () => {
    expect(x.composerUrl("a".repeat(280))).toContain("text=" + "a".repeat(280));
    expect(() => x.composerUrl("a".repeat(281))).toThrow(/281 characters — the limit is 280/);
  });

  it("LinkedIn: the feed composer prefill with the text url-encoded", () => {
    expect(linkedin.composerUrl("Big news:\n\nwe shipped & it works")).toBe(
      "https://www.linkedin.com/feed/?shareActive=true&text=Big%20news%3A%0A%0Awe%20shipped%20%26%20it%20works",
    );
    // LinkedIn has no 280 cap here.
    expect(linkedin.composerUrl("a".repeat(1500))).toContain("a".repeat(1500));
  });

  it("publisherFor maps each platform to its label and composer", () => {
    expect(publisherFor("x").label).toBe("X");
    expect(publisherFor("x").composerUrl("hi")).toBe("https://x.com/intent/post?text=hi");
    expect(publisherFor("linkedin").label).toBe("LinkedIn");
    expect(publisherFor("linkedin").composerUrl("hi")).toBe("https://www.linkedin.com/feed/?shareActive=true&text=hi");
  });
});

describe("public urls", () => {
  it("defaults to the dev origin and strips trailing slashes", () => {
    expect(publicBaseUrl({})).toBe(DEFAULT_PUBLIC_BASE_URL);
    expect(DEFAULT_PUBLIC_BASE_URL).toBe("http://localhost:3210");
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://postecho.vercel.app/" })).toBe("https://postecho.vercel.app");
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "   " })).toBe(DEFAULT_PUBLIC_BASE_URL);
  });

  it("publishWebhookUrl points QStash at POST /api/publish/[id]", () => {
    expect(publishWebhookUrl(ID, { PUBLIC_BASE_URL: "https://app.test" })).toBe(`https://app.test/api/publish/${ID}`);
    expect(publishWebhookUrl(ID, {})).toBe(`http://localhost:3210/api/publish/${ID}`);
  });
});

describe("mark-as-posted signature", () => {
  it("signs the id with SESSION_SECRET as hex HMAC-SHA256 and builds the link", () => {
    const sig = markPostedSig(ID, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(markPostedUrl(ID, { ...SECRET, PUBLIC_BASE_URL: "https://app.test" })).toBe(
      `https://app.test/api/mark-posted?id=${ID}&sig=${sig}`,
    );
    // Deterministic, secret-dependent.
    expect(markPostedSig(ID, SECRET)).toBe(sig);
    expect(markPostedSig(ID, { SESSION_SECRET: "another-secret-another-secret-12" })).not.toBe(sig);
  });

  it("verifies the genuine signature only", () => {
    const sig = markPostedSig(ID, SECRET)!;
    expect(verifyMarkPostedSig(ID, sig, SECRET)).toBe(true);
    expect(verifyMarkPostedSig(ID, sig.toUpperCase(), SECRET)).toBe(false);
    expect(verifyMarkPostedSig(ID, sig.slice(0, 63) + (sig.endsWith("0") ? "1" : "0"), SECRET)).toBe(false);
    expect(verifyMarkPostedSig(ID, sig.slice(1), SECRET)).toBe(false);
    expect(verifyMarkPostedSig(ID, "", SECRET)).toBe(false);
    expect(verifyMarkPostedSig("22222222-2222-4222-8222-222222222222", sig, SECRET)).toBe(false);
  });

  it("can neither sign nor verify without SESSION_SECRET", () => {
    expect(markPostedSig(ID, {})).toBeNull();
    expect(() => markPostedUrl(ID, {})).toThrow(/SESSION_SECRET/);
    expect(() => postPageUrl(ID, {})).toThrow(/SESSION_SECRET/);
    const sig = markPostedSig(ID, SECRET)!;
    expect(verifyMarkPostedSig(ID, sig, {})).toBe(false);
  });
});

describe("postPageUrl (the email's Post on … button)", () => {
  it("is /post/<id>?sig=… on the public origin, carrying the very signature the mark link carries", () => {
    const sig = markPostedSig(ID, SECRET)!;
    expect(postPageUrl(ID, { ...SECRET, PUBLIC_BASE_URL: "https://app.test/" })).toBe(`https://app.test/post/${ID}?sig=${sig}`);
    expect(postPageUrl(ID, SECRET)).toBe(`http://localhost:3210/post/${ID}?sig=${sig}`);
    expect(new URL(markPostedUrl(ID, SECRET)).searchParams.get("sig")).toBe(sig);
  });

  it("verifies with verifyMarkPostedSig — one signature per row serves the page and the mark", () => {
    const url = new URL(postPageUrl(ID, SECRET));
    const id = url.pathname.split("/").pop()!;
    const sig = url.searchParams.get("sig")!;
    expect(id).toBe(ID);
    expect(verifyMarkPostedSig(id, sig, SECRET)).toBe(true);
    expect(verifyMarkPostedSig("22222222-2222-4222-8222-222222222222", sig, SECRET)).toBe(false);
    expect(verifyMarkPostedSig(id, sig, { SESSION_SECRET: "another-secret-another-secret-12" })).toBe(false);
  });
});

describe("renderDueEmail", () => {
  const xItem = {
    platform: "x" as const,
    text: "Shipping the thing today.\n\nDetails & a <link> below",
    pageUrl: "https://app.test/post/x-id?sig=abc",
    markPostedUrl: "https://app.test/api/mark-posted?id=x-id&sig=abc",
  };
  const linkedinItem = {
    platform: "linkedin" as const,
    text: "Longer LinkedIn story",
    pageUrl: "https://app.test/post/li-id?sig=def",
    markPostedUrl: "https://app.test/api/mark-posted?id=li-id&sig=def",
  };

  it("subject: Europe/Rome time, the platforms in order, the first 40 characters quoted", () => {
    // 15:00Z in September is 17:00 CEST; 16:00Z in January is 17:00 CET.
    const summer = renderDueEmail({ items: [xItem, linkedinItem], dueAt: new Date("2026-09-22T15:00:00Z") });
    expect(summer.subject).toBe('Post at 17:00 · X + LinkedIn · "Shipping the thing today. Details & a <l…"');
    const winter = renderDueEmail({ items: [linkedinItem], dueAt: new Date("2026-01-15T16:00:00Z") });
    expect(winter.subject).toBe('Post at 17:00 · LinkedIn · "Longer LinkedIn story"');
    const midnight = renderDueEmail({ items: [xItem], dueAt: new Date("2026-09-22T22:00:00Z") });
    expect(midnight.subject.startsWith("Post at 00:00 · X ·")).toBe(true);
  });

  it("subjectPreview collapses whitespace and cuts at 40 with an ellipsis", () => {
    expect(subjectPreview("  a   b\n\nc  ")).toBe("a b c");
    expect(subjectPreview("x".repeat(40))).toBe("x".repeat(40));
    expect(subjectPreview("x".repeat(41))).toBe("x".repeat(40) + "…");
    expect(subjectPreview("word ".repeat(10))).toBe("word word word word word word word word…");
  });

  it("html: one section per platform with escaped text, a Post on button to the share page and a Mark as posted link", () => {
    const { html } = renderDueEmail({ items: [xItem, linkedinItem], dueAt: new Date("2026-09-22T15:00:00Z") });
    expect(html).toContain("Post on X");
    expect(html).toContain("Post on LinkedIn");
    expect(html.indexOf("Post on X")).toBeLessThan(html.indexOf("Post on LinkedIn"));
    // The post text is escaped and its newlines kept.
    expect(html).toContain("Shipping the thing today.<br><br>Details &amp; a &lt;link&gt; below");
    expect(html).not.toContain("<link>");
    // The buttons open the rows' share pages; the mark links are attribute-escaped (the &). Both platforms present.
    expect(html).toContain('href="https://app.test/post/x-id?sig=abc"');
    expect(html).toContain('href="https://app.test/post/li-id?sig=def"');
    expect(html).toContain('href="https://app.test/api/mark-posted?id=x-id&amp;sig=abc"');
    expect(html).toContain('href="https://app.test/api/mark-posted?id=li-id&amp;sig=def"');
    expect((html.match(/Mark as posted/g) ?? []).length).toBe(2);
    // No composer URL anywhere in the email: on the phone it opens logged out (X) or unprefilled (LinkedIn app).
    expect(html).not.toContain("x.com/intent");
    expect(html).not.toContain("linkedin.com/feed");
    // Dark palette and the footer time in Europe/Rome.
    expect(html).toContain("#08080a");
    expect(html).toContain("#f5f5f7");
    expect(html).toContain("#7c7c86");
    expect(html).toContain("Scheduled for Tue 22 Sep, 17:00 (Europe/Rome) · PostEcho");
  });

  it("text: the same links, unescaped, one block per platform", () => {
    const { text } = renderDueEmail({ items: [xItem, linkedinItem], dueAt: new Date("2026-09-22T15:00:00Z") });
    expect(text).toContain("Post at 17:00 (Europe/Rome) · X + LinkedIn");
    expect(text).toContain("── X ──\n\nShipping the thing today.\n\nDetails & a <link> below\n\nPost on X:\nhttps://app.test/post/x-id?sig=abc\nMark as posted:\nhttps://app.test/api/mark-posted?id=x-id&sig=abc");
    expect(text).toContain("── LinkedIn ──");
    expect(text).toContain("Post on LinkedIn:\nhttps://app.test/post/li-id?sig=def");
    expect(text).toContain("Scheduled for Tue 22 Sep, 17:00 (Europe/Rome) · PostEcho");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("x.com/intent");
    expect(text).not.toContain("linkedin.com/feed");
  });

  it("escapeHtml covers the five characters and refuses an empty batch", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
    expect(() => renderDueEmail({ items: [], dueAt: new Date() })).toThrow(/nothing to send/);
  });
});
