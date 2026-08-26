/*
  Seeded PRNG for the synthetic feed and fixtures. mulberry32 is tiny, fast,
  and fully deterministic — the whole point: recorded real OPRA data cannot
  be redistributed, so the demo tape must be reproducible from a seed.
*/

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
  if (item === undefined) throw new Error("pick from empty array");
  return item;
}

/** Standard normal via Box–Muller. */
export function randNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randLogNormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * randNormal(rng));
}

/** Exponential inter-arrival with the given mean. */
export function randExp(rng: Rng, mean: number): number {
  let u = rng();
  while (u === 0) u = rng();
  return -Math.log(u) * mean;
}

/** Weighted index pick; weights need not sum to 1. */
export function pickWeighted(rng: Rng, weights: readonly number[]): number {
  let sum = 0;
  for (const w of weights) sum += w;
  let target = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] ?? 0;
    if (target <= 0) return i;
  }
  return weights.length - 1;
}
