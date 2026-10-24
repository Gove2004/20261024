import { AI } from '../content/heroAi';
import { ARENA, DETONATE, HERO, PILLARS, THRONE, heroAtk, heroMaxHp, heroSpeed, xpNeed } from '../content/config';
import type { MonsterStore } from '../ecs/store';
import { clamp, damp, distance, inCone, normalize } from '../core/math';
import type { Rng } from '../core/rng';

export type HeroState = 'idle' | 'patrol' | 'seek' | 'engage' | 'retreat' | 'enrage';
export type HeroIntent = 'chase' | 'charge' | 'retreat';

/** 勇者与外部世界的交互回调（伤害结算、特效、播报都从这里出去）。 */
export interface HeroHooks {
  hitMonster(slot: number, damage: number, crit: boolean): void;
  onQi(fromX: number, fromY: number, dirX: number, dirY: number): void;
  onSwing(): void;
  onLevelUp(level: number, passive: string): void;
  onHurt(amount: number): void;
}

interface Passive {
  readonly name: string;
  apply(hero: Hero): void;
}

const PASSIVES: readonly Passive[] = [
  { name: '力量 +8%', apply: (h) => h.gainAtk(0.08) },
  { name: '攻速 +12%', apply: (h) => void (h.atkSpeedMul += 0.12) },
  { name: '护甲 +3', apply: (h) => void (h.armor += 3) },
  { name: '暴击 +8%', apply: (h) => void (h.crit += 0.08) },
  { name: '吸血 +5%', apply: (h) => void (h.lifesteal += 0.05) },
  { name: '生命 +8%', apply: (h) => h.gainMaxHp(0.08) },
];

/**
 * 勇者「锅巴」。近战剑士 + 标志性剑气。
 *
 * 已落地（策划案 §5）：感知 10Hz + 目标迟滞、SEEK/ENGAGE/RETREAT/ENRAGE 状态机、
 * 带加速度的转向、卡住自愈、普攻三段（前摇/判定/后摇）、剑气蓄力与地面预警。
 */
export class Hero {
  public x: number = ARENA.cx;
  public y: number = ARENA.cy + 420;
  public vx = 0;
  public vy = 0;

  public hp: number = HERO.baseHp;
  public maxHp: number = HERO.baseHp;
  public level = 1;
  public xp = 0;

  public atk: number = HERO.baseAtk;
  public atkSpeedMul = 1;
  public speed: number = HERO.baseSpeed;
  public armor = 0;
  public crit = 0.05;
  public lifesteal = 0;

  /** 被动带来的永久倍率（等级公式重算时要乘回去） */
  public hpMul = 1;
  public atkMul = 1;

  public state: HeroState = 'seek';
  public target = -1;
  public facingX = 0;
  public facingY = 1;
  public moving = false;

  public attackTimer = 0;
  public windup = 0;
  public recover = 0;

  public qiCd: number = AI.qiCd * 0.5;
  public qiWindup = 0;
  public qiDirX = 0;
  public qiDirY = 1;

  public flash = 0;
  public hurtTimer = 0;
  public retreatLock = 0;
  public stateTimer = 0;
  /** 引爆造成的「饥渴」层数：攻速 +4%/层 */
  public hunger = 0;

  public intent: HeroIntent = 'chase';

  private perceiveTimer = 0;
  private stuckTimer = 0;
  private lastX = this.x;
  private lastY = this.y;
  private dodgeTimer = 0;
  private dodgeSign = 1;

  constructor(private readonly rng: Rng) {}

  public get alive(): boolean {
    return this.hp > 0;
  }

  public get hpRatio(): number {
    return this.maxHp > 0 ? clamp(this.hp / this.maxHp, 0, 1) : 0;
  }

  public reset(): void {
    this.x = ARENA.cx;
    this.y = ARENA.cy + 420;
    this.vx = 0;
    this.vy = 0;
    this.hp = HERO.baseHp;
    this.maxHp = HERO.baseHp;
    this.level = 1;
    this.xp = 0;
    this.atk = HERO.baseAtk;
    this.atkSpeedMul = 1;
    this.speed = HERO.baseSpeed;
    this.armor = 0;
    this.crit = 0.05;
    this.lifesteal = 0;
    this.hpMul = 1;
    this.atkMul = 1;
    this.state = 'seek';
    this.target = -1;
    this.attackTimer = 0;
    this.windup = 0;
    this.recover = 0;
    this.qiCd = AI.qiCd * 0.5;
    this.qiWindup = 0;
    this.flash = 0;
    this.hurtTimer = 0;
    this.retreatLock = 0;
    this.stateTimer = 0;
    this.hunger = 0;
    this.intent = 'chase';
    this.perceiveTimer = 0;
    this.stuckTimer = 0;
    this.lastX = this.x;
    this.lastY = this.y;
    this.dodgeTimer = 0;
  }

  public gainAtk(mul: number): void {
    this.atkMul *= 1 + mul;
    this.atk *= 1 + mul;
  }

  public gainMaxHp(mul: number): void {
    this.hpMul *= 1 + mul;
    this.maxHp *= 1 + mul;
    this.hp *= 1 + mul;
  }

  public takeDamage(amount: number, hooks: HeroHooks): void {
    if (!this.alive) return;
    // 护甲走百分比减免，不做减法：减法会让"小怪 vs 高护甲"直接塌成 1 点伤害，
    // 后期护甲一叠，杂兵就彻底打不动人（这是实测踩到的坑）。
    const reduction = this.armor / (this.armor + 60);
    const real = Math.max(1, amount * (1 - reduction));
    this.hp -= real;
    this.flash = 1;
    this.hurtTimer = 0.25;
    hooks.onHurt(real);
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'idle';
      this.vx = 0;
      this.vy = 0;
    }
  }

  public addXp(amount: number, hooks: HeroHooks): void {
    this.xp += amount;
    let need = xpNeed(this.level);
    while (this.xp >= need) {
      this.xp -= need;
      this.level += 1;
      this.maxHp = heroMaxHp(this.level) * this.hpMul;
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.08);
      this.atk = heroAtk(this.level) * this.atkMul;
      this.speed = heroSpeed(this.level);
      this.armor += HERO.armorPerLevel;
      const passive = this.rng.pick(PASSIVES);
      if (passive) passive.apply(this);
      hooks.onLevelUp(this.level, passive ? passive.name : '');
      need = xpNeed(this.level);
    }
  }

  public update(dt: number, store: MonsterStore, hooks: HeroHooks): void {
    if (!this.alive) return;

    this.flash = Math.max(0, this.flash - dt * 6);
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.retreatLock = Math.max(0, this.retreatLock - dt);
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.recover = Math.max(0, this.recover - dt);
    this.qiCd = Math.max(0, this.qiCd - dt);

    this.updatePerception(dt, store);
    this.updateState(dt);
    this.updateAttack(dt, store, hooks);
    this.updateMovement(dt, store);
  }

  private get enraged(): boolean {
    return this.state === 'enrage';
  }

  private atkSpeedNow(): number {
    const hunger = 1 + this.hunger * DETONATE.hungerPerUse;
    return Math.max(0.3, this.atkSpeedMul * (this.enraged ? AI.enrageAtkSpeed : 1) * hunger);
  }

  private damageMul(): number {
    return this.enraged ? 1.2 : 1;
  }

  /** ---- 感知：10Hz 刷新候选，带迟滞 ---- */
  private updatePerception(dt: number, store: MonsterStore): void {
    if (this.target >= 0 && store.alive[this.target] === 0) this.target = -1;

    this.perceiveTimer -= dt;
    if (this.perceiveTimer > 0) return;
    this.perceiveTimer = 1 / AI.perceiveHz;

    let bestSlot = -1;
    let bestScore = -Infinity;
    let currentScore = -Infinity;

    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const d = distance(this.x, this.y, store.x[slot] ?? 0, store.y[slot] ?? 0);
      if (d > AI.maxChaseDistance) continue;

      const maxHp = store.maxHp[slot] ?? 1;
      const hpRatio = maxHp > 0 ? (store.hp[slot] ?? 0) / maxHp : 0;
      let score = AI.scoreBase - d * AI.scoreDistance;
      score += (1 - hpRatio) * AI.scoreLowHp;
      score += (store.range[slot] ?? 0) > 120 ? AI.scoreRangedFirst : 0;
      score -= (store.armor[slot] ?? 0) * AI.scoreArmor;
      if (slot === this.target) score += AI.scoreSticky;

      if (slot === this.target) currentScore = score;
      if (score > bestScore) {
        bestScore = score;
        bestSlot = slot;
      }
    }

    if (bestSlot < 0) {
      this.target = -1;
      return;
    }
    if (this.target >= 0 && store.alive[this.target] === 1 && bestSlot !== this.target) {
      if (bestScore < currentScore * AI.switchGain) return;
    }
    this.target = bestSlot;
  }

  /** ---- 状态机 ---- */
  private updateState(dt: number): void {
    if (!this.alive) {
      this.state = 'idle';
      return;
    }
    const hpRatio = this.hpRatio;

    if (this.level >= AI.enrageLevel && hpRatio <= AI.enrageThreshold) {
      this.state = 'enrage';
      this.intent = 'chase';
      return;
    }

    if (this.state === 'retreat') {
      this.intent = 'retreat';
      this.stateTimer += dt;
      if (this.stateTimer >= AI.retreatTime || hpRatio >= AI.backOff || this.target < 0) {
        this.state = 'engage';
        this.retreatLock = AI.retreatCooldown;
        this.stateTimer = 0;
      }
      return;
    }

    if (this.retreatLock <= 0 && this.target >= 0 && hpRatio <= AI.retreatThreshold) {
      this.state = 'retreat';
      this.stateTimer = 0;
      this.intent = 'retreat';
      return;
    }

    if (this.target < 0) {
      this.state = 'patrol';
      this.intent = 'chase';
      return;
    }

    this.state = 'engage';
    this.intent = this.windup > 0 || this.qiWindup > 0 ? 'charge' : 'chase';
  }

  /** ---- 攻击与剑气 ---- */
  private updateAttack(dt: number, store: MonsterStore, hooks: HeroHooks): void {
    if (this.qiWindup > 0) {
      this.qiWindup -= dt;
      if (this.qiWindup <= 0) this.resolveQi(store, hooks);
      return;
    }

    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0) this.resolveSwing(store, hooks);
      return;
    }

    if (this.target < 0 || this.state === 'retreat') return;

    // 剑气：能串到 ≥2 个目标时才放，避免浪费
    if (this.qiCd <= 0 && this.countQiTargets(store) >= AI.qiMinTargets) {
      const dir = normalize((store.x[this.target] ?? this.x) - this.x, (store.y[this.target] ?? this.y) - this.y);
      this.qiDirX = dir.x;
      this.qiDirY = dir.y;
      this.facingX = dir.x;
      this.facingY = dir.y;
      this.qiWindup = AI.qiWindup;
      this.qiCd = AI.qiCd;
      this.intent = 'charge';
      return;
    }

    if (this.attackTimer > 0 || this.recover > 0) return;

    const d = distance(this.x, this.y, store.x[this.target] ?? 0, store.y[this.target] ?? 0);
    const reach = AI.engageRange + (store.radius[this.target] ?? 0);
    if (d > reach) return;

    const dir = normalize((store.x[this.target] ?? this.x) - this.x, (store.y[this.target] ?? this.y) - this.y);
    this.facingX = dir.x;
    this.facingY = dir.y;
    this.windup = AI.windup;
    this.intent = 'charge';
    hooks.onSwing();
  }

  private resolveSwing(store: MonsterStore, hooks: HeroHooks): void {
    this.attackTimer = HERO.baseAtkInterval / this.atkSpeedNow();
    this.recover = AI.recover;
    this.windup = 0;

    const reach = AI.engageRange + 26;
    let hits = 0;
    for (let i = 0; i < store.activeCount; i += 1) {
      if (hits >= AI.maxSwingTargets) break;
      const slot = store.active[i];
      if (slot === undefined) continue;
      const mx = store.x[slot] ?? 0;
      const my = store.y[slot] ?? 0;
      const r = store.radius[slot] ?? 0;
      if (!inCone(this.x, this.y, this.facingX, this.facingY, AI.halfArc, mx, my, reach + r)) continue;
      hits += 1;

      const crit = this.rng.chance(this.crit);
      const raw = this.atk * this.damageMul() * (crit ? 1.8 : 1);
      const dmg = Math.max(1, raw - (store.armor[slot] ?? 0));
      hooks.hitMonster(slot, dmg, crit);
      if (this.lifesteal > 0) this.hp = Math.min(this.maxHp, this.hp + dmg * this.lifesteal);
    }
  }

  private countQiTargets(store: MonsterStore): number {
    if (this.target < 0) return 0;
    const dir = normalize((store.x[this.target] ?? this.x) - this.x, (store.y[this.target] ?? this.y) - this.y);
    let count = 0;
    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const mx = (store.x[slot] ?? 0) - this.x;
      const my = (store.y[slot] ?? 0) - this.y;
      const along = mx * dir.x + my * dir.y;
      if (along <= 0 || along > AI.qiLength) continue;
      if (Math.abs(mx * dir.y - my * dir.x) <= AI.qiHalfWidth + (store.radius[slot] ?? 0)) count += 1;
    }
    return count;
  }

  private resolveQi(store: MonsterStore, hooks: HeroHooks): void {
    hooks.onQi(this.x, this.y, this.qiDirX, this.qiDirY);
    this.recover = AI.qiRecover;
    this.qiWindup = 0;
    this.intent = 'chase';

    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const mx = (store.x[slot] ?? 0) - this.x;
      const my = (store.y[slot] ?? 0) - this.y;
      const along = mx * this.qiDirX + my * this.qiDirY;
      if (along <= 0 || along > AI.qiLength) continue;
      if (Math.abs(mx * this.qiDirY - my * this.qiDirX) > AI.qiHalfWidth + (store.radius[slot] ?? 0)) continue;

      const dmg = Math.max(1, this.atk * AI.qiDamageMul - (store.armor[slot] ?? 0));
      hooks.hitMonster(slot, dmg, false);
      if (this.lifesteal > 0) this.hp = Math.min(this.maxHp, this.hp + dmg * this.lifesteal);
    }
  }

  /** ---- 移动 ---- */
  private updateMovement(dt: number, store: MonsterStore): void {
    let dirX = 0;
    let dirY = 0;
    let wantMove = false;

    if (this.target >= 0) {
      const tx = store.x[this.target] ?? this.x;
      const ty = store.y[this.target] ?? this.y;
      const d = distance(this.x, this.y, tx, ty);
      const dir = normalize(tx - this.x, ty - this.y);

      if (this.state === 'retreat') {
        dirX = -dir.x;
        dirY = -dir.y;
        wantMove = true;
      } else if (d > AI.engageRange * AI.stopFactor) {
        dirX = dir.x;
        dirY = dir.y;
        wantMove = true;
        this.facingX = dir.x;
        this.facingY = dir.y;
      }
    } else {
      const homeX = ARENA.cx;
      const homeY = ARENA.cy + 300;
      const dir = normalize(homeX - this.x, homeY - this.y);
      dirX = dir.x;
      dirY = dir.y;
      wantMove = distance(this.x, this.y, homeX, homeY) > 70;
    }

    // 卡住自愈：贴石头推不动时侧向绕行
    this.stuckTimer += dt;
    if (this.stuckTimer >= AI.stuckTime) {
      this.stuckTimer = 0;
      if (wantMove && distance(this.x, this.y, this.lastX, this.lastY) < AI.stuckDist) {
        this.dodgeTimer = AI.dodgeTime;
        this.dodgeSign = this.rng.chance(0.5) ? 1 : -1;
      }
      this.lastX = this.x;
      this.lastY = this.y;
    }
    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      const px = -dirY * this.dodgeSign;
      const py = dirX * this.dodgeSign;
      dirX = dirX * 0.35 + px;
      dirY = dirY * 0.35 + py;
    }

    const speedMul = (this.enraged ? AI.enrageSpeed : 1) * (this.state === 'retreat' ? 1.1 : 1);
    const targetVx = wantMove ? dirX * this.speed * speedMul : 0;
    const targetVy = wantMove ? dirY * this.speed * speedMul : 0;

    this.vx = damp(this.vx, targetVx, AI.accelK, dt);
    this.vy = damp(this.vy, targetVy, AI.accelK, dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.moving = Math.abs(this.vx) + Math.abs(this.vy) > 18;
    this.confineToArena();
  }

  private confineToArena(): void {
    const limit = ARENA.r - 40;
    const dx = this.x - ARENA.cx;
    const dy = this.y - ARENA.cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > limit) {
      const nx = dx / d;
      const ny = dy / d;
      this.x = ARENA.cx + nx * limit;
      this.y = ARENA.cy + ny * limit;
      const dot = this.vx * nx + this.vy * ny;
      if (dot > 0) {
        this.vx -= nx * dot;
        this.vy -= ny * dot;
      }
    }
    this.pushOut(THRONE.x, THRONE.y, THRONE.r);
    for (const pillar of PILLARS) this.pushOut(pillar.x, pillar.y, pillar.r);
  }

  private pushOut(ox: number, oy: number, or: number): void {
    const dx = this.x - ox;
    const dy = this.y - oy;
    const min = or + HERO.radius + 4;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= min || d < 0.001) return;
    this.x = ox + (dx / d) * min;
    this.y = oy + (dy / d) * min;
  }
}
