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
 * 7 个复合天赋。每次升级随机抽一个 —— 这是"每局长得不一样"的来源。
 *
 * v2.4：每条天赋 = **一个机制 + 一点属性**（用户要求"强力且不只是属性"）。
 * v2.5：**14 条合并成 7 条**（用户反馈「大量合并和减少双方天赋数量，降低理解成本」）。
 *       合并原则：同一处机制只留一条，把原来分散的小加成并进主机制里，
 *       并把描述写成「你会在战斗中看到什么」而不是一串百分数。
 */
export const PASSIVE_POOL: readonly PassiveDef[] = [
  { name: '猎手直觉', desc: '力量 +10% · 对残血（<30%）魔物伤害 +60%，起手就先收残血' },
  { name: '铁壁回响', desc: '护甲 +5、减伤 +8% · 挨打时回敬来源 25% 伤害' },
  { name: '嗜血', desc: '吸血 4% · 每击杀一只回 3% 生命，清场能回血' },
  { name: '疾风连珠', desc: '移速 +12%、攻速 +12% · 击杀后立刻回一次弹弓' },
  { name: '困兽之斗', desc: '生命 <40% 时攻速 +50%、伤害 +15% · 最大生命 +8%' },
  { name: '剑豪', desc: '剑气伤害 +30%、冷却 −15% · 弹弓穿透 +1' },
  { name: '暴击狂徒', desc: '暴击 +12% · 暴击会溅射到附近的魔物' },
];
