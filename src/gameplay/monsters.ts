import { ARENA, HERO, PILLARS, THRONE } from '../content/config';
import type { MonsterStore } from '../ecs/store';
import { normalize } from '../core/math';
import type { Hero } from './hero';

export interface MonsterHooks {
  /** 魔物打中勇者 */
  hitHero(amount: number, slot: number): void;
  /** 远程攻击的开火表现 */
  onRangedShot(slot: number, fromX: number, fromY: number, toX: number, toY: number): void;
}

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

    const dx = hero.x - x;
    const dy = hero.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const range = store.range[slot] ?? 40;
    const radius = store.radius[slot] ?? 12;

    if (dist > range) {
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
    const limit = ARENA.r - radius - 6;
    const adx = x - ARENA.cx;
    const ady = y - ARENA.cy;
    const ad = Math.sqrt(adx * adx + ady * ady);
    if (ad > limit) {
      x = ARENA.cx + (adx / ad) * limit;
      y = ARENA.cy + (ady / ad) * limit;
    }
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
    if (dist <= range + heroRadius && (store.atkTimer[slot] ?? 0) <= 0) {
      store.atkTimer[slot] = store.atkInterval[slot] ?? 1;
      if (range > 120) hooks.onRangedShot(slot, x, y, hero.x, hero.y);
      hooks.hitHero(store.atk[slot] ?? 1, slot);
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
      const min = ((store.radius[a] ?? 0) + (store.radius[b] ?? 0)) * 0.85;
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
