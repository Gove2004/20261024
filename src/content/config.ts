/** 全局可调常量。所有数值调整都应该只改这里，不要散落在逻辑里。 */

/** 设计分辨率（逻辑坐标系），实际屏幕等比缩放。 */
export const VIEW = { w: 1280, h: 720 } as const;

/** 世界尺寸：大于视口，靠相机跟随。 */
export const WORLD = { w: 2400, h: 1600 } as const;

/** 战斗区域（圆形大厅）。 */
export const ARENA = { cx: 1200, cy: 800, r: 720 } as const;

/** 中央王座台：不可通行。 */
export const THRONE = { x: 1200, y: 800, r: 190 } as const;

export interface Obstacle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** 可绕行的石柱。 */
export const PILLARS: readonly Obstacle[] = [
  { x: 1200 - 430, y: 800 - 300, r: 54 },
  { x: 1200 + 430, y: 800 - 300, r: 54 },
  { x: 1200 - 430, y: 800 + 300, r: 54 },
  { x: 1200 + 430, y: 800 + 300, r: 54 },
  { x: 1200, y: 800 - 470, r: 46 },
  { x: 1200, y: 800 + 470, r: 46 },
];

/** 一局时长与提醒节点（秒）。 */
export const RUN = { duration: 300, warnAt: 60, finalWarnAt: 10 } as const;

/** 星数上限：X(t) = base + perTick × floor(t / tickSec)，封顶 max。 */
export const STAR_CAP = { base: 10, perTick: 5, tickSec: 30, max: 60, hardMax: 75 } as const;

/** 召唤规则。 */
export const PLACE = { minDistHero: 90, screenEdge: 36 } as const;

/** 勇者基础属性与成长。 */
export const HERO = {
  baseHp: 12000,
  hpPerLevel: 600,
  /** 每级自然增长的护甲（%减伤，见 Hero.takeDamage） */
  armorPerLevel: 1,
  baseAtk: 26,
  atkPerLevel: 7,
  baseSpeed: 108,
  speedPerLevel: 2.2,
  maxSpeed: 152,
  baseAtkInterval: 1 / 1.1,
  range: 62,
  radius: 20,
} as const;

/** 权能触发间隔（秒）。 */
export const POWERUP = { interval: 30, slowScale: 0.15 } as const;

/** 经验：XP_need(L) = base + per × (L − 1)；击杀所得 = 星级 × perStar。 */
export const XP = { base: 60, per: 45, perStar: 8 } as const;

/** 引爆。 */
export const DETONATE = { radius: 110, perStar: 30, cd: 2, hungerPerUse: 0.04, hungerMax: 10 } as const;

/** 击杀奖励（评分用）。 */
export const SCORE = { perSecondLeft: 12, perPeakStar: 50, perKill: 4 } as const;

export function starCapAt(elapsed: number, bonus: number): number {
  const ticks = Math.floor(elapsed / STAR_CAP.tickSec);
  return Math.min(STAR_CAP.base + STAR_CAP.perTick * ticks + bonus, STAR_CAP.hardMax);
}

export function xpNeed(level: number): number {
  return XP.base + XP.per * (level - 1);
}

export function heroMaxHp(level: number): number {
  return HERO.baseHp + HERO.hpPerLevel * (level - 1);
}

export function heroAtk(level: number): number {
  return HERO.baseAtk + HERO.atkPerLevel * (level - 1);
}

export function heroSpeed(level: number): number {
  return Math.min(HERO.baseSpeed + HERO.speedPerLevel * (level - 1), HERO.maxSpeed);
}
