/**
 * 新手引导：前 30 秒只教一个动作。
 *
 * 设计取舍 —— 为什么用「卡池闸门」而不是弹窗教程：
 *
 * 这个游戏开局只需要玩家学会一件事：**点卡 → 点地面**。但如果一次给三张卡，
 * 玩家的第一反应是「这三张有什么区别」，于是先去研究卡牌，反而不知道该干什么。
 * 弹窗教程更糟 —— 玩家会直接点掉，然后照样不会。
 *
 * 所以用卡池当教学：先只给一张最便宜的卡，逼出那一个动作；放下第一只之后
 * 再放第二张、第三张。学习曲线和卡池成长曲线重合，玩家不会感觉到"在被教"。
 *
 * 为什么写在 `content/` 而不是 `ui/`：这里是纯数据 + 纯函数，不认识 DOM。
 * `ui/hud.ts` 只负责把结果画出来。
 */

export const TUTORIAL = {
  /** 开局露出几张卡。1 = 只给最便宜的那张 */
  startCards: 1,
  /** 每成功放置几只，多解锁一张卡 */
  placementsPerCard: 1,
} as const;

/** 引导结束后的常驻提示，与 `index.html` 里 `[data-hint]` 的初始文本保持一致 */
export const HINT_DEFAULT = '点卡 → 点地面';

/**
 * 当前应该露出几张卡。
 *
 * 只决定"露几张"，不改 `game.hand` —— 卡池属于玩法，由学长负责且正在高频改动。
 * 即使他重构卡池，这里最差也只是退化成"全部可见"，不会把游戏改坏。
 */
export function tutorialCardCount(placedTotal: number, handLength: number): number {
  const unlocked = TUTORIAL.startCards + Math.floor(placedTotal / TUTORIAL.placementsPerCard);
  return Math.min(handLength, Math.max(TUTORIAL.startCards, unlocked));
}

/**
 * 按已放置数量给出提示条文案。
 *
 * 每一句只教一个新概念，教完就不再说 —— 常驻提示条的价值在于"此刻该干什么"，
 * 不在于把所有规则堆在一起。
 */
export function tutorialHint(placedTotal: number, fallback: string): string {
  if (placedTotal === 0) return '点下面的卡 → 再点地面召唤';
  if (placedTotal <= 2) return '他会吃掉它，然后变强 —— 这正是要阻止的';
  if (placedTotal <= 5) return '每张卡有充能次数，用完了要等回充';
  return fallback;
}
