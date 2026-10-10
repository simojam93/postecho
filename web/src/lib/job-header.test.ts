import { describe, expect, it } from "vitest";
import { JOB_HEADER, jobCreated } from "@/lib/job-header";

describe("jobCreated", () => {
  it("answers 201 with the body and names the new job in X-PostEcho-Job", async () => {
    const res = jobCreated({ jobId: "j1" }, "j1");
    expect(JOB_HEADER).toBe("X-PostEcho-Job");
    expect(res.status).toBe(201);
    expect(res.headers.get("X-PostEcho-Job")).toBe("j1");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ jobId: "j1" });
  });
});
