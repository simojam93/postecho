import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

/** What the page reads when this computer can't show a folder picker: it shows the path field instead. */
export const NO_PICKER = "No folder picker on this computer: type the path instead.";

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

export type PickFolderResult = { path: string } | { cancelled: true };

/** The picker waits for the owner, but not past the job's budget (main.ts's 9 minutes). */
const PICKER_TIMEOUT_MS = 5 * 60_000;

const defaultExecFile: ExecFileFn = (file, args) =>
  promisify(nodeExecFile)(file, args, { timeout: PICKER_TIMEOUT_MS, encoding: "utf8" });

/**
 * pick_folder (posts from a repo, 2026-10-10): the operating system's own
 * folder picker, on the computer the agent runs on. Only macOS has one we
 * can call (osascript); a cancel there exits 1 with "User canceled" (-128)
 * and is an answer, not a failure. Any other failure (no GUI session, say)
 * is treated as no picker, so the page falls back to the path field.
 */
export async function pickFolder(
  deps: { platform?: NodeJS.Platform; execFile?: ExecFileFn } = {},
): Promise<PickFolderResult> {
  if ((deps.platform ?? process.platform) !== "darwin") throw new Error(NO_PICKER);
  const execFile = deps.execFile ?? defaultExecFile;
  let stdout: string;
  try {
    ({ stdout } = await execFile("osascript", ["-e", "POSIX path of (choose folder)"]));
  } catch (e) {
    const { stderr, killed } = e as { stderr?: unknown; killed?: boolean };
    // Left open past the timeout counts as a cancel too: the owner walked away.
    if (killed || /User canceled|-128/.test(String(stderr ?? ""))) return { cancelled: true };
    throw new Error(NO_PICKER);
  }
  const path = stdout.trim();
  if (!path) return { cancelled: true };
  return { path: path.length > 1 ? path.replace(/\/+$/, "") : path };
}
