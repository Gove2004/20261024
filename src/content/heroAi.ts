/**
 * 勇者 AI 的全部可调参数。
 *
 * 只改这里、不改 `gameplay/hero.ts` 的逻辑，就能整体调手感 ——
 * 这是策划案 §5.6「体验调参表」的代码落点。
 */
export const AI = {
  /** 感知刷新频率（Hz）。太高会抽搐，太低会迟钝。 */
  perceiveHz: 10,
  /** 新目标分数要超过当前目标多少才切换（迟滞，防抽搐）。 */
  switchGain: 1.25,
  /** 超过这个距离强制换目标 */
  maxChaseDistance: 900,

  /** 攻击 */
  engageRange: 62,
  stopFactor: 0.9,
  windup: 0.18,
  recover: 0.16,
  halfArc: Math.PI / 4,
  /** 普攻一次最多命中几个目标。不设上限的话一刀清光整个扇形，
   *  "用数量淹没他"这条策略就直接失效了。 */
  maxSwingTargets: 3,

  /** 剑气 */
  qiCd: 6,
  qiWindup: 0.35,
  qiRecover: 0.3,
  qiLength: 420,
  qiHalfWidth: 28,
  qiMinTargets: 2,
  qiDamageMul: 1.4,

  /** 移动 */
  accelK: 12,
  stuckTime: 0.5,
  stuckDist: 8,
  dodgeTime: 0.6,

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
