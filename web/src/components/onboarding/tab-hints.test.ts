import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlowOnce, HintsProvider } from "./tab-hints";

type Seen = Array<"sources" | "settings">;
const inProvider = (seen: Seen, child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(HintsProvider, { seen }, child));

describe("first-time highlights (2026-09-27: \"un'animazione di highlight la prima volta\")", () => {
  it("+ More sources glows until seen, and stays", () => {
    const pill = createElement("button", { type: "button" }, "+ More sources");
    expect(inProvider([], createElement(GlowOnce, { id: "sources" }, pill))).toContain("animate-[postecho-glow");
    const seen = inProvider(["sources"], createElement(GlowOnce, { id: "sources" }, pill));
    expect(seen).toContain("+ More sources");
    expect(seen).not.toContain("animate-[postecho-glow");
  });
});
