type Opts = { max: number; windowMs: number; now?: () => number };

export function makeRateLimiter({ max, windowMs, now = Date.now }: Opts) {
  const hits = new Map<string, number[]>();
  return function allow(key: string): boolean {
    const t = now();
    const windowStart = t - windowMs;
    const arr = (hits.get(key) ?? []).filter((x) => x > windowStart);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(t);
    hits.set(key, arr);
    return true;
  };
}
