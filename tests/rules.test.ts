import { describe, expect, it } from 'vitest';
import {
  CARDS,
  CARD_CD,
  STARTER_HAND,
  cardCdSeconds,
  findCard,
  summonCount,
} from '../src/content/cards';
import { STAR_CAP, heroAtk, heroMaxHp, starCapAt, xpNeed } from '../src/content/config';
import { AI } from '../src/content/heroAi';
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

  it('初始星级不超过上限，且属性为正', () => {
    for (const card of CARDS) {
      expect(card.startStar).toBeGreaterThanOrEqual(1);
      expect(card.startStar).toBeLessThanOrEqual(card.maxStar);
      expect(card.maxStar).toBeLessThanOrEqual(10);
      expect(card.hp).toBeGreaterThan(0);
      expect(card.atk).toBeGreaterThan(0);
    }
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

  it('迟滞系数 > 1，避免每帧换目标', () => {
    expect(AI.switchGain).toBeGreaterThan(1);
  });

  it('撤退阈值低于狂化阈值之上，形成"先撤后狂"的层次', () => {
    expect(AI.retreatThreshold).toBeGreaterThan(AI.enrageThreshold);
  });
});
