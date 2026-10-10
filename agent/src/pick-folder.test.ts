import { describe, expect, it, vi } from "vitest";
import { NO_PICKER, pickFolder, type ExecFileFn } from "./pick-folder.js";

describe("pickFolder (posts from a repo, 2026-10-10)", () => {
  it("asks macOS for a folder and returns its path, without the trailing slash", async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: "/Users/me/dev/postecho/\n" }));
    expect(await pickFolder({ platform: "darwin", execFile })).toEqual({ path: "/Users/me/dev/postecho" });
    expect(execFile).toHaveBeenCalledWith("osascript", ["-e", "POSIX path of (choose folder)"]);
  });

  it("keeps / as it is", async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: "/\n" }));
    expect(await pickFolder({ platform: "darwin", execFile })).toEqual({ path: "/" });
  });

  it("a cancel is an answer, not a failure", async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw Object.assign(new Error("Command failed"), { code: 1, stderr: "execution error: User canceled. (-128)\n" });
    });
    expect(await pickFolder({ platform: "darwin", execFile })).toEqual({ cancelled: true });
  });

  it("any other osascript failure means there's no picker to use", async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw Object.assign(new Error("Command failed"), { code: 1, stderr: "No user interaction allowed. (-1713)" });
    });
    await expect(pickFolder({ platform: "darwin", execFile })).rejects.toThrow(NO_PICKER);
  });

  it("elsewhere there is no picker", async () => {
    const execFile = vi.fn<ExecFileFn>();
    await expect(pickFolder({ platform: "linux", execFile })).rejects.toThrow("No folder picker on this computer: type the path instead.");
    expect(execFile).not.toHaveBeenCalled();
  });
});
