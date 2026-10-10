import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
const { Nav } = await import("./nav");

describe("the sidebar (posts from a repo, 2026-10-10)", () => {
  it("names the sections Find Ideas and Compose (owner, 2026-10-10)", () => {
    const html = renderToStaticMarkup(createElement(Nav));
    expect(html).toContain(">Find Ideas<");
    expect(html).toContain(">Compose<");
    expect(html).not.toContain("Create posts");
    expect(html).not.toContain(">Write<");
  });
});
