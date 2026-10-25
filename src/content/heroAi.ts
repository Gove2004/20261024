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

  /**
   * ── 走位（v2.4 新增，本作核心）────────────────────────────────
   *
   * 旧版走位是"朝目标直线前进 / 直线后撤"，于是玩家只要把怪铺在墙边，
   * 锅巴就会自己往墙角里退，然后被抓死 —— 看起来非常蠢（用户原话）。
   * 现在改成**势场转向**：附近威胁的排斥向量 + 绕圈切向分量 + 离墙推力，
   * 三股力合成一个方向。目标：会拉扯、会跑圈、不会进墙角。
   */
  /** 威胁感知半径：这个范围内每一只魔物都参与转向计算 */
  threatRadius: 420,
  /** 离墙多少距离开始被推回场地中间 */
  wallMargin: 260,
  /** 切向（绕圈）分量权重。越大越爱跑圈，越小越像直线逃跑 */
  orbitWeight: 1.2,
  /** 离墙推力权重。这是"不进墙角"的主要保障 */
  wallWeight: 1.7,
  /** 切向方向换边的门槛：外侧空间要明显更大才换，防止每帧抖动 */
  orbitFlipGain: 1.35,
  /** 远程魔物的威胁权重更高：站着挨打比被近战贴身更疼 */
  threatRanged: 1.6,
  /** 自爆虫：必须躲，权重最高 */
  threatSuicide: 2.0,
  /**
   * 走位转弯角速度（弧度/秒）。这是「跑圈」看得出来的关键参数：
   * 太大 = 原地抖动，太小 = 撞墙才拐弯。3.0 大约是 0.5 秒转 90°。
   */
  turnRate: 3.0,

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
  /** 残血收尾：血量低于这个比例时额外加权，他会回头补掉快死的怪 */
  scoreFinisherHp: 0.3,
  scoreFinisher: 22,
  /** 精英（会召唤的）先打：放任它 20 秒，场上就多出一队小怪 */
  scoreElite: 26,
  /** 抱团加成：周围 120px 内每多一只友军 +6，逼他往怪堆里放 AoE */
  scoreClusterRadius: 120,
  scoreCluster: 6,
  /** 看到冲锋/扑击前摇时提前翻滚：蓄力中的石像鬼在 200px 内就闪 */
  dodgeWindupRange: 210,
  dodgeBurstRange: 110,
} as const;
