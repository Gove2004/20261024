/**
 * 种子化随机数（mulberry32）。
 *
 * 全局禁止裸 `Math.random()`：没有种子就没有可复现的模拟，
 * 「每日挑战」和 `tools/simulate.mjs` 的数值校准都会失效。
 */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  /** [0, max) 整数 */
  int(max: number): number;
  /** 从数组里取一个（空数组返回 undefined） */
  pick<T>(items: readonly T[]): T | undefined;
  /** 概率为 p 时返回 true */
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (max) => Math.floor(next() * max),
    pick: <T,>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}
