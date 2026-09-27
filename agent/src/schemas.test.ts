import { describe, expect, it } from "vitest";
import {
  DRAFTS_SCHEMA,
  IMAGE_PROMPT_SCHEMA,
  REVISE_SCHEMA,
  STYLE_GUIDE_SCHEMA,
  parseDraftsResult,
  parseImagePromptResult,
  parseReviseResult,
  parseStyleGuideResult,
} from "./schemas.js";
import { humanizeMaxChars, humanizeSchema, parseHumanizeResult, parseSyncLinkedinResult, parseVoiceResult, SYNC_LINKEDIN_SCHEMA, voiceSchema } from "./schemas.js";

describe("JSON Schema constants", () => {
  it("DRAFTS_SCHEMA describes an object with a drafts array", () => {
    expect(DRAFTS_SCHEMA.type).toBe("object");
    expect(DRAFTS_SCHEMA.required).toEqual(["drafts"]);
    expect(DRAFTS_SCHEMA.properties.drafts.type).toBe("array");
    expect(DRAFTS_SCHEMA.properties.drafts.minItems).toBe(1);
    expect(DRAFTS_SCHEMA.properties.drafts.maxItems).toBe(25);
  });

  it("REVISE_SCHEMA describes a flat object with optional platform fields", () => {
    expect(REVISE_SCHEMA.type).toBe("object");
    expect(REVISE_SCHEMA.properties).toHaveProperty("xText");
    expect(REVISE_SCHEMA.properties).toHaveProperty("linkedinText");
  });

  it("IMAGE_PROMPT_SCHEMA requires imagePrompt", () => {
    expect(IMAGE_PROMPT_SCHEMA.required).toEqual(["imagePrompt"]);
  });

  it("STYLE_GUIDE_SCHEMA requires styleGuide", () => {
    expect(STYLE_GUIDE_SCHEMA.required).toEqual(["styleGuide"]);
  });
});

describe("parseDraftsResult", () => {
  const linkedinOk = "l".repeat(700);

  it("accepts a valid drafts array", () => {
    const value = { drafts: [{ xText: "hello world", linkedinText: linkedinOk }, { xText: "second", linkedinText: linkedinOk }] };
    expect(parseDraftsResult(value)).toEqual(value);
  });

  it("rejects an xText over 280 chars (hard rule)", () => {
    expect(() => parseDraftsResult({ drafts: [{ xText: "a".repeat(281), linkedinText: linkedinOk }] })).toThrow();
  });

  it("accepts an xText at exactly 280 chars", () => {
    const value = { drafts: [{ xText: "a".repeat(280), linkedinText: linkedinOk }] };
    expect(parseDraftsResult(value)).toEqual(value);
  });

  it("rejects a linkedinText outside the 600-1200 char window", () => {
    expect(() => parseDraftsResult({ drafts: [{ xText: "ok", linkedinText: "short" }] })).toThrow();
    expect(() => parseDraftsResult({ drafts: [{ xText: "x only" }] })).toThrow();
    expect(() => parseDraftsResult({ drafts: [{ linkedinText: linkedinOk }] })).toThrow();
    expect(() => parseDraftsResult({ drafts: [{ xText: "ok", linkedinText: "l".repeat(1201) }] })).toThrow();
  });

  it("rejects a draft with neither xText nor linkedinText", () => {
    expect(() => parseDraftsResult({ drafts: [{}] })).toThrow();
  });

  it("rejects an empty drafts array", () => {
    expect(() => parseDraftsResult({ drafts: [] })).toThrow();
  });

  it("rejects more than 25 drafts", () => {
    const drafts = Array.from({ length: 26 }, () => ({ xText: "hi" }));
    expect(() => parseDraftsResult({ drafts })).toThrow();
  });
});

describe("parseReviseResult", () => {
  it("accepts xText alone", () => {
    expect(parseReviseResult({ xText: "hello" })).toEqual({ xText: "hello" });
  });

  it("accepts linkedinText alone, with no 600-char floor (a revision may legitimately shorten it)", () => {
    expect(parseReviseResult({ linkedinText: "short revision" })).toEqual({ linkedinText: "short revision" });
  });

  it("still enforces the 280-char hard rule for xText", () => {
    expect(() => parseReviseResult({ xText: "a".repeat(281) })).toThrow();
  });

  it("rejects neither field present", () => {
    expect(() => parseReviseResult({})).toThrow();
  });
});

describe("parseImagePromptResult", () => {
  it("accepts a normal imagePrompt", () => {
    expect(parseImagePromptResult({ imagePrompt: "a minimalist 16:9 illustration" })).toEqual({
      imagePrompt: "a minimalist 16:9 illustration",
    });
  });

  it("rejects an empty imagePrompt", () => {
    expect(() => parseImagePromptResult({ imagePrompt: "" })).toThrow();
  });

  it("rejects an imagePrompt over 2000 chars", () => {
    expect(() => parseImagePromptResult({ imagePrompt: "a".repeat(2001) })).toThrow();
  });
});

describe("parseStyleGuideResult", () => {
  it("accepts a normal styleGuide", () => {
    expect(parseStyleGuideResult({ styleGuide: "# Voice\nConcrete, first person." })).toEqual({
      styleGuide: "# Voice\nConcrete, first person.",
    });
  });

  it("rejects an empty styleGuide", () => {
    expect(() => parseStyleGuideResult({ styleGuide: "" })).toThrow();
  });

  it("rejects a styleGuide over 20000 chars", () => {
    expect(() => parseStyleGuideResult({ styleGuide: "a".repeat(20001) })).toThrow();
  });
});

describe("every --json-schema is a valid API tool input_schema", () => {
  // The API rejects oneOf/allOf/anyOf at the top level of a tool's
  // input_schema (hit live on 2026-09-22 with REVISE_SCHEMA). Nested
  // combinators are fine, so this only checks the root.
  const ALL = { DRAFTS_SCHEMA, REVISE_SCHEMA, IMAGE_PROMPT_SCHEMA, STYLE_GUIDE_SCHEMA };
  for (const [name, schema] of Object.entries(ALL)) {
    it(`${name} has no top-level oneOf/allOf/anyOf and is a closed object`, () => {
      const root = schema as Record<string, unknown>;
      expect(root.type).toBe("object");
      expect(root.additionalProperties).toBe(false);
      expect(root).not.toHaveProperty("anyOf");
      expect(root).not.toHaveProperty("oneOf");
      expect(root).not.toHaveProperty("allOf");
    });
  }
});

describe("humanize schema helpers", () => {
  it("humanizeMaxChars: X posts and anything that fits one stay within 280; a longer LinkedIn post may grow 40% within its ceiling", () => {
    expect(humanizeMaxChars("a".repeat(100), "linkedin")).toBe(280);
    expect(humanizeMaxChars("a".repeat(500), "x")).toBe(280);
    expect(humanizeMaxChars("a".repeat(1000), "linkedin")).toBe(1400);
    expect(humanizeMaxChars("a".repeat(3500), "linkedin")).toBe(4000);
  });

  it("humanizeSchema is a plain object schema with no top-level combinators", () => {
    const schema = humanizeSchema(280);
    expect(schema).toEqual({ type: "object", properties: { rewrite: { type: "string", minLength: 1, maxLength: 280 } }, required: ["rewrite"], additionalProperties: false });
    for (const key of ["anyOf", "oneOf", "allOf"]) expect(key in schema).toBe(false);
  });

  it("parseHumanizeResult trims, rejects empty and over-long text", () => {
    const parse = parseHumanizeResult(10);
    expect(parse({ rewrite: "  hi  " })).toEqual({ text: "hi" });
    expect(() => parse({ rewrite: "   " })).toThrow();
    expect(() => parse({ rewrite: "x".repeat(11) })).toThrow();
    expect(() => parse({})).toThrow();
  });

  it("parseHumanizeResult unwraps a reply that nested the JSON inside the field (seen live)", () => {
    const parse = parseHumanizeResult(200);
    expect(parse({ rewrite: '{"rewrite": "Consistency beats a big push, at least for me."}' })).toEqual({ text: "Consistency beats a big push, at least for me." });
    expect(parse({ rewrite: ' {"text": "old field name"} ' })).toEqual({ text: "old field name" });
    expect(parse({ rewrite: "{not json} but fine" })).toEqual({ text: "{not json} but fine" });
    // The cap applies to the unwrapped text.
    expect(() => parseHumanizeResult(10)({ rewrite: '{"rewrite": "far too long for ten"}' })).toThrow();
  });
});

describe("edit schemas", () => {
  it("sync LinkedIn: 600-1200 characters, required, no combinators", () => {
    expect(SYNC_LINKEDIN_SCHEMA.required).toEqual(["linkedinText"]);
    expect(() => parseSyncLinkedinResult({ linkedinText: "short" })).toThrow();
    expect(parseSyncLinkedinResult({ linkedinText: "l".repeat(700) })).toEqual({ linkedinText: "l".repeat(700) });
  });

  it("voice: requires exactly the platforms the post has", () => {
    expect(voiceSchema({ x: true, linkedin: false })).toEqual({
      type: "object", properties: { xText: { type: "string", minLength: 1, maxLength: 280 } }, required: ["xText"], additionalProperties: false,
    });
    const parse = parseVoiceResult({ x: true, linkedin: false });
    expect(parse({ xText: "ok" })).toEqual({ xText: "ok" });
    expect(() => parse({})).toThrow();
    expect(() => parse({ xText: "ok", linkedinText: "extra" })).toThrow();
  });
});
