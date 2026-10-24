import { HERO, PILLARS, THRONE, hallX, hallY } from '../content/config';
import type { MonsterStore } from '../ecs/store';
import { normalize } from '../core/math';
import type { Hero } from './hero';

export interface MonsterHooks {
  /** 魔物打中勇者 */
  hitHero(amount: number, slot: number): void;
  /** 远程攻击的开火表现 */
  onRangedShot(slot: number, fromX: number, fromY: number, toX: number, toY: number): void;
  /** 自爆虫引爆：范围内对勇者造成伤害 */
  onExplode(slot: number, x: number, y: number, radius: number, damage: number): void;
  /** 只有视觉预警、伤害由魔物自己结算（自爆虫引信） */
  onWarn(x: number, y: number, radius: number, duration: number): void;
  /** 巫医治疗周围友军 */
  onHeal(slot: number, x: number, y: number): void;
  /** 召唤物寿命到期 */
  onExpire(slot: number): void;
}

/** 特性编号，与 cards.ts 的 ABILITY_CODE 对应。 */
const ABI_SUICIDE = 1;
const ABI_HEAL = 2;
const ABI_SLOW_SHOT = 3;

const FUSE_TIME = 0.6;
const HEAL_INTERVAL = 2;

/**
 * 魔物行为：朝勇者靠拢 → 进入射程 → 按攻速攻击。
 *
 * 留了 `range` 这一条：近战怪会停在 40–46px（自然保持包围圈，不会叠成一坨），
 * 远程怪停在 260px 外，于是"阵型"是数值自然长出来的，而不是写死的位置槽。
 */
export function updateMonsters(store: MonsterStore, hero: Hero, dt: number, hooks: MonsterHooks): void {
  store.refreshActive();
  const heroRadius = HERO.radius;

  for (let i = 0; i < store.activeCount; i += 1) {
    const slot = store.active[i];
    if (slot === undefined) continue;

    store.flash[slot] = Math.max(0, (store.flash[slot] ?? 0) - dt * 5);
    if ((store.slowT[slot] ?? 0) > 0) {
      store.slowT[slot] = Math.max(0, (store.slowT[slot] ?? 0) - dt);
      if ((store.slowT[slot] ?? 0) <= 0) store.slowFactor[slot] = 1;
    }

    let x = store.x[slot] ?? 0;
    let y = store.y[slot] ?? 0;
    let vx = store.vx[slot] ?? 0;
    let vy = store.vy[slot] ?? 0;

    // 召唤物寿命
    if ((store.life[slot] ?? 0) > 0) {
      store.life[slot] = (store.life[slot] ?? 0) - dt;
      if ((store.life[slot] ?? 0) <= 0) {
        store.life[slot] = 0;
        hooks.onExpire(slot);
        continue;
      }
    }

    const dx = hero.x - x;
    const dy = hero.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const range = store.range[slot] ?? 40;
    const radius = store.radius[slot] ?? 12;
    const abi = store.abi[slot] ?? 0;
    const star = store.star[slot] ?? 1;
    const frozen = (store.frozenT[slot] ?? 0) > 0;

    if (frozen) {
      store.frozenT[slot] = Math.max(0, (store.frozenT[slot] ?? 0) - dt);
      store.vx[slot] = 0;
      store.vy[slot] = 0;
      continue;
    }

    // 引信点燃后原地不动，给勇者 0.6 秒跑开或换手
    const fusing = (store.fuse[slot] ?? 0) > 0;
    if (fusing) {
      store.fuse[slot] = (store.fuse[slot] ?? 0) - dt;
      if ((store.fuse[slot] ?? 0) <= 0) {
        store.fuse[slot] = 0;
        hooks.onExplode(slot, x, y, 80 + star * 6, 55 * star);
        store.kill(slot);
        continue;
      }
    }

    // 特性计时。卡池裁到 5 种之后只剩「自爆（引信，上面已处理）」和「巫医回血」，
    // 嘲讽 / 火球 / 召唤随卡池一起删掉了 —— 留着没人调用的分支只是负担。
    if (abi === ABI_HEAL) {
      store.abT[slot] = (store.abT[slot] ?? 0) - dt;
      if ((store.abT[slot] ?? 0) <= 0) {
        store.abT[slot] = HEAL_INTERVAL;
        hooks.onHeal(slot, x, y);
      }
    }

    const canMove = !fusing;

    if (!canMove) {
      vx = 0;
      vy = 0;
    } else if (dist > range) {
      const dir = normalize(dx, dy);
      const speed = (store.speed[slot] ?? 60) * (store.slowFactor[slot] ?? 1);
      vx = dir.x * speed;
      vy = dir.y * speed;
    } else {
      vx = 0;
      vy = 0;
    }

    x += vx * dt;
    y += vy * dt;

    // 场地与障碍
    const limit = radius + 6;
    x = hallX(x, limit);
    y = hallY(y, limit);
    const tdx = x - THRONE.x;
    const tdy = y - THRONE.y;
    const td = Math.sqrt(tdx * tdx + tdy * tdy);
    const tmin = THRONE.r + radius;
    if (td < tmin && td > 0.001) {
      x = THRONE.x + (tdx / td) * tmin;
      y = THRONE.y + (tdy / td) * tmin;
    }
    for (const pillar of PILLARS) {
      const pdx = x - pillar.x;
      const pdy = y - pillar.y;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy);
      const pmin = pillar.r + radius;
      if (pd < pmin && pd > 0.001) {
        x = pillar.x + (pdx / pd) * pmin;
        y = pillar.y + (pdy / pd) * pmin;
      }
    }

    store.x[slot] = x;
    store.y[slot] = y;
    store.vx[slot] = vx;
    store.vy[slot] = vy;

    // 攻击
    store.atkTimer[slot] = (store.atkTimer[slot] ?? 0) - dt;
    const inRange = dist <= range + heroRadius;

    // 自爆虫：贴到身边就点引信（引信期间不再移动，给对手反应时间）
    if (abi === ABI_SUICIDE) {
      if (inRange && !fusing && (store.fuse[slot] ?? 0) === 0) {
        store.fuse[slot] = FUSE_TIME;
        // 引信必须给地面预警，否则就是"突然炸了"
        hooks.onWarn(store.x[slot] ?? x, store.y[slot] ?? y, 80 + star * 6, FUSE_TIME);
      }
      continue;
    }

    if (inRange && (store.atkTimer[slot] ?? 0) <= 0) {
      store.atkTimer[slot] = store.atkInterval[slot] ?? 1;
      if (range > 120) hooks.onRangedShot(slot, x, y, hero.x, hero.y);
      hooks.hitHero(store.atk[slot] ?? 1, slot);
      // 毒蜘蛛的远程弹会给勇者叠减速层：这是"必须换位置"的压力来源
      if (abi === ABI_SLOW_SHOT) store.slowFactor[slot] = 1;
    }
  }

  separate(store);
}

/** 轻量的同伴分离力：只推开重叠，不做完整物理。 */
function separate(store: MonsterStore): void {
  for (let i = 0; i < store.activeCount; i += 1) {
    const a = store.active[i];
    if (a === undefined || store.ghostly[a] === 1) continue;
    for (let j = i + 1; j < store.activeCount; j += 1) {
      const b = store.active[j];
      if (b === undefined || store.ghostly[b] === 1) continue;
      const dx = (store.x[b] ?? 0) - (store.x[a] ?? 0);
      const dy = (store.y[b] ?? 0) - (store.y[a] ?? 0);
      // 视觉占位比碰撞半径大（贴图带装饰外沿），分离距离也跟着放大一点，
      // 否则一群怪会糊成一个色块，玩家分不清哪只是哪只。
      const min = ((store.radius[a] ?? 0) + (store.radius[b] ?? 0)) * 1.12;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) * 0.5;
      const nx = dx / d;
      const ny = dy / d;
      store.x[a] = (store.x[a] ?? 0) - nx * push;
      store.y[a] = (store.y[a] ?? 0) - ny * push;
      store.x[b] = (store.x[b] ?? 0) + nx * push;
      store.y[b] = (store.y[b] ?? 0) + ny * push;
    }
  }
}
