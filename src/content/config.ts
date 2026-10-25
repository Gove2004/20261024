/** 全局可调常量。所有数值调整都应该只改这里，不要散落在逻辑里。 */

import { clamp } from '../core/math';

/** 设计分辨率（逻辑坐标系），实际屏幕等比缩放。 */
export const VIEW = { w: 1280, h: 720 } as const;

/** 世界尺寸：大于视口，靠相机跟随。 */
export const WORLD = { w: 1600, h: 1600 } as const;

/** 战斗区域：**正方形**大厅的内墙（可走区域）。外面一圈是深渊。 */
export const HALL = { left: 200, top: 200, right: 1400, bottom: 1400 } as const;

/** 墙厚（只是视觉与"贴墙不能出界"的余量）。 */
export const HALL_WALL = 46;

/**
 * 世界层缩放。
 *
 * 1600 见方的正方形大厅在 1280 设计宽度下一屏只看得见一半。0.8 之后可视约
 * 1600×900 —— 镜头仍然跟着锅巴，但玩家能看见大半个战场。
 * 玩家是上帝视角，看得见的战场才谈得上"掌控力"。
 */
export const CAM_ZOOM = 0.72;

export const HALL_CENTER = {
  x: (HALL.left + HALL.right) / 2,
  y: (HALL.top + HALL.bottom) / 2,
} as const;

/** 夹到大厅内。返回数值而不是对象：这个函数每帧每实体都要跑，不能分配。 */
export function hallX(x: number, margin: number): number {
  return clamp(x, HALL.left + margin, HALL.right - margin);
}

export function hallY(y: number, margin: number): number {
  return clamp(y, HALL.top + margin, HALL.bottom - margin);
}

export function inHall(x: number, y: number, margin: number): boolean {
  return x >= HALL.left + margin && x <= HALL.right - margin && y >= HALL.top + margin && y <= HALL.bottom - margin;
}

/** 中央王座台：装饰物，**不参与碰撞** —— 中心让给魔法阵，锅巴要能跑圈。 */
export const THRONE = { x: 800, y: 290, r: 0 } as const;

/** 中央魔法阵：纯观赏，无任何实际作用（用户明确要求"观赏性"）。 */
export const MAGIC_CIRCLE = { x: 800, y: 800, r: 250 } as const;

export interface Obstacle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/**
 * 四根石柱，落在**四分之一分位**上（1/4 与 3/4 各取横纵坐标）。
 *
 * 为什么是 1/4 而不是"随便摆四根"：正方形大厅里 1/4 分位是最均匀的绕行点位，
 * 玩家无论把怪铺在哪一角，锅巴绕柱子都有两条等长路线 —— 这直接决定了
 * "放风筝"能不能玩得起来（见 docs/GAME_DESIGN.md §5）。
 */
const QUARTER_XS = [HALL.left + (HALL.right - HALL.left) * 0.25, HALL.left + (HALL.right - HALL.left) * 0.75] as const;
const QUARTER_YS = [HALL.top + (HALL.bottom - HALL.top) * 0.25, HALL.top + (HALL.bottom - HALL.top) * 0.75] as const;

export const PILLARS: readonly Obstacle[] = [
  { x: QUARTER_XS[0], y: QUARTER_YS[0], r: 58 },
  { x: QUARTER_XS[1], y: QUARTER_YS[0], r: 58 },
  { x: QUARTER_XS[0], y: QUARTER_YS[1], r: 58 },
  { x: QUARTER_XS[1], y: QUARTER_YS[1], r: 58 },
];

/** 一局时长与提醒节点（秒）。 */
export const RUN = { duration: 300, warnAt: 60, finalWarnAt: 10 } as const;

/** 星数上限：X(t) = base + perTick × floor(t / tickSec)，封顶 max。 */
export const STAR_CAP = { base: 10, perTick: 5, tickSec: 30, max: 60, hardMax: 75 } as const;

/** 召唤规则。 */
export const PLACE = { minDistHero: 90, screenEdge: 36 } as const;

/** 勇者基础属性与成长。 */
export const HERO = {
  baseHp: 18000,
  hpPerLevel: 900,
  /** 每级自然增长的护甲（%减伤，见 Hero.takeDamage） */
  armorPerLevel: 1,
  baseAtk: 26,
  atkPerLevel: 7,
  // v2.7：用户反馈"移速太慢，老是被贴脸"。史莱姆扑击 ×2.4、蝙蝠俯冲 ×2.2 之后，
  // 108 的移速连拉扯都做不出来 —— 提到 132，并把封顶从 152 抬到 186（相当于一直比蝙蝠慢一点）。
  baseSpeed: 132,
  speedPerLevel: 3.0,
  maxSpeed: 186,
  baseAtkInterval: 1 / 1.1,
  range: 62,
  radius: 20,
} as const;

/** 权能触发间隔（秒）。 */
/** 权能面板的前摇：预告多久之后才真正暂停世界。见 Game.openPowerup */
export const POWERUP_WINDUP = 1.1;

export const POWERUP = { interval: 30, slowScale: 0.15 } as const;

/** 经验：XP_need(L) = base + per × (L − 1)；击杀所得 = 星级 × perStar。 */
export const XP = { base: 60, per: 62, perStar: 8 } as const;

/**
 * 魔物对勇者的伤害总倍率。
 *
 * 锅巴改成"纯远程 + 会拉开距离"之后，只有贴身的那几只打得到他，
 * 8 局模拟里他平均剩 81% 血结束 —— 玩家完全没有"快赢了"的紧张感。
 * 这个倍率补的就是"看起来只围住 3 只，实际是整群在打"的差额。
 */
export const MONSTER_DMG_MUL = 1.7;

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
