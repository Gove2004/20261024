/**
 * 卡池定义。
 *
 * 设计约定（见策划案 §4）：
 * - 星级 1–10 同时是「强度」与「占地」，属性对星级**线性**增长，
 *   所以 1 只 10★ 与 10 只 1★ 战力等价，差别只在打法。
 * - **只有 5 种魔物**。这是刻意的：12 种的时候玩家记不住谁是谁（用户反馈原话
 *   "魔物种类太多，根本没法记住"）。5 种刚好能在一个回合里形成肌肉记忆，
 *   而且每种=一种明确的战场角色，看一眼就知道该拿它做什么。
 *
 * 五种角色（必须互不重复，否则就该合并）：
 *   史莱姆  —— 潮水：便宜、量大，专门吃掉他的攻击次数
 *   幽灵    —— 突进：无视同伴碰撞，直线贴脸，逼他翻滚
 *   毒蜘蛛  —— 远程：站桩消耗 + 减速，逼他进圈（这条是"放风筝"能成立的前提）
 *   自爆虫  —— 爆发：贴身读条自爆，范围伤害，逼他离开原地
 *   巫医    —— 支援：给周围回血，制造"先杀它"的目标优先级
 */

export type CardKind = 'melee' | 'ranged' | 'tank' | 'support' | 'summoner';

/** 占位美术的形状：正式贴图接入后换成 sprite key。 */
export type CardShape = 'blob' | 'wisp' | 'skull' | 'spider';

/**
 * 主动特性。没有特性的怪就是"走上去砍"，
 * 有特性的怪负责制造「这一波你必须换个应对」的时刻。
 * 现在只保留实际用得到的 4 种（taunt / aoe / summon 随卡池一起裁掉）。
 */
export type MonsterAbility = 'suicide' | 'heal' | 'slowShot';

/** 特性编号，存进 SoA 的 Uint8Array（热路径里不能存字符串）。 */
export const ABILITY_CODE: Record<MonsterAbility, number> = {
  suicide: 1,
  heal: 2,
  slowShot: 3,
};

export function abilityCode(def: CardDef): number {
  return def.ability === undefined ? 0 : ABILITY_CODE[def.ability];
}

export interface CardDef {
  readonly id: string;
  readonly name: string;
  readonly kind: CardKind;
  readonly shape: CardShape;
  /** 进局时的星级 */
  readonly startStar: number;
  readonly maxStar: number;
  /** 以下均为 1★ 数值；实际值 = 该值 × 星级 */
  readonly hp: number;
  readonly atk: number;
  readonly armor: number;
  readonly atkInterval: number;
  readonly speed: number;
  readonly range: number;
  readonly radius: number;
  readonly color: number;
  /** 穿行：无视同伴碰撞 */
  readonly ghostly?: boolean;
  /** 远程攻击会附带减速（蜘蛛） */
  readonly slow?: number;
  /** 主动特性 */
  readonly ability?: MonsterAbility;
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
 * 卡牌堆叠：每张手牌自带 N 层「通量」，放一次扣一层，没满时按 `cardCdSeconds` 回充。
 *
 * 为什么这样改：旧版放完一张立刻进冷却，玩家每次都要「放一张 → 换牌 → 等冷却」，
 * 手感卡顿（用户原话「卡牌卡手」）。堆叠之后可以连放三次，节奏像真正的铺场，
 * 但**持续召唤速率不变**（回充间隔与旧冷却完全一致）—— 只加了爆发窗口，
 * 所以数值曲线不会被推翻，见 docs/GAME_DESIGN.md §7。
 */
export const CARD_STACK = { charges: 3 } as const;

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
    hp: 46,
    atk: 6,
    armor: 0,
    atkInterval: 1 / 1.2,
    speed: 92,
    range: 44,
    radius: 15,
    color: 0x7be05f,
    note: '潮水：便宜、CD 短，专门消耗他的攻击次数',
  },
  {
    id: 'ghost',
    name: '幽灵',
    kind: 'melee',
    shape: 'wisp',
    startStar: 1,
    maxStar: 10,
    hp: 28,
    atk: 9,
    armor: 0,
    atkInterval: 1 / 1.4,
    speed: 152,
    range: 40,
    radius: 13,
    color: 0x9b6bff,
    ghostly: true,
    note: '突进：无视同伴碰撞，能直接贴脸',
  },
  {
    id: 'spider',
    name: '毒蜘蛛',
    kind: 'ranged',
    shape: 'spider',
    startStar: 2,
    maxStar: 10,
    hp: 64,
    atk: 4,
    armor: 0,
    atkInterval: 1 / 0.9,
    speed: 48,
    range: 250,
    radius: 16,
    color: 0x55d68a,
    slow: 0.22,
    ability: 'slowShot',
    note: '远程：站桩消耗 + 减速，逼他不停换位置',
  },
  {
    id: 'boom',
    name: '自爆虫',
    kind: 'melee',
    shape: 'blob',
    startStar: 2,
    maxStar: 10,
    hp: 44,
    atk: 0,
    armor: 0,
    atkInterval: 1,
    speed: 124,
    range: 34,
    radius: 12,
    color: 0xff7a3c,
    // 穿行很关键：自爆虫挤不过前排，不穿行就永远贴不到脸，
    // 「引信 0.6 秒」这套读条也就不存在了。
    ghostly: true,
    ability: 'suicide',
    note: '爆发：贴身 0.6s 引信，炸 55×星 范围伤害',
  },
  {
    id: 'shaman',
    name: '巫医',
    kind: 'support',
    shape: 'skull',
    startStar: 3,
    maxStar: 10,
    hp: 96,
    atk: 4,
    armor: 0,
    atkInterval: 1 / 0.9,
    speed: 62,
    range: 200,
    radius: 15,
    color: 0x9be07a,
    ability: 'heal',
    note: '支援：每 2s 治疗周围 3 只，制造「先杀它」的目标优先级',
  },
];

/** 开局手牌（卡池 id，按手牌顺序）。前三种是"潮水 / 突进 / 远程"的骨架。 */
export const STARTER_HAND: readonly string[] = ['slime', 'ghost', 'spider'];

export function findCard(id: string): CardDef | undefined {
  return CARDS.find((card) => card.id === id);
}

/** 每次召唤的数量。现在所有卡都是单体 —— 数量靠堆叠与 CD，不靠一张出三只。 */
export function summonCount(_card: CardDef, _star: number): number {
  return 1;
}
