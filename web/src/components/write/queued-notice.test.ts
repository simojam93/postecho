import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedNotice } from "./queued-notice";

describe("the line after Add to queue (schedule in a row, 2026-10-10)", () => {
  it("says the post is in the queue and links to Schedule", () => {
    const html = renderToStaticMarkup(createElement(QueuedNotice));
    expect(html).toContain("✓ In the queue · ");
    expect(html).toContain('href="/calendar"');
    expect(html).toContain(">See it in Schedule</a>");
    expect(html).not.toContain("Ready");
  });
});
