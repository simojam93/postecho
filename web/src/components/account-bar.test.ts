import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountBar } from "./account-bar";

describe("the account bar at the foot of the sidebar (2026-09-27)", () => {
  it("a generic avatar, the name from Profile, and the cog; no menu", () => {
    const html = renderToStaticMarkup(createElement(AccountBar, { name: "Simone Lovera" }));
    expect(html).toContain(">Simone Lovera</span>");
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("says You until a name is saved", () => {
    expect(renderToStaticMarkup(createElement(AccountBar, { name: "  " }))).toContain(">You</span>");
  });
});
