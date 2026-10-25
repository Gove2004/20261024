/**
 * 卡池定义。
 *
 * 设计约定（见策划案 §4）：
 * - 星级 1–10 同时是「强度」与「占地」，属性对星级**线性**增长，
 *   所以 1 只 10★ 与 10 只 1★ 战力等价，差别只在打法。
 * - **只有 5 种魔物**，按星级排成一条"越来越强"的阶梯：1 星杂兵 → 5 星精英。
 *   12 种时玩家记不住谁是谁（用户原话「魔物种类太多，根本没法记住」），
 *   5 种刚好能在一回合里形成肌肉记忆，而且**星级本身就是记忆锚点**。
 *
 * 五种角色（必须互不重复，否则就该合并）：
 *   1★ 史莱姆   —— 普通小怪：便宜、量大，专门吃掉他的攻击次数
 *   2★ 蝙蝠群   —— 三只快速小小怪：一次落三只，分散火力、逼他换目标
 *   3★ 哥布林弓箭手 —— 远程：站在射程外持续输出，逼他进圈
 *   4★ 石像鬼   —— 高血量高防御：肉盾，卡他的走位和弹道
 *   5★ 巨大蜘蛛 —— 精英：远程吐丝 + 近身咬 + 召唤小蜘蛛，多形态
 */

export type CardKind = 'melee' | 'ranged' | 'tank' | 'support' | 'summoner';

/** 占位美术的形状：正式贴图接入后换成 sprite key。 */
export type CardShape = 'blob' | 'wisp' | 'skull' | 'spider' | 'bat' | 'goblin' | 'gargoyle';

/**
 * 主动特性。没有特性的怪就是"走上去砍"，
 * 有特性的怪负责制造「这一波你必须换个应对」的时刻。
 */
export type MonsterAbility = 'suicide' | 'heal' | 'slowShot' | 'summon';

/** 特性编号，存进 SoA 的 Uint8Array（热路径里不能存字符串）。 */
export const ABILITY_CODE: Record<MonsterAbility, number> = {
  suicide: 1,
  heal: 2,
  slowShot: 3,
  summon: 4,
};

export function abilityCode(def: CardDef): number {
  return def.ability === undefined ? 0 : ABILITY_CODE[def.ability];
}

/**
 * 行为原型：决定「它怎么靠近、什么时候出手」，和特性（周期性技能）是两件事。
 *
 * 用户反馈「怪物也需要更加复杂的行为，而不只是简单的追击」。
 * 五种怪各给一套走位逻辑，于是同样 5 张卡在场的移动节奏完全不同：
 * 直冲、盘旋俯冲、站桩横移放箭、蓄力冲锋、精英的多形态。
 * 代码在 `gameplay/monsters.ts` 的 `behaviorStep()` 里，一张分支表。
 */
export type MonsterBehavior = 'lunge' | 'dive' | 'skirmish' | 'charger' | 'elite';

export const BEHAVIOR_CODE: Record<MonsterBehavior, number> = {
  lunge: 1,
  dive: 2,
  skirmish: 3,
  charger: 4,
  elite: 5,
};

export function behaviorCode(def: CardDef): number {
  return def.behavior === undefined ? 0 : BEHAVIOR_CODE[def.behavior];
}

export interface CardDef {
  readonly id: string;
  readonly name: string;
  readonly kind: CardKind;
  readonly shape: CardShape;
  /** 进局时的星级 */
  readonly startStar: number;
  readonly maxStar: number;
  /** 以下均为 1★ 数值；实际值 = 该值 × 星级（再乘卡牌等级加成） */
  readonly hp: number;
  readonly atk: number;
  readonly armor: number;
  readonly atkInterval: number;
  readonly speed: number;
  readonly range: number;
  readonly radius: number;
  readonly color: number;
  /** 一次召唤几只（蝙蝠群 = 3）。默认 1。 */
  readonly units?: number;
  /** 穿行：无视同伴碰撞 */
  readonly ghostly?: boolean;
  /** 远程攻击会附带减速 */
  readonly slow?: number;
  /** 主动特性 */
  readonly ability?: MonsterAbility;
  /** 贴图 id（默认等于卡 id）：巨大蜘蛛用 spider-giant，不用旧毒蜘蛛的图 */
  readonly art?: string;
  /** 行为原型：不填就是"直线追击"（最笨的那一档） */
  readonly behavior?: MonsterBehavior;
  /** 显示在悬浮提示里的"标签"，一行一个，玩家读得懂的人话 */
  readonly tags: readonly string[];
  readonly note: string;
}

/**
 * CD(星) = 2.5 + 1.55×星 + 0.05×星²（秒）。
 *
 * 为什么要带二次项：如果 CD 只是线性，那么"单位星数的召唤吞吐"会随星级单调上升
 * （10★ 每秒塞进场的星数比 1★ 还多），最后所有人都只放巨怪。
 * 加上二次项后吞吐在 7★ 附近见顶，巨怪变成"高投入、低频次"的承诺，
 * 杂兵变成"高频次、可牺牲"的消耗品 —— 这才是 1–10 星该有的取舍。
 */
export const CARD_CD = { base: 2.5, linear: 1.55, quad: 0.05 } as const;

/**
 * 卡牌充能：每张手牌自带 N 层「充能」，放一次扣一层，**不进入冷却**，
 * 没满时按 `cardCdSeconds` 稳定回充。用光就只能等回充。
 *
 * 为什么这样改（用户第二次反馈「卡牌依旧卡手」）：
 * 第一版是"放完立刻进冷却"，玩家每次都要「放一张 → 换牌 → 等冷却」；
 * 第二版虽然加了 3 层，但**选中/放置仍然会触发冷却**，手感还是被卡。
 * 现在冷却只影响「回充速度」不影响「能不能放」——
 * 于是「一口气把 4 层全砸在同一个位置」变成了一个真实可用的战术动作。
 * 持续召唤速率不变（回充间隔 = 旧冷却），所以数值曲线不会被推翻，见 §7。
 */
export const CARD_STACK = { charges: 5 } as const;

/**
 * 卡牌等级：放得越多，这张卡越强。
 *
 * 为什么需要（用户原话「前期勇者两道一个，后期一刀一个，构不成威胁」）：
 * 勇者的攻击力随等级线性涨，而玩家的魔物属性是常数 ——
 * 于是同一张卡在 0 分钟和 4 分钟的实际威胁差了 3 倍以上。
 * 卡牌等级把「你一直用这张卡」这件事变成成长曲线，让杂兵到后期仍然有存在感。
 */
export const CARD_LEVEL = {
  /** 每放出 1 只累加的经验 */
  xpPerPlace: 1,
  /** 升 1 级需要的累计经验（线性：第 n 级需要 n*xpPerLevel 经验） */
  xpPerLevel: 5,
  maxLevel: 6,
  /** 每级给基础属性 +12% */
  statPerLevel: 0.1,
} as const;

export function cardLevelXpNeed(level: number): number {
  return CARD_LEVEL.xpPerLevel * level;
}

/** 等级带来的属性倍率（1 级 = 1.0）。 */
export function cardLevelMul(level: number): number {
  return 1 + CARD_LEVEL.statPerLevel * (level - 1);
}

export function cardCdSeconds(star: number): number {
  return CARD_CD.base + CARD_CD.linear * star + CARD_CD.quad * star * star;
}

export const CARDS: readonly CardDef[] = [
  {
    id: 'slime',
    name: '史莱姆',
    kind: 'melee',
    shape: 'blob',
    startStar: 1,
    maxStar: 10,
    hp: 66,
    atk: 6,
    armor: 0,
    atkInterval: 1 / 1.2,
    speed: 92,
    range: 54,
    radius: 15,
    color: 0x7be05f,
    behavior: 'lunge',
    tags: ['近战', '便宜', '数量'],
    note: '普通小怪：便宜、能一直铺，专门消耗他的攻击次数',
  },
  {
    id: 'bat',
    name: '蝙蝠群',
    kind: 'melee',
    shape: 'bat',
    startStar: 2,
    maxStar: 10,
    hp: 22,
    atk: 4,
    armor: 0,
    atkInterval: 1 / 1.6,
    speed: 186,
    range: 42,
    radius: 10,
    color: 0xc79bff,
    units: 3,
    ghostly: true,
    behavior: 'dive',
    tags: ['三只', '极快', '穿行'],
    note: '快速小怪：一次落三只，无视同伴碰撞，速度和勇者持平半档',
  },
  {
    id: 'goblin',
    name: '哥布林弓箭手',
    kind: 'ranged',
    shape: 'goblin',
    startStar: 3,
    maxStar: 10,
    hp: 110,
    atk: 9,
    armor: 2,
    atkInterval: 1 / 0.75,
    speed: 74,
    range: 310,
    radius: 14,
    color: 0x6fd06f,
    behavior: 'skirmish',
    tags: ['远程', '射程 310', '横向走位'],
    note: '远程弓箭手：站在射程外持续放箭，逼他不断进圈',
  },
  {
    id: 'gargoyle',
    name: '石像鬼',
    kind: 'tank',
    shape: 'gargoyle',
    startStar: 4,
    maxStar: 10,
    hp: 300,
    atk: 14,
    armor: 16,
    atkInterval: 1 / 0.7,
    speed: 66,
    range: 56,
    radius: 22,
    color: 0x8f8fa8,
    behavior: 'charger',
    tags: ['高血量', '高护甲', '蓄力冲锋'],
    note: '高血量高防御：走上去就是一面墙，能卡住他的弹道和走位',
  },
  {
    id: 'spider',
    name: '巨大蜘蛛',
    kind: 'summoner',
    shape: 'spider',
    startStar: 5,
    maxStar: 10,
    hp: 460,
    atk: 12,
    armor: 6,
    atkInterval: 1 / 0.85,
    speed: 58,
    range: 300,
    radius: 30,
    color: 0x9b5bff,
    slow: 0.22,
    ability: 'summon',
    behavior: 'elite',
    art: 'spider-giant',
    tags: ['精英', '远程吐丝', '近身咬', '召唤小蜘蛛'],
    note: '精英：远距离吐丝（带减速）、贴脸改咬、每 5 秒生 2 只小蜘蛛',
  },
];

/** 开局手牌（卡池 id，按手牌顺序）。1★/2★/3★ 各一张，梯队从低到高。 */
export const STARTER_HAND: readonly string[] = ['slime', 'bat', 'goblin'];

export function findCard(id: string): CardDef | undefined {
  return CARDS.find((card) => card.id === id);
}

/** 一次召唤的魔物数量。 */
export function summonCount(card: CardDef): number {
  return card.units ?? 1;
}

/** 多只召唤时，每只分到的星级（保证不会被压到 0）。 */
export function unitStar(card: CardDef, star: number): number {
  const units = summonCount(card);
  if (units <= 1) return star;
  return Math.max(1, Math.round(star / units));
}
