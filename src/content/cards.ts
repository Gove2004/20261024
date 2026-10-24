/**
 * 卡池定义。
 *
 * 设计约定（见策划案 §3.2 / §4）：
 * - 星级 1–10 同时是「强度」与「占地」，属性对星级**线性**增长，
 *   所以 1 只 10★ 与 10 只 1★ 战力等价，差别只在打法。
 * - 初始手牌只有 4 张，其余靠权能解锁。
 */

export type CardKind = 'melee' | 'ranged' | 'tank';

/** 占位美术的形状：正式贴图接入后换成 sprite key。 */
export type CardShape = 'blob' | 'wisp' | 'skull' | 'spider';

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
    hp: 42,
    atk: 6,
    armor: 0,
    atkInterval: 1 / 1.2,
    speed: 90,
    range: 44,
    radius: 15,
    color: 0x7be05f,
    note: '便宜、CD 短，专门消耗他的攻击次数',
  },
  {
    id: 'ghost',
    name: '幽灵',
    kind: 'melee',
    shape: 'wisp',
    startStar: 1,
    maxStar: 10,
    hp: 25,
    atk: 8,
    armor: 0,
    atkInterval: 1 / 1.4,
    speed: 150,
    range: 40,
    radius: 13,
    color: 0x9b6bff,
    ghostly: true,
    note: '穿行：无视同伴碰撞，能贴脸',
  },
  {
    id: 'skeleton',
    name: '骷髅兵',
    kind: 'tank',
    shape: 'skull',
    startStar: 2,
    maxStar: 10,
    hp: 130,
    atk: 7,
    armor: 5,
    atkInterval: 1 / 0.8,
    speed: 55,
    range: 46,
    radius: 18,
    color: 0xe6e0d4,
    note: '护甲高，肉盾，卡他的走位',
  },
  {
    id: 'spider',
    name: '毒蜘蛛',
    kind: 'ranged',
    shape: 'spider',
    startStar: 2,
    maxStar: 10,
    hp: 60,
    atk: 4,
    armor: 0,
    atkInterval: 1 / 0.9,
    speed: 45,
    range: 260,
    radius: 16,
    color: 0x55d68a,
    slow: 0.2,
    note: '远程消耗，附带减速',
  },
  {
    id: 'bat',
    name: '蝙蝠群',
    kind: 'melee',
    shape: 'wisp',
    startStar: 1,
    maxStar: 10,
    hp: 17,
    atk: 3,
    armor: 0,
    atkInterval: 1 / 1.5,
    speed: 165,
    range: 38,
    radius: 10,
    color: 0xc06bd8,
    ghostly: true,
    note: '一次 3 只，分散仇恨',
  },
  {
    id: 'assassin',
    name: '刺客',
    kind: 'melee',
    shape: 'wisp',
    startStar: 3,
    maxStar: 10,
    hp: 75,
    atk: 18,
    armor: 0,
    atkInterval: 1 / 1.3,
    speed: 170,
    range: 42,
    radius: 14,
    color: 0xff5a6e,
    note: '背击伤害更高，高风险高回报',
  },
];

/** 开局手牌（卡池 id，按手牌顺序）。 */
export const STARTER_HAND: readonly string[] = ['slime', 'ghost', 'skeleton', 'spider'];

export function findCard(id: string): CardDef | undefined {
  return CARDS.find((card) => card.id === id);
}

/** 每次召唤的数量（蝙蝠群一次 3 只）。 */
export function summonCount(card: CardDef, star: number): number {
  return card.id === 'bat' ? 3 : 1;
}
