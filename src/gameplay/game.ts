import {
  DETONATE,
  HALL_CENTER,
  HERO,
  PILLARS,
  PLACE,
  POWERUP,
  RUN,
  SCORE,
  THRONE,
  VIEW,
  WORLD,
  XP,
  inHall,
  starCapAt,
} from '../content/config';
import { CARDS, STARTER_HAND, cardCdSeconds, findCard, summonCount } from '../content/cards';
import { MonsterStore } from '../ecs/store';
import { Hero, type HeroHooks } from './hero';
import { updateMonsters } from './monsters';
import { createRng, type Rng } from '../core/rng';
import { clamp, damp, distance } from '../core/math';

export type GameState = 'title' | 'playing' | 'powerup' | 'won' | 'lost' | 'paused';

export interface HandCard {
  readonly id: string;
  readonly defIdx: number;
  star: number;
  cd: number;
}

export type PowerupKind = 'atk' | 'hp' | 'atkspeed' | 'cd' | 'starcap' | 'hand' | 'star';

export interface PowerupOption {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  readonly kind: PowerupKind;
  readonly value: number;
}

/**
 * 手牌从 4 提到 6：12 张卡池里 4 个格子意味着"这局我能玩到什么"太随机，
 * 6 格才够组出一个流派（坦克 + 输出 + 功能），也让新解锁的卡真的能被用上。
 * 再往上给 2 格权能，上限 8 —— 再多人就只看手牌不看战场了。
 */
const HAND_BASE = 6;
const HAND_MAX_EXTRA = 2;

const POWERUPS: readonly PowerupOption[] = [  { id: 'atk', title: '尖牙', desc: '全魔物攻击 +14%', kind: 'atk', value: 0.14 },
  { id: 'hp', title: '厚壳', desc: '全魔物生命 +18%', kind: 'hp', value: 0.18 },
  { id: 'atkspeed', title: '躁动', desc: '全魔物攻速 +10%', kind: 'atkspeed', value: 0.1 },
  { id: 'cd', title: '冷却缩减', desc: '全卡 CD −8%', kind: 'cd', value: 0.08 },
  { id: 'starcap', title: '星域扩张', desc: '星数上限 +5', kind: 'starcap', value: 5 },
  { id: 'hand', title: '更多手牌', desc: '手牌位 +1（最多 6）', kind: 'hand', value: 1 },
];

/** 升星永远出现在每轮三选一里：它是玩家"养大自己的东西"的唯一通道。 */
const STAR_UPGRADE: PowerupOption = {
  id: 'star',
  title: '卡牌升星',
  desc: '随机一张手牌 +1 星（最高 10★）',
  kind: 'star',
  value: 1,
};

/** 渲染层/UI 需要监听的事件。游戏逻辑不直接碰 DOM 与 Pixi。 */
export interface GameEvents {
  onSpawn(slot: number): void;
  onDeath(slot: number): void;
  onHeroHurt(amount: number): void;
  onHeroLevel(level: number, passive: string): void;
  onSwing(): void;
  onQi(x: number, y: number, dirX: number, dirY: number): void;
  onRangedShot(slot: number, fromX: number, fromY: number, toX: number, toY: number): void;
  onDetonate(x: number, y: number, radius: number): void;
  /** 地面预警圈（火球/自爆），duration 秒后结算 */
  onTelegraph(x: number, y: number, radius: number, duration: number): void;
  /** 治疗/冰冻等即时表现 */
  onEffect(kind: 'heal' | 'freeze' | 'taunt' | 'boom', x: number, y: number, radius: number): void;
  toast(text: string, kind?: 'info' | 'good' | 'bad'): void;
  onPowerup(options: readonly PowerupOption[]): void;
  onFinish(won: boolean): void;
}

/** 待结算的范围伤害（火球）。预警是义务，不是特效。 */
interface PendingAoe {
  x: number;
  y: number;
  radius: number;
  delay: number;
  damage: number;
}

export class Game {
  public state: GameState = 'title';
  public elapsed = 0;
  public timeLeft: number = RUN.duration;

  public readonly store = new MonsterStore();
  public readonly hero: Hero;
  public readonly rng: Rng;

  /** 镜头中心（世界坐标）。始终朝勇者靠拢。 */
  public camX: number = HALL_CENTER.x;
  public camY: number = HALL_CENTER.y + 300;

  public hand: HandCard[] = [];
  public selected = -1;

  public peakStars = 0;
  public kills = 0;
  public detonations = 0;
  public score = 0;
  /** 特性触发计数：给冒烟测试断言用，也方便调平衡时看"这些卡到底有没有参与" */
  public statBoom = 0;
  public statHeal = 0;
  public statTaunt = 0;
  public statFreeze = 0;

  /** 权能叠层 */
  public starBonus = 0;
  public handBonus = 0;
  private atkStack = 0;
  private hpStack = 0;
  private atkSpeedStack = 0;
  private cdStack = 0;

  private detonateCd = 0;
  private powerupTimer: number = POWERUP.interval;
  private pendingPowerup: PowerupOption[] | null = null;
  /** 火球等延迟结算的 AoE */
  private readonly pendingAoe: PendingAoe[] = [];

  constructor(
    private readonly events: GameEvents,
    seed = 20261024,
  ) {
    this.rng = createRng(seed);
    this.hero = new Hero(this.rng);
    this.reset();
  }

  // ---------------------------------------------------------------- 生命周期

  public reset(): void {
    this.state = 'title';
    this.elapsed = 0;
    this.timeLeft = RUN.duration;
    this.store.reset();
    this.hero.reset();
    this.pendingAoe.length = 0;
    this.statBoom = 0;
    this.statHeal = 0;
    this.statTaunt = 0;
    this.statFreeze = 0;
    this.hand = STARTER_HAND.map((id) => ({
      id,
      defIdx: CARDS.findIndex((card) => card.id === id),
      star: findCard(id)?.startStar ?? 1,
      cd: 0,
    }));
    this.selected = -1;
    this.peakStars = 0;
    this.kills = 0;
    this.detonations = 0;
    this.score = 0;
    this.starBonus = 0;
    this.handBonus = 0;
    this.atkStack = 0;
    this.hpStack = 0;
    this.atkSpeedStack = 0;
    this.cdStack = 0;
    this.detonateCd = 0;
    this.powerupTimer = POWERUP.interval;
    this.pendingPowerup = null;
    this.camX = this.hero.x;
    this.camY = this.hero.y;
  }

  public start(): void {
    this.reset();
    this.state = 'playing';
  }

  /** 调试/冒烟测试用：把手牌换成全卡池，并放开星数预算。 */
  public debugFillHand(): void {
    this.hand = CARDS.map((card, defIdx) => ({
      id: card.id,
      defIdx,
      star: card.startStar,
      cd: 0,
    }));
    this.handBonus = 6;
    this.starBonus = 60;
  }

  public togglePause(): void {
    if (this.state === 'playing') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'playing';
  }

  // ---------------------------------------------------------------- 主循环

  public update(dt: number): void {
    if (this.state === 'playing') {
      this.step(dt);
    } else if (this.state === 'powerup') {
      // 权能选择期间世界几乎停滞：只保留镜头与呼吸
      this.stepCamera(dt, 0.6);
    }
  }

  private step(dt: number): void {
    this.elapsed += dt;
    this.timeLeft = Math.max(0, RUN.duration - this.elapsed);

    this.hero.update(dt, this.store, this.heroHooks);
    updateMonsters(this.store, this.hero, dt, {
      hitHero: (amount, slot) => this.damageHero(amount, slot),
      onRangedShot: (slot, fx, fy, tx, ty) => this.events.onRangedShot(slot, fx, fy, tx, ty),
      onExplode: (slot, x, y, radius, damage) => this.explodeAt(slot, x, y, radius, damage),
      onTelegraph: (x, y, radius, delay, damage) => {
        this.pendingAoe.push({ x, y, radius, delay, damage });
        this.events.onTelegraph(x, y, radius, delay);
      },
      onWarn: (x, y, radius, duration) => this.events.onTelegraph(x, y, radius, duration),
      onHeal: (slot, x, y) => this.healAround(slot, x, y),
      onSummon: (slot, x, y) => this.summonSkeleton(slot, x, y),
      onTaunt: (slot, seconds) => {
        this.statTaunt += 1;
        this.hero.taunt(slot, seconds);
        this.events.onEffect('taunt', this.hero.x, this.hero.y, 46);
      },
      onFrostHit: () => {
        if (this.hero.addFrostStack(2)) {
          this.statFreeze += 1;
          this.events.onEffect('freeze', this.hero.x, this.hero.y, 52);
          this.events.toast('他被冻住了', 'good');
        }
      },
      onExpire: (slot) => this.killMonster(slot, false),
    });

    this.updateAoe(dt);

    this.detonateCd = Math.max(0, this.detonateCd - dt);

    for (const card of this.hand) card.cd = Math.max(0, card.cd - dt);

    const occupied = this.store.occupiedStars();
    if (occupied > this.peakStars) this.peakStars = occupied;

    this.stepCamera(dt, 1);

    if (!this.hero.alive) {
      this.finish(true);
      return;
    }
    if (this.timeLeft <= 0) {
      this.finish(false);
      return;
    }

    this.powerupTimer -= dt;
    if (this.powerupTimer <= 0) {
      this.powerupTimer += POWERUP.interval;
      this.openPowerup();
    }
  }

  // ---------------------------------------------------------------- 魔物特性

  /** 自爆虫：对范围内的勇者造成伤害，自己已由调用方标记死亡。 */
  private explodeAt(slot: number, x: number, y: number, radius: number, damage: number): void {
    this.statBoom += 1;    this.events.onEffect('boom', x, y, radius);
    this.events.onDetonate(x, y, radius);
    const d = distance(x, y, this.hero.x, this.hero.y);
    if (d <= radius + HERO.radius) this.damageHero(damage, slot);
    else this.events.toast('自爆虫炸空了', 'info');
  }

  /** 巫医：治疗周围最多 3 只，按最大生命的 18%。 */
  private healAround(slot: number, x: number, y: number): void {
    const store = this.store;
    let healed = 0;    for (let i = 0; i < store.activeCount && healed < 3; i += 1) {
      const other = store.active[i];
      if (other === undefined || other === slot) continue;
      const d = distance(x, y, store.x[other] ?? 0, store.y[other] ?? 0);
      if (d > 180) continue;
      const maxHp = store.maxHp[other] ?? 0;
      const hp = store.hp[other] ?? 0;
      if (hp >= maxHp) continue;
      store.hp[other] = Math.min(maxHp, hp + maxHp * 0.18);
      healed += 1;
    }
    if (healed > 0) this.events.onEffect('heal', x, y, 96);
    this.statHeal += healed;
  }

  /** 骷髅将军：召一只 1★ 骷髅兵，不占星、10 秒崩解、不给经验。 */
  private summonSkeleton(slot: number, x: number, y: number): void {
    if (this.store.occupiedStars() >= this.starCap + 10) return;
    const defIndex = CARDS.findIndex((card) => card.id === 'skeleton');
    const def = CARDS[defIndex];
    if (!def) return;
    const phase = this.rng.next();
    const angle = this.rng.range(0, Math.PI * 2);
    const newSlot = this.store.spawn(
      def,
      defIndex,
      1,
      x + Math.cos(angle) * 34,
      y + Math.sin(angle) * 34,
      phase,
    );
    if (newSlot < 0) return;
    this.store.life[newSlot] = 10;
    this.store.refreshActive();
    this.events.onSpawn(newSlot);
  }

  /** 火球结算：预警时间到了才判定，绝不瞬间伤害。 */
  private updateAoe(dt: number): void {
    for (let i = this.pendingAoe.length - 1; i >= 0; i -= 1) {
      const aoe = this.pendingAoe[i];
      if (!aoe) continue;
      aoe.delay -= dt;
      if (aoe.delay > 0) continue;
      this.pendingAoe.splice(i, 1);
      this.events.onDetonate(aoe.x, aoe.y, aoe.radius);
      const d = distance(aoe.x, aoe.y, this.hero.x, this.hero.y);
      if (d <= aoe.radius + HERO.radius) this.damageHero(aoe.damage, -1);
    }
  }

  private stepCamera(dt: number, rate: number): void {
    const halfW = VIEW.w / 2;
    const halfH = VIEW.h / 2;
    const targetX = clamp(this.hero.x, halfW, WORLD.w - halfW);
    const targetY = clamp(this.hero.y, halfH, WORLD.h - halfH);
    this.camX = damp(this.camX, targetX, 8 * rate, dt);
    this.camY = damp(this.camY, targetY, 8 * rate, dt);
  }

  // ---------------------------------------------------------------- 召唤

  public get starCap(): number {
    return starCapAt(this.elapsed, this.starBonus);
  }

  public get occupiedStars(): number {
    return this.store.occupiedStars();
  }

  public selectCard(index: number): void {
    if (index < 0 || index >= this.hand.length) return;
    this.selected = this.selected === index ? -1 : index;
  }

  public cardReady(index: number): boolean {
    const card = this.hand[index];
    return card !== undefined && card.cd <= 0;
  }

  /** 返回不可召唤的原因；可以放则返回 null。 */
  public placementError(worldX: number, worldY: number): string | null {
    if (this.state !== 'playing') return '现在不能召唤';
    const card = this.hand[this.selected];
    if (!card) return '先选一张卡';
    if (card.cd > 0) return `冷却中 ${card.cd.toFixed(1)}s`;

    const def = CARDS[card.defIdx];
    if (!def) return '未知卡牌';

    const cost = card.star * summonCount(def, card.star);
    if (this.occupiedStars + cost > this.starCap) {
      return `星数已满 ${this.occupiedStars}/${this.starCap}`;
    }

    // 只能放在当前画面里 —— 魔王没有身体，他的范围就是他的视线
    const left = this.camX - VIEW.w / 2 + PLACE.screenEdge;
    const right = this.camX + VIEW.w / 2 - PLACE.screenEdge;
    const top = this.camY - VIEW.h / 2 + PLACE.screenEdge;
    const bottom = this.camY + VIEW.h / 2 - PLACE.screenEdge;
    if (worldX < left || worldX > right || worldY < top || worldY > bottom) return '超出视野';

    if (!inHall(worldX, worldY, 30)) return '超出大厅';
    if (distance(worldX, worldY, THRONE.x, THRONE.y) < THRONE.r + 20) return '王座台不可放置';
    for (const pillar of PILLARS) {
      if (distance(worldX, worldY, pillar.x, pillar.y) < pillar.r + 16) return '石柱上不可放置';
    }
    if (distance(worldX, worldY, this.hero.x, this.hero.y) < PLACE.minDistHero) return '离他太近了';

    return null;
  }

  /** 尝试召唤。成功返回 true。 */
  public place(worldX: number, worldY: number): boolean {
    const error = this.placementError(worldX, worldY);
    if (error) {
      this.events.toast(error, 'bad');
      return false;
    }
    const card = this.hand[this.selected];
    if (!card) return false;
    const def = CARDS[card.defIdx];
    if (!def) return false;

    const count = summonCount(def, card.star);
    const spread = count > 1 ? 26 : 0;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const slot = this.store.spawn(
        def,
        card.defIdx,
        card.star,
        worldX + Math.cos(angle) * spread,
        worldY + Math.sin(angle) * spread,
        this.rng.next() * Math.PI * 2,
      );
      if (slot < 0) break;
      this.applyStacks(slot);
      this.events.onSpawn(slot);
    }

    card.cd = cardCdSeconds(card.star) * Math.pow(1 - 0.08, this.cdStack);
    this.selected = -1;
    this.store.refreshActive();
    return true;
  }

  private applyStacks(slot: number): void {
    this.store.maxHp[slot] = (this.store.maxHp[slot] ?? 0) * (1 + 0.18 * this.hpStack);
    this.store.hp[slot] = this.store.maxHp[slot] ?? 0;
    this.store.atk[slot] = (this.store.atk[slot] ?? 0) * (1 + 0.14 * this.atkStack);
    this.store.atkInterval[slot] = (this.store.atkInterval[slot] ?? 1) / (1 + 0.1 * this.atkSpeedStack);
  }

  // ---------------------------------------------------------------- 引爆

  public tryDetonate(worldX: number, worldY: number): boolean {
    if (this.state !== 'playing') return false;
    if (this.detonateCd > 0) {
      this.events.toast('引爆还在冷却', 'bad');
      return false;
    }
    const slot = this.store.pickAt(worldX, worldY, 34);
    if (slot < 0) return false;

    const star = this.store.star[slot] ?? 1;
    const mx = this.store.x[slot] ?? 0;
    const my = this.store.y[slot] ?? 0;
    const damage = star * DETONATE.perStar;

    // 爆炸范围直接砸在勇者身上：这是"止损"而不是"输出"
    if (distance(mx, my, this.hero.x, this.hero.y) <= DETONATE.radius) {
      this.hero.takeDamage(damage, this.heroHooks);
    }

    this.store.kill(slot);
    this.store.refreshActive();
    this.detonations += 1;
    this.detonateCd = DETONATE.cd;
    this.hero.hunger = Math.min(DETONATE.hungerMax, this.hero.hunger + 1);
    this.events.onDetonate(mx, my, DETONATE.radius);
    this.events.onDeath(slot);
    this.events.toast('经验已阻断', 'good');
    return true;
  }

  // ---------------------------------------------------------------- 权能

  private openPowerup(): void {
    const pool = [...POWERUPS];
    const options: PowerupOption[] = [STAR_UPGRADE];
    for (let i = 0; i < 2 && pool.length > 0; i += 1) {
      const idx = Math.floor(this.rng.next() * pool.length);
      const picked = pool.splice(idx, 1)[0];
      if (picked) options.push(picked);
    }
    this.pendingPowerup = options;
    this.state = 'powerup';
    this.events.onPowerup(options);
  }

  public choosePowerup(optionId: string): void {
    const options = this.pendingPowerup;
    if (!options) return;
    const picked = options.find((option) => option.id === optionId);
    if (!picked) return;

    switch (picked.kind) {
      case 'atk':
        this.atkStack += 1;
        break;
      case 'hp':
        this.hpStack += 1;
        break;
      case 'atkspeed':
        this.atkSpeedStack += 1;
        break;
      case 'cd':
        this.cdStack += 1;
        break;
      case 'starcap':
        this.starBonus += picked.value;
        break;
      case 'hand':
        this.handBonus = Math.min(HAND_MAX_EXTRA, this.handBonus + 1);
        this.grantExtraCard();
        break;
      case 'star':
        this.upgradeRandomCard();
        break;
    }

    this.pendingPowerup = null;
    this.state = 'playing';
    this.events.toast(`获得权能：${picked.title}`, 'good');
  }

  /** 随机一张还没满星的手牌 +1 星。 */
  private upgradeRandomCard(): void {
    const candidates = this.hand.filter((card) => {
      const def = CARDS[card.defIdx];
      return def !== undefined && card.star < def.maxStar;
    });
    const picked = this.rng.pick(candidates);
    if (!picked) {
      this.handBonus = Math.min(HAND_MAX_EXTRA, this.handBonus + 1);
      this.grantExtraCard();
      return;
    }
    picked.star = Math.min(10, picked.star + 1);
    const def = CARDS[picked.defIdx];
    this.events.toast(`${def?.name ?? picked.id} 升到 ★${picked.star}`, 'good');
  }

  private grantExtraCard(): void {
    const owned = new Set(this.hand.map((card) => card.id));
    const pool = CARDS.filter((card) => !owned.has(card.id));
    const next = this.rng.pick(pool);
    if (!next) return;
    this.hand.push({
      id: next.id,
      defIdx: CARDS.findIndex((card) => card.id === next.id),
      star: next.startStar,
      cd: 0,
    });
  }

  // ---------------------------------------------------------------- 结算

  private finish(won: boolean): void {
    this.state = won ? 'won' : 'lost';
    this.score = Math.round(
      (won ? this.timeLeft * SCORE.perSecondLeft : 0) +
        this.peakStars * SCORE.perPeakStar +
        this.kills * SCORE.perKill,
    );
    this.events.onFinish(won);
  }

  // ---------------------------------------------------------------- 内部

  private damageHero(amount: number, slot: number): void {
    const star = this.store.star[slot] ?? 1;
    this.hero.takeDamage(amount * (1 + 0.05 * star), this.heroHooks);
  }

  private readonly heroHooks: HeroHooks = {
    hitMonster: (slot, damage, crit) => {
      const hp = (this.store.hp[slot] ?? 0) - damage;
      this.store.hp[slot] = hp;
      this.store.flash[slot] = 1;
      if (hp <= 0) this.killMonster(slot, true);
    },
    onQi: (x, y, dirX, dirY) => this.events.onQi(x, y, dirX, dirY),
    onSwing: () => this.events.onSwing(),
    onLevelUp: (level, passive) => {
      this.events.onHeroLevel(level, passive);
      this.events.toast(`锅巴 Lv${level} · ${passive}`, 'bad');
    },
    onHurt: (amount) => this.events.onHeroHurt(amount),
  };

  /** `byHero` 为 false 表示被引爆的（不给经验）。 */
  private killMonster(slot: number, byHero: boolean): void {
    const star = this.store.star[slot] ?? 1;
    this.store.kill(slot);
    this.store.refreshActive();
    this.events.onDeath(slot);
    if (!byHero) return;
    this.kills += 1;
    this.hero.addXp(star * XP.perStar, this.heroHooks);
  }

  public get handLimit(): number {
    return HAND_BASE + this.handBonus;
  }

  /** 调试 / 冒烟测试用：把下一次权能提前到 `seconds` 秒后。 */
  public deferPowerup(seconds: number): void {
    this.powerupTimer = seconds;
  }
}
