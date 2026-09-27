import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReferencesSection } from "./references-section";

// Static render (react-dom/server, node env): the items load in an effect, so the list reads "Loading…" here.
describe("Reference material from a PDF or a Word file (2026-09-26)", () => {
  it("the file picker takes .txt, .md, .pdf and .docx files", () => {
    const html = renderToStaticMarkup(createElement(ReferencesSection));
    const input = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? "";
    const accept = /accept="([^"]*)"/.exec(input)?.[1].split(",") ?? [];
    expect(accept).toEqual(expect.arrayContaining([
      ".txt", ".md", "text/plain", "text/markdown",
      ".pdf", ".docx", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]));
    expect(accept).not.toContain(".doc");
    expect(input).not.toContain("disabled");
    expect(html).toContain(">Upload a file (.txt, .md, .pdf, .docx)</span>");
    expect(html).toContain('placeholder="Paste the text, or pick a .txt, .md, .pdf or .docx file"');
    expect(html).not.toContain("Reading the file…");
  });
});
