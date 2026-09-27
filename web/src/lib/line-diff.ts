/** One line of a line-by-line diff: in both texts, only in the new one, or only in the old one. */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

function linesOf(text: string): string[] {
  return text.trim() ? text.replace(/\r\n?/g, "\n").split("\n") : [];
}

/**
 * What changed from `before` to `after`, line by line, in reading order
 * (longest common subsequence; lines compared without trailing spaces).
 * Settings › Voice shows a suggested style guide this way, so the owner sees
 * exactly what Apply would change. Style guides are short: the quadratic
 * table stays small.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const same = (i: number, j: number) => a[i]!.trimEnd() === b[j]!.trimEnd();
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = same(i, j) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(i, j)) {
      out.push({ kind: "same", text: b[j]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i++]! });
    } else {
      out.push({ kind: "added", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}
