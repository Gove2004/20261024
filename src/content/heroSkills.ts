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
 * 7 个复合天赋 = **七美德**，一一对应魔王权能的七宗罪（v2.7）。
 *
 * 用户原话："鼠标悬浮在锅巴上也能看到他选择的天赋效果 分别是7宗罪的反义词"。
 * 所以这里不只是改名：**勇者的成长和玩家的成长成了同一副牌的两面** ——
 * 你选「暴怒」，他就可能抽到「宽容」；牌面上一眼能看出谁在反谁。
 *
 * 数值机制沿用 v2.5 的七条（已被模拟验证），只换名字与描述口径：
 * 描述压到一行、去掉多余的小字（用户："去掉小字描述或者减少不必要的玩法小字"）。
 */
export const PASSIVE_POOL: readonly PassiveDef[] = [
  { name: '谦逊', desc: '免疫傲慢：稳定命中，对残血目标伤害 +60%（反 傲慢）' },
  { name: '贞洁', desc: '免疫色欲：护甲 +5、减伤 8%，被击中时反伤 25%（反 色欲）' },
  { name: '节制', desc: '免疫暴食：击杀回 3% 生命，清场能回血（反 暴食）' },
  { name: '勤勉', desc: '免疫懒惰：移速 +12%、攻速 +12%，击杀后立刻回一次弹弓（反 懒惰）' },
  { name: '宽容', desc: '免疫暴怒：生命 <40% 时攻速 +50%、伤害 +15%（反 暴怒）' },
  { name: '慷慨', desc: '免疫贪婪：剑气伤害 +30%、冷却 −15%，弹弓穿透 +1（反 贪婪）' },
  { name: '善良', desc: '免疫嫉妒：暴击 +12%，暴击会溅射到附近的魔物（反 嫉妒）' },
];
