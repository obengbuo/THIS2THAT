/** Returns a uniformly distributed integer in [0, n). */
export type Rng = (n: number) => number;

/** Cryptographically secure RNG (Web Crypto; available in Node 20+ and browsers). */
export const secureRng: Rng = (n) => {
  if (n <= 1) return 0;
  // Rejection sampling removes modulo bias.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % n;
  }
};

/** Deterministic RNG for tests (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

export function pick<T>(items: readonly T[], rng: Rng): T {
  return items[rng(items.length)]!;
}
