/**
 * 勇者（锅巴）的主动技能池与被动池 —— M3「双成长」的内容落点。
 *
 * 只在这里调数值，`gameplay/hero.ts` 只负责「按优先级挑一个技能放出去」。
 * 设计约束（策划案 §5.6）：**任何技能都必须有前摇**，
 * 玩家看到前摇才有反应窗口；没有前摇的技能在反向肉鸽里等于随机死亡。
 */

export type SkillId = 'shot' | 'spread' | 'qi' | 'bomb' | 'heavy' | 'heal' | 'roll';

export interface SkillDef {
  readonly id: SkillId;
  readonly name: string;
  /** 前摇（秒）。玩家就是靠这段时间判断"该跑/该散"。 */
  readonly windup: number;
  /** 冷却（秒）。0 表示普攻，每帧都可以尝试。 */
  readonly cd: number;
  readonly desc: string;
}

/**
 * 7 个主动技能。**全部是远程/自保**：锅巴没有近战判定，
 * 所以"围住他"永远是有效解法，玩家不会遇到"贴脸反而打不到"的怪事。
 */
export const SKILLS: readonly SkillDef[] = [
  { id: 'shot', name: '弹弓', windup: 0.22, cd: 0, desc: '单体射击，射程 340' },
  { id: 'spread', name: '散射', windup: 0.34, cd: 7, desc: '扇形 5 连发，清小怪' },
  { id: 'qi', name: '剑气', windup: 0.35, cd: 6, desc: '穿透一条直线上的所有魔物' },
  { id: 'bomb', name: '爆米花弹', windup: 0.45, cd: 9, desc: '抛射范围伤害，落点有 0.6s 预警' },
  { id: 'heavy', name: '蓄力重击', windup: 0.75, cd: 10, desc: '长前摇高伤害，专治高星单体' },
  { id: 'heal', name: '干粮', windup: 0.35, cd: 14, desc: '回 12% 最大生命（生命<38% 才用）' },
  { id: 'roll', name: '翻滚', windup: 0.12, cd: 8, desc: '被贴到 120px 内时后撤 130px' },
];

/** id → 定义，避免每帧线性查找。 */
export const SKILL_BY_ID: Readonly<Record<SkillId, SkillDef>> = Object.freeze(
  SKILLS.reduce<Record<string, SkillDef>>((acc, skill) => {
    acc[skill.id] = skill;
    return acc;
  }, {}) as Record<SkillId, SkillDef>,
);

/** 散射 / 爆弹 / 重击 的可调强度（和 heroAi.ts 分开：这里是"技能手感"，那边是"AI 决策"）。 */
export const SKILL_TUNING = {
  spreadPellets: 5,
  spreadAngle: 0.42,
  spreadRange: 300,
  bombRadius: 120,
  bombDamageMul: 2.6,
  bombDelay: 0.6,
  heavyDamageMul: 3.2,
  heavyRange: 420,
  healRatio: 0.12,
  healThreshold: 0.38,
  rollDistance: 130,
  rollTrigger: 120,
} as const;

export interface PassiveDef {
  readonly name: string;
  readonly desc: string;
}

/**
 * 14 个被动。每次升级随机抽 3 个不重复的给玩家看 ——
 * 这是"每局长得不一样"的来源，所以条目要够多、效果要能叠加。
 */
export const PASSIVE_POOL: readonly PassiveDef[] = [
  { name: '力量 +8%', desc: '攻击力提升' },
  { name: '攻速 +12%', desc: '射击更快' },
  { name: '护甲 +3', desc: '受到伤害减少' },
  { name: '暴击 +8%', desc: '暴击造成 1.8 倍伤害' },
  { name: '吸血 4%', desc: '造成伤害的 4% 回血' },
  { name: '移速 +10%', desc: '走位更快' },
  { name: '减伤 8%', desc: '受到伤害直接降低' },
  { name: '生命 +8%', desc: '最大生命提升' },
  { name: '剑气 +25%', desc: '剑气伤害提升' },
  { name: '散射 +2 弹', desc: '散射多两发' },
  { name: '重击 +30%', desc: '蓄力重击伤害提升' },
  { name: '技能冷却 −12%', desc: '所有主动技能转得更快' },
  { name: '击杀回血 2%', desc: '每击杀一只回 2% 生命' },
  { name: '弹弓穿透 +1', desc: '普通射击可以多打一只' },
];
