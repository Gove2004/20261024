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
  /** 精英召唤小怪（巨大蜘蛛） */
  onSummon(slot: number, x: number, y: number): void;
  /** 召唤物寿命到期 */
  onExpire(slot: number): void;
}

/** 行为原型编号，与 cards.ts 的 BEHAVIOR_CODE 对应。 */
const BEH_LUNGE = 1;
const BEH_DIVE = 2;
const BEH_SKIRMISH = 3;
const BEH_CHARGER = 4;
const BEH_ELITE = 5;

/** 特性编号，与 cards.ts 的 ABILITY_CODE 对应。 */
const ABI_SUICIDE = 1;
const ABI_HEAL = 2;
const ABI_SLOW_SHOT = 3;
const ABI_SUMMON = 4;

const FUSE_TIME = 0.6;
const HEAL_INTERVAL = 2;
const SUMMON_INTERVAL = 5;
/** 巨大蜘蛛的"近战形态"判定距离：进到这个距离就改咬，不再吐丝 */
const ELITE_MELEE_RANGE = 110;

// ---- 行为原型的节拍参数（秒 / 倍率）。调这里就是调"这怪打起来什么手感" ----

/** 史莱姆：直冲 + 周期性扑击（短距离爆发，给玩家"它扑过来了"的可读节奏） */
const LUNGE_EVERY = 2.4;
const LUNGE_TIME = 0.38;
const LUNGE_SPEED = 2.4;

/** 蝙蝠群：贴近后盘旋，再俯冲 */
const DIVE_RADIUS = 150;
const DIVE_EVERY = 1.9;
const DIVE_TIME = 0.42;
const DIVE_SPEED = 2.2;

/** 哥布林：保持在射程边缘 + 横移；开火后短暂站定（收招） */
const SKIRMISH_BAND = 0.86;
const SKIRMISH_STRAFE = 0.55;
const SKIRMISH_RECOIL = 0.32;

/** 石像鬼：蓄力（站定 + 地面预警）→ 冲锋 → 撞上就砸 */
const CHARGE_EVERY = 5.2;
const CHARGE_WINDUP = 0.55;
const CHARGE_TIME = 1.1;
const CHARGE_SPEED = 3.1;
const CHARGE_SLAM = 1.6;

/** 巨大蜘蛛：在射程里横向绕，每 7 秒一次扑击（拉近距离，逼他翻滚） */
const ELITE_LEAP_EVERY = 7;
const ELITE_LEAP_TIME = 0.5;
const ELITE_LEAP_SPEED = 2.8;

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

    // 特性计时。卡池 5 种之后只有两个周期型特性：巫医回血、精英召唤。
    // 嘲讽 / 火球 随卡池一起删掉了 —— 留着没人调用的分支只是负担。
    if (abi === ABI_HEAL) {
      store.abT[slot] = (store.abT[slot] ?? 0) - dt;
      if ((store.abT[slot] ?? 0) <= 0) {
        store.abT[slot] = HEAL_INTERVAL;
        hooks.onHeal(slot, x, y);
      }
    } else if (abi === ABI_SUMMON) {
      store.abT[slot] = (store.abT[slot] ?? 0) - dt;
      if ((store.abT[slot] ?? 0) <= 0) {
        store.abT[slot] = SUMMON_INTERVAL;
        hooks.onSummon(slot, x, y);
      }
    }

    const canMove = !fusing;

    // 行为原型：把"怎么靠近"从一句 `dist > range` 拆成一套小状态机。
    // 五种怪各走一条分支，于是同样 5 张卡在场上的节奏完全不同（见 behaviorStep）。
    let moveVx = 0;
    let moveVy = 0;
    if (canMove) {
      const step = behaviorStep(store, slot, dist, dx, dy, dt, hero, star);
      moveVx = step.vx;
      moveVy = step.vy;
      if (step.telegraph) hooks.onWarn(x, y, step.radius, step.telegraph);
      if (step.slam > 0) hooks.hitHero(step.slam, slot);
    }
    vx = moveVx;
    vy = moveVy;

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
      // 巨大蜘蛛：多形态。贴脸时改"咬"（更疼、不出弹道），中远距离才吐丝。
      // 这是本卡"精英"的地方 —— 他不能靠"站远一点"躲开，也不能靠"贴上去"压制。
      if (abi === ABI_SUMMON && dist < ELITE_MELEE_RANGE) {
        hooks.hitHero((store.atk[slot] ?? 1) * 2.2, slot);
        hooks.onWarn(store.x[slot] ?? x, store.y[slot] ?? y, ELITE_MELEE_RANGE * 0.7, 0.25);
      } else {
        if (range > 120) hooks.onRangedShot(slot, x, y, hero.x, hero.y);
        hooks.hitHero(store.atk[slot] ?? 1, slot);
        // 远程弹附带减速层：这是"必须换位置"的压力来源
        if (abi === ABI_SLOW_SHOT || abi === ABI_SUMMON) store.slowFactor[slot] = 1;
        // 弓箭手开火后站定 0.32s：射箭有收招，看起来才像"瞄准射击"而不是边跑边泼箭
        if ((store.beh[slot] ?? 0) === BEH_SKIRMISH) {
          store.behMode[slot] = 3;
          store.behT[slot] = SKIRMISH_RECOIL;
        }
      }
    }
  }

  separate(store);
}

/** 一次行为步进的输出：期望速度 + 可选的"给玩家看的预警" + 可选的抠血。 */
interface BehaviorStep {
  vx: number;
  vy: number;
  /** 地面预警半径（0 = 不预警） */
  radius: number;
  /** 预警持续时间（>0 就画圈） */
  telegraph: number;
  /** 这一帧对勇者造成的额外伤害（冲锋撞击/砸地） */
  slam: number;
}

const STEP_ZERO: BehaviorStep = { vx: 0, vy: 0, radius: 0, telegraph: 0, slam: 0 };

/**
 * 行为原型状态机。
 *
 * 五个分支共用一套约定：
 * - `behMode` 0 = 接近，1 = 蓄力/盘旋，2 = 冲刺/俯冲，3 = 收招；
 * - `behT` 是当前阶段的剩余时间；
 * - **所有"爆发"阶段都先给地面预警**（`telegraph`），因为反向肉鸽里
 *   "我看不到就死了"是最差的一种死法，玩家必须能读到"它要冲了"。
 */
function behaviorStep(
  store: MonsterStore,
  slot: number,
  dist: number,
  dx: number,
  dy: number,
  dt: number,
  hero: Hero,
  star: number,
): BehaviorStep {
  const beh = store.beh[slot] ?? 0;
  const speed = (store.speed[slot] ?? 60) * (store.slowFactor[slot] ?? 1);
  const range = store.range[slot] ?? 40;
  const radius = store.radius[slot] ?? 12;
  let mode = store.behMode[slot] ?? 0;
  let t = (store.behT[slot] ?? 0) - dt;
  const dirX = dx / (dist || 1);
  const dirY = dy / (dist || 1);

  if (beh === 0) {
    // 没有行为原型的（例如召唤出来的小蜘蛛）：老实追击，范围外再走
    if (dist > range * 0.9) return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    return STEP_ZERO;
  }

  // 1) 史莱姆：直冲，每 2.4s 扑一下（速度 ×2.4，持续 0.38s）
  if (beh === BEH_LUNGE) {
    if (mode === 2) {
      if (t <= 0) {
        mode = 0;
        t = LUNGE_EVERY;
      }
      store.behMode[slot] = mode;
      store.behT[slot] = t;
      const boost = speed * LUNGE_SPEED;
      return { vx: dirX * boost, vy: dirY * boost, radius: 0, telegraph: 0, slam: 0 };
    }
    // 距离条件去掉了：史莱姆第一次扑击必须早，否则它看起来只是"在走"。
    if (t <= 0) {
      store.behMode[slot] = 2;
      store.behT[slot] = LUNGE_TIME;
      // 扑击前给 0.22s 的圈：玩家读得到"它要扑了"
      return { vx: 0, vy: 0, radius: radius + 22, telegraph: 0.22, slam: 0 };
    }
    store.behMode[slot] = 0;
    store.behT[slot] = t;
    if (dist > range) return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    return STEP_ZERO;
  }

  // 2) 蝙蝠群：贴到 150px 就改成横向盘旋，再周期性俯冲
  if (beh === BEH_DIVE) {
    if (mode === 2) {
      if (t <= 0) {
        mode = 0;
        t = DIVE_EVERY;
        store.behMode[slot] = mode;
        store.behT[slot] = t;
        return STEP_ZERO;
      }
      store.behMode[slot] = 2;
      store.behT[slot] = t;
      const boost = speed * DIVE_SPEED;
      return { vx: dirX * boost, vy: dirY * boost, radius: 0, telegraph: 0, slam: 0 };
    }
    if (dist > DIVE_RADIUS) {
      store.behMode[slot] = 0;
      store.behT[slot] = t;
      return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    }
    if (t <= 0) {
      store.behMode[slot] = 2;
      store.behT[slot] = DIVE_TIME;
      return { vx: 0, vy: 0, radius: radius + 26, telegraph: 0.2, slam: 0 };
    }
    // 盘旋：切向 + 一点点向内，读起来像"绕着他打转找角度"
    const side = (store.phase[slot] ?? 0) > Math.PI ? -1 : 1;
    store.behMode[slot] = 1;
    store.behT[slot] = t;
    return {
      vx: (-dirY * side * 0.9 + dirX * 0.25) * speed,
      vy: (dirX * side * 0.9 + dirY * 0.25) * speed,
      radius: 0,
      telegraph: 0,
      slam: 0,
    };
  }

  // 3) 哥布林弓箭手：站在射程边缘，横移找角度，开火瞬间站定
  if (beh === BEH_SKIRMISH) {
    if (mode === 3) {
      if (t > 0) {
        store.behMode[slot] = 3;
        store.behT[slot] = t;
        return STEP_ZERO;
      }
      mode = 0;
    }
    const ideal = range * SKIRMISH_BAND;
    if (dist > ideal * 1.06) {
      store.behMode[slot] = 0;
      store.behT[slot] = t;
      return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    }
    if (dist < ideal * 0.72) {
      // 太近了：后撤步，同时保持横移（不是掉头就跑）
      const side = (store.phase[slot] ?? 0) > Math.PI ? -1 : 1;
      store.behMode[slot] = 1;
      store.behT[slot] = t;
      return {
        vx: (-dirX * 0.85 + -dirY * side * SKIRMISH_STRAFE) * speed,
        vy: (-dirY * 0.85 + dirX * side * SKIRMISH_STRAFE) * speed,
        radius: 0,
        telegraph: 0,
        slam: 0,
      };
    }
    const side = (store.phase[slot] ?? 0) > Math.PI ? -1 : 1;
    store.behMode[slot] = 1;
    store.behT[slot] = t;
    return {
      vx: -dirY * side * SKIRMISH_STRAFE * speed,
      vy: dirX * side * SKIRMISH_STRAFE * speed,
      radius: 0,
      telegraph: 0,
      slam: 0,
    };
  }

  // 4) 石像鬼：蓄力 → 直线冲锋 → 撞击砸地（这一下最疼）
  if (beh === BEH_CHARGER) {
    if (mode === 1) {
      // 蓄力：站定 + 地面预警圈
      if (t <= 0) {
        store.behMode[slot] = 2;
        store.behT[slot] = CHARGE_TIME;
        return STEP_ZERO;
      }
      store.behMode[slot] = 1;
      store.behT[slot] = t;
      return { vx: 0, vy: 0, radius: radius + 30, telegraph: 0.12, slam: 0 };
    }
    if (mode === 2) {
      // 冲到 76px 内就算撞上：石像鬼体积大，擦身而过也该吃这一下
      if (t <= 0 || dist < radius + HERO.radius + 54) {
        // 撞上了（或冲过头了）：砸地 + 收招
        store.behMode[slot] = 3;
        store.behT[slot] = 1.3;
        const slam = (store.atk[slot] ?? 1) * CHARGE_SLAM;
        return {
          vx: 0,
          vy: 0,
          radius: radius + 34,
          telegraph: 0.28,
          slam: dist < radius + HERO.radius + 70 ? slam : 0,
        };
      }
      store.behMode[slot] = 2;
      store.behT[slot] = t;
      const boost = speed * CHARGE_SPEED;
      return { vx: dirX * boost, vy: dirY * boost, radius: 0, telegraph: 0, slam: 0 };
    }
    if (mode === 3) {
      if (t <= 0) {
        store.behMode[slot] = 0;
        store.behT[slot] = CHARGE_EVERY;
        return STEP_ZERO;
      }
      store.behMode[slot] = 3;
      store.behT[slot] = t;
      return STEP_ZERO;
    }
    // 接近：只有进入 340px 内才蓄力，太远就一直走
    if (t <= 0 && dist < 340) {
      store.behMode[slot] = 1;
      store.behT[slot] = CHARGE_WINDUP;
      return { vx: 0, vy: 0, radius: radius + 30, telegraph: 0.28, slam: 0 };
    }
    store.behMode[slot] = 0;
    store.behT[slot] = t;
    if (dist > range + star * 4) return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    return STEP_ZERO;
  }

  // 5) 巨大蜘蛛：远距离横绕保持射程，周期性扑击贴身（配合"贴脸改咬"）
  if (beh === BEH_ELITE) {
    if (mode === 2) {
      if (t <= 0) {
        store.behMode[slot] = 0;
        store.behT[slot] = ELITE_LEAP_EVERY;
        return STEP_ZERO;
      }
      store.behMode[slot] = 2;
      store.behT[slot] = t;
      const boost = speed * ELITE_LEAP_SPEED;
      return { vx: dirX * boost, vy: dirY * boost, radius: 0, telegraph: 0, slam: 0 };
    }
    if (t <= 0 && dist < ELITE_MELEE_RANGE * 3.2) {
      store.behMode[slot] = 2;
      store.behT[slot] = ELITE_LEAP_TIME;
      return { vx: 0, vy: 0, radius: radius + 40, telegraph: 0.3, slam: 0 };
    }
    store.behMode[slot] = mode === 1 ? 1 : 0;
    store.behT[slot] = t;
    if (dist > range * 0.95) return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
    // 射程内横绕：保持"能吐丝但不会被贴死"的距离带
    const side = (store.phase[slot] ?? 0) > Math.PI ? -1 : 1;
    return {
      vx: -dirY * side * 0.5 * speed,
      vy: dirX * side * 0.5 * speed,
      radius: 0,
      telegraph: 0,
      slam: 0,
    };
  }

  // 兜底：直线追击（新增卡没配 behavior 时走这里，不会卡死）
  if (dist > range) return { vx: dirX * speed, vy: dirY * speed, radius: 0, telegraph: 0, slam: 0 };
  return STEP_ZERO;
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
