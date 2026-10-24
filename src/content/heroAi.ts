/**
 * 勇者 AI 的全部可调参数。
 *
 * 只改这里、不改 `gameplay/hero.ts` 的逻辑，就能整体调手感 ——
 * 这是策划案 §5.6「体验调参表」的代码落点。
 *
 * v2.2 改动：锅巴改成**纯远程**。他没有近战判定，靠拉开距离射击输出，
 * 所以"贴脸"不再是他的获胜方式，而是玩家的获胜方式。
 */
export const AI = {
  /** 感知刷新频率（Hz）。太高会抽搐，太低会迟钝。 */
  perceiveHz: 10,
  /** 新目标分数要超过当前目标多少才切换（迟滞，防抽搐）。 */
  switchGain: 1.25,
  /** 超过这个距离强制换目标 */
  maxChaseDistance: 900,

  /** 攻击（远程） */
  /** 射程：远到他可以站在魔物群外面打 */
  shootRange: 340,
  /** 想维持的作战距离：太近就后撤，太远就靠近 */
  keepRange: 250,
  /** 近于此距离判定"被贴脸"，直接后撤 */
  panicRange: 150,
  stopFactor: 0.9,
  windup: 0.22,
  recover: 0.16,

  /** 剑气：穿透一条线的远程重击 */
  qiCd: 6,
  qiWindup: 0.35,
  qiRecover: 0.3,
  qiLength: 460,
  qiHalfWidth: 28,
  qiMinTargets: 2,
  qiDamageMul: 1.4,

  /** 移动 */
  accelK: 12,
  stuckTime: 0.5,
  stuckDist: 8,
  dodgeTime: 0.6,
  /** 被贴脸时后撤的速度倍率 */
  kiteSpeed: 1.08,

  /** 撤退 */
  retreatThreshold: 0.25,
  retreatTime: 2.5,
  retreatCooldown: 2,
  backOff: 0.55,

  /** 狂化 */
  enrageThreshold: 0.2,
  enrageLevel: 10,
  enrageAtkSpeed: 1.4,
  enrageSpeed: 1.25,

  /** 目标评分权重 */
  scoreBase: 100,
  scoreDistance: 0.1,
  scoreLowHp: 30,
  scoreAttackingMe: 15,
  scoreRangedFirst: 8,
  scoreArmor: 2,
  scoreSticky: 25,
} as const;
