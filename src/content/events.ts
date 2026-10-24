/**
 * 地图事件（M6 内容）。
 *
 * 为什么加这个：5 分钟一局里，"每局都长一样"是复玩率的最大杀手 ——
 * 卡池和权能解决的是"我这一局怎么摆"，事件解决的是"这一局会发生什么"。
 *
 * 设计红线（踩过一次才写下来的）：**事件不能通过"帮玩家杀怪"来生效**。
 * 第一版做过「火盆喷发」——四角喷火同时烧魔物和锅巴，本意是"逼玩家挪怪"，
 * 结果模拟里锅巴终局血量从 50% 涨到 74%：火盆把怪烧成残血，他补刀拿到经验，
 * 等于给了他一条白嫖的成长路径。所以三个事件全部改成**只改玩家这边的节奏**：
 *
 * - 血月：魔物攻速 +35% → 值得铺得更满
 * - 狂潮：召唤 CD -40% → 短 CD 杂兵流突然能站住
 * - 献祭：星数上限 +12 → 敢把巨怪放出来
 *
 * 都不改判定规则，所以加内容不会把已经调好的平衡掀翻（曲线见 docs §5.2）。
 */

export type MapEventId = 'bloodmoon' | 'surge' | 'sacrifice';

export interface MapEventDef {
  readonly id: MapEventId;
  readonly name: string;
  /** 播报文案：必须说清"我现在该怎么打"，而不是只说"发生了一件事" */
  readonly toast: string;
  /** 持续秒数 */
  readonly duration: number;
}

export const MAP_EVENTS: Readonly<Record<MapEventId, MapEventDef>> = {
  bloodmoon: {
    id: 'bloodmoon',
    name: '血月',
    toast: '血月 · 魔物攻速 +35%，现在铺满更划算',
    duration: 28,
  },
  surge: {
    id: 'surge',
    name: '狂潮',
    toast: '狂潮 · 召唤冷却 -40%，短 CD 杂兵能站住了',
    duration: 22,
  },
  sacrifice: {
    id: 'sacrifice',
    name: '献祭',
    toast: '献祭 · 星数上限 +12，把巨怪放出来',
    duration: 30,
  },
};

/** 一局触发三次，落在三段结构的转场处（开局 / 中盘 / 决战）。 */
export const MAP_EVENT_AT: readonly number[] = [55, 140, 225];

export const MAP_EVENT_TUNING = {
  /** 血月：魔物攻击间隔缩放 */
  bloodmoonAtkMul: 1.35,
  /** 狂潮：卡牌 CD 衰减倍率（-40% 冷却 ⇔ 衰减 ×1/0.6） */
  surgeCdMul: 1.67,
  /** 献祭：临时星数上限加成 */
  sacrificeStarBonus: 12,
} as const;
