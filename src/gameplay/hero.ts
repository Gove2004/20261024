import { AI } from '../content/heroAi';
import { PASSIVE_POOL, SKILL_BY_ID, SKILL_TUNING, type SkillId } from '../content/heroSkills';

/** 技能 id 的固定顺序（热路径遍历冷却用，避免每帧 Object.keys） */
const SKILL_IDS: readonly SkillId[] = ['shot', 'spread', 'qi', 'bomb', 'heavy', 'heal', 'roll'];
import {
  HALL,
  HALL_CENTER,
  HERO,
  PILLARS,
  THRONE,
  hallX,
  hallY,
  heroAtk,
  heroMaxHp,
  heroSpeed,
  xpNeed,
} from '../content/config';
import type { MonsterStore } from '../ecs/store';
import { clamp, damp, distance, normalize } from '../core/math';
import type { Rng } from '../core/rng';

export type HeroState = 'idle' | 'patrol' | 'seek' | 'engage' | 'retreat' | 'enrage';
export type HeroIntent = 'chase' | 'charge' | 'retreat';

/** 勇者与外部世界的交互回调（伤害结算、特效、播报都从这里出去）。 */
export interface HeroHooks {
  hitMonster(slot: number, damage: number, crit: boolean): void;
  onQi(fromX: number, fromY: number, dirX: number, dirY: number): void;
  /** 远程射击（视觉表现：弹丸从弹弓飞向目标） */
  onShot(fromX: number, fromY: number, dirX: number, dirY: number): void;
  /** 抛射爆弹：落点由 game 排进"延迟结算"，预警是义务 */
  onBomb(x: number, y: number, radius: number, damage: number): void;
  /** 自己回血（干粮） */
  onHealSelf(x: number, y: number, amount: number): void;
  /** 翻滚位移 */
  onRoll(fromX: number, fromY: number, toX: number, toY: number): void;
  onLevelUp(level: number, passive: string): void;
  onHurt(amount: number): void;
}

interface Passive {
  readonly name: string;
  apply(hero: Hero): void;
}

/**
 * 14 个被动的实现。名字必须和 `heroSkills.PASSIVE_POOL` 一一对应 ——
 * 那边是给玩家看的文案，这边是效果，单测会校验两边条数一致。
 */
const PASSIVES: readonly Passive[] = [
  { name: '力量 +8%', apply: (h) => h.gainAtk(0.08) },
  { name: '攻速 +12%', apply: (h) => void (h.atkSpeedMul += 0.12) },
  { name: '护甲 +3', apply: (h) => void (h.armor += 3) },
  { name: '暴击 +8%', apply: (h) => void (h.crit += 0.08) },
  { name: '吸血 4%', apply: (h) => void (h.lifesteal += 0.04) },
  { name: '移速 +10%', apply: (h) => void (h.moveMul += 0.1) },
  { name: '减伤 8%', apply: (h) => void (h.damageReduction = Math.min(0.6, h.damageReduction + 0.08)) },
  { name: '生命 +8%', apply: (h) => h.gainMaxHp(0.08) },
  { name: '剑气 +25%', apply: (h) => void (h.qiMul += 0.25) },
  { name: '散射 +2 弹', apply: (h) => void (h.spreadExtra += 2) },
  { name: '重击 +30%', apply: (h) => void (h.heavyMul += 0.3) },
  { name: '技能冷却 −12%', apply: (h) => void (h.skillCdMul *= 0.88) },
  { name: '击杀回血 2%', apply: (h) => void (h.killHeal += 0.02) },
  { name: '弹弓穿透 +1', apply: (h) => void (h.shotPierce += 1) },
];

/** 被动条数必须和文案表一致，否则玩家看到的升级选项和实际效果会错位。 */
export const PASSIVE_COUNT = PASSIVES.length;
export const PASSIVE_POOL_COUNT = PASSIVE_POOL.length;

/**
 * 勇者「锅巴」。近战剑士 + 标志性剑气。
 *
 * 已落地（策划案 §5）：感知 10Hz + 目标迟滞、SEEK/ENGAGE/RETREAT/ENRAGE 状态机、
 * 带加速度的转向、卡住自愈、普攻三段（前摇/判定/后摇）、剑气蓄力与地面预警。
 */
export class Hero {
  public x: number = HALL_CENTER.x;
  public y: number = HALL_CENTER.y + 420;
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

  /** 正在蓄力的技能（null = 没在放技能） */
  public pendingSkill: SkillId | null = null;
  /** 每个主动技能的剩余冷却 */
  public readonly cds: Record<SkillId, number> = {
    shot: 0,
    spread: 0,
    qi: 0,
    bomb: 0,
    heavy: 0,
    heal: 0,
    roll: 0,
  };
  /** 爆弹落点（前摇期间 scene 会画预警圈） */
  public bombX = 0;
  public bombY = 0;
  /** 剑气方向（scene 用来画蓄力线） */
  public qiDirX = 0;
  public qiDirY = 1;
  /** 翻滚后的短暂无敌 */
  public guardTimer = 0;

  /** 被动堆出来的属性 */
  public moveMul = 1;
  public damageReduction = 0;
  public qiMul = 1;
  public heavyMul = 1;
  public spreadExtra = 0;
  public shotPierce = 0;
  public killHeal = 0;
  public skillCdMul = 1;

  public flash = 0;
  public hurtTimer = 0;
  public retreatLock = 0;
  /** 势场走位的输出方向与压力（steerKite 写入，热路径零分配） */
  private steerX = 0;
  private steerY = 0;
  private steerPressure = 0;
  private wallPressure = 0;
  /** 绕圈方向（+1 / -1），带粘性，只有外侧明显更开阔才换边 */
  private orbitSign = 1;
  /** 绕圈换边的冷却帧数（见 steerKite） */
  private orbitEval = 0;
  /** 当前走位朝向（弧度）。限速转弯用，见 steerKite */
  private steerAngle = 0;
  public stateTimer = 0;

  public intent: HeroIntent = 'chase';

  /** 减速：蜘蛛的毒与冰霜法师的冰弹都走这里 */
  public slowTimer = 0;
  public slowFactor = 1;
  /** 冰冻（完全不动不攻） */
  public frozenTimer = 0;
  /** 冰霜累积层数：叠到 3 层冻住 */
  public frostStacks = 0;
  /** 嘲讽：石头鬼逼他打自己 */
  public tauntSlot = -1;
  public tauntTimer = 0;

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
    this.x = HALL_CENTER.x;
    this.y = HALL_CENTER.y + 420;
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
    this.pendingSkill = null;
    this.cds.shot = 0;
    this.cds.spread = 0;
    this.cds.qi = 0;
    this.cds.bomb = 0;
    this.cds.heavy = 0;
    this.cds.heal = 0;
    this.cds.roll = 0;
    this.guardTimer = 0;
    this.moveMul = 1;
    this.damageReduction = 0;
    this.qiMul = 1;
    this.heavyMul = 1;
    this.spreadExtra = 0;
    this.shotPierce = 0;
    this.killHeal = 0;
    this.skillCdMul = 1;
    this.flash = 0;
    this.hurtTimer = 0;
    this.retreatLock = 0;
    this.stateTimer = 0;
    this.slowTimer = 0;
    this.slowFactor = 1;
    this.frozenTimer = 0;
    this.frostStacks = 0;
    this.tauntSlot = -1;
    this.tauntTimer = 0;
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

  /** 击杀回血（被动「击杀回血」）。由 game 在结算击杀时调用。 */
  public onKill(): void {
    if (this.killHeal <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * this.killHeal);
  }

  public takeDamage(amount: number, hooks: HeroHooks): void {
    if (!this.alive) return;
    // 翻滚的无敌帧：玩家（摆怪的人）看到他要翻滚时，这一发就算白打
    if (this.guardTimer > 0) return;
    // 护甲走百分比减免，不做减法：减法会让"小怪 vs 高护甲"直接塌成 1 点伤害，
    // 后期护甲一叠，杂兵就彻底打不动人（这是实测踩到的坑）。
    const reduction = this.armor / (this.armor + 60);
    const real = Math.max(1, amount * (1 - reduction) * (1 - this.damageReduction));
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
      // 升级只回 3%，而且**只在真正掉血时才回**：
      // 之前无条件回血，让"打满 300 只怪 → 升 13 级"变成 39% 最大生命的白送治疗，
      // 模拟里他连着好几局都是 100% 血收场 —— 场上没压力，玩家就不会紧张。
      // 门槛 0.7 和被动治疗技能的阈值一致，读起来是同一套"重伤才自救"的直觉。
      if (this.hp < this.maxHp * 0.7) {
        this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.03);
      }
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
    this.guardTimer = Math.max(0, this.guardTimer - dt);
    for (const id of SKILL_IDS) {
      const cd = this.cds[id];
      if (cd > 0) this.cds[id] = Math.max(0, cd - dt);
    }

    if (this.slowTimer > 0) {
      this.slowTimer = Math.max(0, this.slowTimer - dt);
      if (this.slowTimer === 0) {
        this.slowFactor = 1;
        this.frostStacks = 0;
      }
    }
    this.frozenTimer = Math.max(0, this.frozenTimer - dt);
    this.tauntTimer = Math.max(0, this.tauntTimer - dt);
    if (this.tauntTimer === 0) this.tauntSlot = -1;

    this.updatePerception(dt, store);
    this.updateState(dt);
    this.updateAttack(dt, store, hooks);
    this.updateMovement(dt, store);
  }

  private get enraged(): boolean {
    return this.state === 'enrage';
  }

  private atkSpeedNow(): number {
    const hunger = 1;
    if (this.frozenTimer > 0) return 0.3;
    return Math.max(0.3, this.atkSpeedMul * (this.enraged ? AI.enrageAtkSpeed : 1) * hunger);
  }

  private damageMul(): number {
    return this.enraged ? 1.2 : 1;
  }

  /** 移动速度倍率（减速/冰冻）。 */
  private moveFactor(): number {
    if (this.frozenTimer > 0) return 0;
    return this.slowTimer > 0 ? this.slowFactor : 1;
  }

  /** 被减速（取最强的一次，不叠加）。 */
  public applySlow(factor: number, seconds: number): void {
    if (this.frozenTimer > 0) return;
    if (this.slowTimer <= 0 || factor < this.slowFactor) this.slowFactor = factor;
    this.slowTimer = Math.max(this.slowTimer, seconds);
  }

  /** 冰霜叠层：满 3 层冻住。返回是否触发冰冻。 */
  public addFrostStack(seconds: number): boolean {
    this.applySlow(0.65, seconds);
    this.frostStacks += 1;
    if (this.frostStacks < 3) return false;
    this.frostStacks = 0;
    this.freeze(0.8);
    return true;
  }

  public freeze(seconds: number): void {
    this.frozenTimer = Math.max(this.frozenTimer, seconds);
    this.windup = 0;
  }

  /** 嘲讽：强制目标 N 秒，打断撤退。 */
  public taunt(slot: number, seconds: number): void {
    this.tauntSlot = slot;
    this.tauntTimer = seconds;
    this.retreatLock = Math.max(this.retreatLock, seconds);
    if (this.state === 'retreat') this.state = 'seek';
  }

  /** ---- 感知：10Hz 刷新候选，带迟滞 ---- */
  private updatePerception(dt: number, store: MonsterStore): void {
    if (this.target >= 0 && store.alive[this.target] === 0) this.target = -1;

    // 嘲讽高于一切：石头鬼就是要把他的注意力买走 3 秒
    if (this.tauntTimer > 0 && this.tauntSlot >= 0 && store.alive[this.tauntSlot] === 1) {
      this.target = this.tauntSlot;
      return;
    }

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
    this.intent = this.pendingSkill !== null ? 'charge' : 'chase';
  }

  /** ---- 技能调度 ---- */
  private updateAttack(dt: number, store: MonsterStore, hooks: HeroHooks): void {
    if (this.frozenTimer > 0) {
      this.windup = 0;
      this.pendingSkill = null;
      return;
    }

    if (this.pendingSkill !== null) {
      this.windup -= dt;
      if (this.windup > 0) return;
      const skill = this.pendingSkill;
      this.pendingSkill = null;
      this.resolveSkill(skill, store, hooks);
      return;
    }

    if (this.attackTimer > 0 || this.recover > 0 || this.target < 0 || this.state === 'retreat') return;

    // 优先级 = 生存 > 保命位移 > 大招 > 清群 > 补刀。
    // 顺序写死而不是随机：玩家必须能学会"他什么时候会做什么"。
    const tx = store.x[this.target] ?? this.x;
    const ty = store.y[this.target] ?? this.y;
    const dist = distance(this.x, this.y, tx, ty);
    const dir = normalize(tx - this.x, ty - this.y);

    if (this.hpRatio < SKILL_TUNING.healThreshold && this.canUse('heal')) {
      this.beginSkill('heal', dir, hooks);
      return;
    }
    if (dist < SKILL_TUNING.rollTrigger && this.canUse('roll')) {
      this.beginSkill('roll', dir, hooks);
      return;
    }
    if (this.canUse('heavy') && dist > 170 && dist <= SKILL_TUNING.heavyRange) {
      this.beginSkill('heavy', dir, hooks);
      return;
    }
    if (this.canUse('bomb') && this.countAround(store, tx, ty, SKILL_TUNING.bombRadius) >= 3) {
      this.beginSkill('bomb', dir, hooks);
      return;
    }
    if (this.canUse('spread') && this.countInCone(store, dir, SKILL_TUNING.spreadAngle, SKILL_TUNING.spreadRange) >= 2) {
      this.beginSkill('spread', dir, hooks);
      return;
    }
    if (this.canUse('qi') && this.countQiTargets(store) >= AI.qiMinTargets) {
      this.qiDirX = dir.x;
      this.qiDirY = dir.y;
      this.beginSkill('qi', dir, hooks);
      return;
    }

    // 普攻：够得着才射，够不着就继续靠（靠近由 updateMovement 负责）
    if (dist > AI.shootRange + (store.radius[this.target] ?? 0)) return;
    this.beginSkill('shot', dir, hooks);
  }

  private canUse(id: SkillId): boolean {
    return this.cds[id] <= 0;
  }

  private beginSkill(id: SkillId, dir: { x: number; y: number }, hooks: HeroHooks): void {
    const def = SKILL_BY_ID[id];
    this.facingX = dir.x;
    this.facingY = dir.y;
    this.pendingSkill = id;
    this.windup = def.windup;
    this.intent = 'charge';
    if (id === 'bomb') {
      this.bombX = this.x + dir.x * 220;
      this.bombY = this.y + dir.y * 220;
    }
    if (id === 'roll') {
      // 翻滚是唯一没有前摇缓冲的技能，落地就先画一道烟
      hooks.onRoll(this.x, this.y, this.x - dir.x * SKILL_TUNING.rollDistance, this.y - dir.y * SKILL_TUNING.rollDistance);
    }
  }

  private resolveSkill(id: SkillId, store: MonsterStore, hooks: HeroHooks): void {
    const def = SKILL_BY_ID[id];
    if (def.cd > 0) this.cds[id] = def.cd * this.skillCdMul;
    switch (id) {
      case 'shot':
        this.resolveShot(store, hooks);
        break;
      case 'spread':
        this.resolveSpread(store, hooks);
        break;
      case 'qi':
        this.resolveQi(store, hooks);
        break;
      case 'bomb':
        this.resolveBomb(hooks);
        break;
      case 'heavy':
        this.resolveHeavy(store, hooks);
        break;
      case 'heal':
        this.resolveHeal(hooks);
        break;
      case 'roll':
        this.resolveRoll(store);
        break;
    }
  }

  /** 伤害结算的公共出口：暴击、百分比护甲、吸血都在这里，避免每个技能各写一遍。 */
  private hit(slot: number, store: MonsterStore, hooks: HeroHooks, mul: number, canCrit: boolean): number {
    const crit = canCrit && this.rng.chance(this.crit);
    const raw = this.atk * this.damageMul() * mul * (crit ? 1.8 : 1);
    // 百分比减伤而不是直接减法：他改成单体远程后每发伤害变小，
    // 减法会让高护甲怪直接免疫（实测 4 点伤害），"堆数量"就变成唯一解。
    const dmg = Math.max(1, raw * (60 / (60 + (store.armor[slot] ?? 0))));
    hooks.hitMonster(slot, dmg, crit);
    if (this.lifesteal > 0) this.hp = Math.min(this.maxHp, this.hp + dmg * this.lifesteal);
    return dmg;
  }

  /**
   * 射击结算：**单体**命中。他不再有近战挥砍，
   * 所以"一堆小怪围上来"就有了意义 —— 一发只打死一只。
   * 被动「弹弓穿透」能让它多穿几只。
   */
  private resolveShot(store: MonsterStore, hooks: HeroHooks): void {
    this.attackTimer = HERO.baseAtkInterval / this.atkSpeedNow();
    this.recover = AI.recover;
    this.windup = 0;

    hooks.onShot(this.x, this.y, this.facingX, this.facingY);

    let hits = 0;
    const maxHits = 1 + this.shotPierce;
    for (let i = 0; i < store.activeCount && hits < maxHits; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const mx = store.x[slot] ?? 0;
      const my = store.y[slot] ?? 0;
      const radius = store.radius[slot] ?? 0;
      const dx = mx - this.x;
      const dy = my - this.y;
      const along = dx * this.facingX + dy * this.facingY;
      if (along <= 0 || along > AI.shootRange + radius) continue;
      // 弹丸要有"打偏"的可能：不在准星锥内就落空。
      // 否则玩家永远无法靠走位/拉扯躲开他的输出。
      const side = Math.abs(dx * this.facingY - dy * this.facingX);
      if (side > radius + 14) continue;
      this.hit(slot, store, hooks, 1, true);
      hits += 1;
    }
  }

  /** 散射：以准星为中心铺开一片弹丸，专治"杂兵堆成一片"。 */
  private resolveSpread(store: MonsterStore, hooks: HeroHooks): void {
    const pellets = SKILL_TUNING.spreadPellets + this.spreadExtra;
    this.recover = AI.recover;
    this.windup = 0;

    const base = Math.atan2(this.facingY, this.facingX);
    const hitSlots = new Set<number>();
    for (let p = 0; p < pellets; p += 1) {
      const t = pellets === 1 ? 0 : p / (pellets - 1) - 0.5;
      const angle = base + t * SKILL_TUNING.spreadAngle * 2;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      hooks.onShot(this.x, this.y, dx, dy);

      // 每颗弹丸命中最靠近的那只，且不重复命中（否则一炮全灭）
      let bestSlot = -1;
      let bestAlong = Infinity;
      for (let i = 0; i < store.activeCount; i += 1) {
        const slot = store.active[i];
        if (slot === undefined || hitSlots.has(slot)) continue;
        const mx = (store.x[slot] ?? 0) - this.x;
        const my = (store.y[slot] ?? 0) - this.y;
        const along = mx * dx + my * dy;
        if (along <= 0 || along > SKILL_TUNING.spreadRange) continue;
        if (Math.abs(mx * dy - my * dx) > (store.radius[slot] ?? 0) + 12) continue;
        if (along < bestAlong) {
          bestAlong = along;
          bestSlot = slot;
        }
      }
      if (bestSlot >= 0) {
        hitSlots.add(bestSlot);
        this.hit(bestSlot, store, hooks, 0.7, true);
      }
    }
  }

  /** 爆弹：不立即结算，交给 game 走"预警 → 到点 → 伤害"的流程。 */
  private resolveBomb(hooks: HeroHooks): void {
    this.recover = 0.35;
    this.windup = 0;
    hooks.onBomb(this.bombX, this.bombY, SKILL_TUNING.bombRadius, this.atk * SKILL_TUNING.bombDamageMul);
  }

  /** 蓄力重击：长前摇换高伤害，专治高星肉盾。 */
  private resolveHeavy(store: MonsterStore, hooks: HeroHooks): void {
    this.recover = 0.4;
    this.windup = 0;
    hooks.onQi(this.x, this.y, this.facingX, this.facingY);
    const slot = this.target;
    if (slot < 0) return;
    const d = distance(this.x, this.y, store.x[slot] ?? 0, store.y[slot] ?? 0);
    if (d > SKILL_TUNING.heavyRange) return;
    this.hit(slot, store, hooks, SKILL_TUNING.heavyDamageMul * this.heavyMul, true);
  }

  private resolveHeal(hooks: HeroHooks): void {
    this.recover = 0.3;
    this.windup = 0;
    const amount = this.maxHp * SKILL_TUNING.healRatio;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    hooks.onHealSelf(this.x, this.y, amount);
  }

  private resolveRoll(store: MonsterStore): void {
    this.recover = 0.2;
    this.windup = 0;
    const dir = normalize(this.facingX, this.facingY);
    this.x -= dir.x * SKILL_TUNING.rollDistance;
    this.y -= dir.y * SKILL_TUNING.rollDistance;
    this.confineToArena();
    this.guardTimer = 0.35;
    this.vx = 0;
    this.vy = 0;
    void store;
  }

  /** 以 (x,y) 为中心、半径 r 内有几只魔物（爆弹值不值得放）。 */
  private countAround(store: MonsterStore, x: number, y: number, r: number): number {
    let count = 0;
    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      if (distance(x, y, store.x[slot] ?? 0, store.y[slot] ?? 0) <= r) count += 1;
    }
    return count;
  }

  /** 一个扇形里最多有几只（散射值不值得放）。 */
  private countInCone(store: MonsterStore, dir: { x: number; y: number }, halfAngle: number, range: number): number {
    const cosLimit = Math.cos(halfAngle);
    let count = 0;
    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const dx = (store.x[slot] ?? 0) - this.x;
      const dy = (store.y[slot] ?? 0) - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= 1 || d > range) continue;
      if ((dx * dir.x + dy * dir.y) / d < cosLimit) continue;
      count += 1;
    }
    return count;
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
    this.intent = 'chase';

    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const mx = (store.x[slot] ?? 0) - this.x;
      const my = (store.y[slot] ?? 0) - this.y;
      const along = mx * this.qiDirX + my * this.qiDirY;
      if (along <= 0 || along > AI.qiLength) continue;
      if (Math.abs(mx * this.qiDirY - my * this.qiDirX) > AI.qiHalfWidth + (store.radius[slot] ?? 0)) continue;

      this.hit(slot, store, hooks, AI.qiDamageMul * this.qiMul, false);
    }
  }

  /** ---- 移动 ---- */

  /**
   * 势场走位：这是本作的核心 AI（用户原话「跑圈圈放风筝是本游戏核心，重点难点」）。
   *
   * 三股力合成一个期望方向：
   *  1. **排斥**：附近每只魔物按「威胁权重 / 距离」推他一把。远程和自爆虫权重更高
   *     （站着挨远程弹比被近战摸一下更疼，自爆虫必须躲）。
   *  2. **切向（绕圈）**：当压力大到一定程度，加一个垂直于排斥方向的力 ——
   *     这就是"跑圈"：既不远离战场（那样打不到人），也不直冲（那会送死）。
   *     绕圈方向有粘性（`orbitSign`），外侧空间明显更大时才换边，否则会每帧抖动。
   *  3. **离墙推力**：靠近墙就开始被推回中央。这是"不被逼到墙角"的主要保障 ——
   *     旧版直线后撤时，玩家只要把怪铺在墙边，他就会自己退进墙角被抓死。
   *
   * 全部写进字段（`steerX/steerY/steerPressure/wallPressure`），热路径零分配。
   */
  private steerKite(store: MonsterStore, toTargetX: number, toTargetY: number, targetDist: number, dt: number): void {
    const r = AI.threatRadius;
    let repelX = 0;
    let repelY = 0;
    let pressure = 0;
    let nearest = targetDist;

    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const dx = this.x - (store.x[slot] ?? this.x);
      const dy = this.y - (store.y[slot] ?? this.y);
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const d = Math.sqrt(d2) + 0.001;
      if (d < nearest) nearest = d;
      // 威胁权重：远程 > 自爆 > 近战。留一点基础权重，近战群也不能无视。
      const abi = store.abi[slot] ?? 0;
      const weight = (abi === 1 ? AI.threatSuicide : abi === 3 ? AI.threatRanged : 1) * (1 - d / r);
      repelX += (dx / d) * weight;
      repelY += (dy / d) * weight;
      pressure += weight;
    }

    // 离墙推力：每面墙独立算，角落自然叠成双倍
    const m = AI.wallMargin;
    let wallX = 0;
    let wallY = 0;
    const dl = this.x - HALL.left;
    const dr = HALL.right - this.x;
    const dt2 = this.y - HALL.top;
    const db = HALL.bottom - this.y;
    if (dl < m) wallX += (1 - dl / m) ** 2;
    if (dr < m) wallX -= (1 - dr / m) ** 2;
    if (dt2 < m) wallY += (1 - dt2 / m) ** 2;
    if (db < m) wallY -= (1 - db / m) ** 2;
    const wallPressure = Math.sqrt(wallX * wallX + wallY * wallY);

    let x = repelX;
    let y = repelY;
    const len = Math.sqrt(x * x + y * y);

    if (pressure > 0.06) {
      // 切向：垂直于排斥方向。选空间更大的一侧（外侧=能跑得更远）。
      let nx: number;
      let ny: number;
      if (len > 0.0001) {
        nx = x / len;
        ny = y / len;
      } else {
        // 被完全包围时排斥力互相抵消，用"背离目标"当基准方向
        nx = -toTargetX;
        ny = -toTargetY;
      }
      const tangX = -ny;
      const tangY = nx;
      const sign = this.orbitSign >= 0 ? 1 : -1;
      // 换边有冷却：每帧都比较会让绕圈方向一直抖（实测绕圈率只有 0.2），
      // 而"跑圈"成立的前提是方向稳定 —— 必须先转完一段弧再考虑换边。
      this.orbitEval -= 1;
      if (this.orbitEval <= 0) {
        this.orbitEval = 48; // 0.8 秒（60fps）
        const freePlus = this.freeAlong(tangX * sign, tangY * sign);
        const freeMinus = this.freeAlong(-tangX * sign, -tangY * sign);
        if (freeMinus > freePlus * AI.orbitFlipGain) this.orbitSign = -this.orbitSign;
      }
      const s = this.orbitSign;
      // 压力越大越贴向切向（绕圈），压力小时以排斥为主（退开）
      const orbit = Math.min(1, pressure * 1.6) * AI.orbitWeight;
      x = nx * (1 - orbit * 0.45) + tangX * s * orbit;
      y = ny * (1 - orbit * 0.45) + tangY * s * orbit;
    } else if (targetDist > AI.keepRange) {
      // 没压力但离得太远：压向目标
      x = toTargetX;
      y = toTargetY;
    }

    x += wallX * AI.wallWeight;
    y += wallY * AI.wallWeight;

    const finalLen = Math.sqrt(x * x + y * y);
    if (finalLen > 0.0001) {
      // 方向限速（转弯半径）：这是"跑圈"能看出来的关键。
      // 只算合力的话，被围住时各个方向互相抵消，锅巴会在原地疯狂抖动（实测轨迹是一团乱麻）。
      // 限制每秒最多转多少弧度之后，方向有惯性 —— 他自己会跑出弧线，看着就像在放风筝。
      const want = Math.atan2(y / finalLen, x / finalLen);
      let diff = want - this.steerAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = AI.turnRate * dt;
      if (diff > maxTurn) diff = maxTurn;
      else if (diff < -maxTurn) diff = -maxTurn;
      this.steerAngle += diff;
      this.steerX = Math.cos(this.steerAngle);
      this.steerY = Math.sin(this.steerAngle);
    } else {
      this.steerX = 0;
      this.steerY = 0;
    }
    this.steerPressure = pressure;
    this.wallPressure = wallPressure;
  }

  /** 沿某方向到最近的墙还有多远（用于比较"往哪边绕更开阔"）。 */
  private freeAlong(dx: number, dy: number): number {
    let best = 1e6;
    if (dx > 0.0001) best = Math.min(best, (HALL.right - this.x) / dx);
    else if (dx < -0.0001) best = Math.min(best, (HALL.left - this.x) / dx);
    if (dy > 0.0001) best = Math.min(best, (HALL.bottom - this.y) / dy);
    else if (dy < -0.0001) best = Math.min(best, (HALL.top - this.y) / dy);
    return best;
  }

  private updateMovement(dt: number, store: MonsterStore): void {
    let dirX = 0;
    let dirY = 0;
    let wantMove = false;

    // 蓄力时站定：这是玩家唯一能"贴上去"的窗口。
    // 会边跑边射的远程单位在测试里几乎不掉血（8 局平均剩 87% 血），必须给他这个破绽。
    if (this.pendingSkill !== null) {
      this.vx = damp(this.vx, 0, AI.accelK * 2, dt);
      this.vy = damp(this.vy, 0, AI.accelK * 2, dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.moving = false;
      this.confineToArena();
      return;
    }

    if (this.target >= 0) {
      const tx = store.x[this.target] ?? this.x;
      const ty = store.y[this.target] ?? this.y;
      const d = distance(this.x, this.y, tx, ty);
      const dir = normalize(tx - this.x, ty - this.y);

      // 射击始终朝向目标；走位则交给势场（下面三股力）
      this.facingX = dir.x;
      this.facingY = dir.y;

      this.steerKite(store, dir.x, dir.y, d, dt);

      if (this.state === 'retreat') {
        // 撤退：势场方向本身就是"远离所有威胁"，再偏一点侧向避免被直线追死
        const side = this.dodgeSign >= 0 ? 1 : -1;
        dirX = this.steerX * 0.84 - this.steerY * 0.54 * side;
        dirY = this.steerY * 0.84 + this.steerX * 0.54 * side;
        wantMove = true;
      } else if (d > AI.shootRange * 1.15) {
        // 目标在射程外：压上去（此时势场仍然在起作用，避免一头撞进怪物堆）
        dirX = this.steerX * 0.55 + dir.x * 0.75;
        dirY = this.steerY * 0.55 + dir.y * 0.75;
        wantMove = true;
      } else {
        // 射程内：走位全交给势场 —— 这就是"拉扯 / 跑圈"的落点
        dirX = this.steerX;
        dirY = this.steerY;
        wantMove = this.steerPressure > 0.04 || this.wallPressure > 0.05;
      }
    } else {
      const homeX = HALL_CENTER.x;
      const homeY = HALL_CENTER.y + 300;
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

    const speedMul =
      (this.enraged ? AI.enrageSpeed : 1) *
      (this.state === 'retreat' ? 1.1 : 1) *
      (this.target >= 0 && distance(this.x, this.y, store.x[this.target] ?? this.x, store.y[this.target] ?? this.y) < AI.panicRange
        ? AI.kiteSpeed
        : 1);
    const targetVx = wantMove ? dirX * this.speed * speedMul * this.moveFactor() : 0;
    const targetVy = wantMove ? dirY * this.speed * speedMul * this.moveFactor() : 0;

    this.vx = damp(this.vx, targetVx, AI.accelK, dt);
    this.vy = damp(this.vy, targetVy, AI.accelK, dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.moving = Math.abs(this.vx) + Math.abs(this.vy) > 18;
    this.confineToArena();
  }

  private confineToArena(): void {
    const margin = 40;
    const cx = hallX(this.x, margin);
    const cy = hallY(this.y, margin);
    if (cx !== this.x) {
      this.x = cx;
      this.vx = 0;
    }
    if (cy !== this.y) {
      this.y = cy;
      this.vy = 0;
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
