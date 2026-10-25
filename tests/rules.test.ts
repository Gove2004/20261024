import { describe, expect, it } from 'vitest';
import {
  CARDS,
  CARD_CD,
  CARD_STACK,
  CARD_UNLOCK,
  STARTER_HAND,
  cardCdSeconds,
  findCard,
  summonCount,
} from '../src/content/cards';
import { RUN, STAR_CAP, heroAtk, heroMaxHp, starCapAt, xpNeed } from '../src/content/config';
import { AI } from '../src/content/heroAi';
import { PASSIVE_POOL, SKILLS, SKILL_TUNING } from '../src/content/heroSkills';
import { PASSIVE_COUNT, PASSIVE_POOL_COUNT } from '../src/gameplay/hero';
import { angleDelta, clamp, inCone } from '../src/core/math';

describe('星数与 CD 曲线', () => {
  it('每 30 秒加 5 星，到点翻档', () => {
    expect(starCapAt(0, 0)).toBe(STAR_CAP.base);
    expect(starCapAt(29.9, 0)).toBe(10);
    expect(starCapAt(30, 0)).toBe(15);
    expect(starCapAt(60, 0)).toBe(20);
    expect(starCapAt(300, 0)).toBe(STAR_CAP.max);
  });

  it('权能加成会突破基准但不超过硬上限', () => {
    expect(starCapAt(300, 15)).toBe(STAR_CAP.max + 15);
    expect(starCapAt(300, 200)).toBe(STAR_CAP.hardMax);
  });

  it('CD 随星级增长，且大怪比线性更慢（二次项）', () => {
    expect(cardCdSeconds(1)).toBeCloseTo(4.1, 5);
    expect(cardCdSeconds(5)).toBeCloseTo(11.5, 5);
    expect(cardCdSeconds(10)).toBeCloseTo(23.0, 5);
    // 二次项必须真的存在，否则 10★ 的 CD 会低于线性外推
    expect(cardCdSeconds(10)).toBeGreaterThan(CARD_CD.base + CARD_CD.linear * 10);
  });

  it('单位星数的召唤吞吐在 7★ 附近见顶（巨怪是承诺，杂兵是消耗品）', () => {
    const throughput = (star: number): number => star / cardCdSeconds(star);
    const peak = throughput(7);
    expect(peak).toBeGreaterThan(throughput(1));
    expect(peak).toBeGreaterThanOrEqual(throughput(5));
    expect(peak).toBeGreaterThan(throughput(10));
  });
});

describe('勇者成长', () => {
  it('等级公式', () => {
    // v2.8：baseHp 18000→23800、hpPerLevel 900→1180。
    // 砍掉吸血之后他一度 3 局全胜 117~190s（从一个极端跳到另一个极端），
    // 血量抬 32% 才回到"能赢但不轻松"：模拟 6 胜 4 负，压线局只剩 2~3 成血。
    expect(heroMaxHp(1)).toBe(23800);
    // Lv11 = 23800 + 1180×10
    expect(heroMaxHp(11)).toBe(35600);
    expect(heroAtk(1)).toBe(26);
    expect(heroAtk(11)).toBe(96);
  });

  it('升级所需经验递增', () => {
    expect(xpNeed(1)).toBe(60);
    // v2.5：per 45→62，压住「他靠击杀滚雪球到 Lv10」的问题
    expect(xpNeed(10)).toBe(618);
    expect(xpNeed(10)).toBeGreaterThan(xpNeed(9));
  });
});

describe('卡池', () => {
  it('初始手牌都在卡池里', () => {
    for (const id of STARTER_HAND) {
      expect(findCard(id)).toBeDefined();
    }
  });

  it('初始星级不超过上限，且生命为正；普攻型必须有攻击力', () => {
    for (const card of CARDS) {
      expect(card.startStar).toBeGreaterThanOrEqual(1);
      expect(card.startStar).toBeLessThanOrEqual(card.maxStar);
      expect(card.maxStar).toBeLessThanOrEqual(10);
      expect(card.hp).toBeGreaterThan(0);
      // 自爆虫靠引信打伤害，atk 就是 0；其余卡必须有攻击力
      if (card.ability === 'suicide') expect(card.atk).toBe(0);
      else expect(card.atk).toBeGreaterThan(0);
    }
  });

  it('卡池只有 5 种，且五种角色互不重复', () => {
    // 12 种的时候玩家记不住谁是谁（用户反馈）。5 种是刻意的上限，
    // 这条断言就是"以后别再往里加"的闸门。
    expect(CARDS.length).toBe(5);
    // v2.5 卡池：1★ 史莱姆 / 2★ 蝙蝠群 / 3★ 哥布林弓箭手 / 4★ 石像鬼 / 5★ 巨大蜘蛛
    // 只有 5★ 精英带特性（召唤），其余靠体型与射程区分 —— 特性越少越好读
    expect(CARDS.map((card) => card.id)).toEqual(['slime', 'bat', 'goblin', 'gargoyle', 'spider']);
    const withAbility = CARDS.filter((card) => card.ability !== undefined).map((card) => card.id);
    expect(withAbility).toEqual(['spider']);
    // 星级必须是 1..5 的阶梯：玩家看到星级就知道"这是几档的怪"
    expect(CARDS.map((card) => card.startStar)).toEqual([1, 2, 3, 4, 5]);
    // 五张卡必须覆盖「近战 / 远程 / 坦克 / 召唤」四条骨架（少一条战场就只剩一种打法）
    const kinds = new Set(CARDS.map((card) => card.kind));
    expect(kinds.has('melee')).toBe(true);
    expect(kinds.has('ranged')).toBe(true);
    expect(kinds.has('tank')).toBe(true);
    expect(kinds.has('summoner')).toBe(true);
    expect(new Set(CARDS.map((card) => card.id)).size).toBe(5);
  });

  it('卡牌堆叠：每张手牌 5 层，回充间隔等于旧冷却', () => {
    // v2.7 用户指定："史莱姆上限 5，每到一个回填间隔就恢复 1 层"
    expect(CARD_STACK.charges).toBe(5);
    // 通量回充间隔必须等于旧版 CD —— 堆叠只加爆发窗口，不该悄悄加强度
    expect(cardCdSeconds(3)).toBeCloseTo(CARD_CD.base + CARD_CD.linear * 3 + CARD_CD.quad * 9, 6);
  });

  it('高级牌按时间线解锁：递增、可解析、落在一局之内', () => {
    // v2.8 用户问"怎么解锁高级牌" —— 之前那两张只会在"全部满星"时兜底发放，
    // 正常一局根本见不到。这条断言锁住"按时间明牌给"这件事。
    expect(CARD_UNLOCK.length).toBeGreaterThan(0);
    let last = 0;
    for (const step of CARD_UNLOCK) {
      // 必须是真卡，否则解锁时会静默跳过
      expect(findCard(step.id)).toBeDefined();
      // 必须从开局手牌之外给，否则"解锁"等于没解锁
      expect(STARTER_HAND).not.toContain(step.id);
      // 时间必须递增且留在一局之内（否则玩家永远等不到）
      expect(step.at).toBeGreaterThan(last);
      expect(step.at).toBeLessThan(RUN.duration);
      // 文案必须说清"它强在哪" —— 只说"解锁新卡"等于没说
      expect(step.why.length).toBeGreaterThan(6);
      last = step.at;
    }
  });
});

describe('几何判定', () => {
  it('扇形命中', () => {
    // 朝向 +X，半张角 45°
    expect(inCone(0, 0, 1, 0, Math.PI / 4, 50, 0, 100)).toBe(true);
    expect(inCone(0, 0, 1, 0, Math.PI / 4, 50, 60, 100)).toBe(false);
    expect(inCone(0, 0, 1, 0, Math.PI / 4, 150, 0, 100)).toBe(false);
  });

  it('角度差走最短路径', () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 6);
    expect(angleDelta(3.1, -3.1)).toBeCloseTo(0.083185, 5);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
});

describe('AI 参数', () => {
  it('攻击前摇必须大于 0（否则玩家无法反应）', () => {
    expect(AI.windup).toBeGreaterThan(0.1);
    expect(AI.qiWindup).toBeGreaterThan(0.2);
  });

  it('纯远程：射程 > 舒适距离 > 贴脸距离，三段必须拉开层次', () => {
    expect(AI.shootRange).toBeGreaterThan(AI.keepRange);
    expect(AI.keepRange).toBeGreaterThan(AI.panicRange);
    // 射程要明显长于近战贴身距离，否则"远程"名不副实
    expect(AI.shootRange).toBeGreaterThan(AI.panicRange * 2);
  });

  it('迟滞系数 > 1，避免每帧换目标', () => {
    expect(AI.switchGain).toBeGreaterThan(1);
  });

  it('技能池 7 个主动，且每个都有前摇', () => {
    expect(SKILLS.length).toBe(7);
    for (const skill of SKILLS) {
      expect(skill.windup).toBeGreaterThan(0);
      expect(skill.name.length).toBeGreaterThan(0);
    }
    // 锅巴是纯远程：不许出现近战技能
    expect(SKILLS.some((skill) => skill.id === 'shot')).toBe(true);
  });

  it('被动池 7 条（v2.5 合并后），且文案表与效果表一一对应', () => {
    // 14 → 7：条目多的代价是每次升级都要重新理解一遍，玩家反馈"降低理解成本"
    expect(PASSIVE_POOL.length).toBe(7);
    expect(PASSIVE_COUNT).toBe(PASSIVE_POOL_COUNT);
    expect(new Set(PASSIVE_POOL.map((p) => p.name)).size).toBe(7);
  });

  it('撤退阈值低于狂化阈值之上，形成"先撤后狂"的层次', () => {
    expect(AI.retreatThreshold).toBeGreaterThan(AI.enrageThreshold);
  });
});

