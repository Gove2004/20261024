import { describe, expect, it } from 'vitest';
import {
  CARDS,
  CARD_CD,
  STARTER_HAND,
  cardCdSeconds,
  findCard,
  summonCount,
} from '../src/content/cards';
import { STAR_CAP, RUN, heroAtk, heroMaxHp, starCapAt, xpNeed } from '../src/content/config';
import {
  MAP_EVENTS,
  MAP_EVENT_AT,
  MAP_EVENT_TUNING,
  type MapEventId,
} from '../src/content/events';
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
    expect(heroMaxHp(1)).toBe(12000);
    expect(heroMaxHp(11)).toBe(18000);
    expect(heroAtk(1)).toBe(26);
    expect(heroAtk(11)).toBe(96);
  });

  it('升级所需经验递增', () => {
    expect(xpNeed(1)).toBe(60);
    expect(xpNeed(10)).toBe(465);
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

  it('卡池 12 张，功能卡都挂了特性', () => {
    expect(CARDS.length).toBe(12);
    const withAbility = CARDS.filter((card) => card.ability !== undefined).map((card) => card.id);
    expect(withAbility.sort()).toEqual(['boom', 'frost', 'gargoyle', 'general', 'lich', 'shaman']);
  });

  it('蝙蝠群一次召 3 只并按 3 倍占星结算', () => {
    const bat = findCard('bat');
    expect(bat).toBeDefined();
    if (!bat) return;
    expect(summonCount(bat, 1)).toBe(3);
    expect(summonCount(bat, 3)).toBe(3);
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

  it('被动池 14 条，且文案表与效果表一一对应', () => {
    expect(PASSIVE_POOL.length).toBe(14);
    expect(PASSIVE_COUNT).toBe(PASSIVE_POOL_COUNT);
    expect(new Set(PASSIVE_POOL.map((p) => p.name)).size).toBe(14);
  });

  it('撤退阈值低于狂化阈值之上，形成"先撤后狂"的层次', () => {
    expect(AI.retreatThreshold).toBeGreaterThan(AI.enrageThreshold);
  });
});

describe('地图事件', () => {
  it('三个事件定义完整，播报里必须带具体数字', () => {
    const ids = Object.keys(MAP_EVENTS);
    expect(ids.length).toBe(3);
    for (const id of ids) {
      const def = MAP_EVENTS[id as MapEventId];
      expect(def.name.length).toBeGreaterThan(0);
      // 只说"发生了一件事"的播报没用，玩家需要知道该怎么打
      expect(def.toast).toMatch(/\+\d+|-\d+/);
      expect(def.duration).toBeGreaterThan(10);
    }
    expect(MAP_EVENT_AT.length).toBe(3);
  });

  it('触发时刻递增，且都在单局时长之内', () => {
    for (let i = 1; i < MAP_EVENT_AT.length; i += 1) {
      expect(MAP_EVENT_AT[i]!).toBeGreaterThan(MAP_EVENT_AT[i - 1]!);
    }
    expect(MAP_EVENT_AT[0]!).toBeGreaterThan(30);
    expect(MAP_EVENT_AT[MAP_EVENT_AT.length - 1]!).toBeLessThan(RUN.duration - 20);
  });

  it('事件窗口不重叠（否则播报会互相顶掉）', () => {
    const order: readonly MapEventId[] = ['bloodmoon', 'surge', 'sacrifice'];
    let prevEnd = 0;
    for (let i = 0; i < MAP_EVENT_AT.length; i += 1) {
      const start = MAP_EVENT_AT[i]!;
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = start + MAP_EVENTS[order[i]!].duration;
    }
  });

  it('数值在"能感觉到但不失衡"的区间', () => {
    expect(MAP_EVENT_TUNING.bloodmoonAtkMul).toBeGreaterThan(1.2);
    expect(MAP_EVENT_TUNING.bloodmoonAtkMul).toBeLessThan(1.6);
    expect(MAP_EVENT_TUNING.surgeCdMul).toBeGreaterThan(1.4);
    expect(MAP_EVENT_TUNING.surgeCdMul).toBeLessThan(2);
    expect(MAP_EVENT_TUNING.sacrificeStarBonus).toBeGreaterThanOrEqual(8);
  });
});
