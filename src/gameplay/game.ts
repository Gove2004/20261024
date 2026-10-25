import {
  HALL,
  HALL_CENTER,
  HERO,
  MONSTER_DMG_MUL,
  PILLARS,
  PLACE,
  POWERUP,
  POWERUP_WINDUP,
  RUN,
  SCORE,
  THRONE,
  VIEW,
  WORLD,
  XP,
  inHall,
  starCapAt,
} from '../content/config';
import { CARDS, CARD_LEVEL, CARD_STACK, CARD_UNLOCK, STARTER_HAND, cardCdSeconds, cardLevelMul, findCard, summonCount, unitStar } from '../content/cards';
import { SKILL_TUNING } from '../content/heroSkills';
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
  /** 距离下一层充能还要多久（秒）。**不再阻止放置**，只决定回充速度 */
  cd: number;
  /** 剩余可召唤次数（= 充能层数） */
  charges: number;
  maxCharges: number;
  /** 这张卡的等级：放得越多越强（见 CARD_LEVEL） */
  level: number;
  /** 0 = 现在就能用；>0 = 开局就在手牌里但被锁，到这个秒数解禁（v2.10） */
  unlockAt: number;
  xp: number;
}

export type PowerupKind = 'star' | 'charge' | 'hp' | 'atkspeed' | 'atk' | 'starcap' | 'heroSlow';

export interface PowerupOption {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  readonly kind: PowerupKind;
  readonly value: number;
}

/**
 * 手牌从 4 提到 6：卡池 5 张时 4 个格子意味着"这局我能玩到什么"太随机，
 * 6 格才够组出一个流派（坦克 + 输出 + 功能）。
 * 再往上给 2 格权能，上限 8 —— 再多人就只看手牌不看战场了。
 */
const HAND_BASE = 6;
const HAND_MAX_EXTRA = 2;

/**
 * 权能池。v2.5 按反馈**大幅合并**（11 → 6 条）：条目越多，玩家每次三选一
 * 都要重新理解一遍，决策成本超过信息量。现在每条要么直接改魔物数值，
 * 要么改"你能放多少"，没有重复的小加成。
 */
/**
 * 权能池 = **七宗罪**（v2.7）。
 *
 * 用户原话："全能就7个, 化用七宗罪"。之前是 6 条功能名（尖牙/厚壳/硬皮…），
 * 玩家记不住"厚壳和硬皮有什么区别"。七宗罪的好处是**每个人都已经认识这七个词**，
 * 于是记忆成本为零，只需要记"这一条改的是哪个数"。
 *
 * 数值都往上抬了一档：条目少了，每条就得更"够本"，否则三选一变成三选零。
 */
const POWERUPS: readonly PowerupOption[] = [
  { id: 'pride', title: '傲慢', desc: '指定一张手牌提升 1 星：该卡的血量、攻击、护甲同步提高，场上同类魔物一并受益。', kind: 'star', value: 1 },
  { id: 'greed', title: '贪婪', desc: '每张手牌立即回复 2 层充能，并永久提高其层数上限 2 层。', kind: 'charge', value: 2 },
  { id: 'gluttony', title: '暴食', desc: '场上与后续召唤的所有魔物最大生命 +28%。', kind: 'hp', value: 0.28 },
  { id: 'lust', title: '色欲', desc: '所有魔物攻击间隔缩短，等效攻速 +20%。', kind: 'atkspeed', value: 0.2 },
  { id: 'wrath', title: '暴怒', desc: '所有魔物攻击力 +28%。', kind: 'atk', value: 0.28 },
  { id: 'envy', title: '嫉妒', desc: '星数上限永久 +12（只抬上限，不补当前星数）。', kind: 'starcap', value: 12 },
  { id: 'sloth', title: '懒惰', desc: '锅巴移速 −12%、攻击间隔延长 10%，技能冷却相应增加。', kind: 'heroSlow', value: 0.12 },
];

/**
 * 升星永远出现在每轮三选一里：它是玩家"养大自己的东西"的唯一通道。
 *
 * 文案改过：旧版写「随机一张手牌 +1 星（最高 10★）」，玩家反馈"描述全是负面，
 * 根本不知道有啥用"—— 因为星数是"消耗"（占星数上限）却看不出收益。
 * 现在把**收益**写在最前面，并明确它会立刻作用于已放置的同类魔物。
 */


/** 渲染层/UI 需要监听的事件。游戏逻辑不直接碰 DOM 与 Pixi。 */
export interface GameEvents {
  onSpawn(slot: number): void;
  onDeath(slot: number): void;
  onHeroHurt(amount: number): void;
  /** 打中魔物的伤害数字（上帝视角里"谁在掉血"必须一眼看得出来） */
  onMonsterHit(x: number, y: number, amount: number, crit: boolean): void;
  /** 翻滚位移：渲染层要画残影/尘土，否则看起来就是"闪现"（用户原话） */
  onRoll(fromX: number, fromY: number, toX: number, toY: number): void;
  /** 技能名飘字：剑气 / 落雷 / 翻滚 / 干粮 */
  onSkillLabel(text: string, kind: 'qi' | 'bomb' | 'roll' | 'heal'): void;
  onHeroLevel(level: number, passive: string, passiveLevel?: number): void;
  /** 锅巴开弓射击（视觉：弹丸从弹弓飞出去） */
  onShot(x: number, y: number, dirX: number, dirY: number): void;
  onQi(x: number, y: number, dirX: number, dirY: number): void;
  onRangedShot(slot: number, fromX: number, fromY: number, toX: number, toY: number): void;
  /** 爆炸表现（自爆虫 / 火球），纯视觉 */
  onBlast(x: number, y: number, radius: number): void;
  /** 地面预警圈（火球/自爆），duration 秒后结算 */
  onTelegraph(x: number, y: number, radius: number, duration: number): void;
  /** 治疗/冰冻等即时表现 */
  onEffect(kind: 'heal' | 'freeze' | 'taunt' | 'boom' | 'summon', x: number, y: number, radius: number): void;
  toast(text: string, kind?: 'info' | 'good' | 'bad'): void;
  onPowerup(options: readonly PowerupOption[]): void;
  /** 权能预告（面板弹出前的前摇），HUD 用它出倒计时 */
  onPowerupWarning(seconds: number): void;
  /** 高级牌解锁（v2.8）：必须播报，否则玩家永远不知道有这张牌 */
  onCardUnlock(name: string, star: number, why: string): void;
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
  public placedTotal = 0;
  public score = 0;
  /** 特性触发计数：给冒烟测试断言用，也方便调平衡时看"这些卡到底有没有参与" */
  public statBoom = 0;
  /** 精英召唤次数（巨大蜘蛛） */
  public statSummon = 0;
  public statHeal = 0;
  /** 远程开火次数（毒蜘蛛），冒烟测试用 */
  public statRanged = 0;
  /** 勇者技能触发计数（M3）：看"这套技能池到底有没有在动" */
  public statQi = 0;
  public statShot = 0;
  public statBomb = 0;
  public statSelfHeal = 0;
  public statRoll = 0;

  /** 权能叠层 */
  public starBonus = 0;
  public handBonus = 0;
  private atkStack = 0;
  private hpStack = 0;
  private atkSpeedStack = 0;
  private cdStack = 0;
  private armorStack = 0;
  /** 攻速倍率（色欲叠层）：只影响魔物出手间隔，不影响移速 */
  private atkSpeedMul = 1;

  private powerupTimer: number = POWERUP.interval;
  /** 已解锁到第几张高级牌（CARD_UNLOCK 的下标） */
  private unlockIdx = 0;
  /** 权能前摇剩余秒数（>0 表示预告中，世界还在跑） */
  private powerupWindup = 0;
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
    this.statSummon = 0;
    this.statHeal = 0;
    this.statRanged = 0;
    this.statQi = 0;
    this.statShot = 0;
    this.statBomb = 0;
    this.statSelfHeal = 0;
    this.statRoll = 0;
    // v2.10：**五张卡一开始全在手牌里**，没到时间的显示为禁用 + 解锁倒计时。
    // 用户原话：「锅巴一开始就能看到所有魔物卡，只是被禁用的卡无法选择，并且能看到解锁倒计时」。
    // 好处很直接：玩家第一眼就知道"这局长什么样"，而不是打两分钟才发现还有别的卡。
    this.hand = CARDS.map((card, defIdx) => {
      const lock = CARD_UNLOCK.find((item) => item.id === card.id);
      const starter = STARTER_HAND.includes(card.id);
      return {
        id: card.id,
        defIdx,
        star: card.startStar,
        cd: 0,
        charges: CARD_STACK.charges,
        maxCharges: CARD_STACK.charges,
        level: 1,
        xp: 0,
        unlockAt: starter || lock === undefined ? 0 : lock.at,
      };
    });
    this.selected = -1;
    this.peakStars = 0;
    this.kills = 0;
    this.placedTotal = 0;
    this.score = 0;
    this.starBonus = 0;
    this.handBonus = 0;
    this.atkStack = 0;
    this.hpStack = 0;
    this.atkSpeedStack = 0;
    this.cdStack = 0;
    this.armorStack = 0;
    this.atkSpeedMul = 1;
    this.powerupTimer = POWERUP.interval;
    this.unlockIdx = 0;
    this.powerupWindup = 0;
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
      charges: CARD_STACK.charges,
      maxCharges: CARD_STACK.charges,
      level: 1,
      xp: 0,
      unlockAt: 0,
    }));
    this.handBonus = 6;
    this.starBonus = 60;
  }

  /** 调试/截图用：把全部手牌回满通量（免得脚本里逐张改） */
  public debugRefill(): void {
    for (const card of this.hand) {
      card.charges = card.maxCharges;
      card.cd = 0;
    }
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
      onRangedShot: (slot, fx, fy, tx, ty) => {
        this.statRanged += 1;
        this.events.onRangedShot(slot, fx, fy, tx, ty);
      },
      onExplode: (slot, x, y, radius, damage) => this.explodeAt(slot, x, y, radius, damage),
      onWarn: (x, y, radius, duration) => this.events.onTelegraph(x, y, radius, duration),
      onHeal: (slot, x, y) => this.healAround(slot, x, y),
      onSummon: (slot) => this.spawnMinions(slot),
      onExpire: (slot) => this.killMonster(slot, false),
    });

    this.updateAoe(dt);

    // 充能回填：**计时器一直在走，放置不会重置它**（v2.7 修的就是这条）。
    // 旧实现里 place() 会把 cd 顶回满值，于是"放得越快回得越慢"，
    // 玩家体感就是"明明有次数却永远在等"——这就是他说的卡手。
    for (const card of this.hand) {
      if (card.charges >= card.maxCharges) {
        // 满的时候计时归零：这样第一次放出去之后，第一个回填间隔是从此刻开始算的
        card.cd = 0;
        continue;
      }
      card.cd -= dt;
      if (card.cd > 0) continue;
      card.charges += 1;
      if (card.charges >= card.maxCharges) {
        card.cd = 0;
      } else {
        // 用 += 而不是 =：把这一帧多出来的时间带到下一次回填里，
        // 否则每补一层都会悄悄丢掉最多 1/60 秒，长局里累积成肉眼可见的"回得慢"。
        card.cd += this.cardCd(card.star);
      }
    }

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

    // 高级牌按时间线解锁（v2.10：全部卡一开始就在手牌里，只是"禁用 + 倒计时"）
    // 用户原话：「锅巴一开始就能看到所有魔物卡，只是被禁用的卡无法选择，并且能看到解锁倒计时」。
    // 所以这里不再"往手牌里塞卡"，而是把到点的卡**解禁**并给满层充能。
    const elapsed = RUN.duration - this.timeLeft;
    for (const card of this.hand) {
      if (card.unlockAt <= 0 || elapsed < card.unlockAt) continue;
      card.unlockAt = 0;
      card.charges = card.maxCharges;
      const def = CARDS[card.defIdx];
      if (def === undefined) continue;
      const step = CARD_UNLOCK.find((item) => item.id === def.id);
      this.handBonus = Math.min(HAND_MAX_EXTRA, this.handBonus + 1);
      this.events.onCardUnlock(def.name, def.startStar, step?.why ?? '');
    }

    // 权能前摇：世界照常跑，倒计时结束才真正暂停开面板
    if (this.powerupWindup > 0) {
      this.powerupWindup -= dt;
      if (this.powerupWindup <= 0) this.commitPowerup();
    }
  }

  // ---------------------------------------------------------------- 魔物特性

  /** 自爆虫：对范围内的勇者造成伤害，自己已由调用方标记死亡。 */
  private explodeAt(slot: number, x: number, y: number, radius: number, damage: number): void {
    this.statBoom += 1;
    this.events.onBlast(x, y, radius);
    const d = distance(x, y, this.hero.x, this.hero.y);
    if (d <= radius + HERO.radius) this.damageHero(damage, slot);
    else this.events.toast('自爆虫炸空了', 'info');
  }

  /** 巫医：治疗周围最多 3 只，按最大生命的 18%。 */
  /**
   * 巨大蜘蛛的召唤：在自身周围生 2 只小蜘蛛（1 星史莱姆的量级）。
   *
   * 小蜘蛛用的是 slime 的数值但贴蜘蛛的图 —— 它们不是"卡"，只是这个精英的持续压力，
   * 所以不记击杀奖励以外的任何东西，也不出现在手牌里。
   */
  private spawnMinions(slot: number): void {
    const store = this.store;
    // v2.10 修 bug：这里原来硬编码成 'slime'，于是"巨大蜘蛛生小蜘蛛"实际生的是史莱姆。
    // 小蜘蛛就是蜘蛛本人缩小版：血量 35%、速度 ×1.4，所以不用再建一张卡。
    const defIdx = CARDS.findIndex((card) => card.id === 'spider');
    const def = CARDS[defIdx];
    if (!def) return;
    const x = store.x[slot] ?? 0;
    const y = store.y[slot] ?? 0;
    for (let i = 0; i < 2; i += 1) {
      const angle = this.rng.next() * Math.PI * 2;
      const child = store.spawn(
        def,
        defIdx,
        1,
        x + Math.cos(angle) * 46,
        y + Math.sin(angle) * 46,
        this.rng.next() * Math.PI * 2,
      );
      if (child < 0) break;
      // 小蜘蛛：血量只有 35%，但会立刻扑上去。
      // v2.10 修严重 bug：之前子代复制了母体的特性/行为，于是**小蜘蛛还能再召唤**，
      // 一波变两波、两波变四波。这里强制把它们降级成"普通小怪"：
      // 没有特性（abi=0）、没有精英跳劈（beh=0）、半径减半（贴图随之缩小）。
      store.maxHp[child] = (store.maxHp[child] ?? 0) * 0.35;
      store.hp[child] = store.maxHp[child] ?? 0;
      store.speed[child] = (store.speed[child] ?? 90) * 1.4;
      store.abi[child] = 0;
      store.beh[child] = 0;
      store.abT[child] = 0;
      store.behT[child] = 0;
      store.radius[child] = (store.radius[child] ?? 30) * 0.5;
      this.applyStacks(child);
      this.placedTotal += 1;
      this.events.onSpawn(child);
    }
    this.statSummon += 1;
    this.events.onEffect('summon', x, y, 120);
  }

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
      this.events.onBlast(aoe.x, aoe.y, aoe.radius);
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

  /** 冷却缩减百分比（0-92）。HUD 左上角要显示，别让 UI 去碰私有叠层数。 */
  public get cdReductionPercent(): number {
    return Math.round((1 - Math.pow(1 - 0.08, this.cdStack)) * 100);
  }

  public selectCard(index: number): void {
    if (index < 0 || index >= this.hand.length) return;
    const card = this.hand[index];
    // v2.10：还没解锁的卡在手牌里可见但不可选；点了给一句倒计时，而不是默默没反应
    if (card !== undefined && card.unlockAt > 0) {
      const left = Math.ceil(card.unlockAt - (RUN.duration - this.timeLeft));
      this.events.toast(left > 0 ? `还有 ${left} 秒解锁` : '即将解锁', 'info');
      return;
    }
    this.selected = this.selected === index ? -1 : index;
  }

  public cardReady(index: number): boolean {
    // 只看「还有没有充能」：冷却不再拦住放置（见 CARD_STACK 注释）
    const card = this.hand[index];
    return card !== undefined && card.charges > 0;
  }

  /** 返回不可召唤的原因；可以放则返回 null。 */
  public placementError(worldX: number, worldY: number): string | null {
    if (this.state !== 'playing') return '现在不能召唤';
    const card = this.hand[this.selected];
    if (!card) return '先选一张卡';
    if (card.unlockAt > 0) return `${Math.ceil(card.unlockAt)} 秒后解锁`;
    if (card.charges <= 0) return `充能中 ${card.cd.toFixed(1)}s`;

    const def = CARDS[card.defIdx];
    if (!def) return '未知卡牌';

    const cost = card.star * summonCount(def);
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
    // 王座现在是纯装饰（r=0），中央让给魔法阵，所以不再有"不可放置"的死区
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

    const count = summonCount(def);
    const spread = count > 1 ? 26 : 0;
    const starForUnit = unitStar(def, card.star);
    const levelMul = cardLevelMul(card.level);
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const slot = this.store.spawn(
        def,
        card.defIdx,
        starForUnit,
        worldX + Math.cos(angle) * spread,
        worldY + Math.sin(angle) * spread,
        this.rng.next() * Math.PI * 2,
      );
      if (slot < 0) break;
      // 卡牌等级：同一张卡放得越多，召唤出来的基础属性越高。
      // 这是"前期两刀一只、后期一刀一只"的对冲项（见 cards.ts CARD_LEVEL）。
      this.store.maxHp[slot] = (this.store.maxHp[slot] ?? 0) * levelMul;
      this.store.hp[slot] = this.store.maxHp[slot] ?? 0;
      this.store.atk[slot] = (this.store.atk[slot] ?? 0) * levelMul;
      this.applyStacks(slot);
      this.placedTotal += 1;
      this.events.onSpawn(slot);
    }

    // 充能：放一次扣一层，**放置不进入冷却、也不重置回填计时**。
    // 用光之前可以连着放同一张卡；回填在 step() 里按固定节拍一直走。
    card.charges = Math.max(0, card.charges - 1);
    if (card.maxCharges > 0 && card.cd <= 0 && card.charges < card.maxCharges) {
      card.cd = this.cardCd(card.star);
    }
    this.gainCardXp(card, count);
    // v2.8 用户反馈「放置一张卡之后选中状态不消失, 直接点击地板还能放置」：
    // 以前放完就 `selected = -1`，玩家每放一只都得重新点一次卡 —— 这在"一口气砸 5 层"的
    // 次数制下就是纯浪费。现在**只要还剩层数就保持选中**，连点地面就是连续放置；
    // 层数用光才取消选中（此时选中也没有意义，还会让人以为"点了没反应"）。
    if (card.charges <= 0) this.selected = -1;
    this.store.refreshActive();
    return true;
  }

  /**
   * 卡牌经验：每放一只 +1。累计到阈值就升级，基础属性 +12%。
   *
   * 刻意做得"慢而稳"：一局大约能把常用的那张卡养到 4–5 级（+36%~+48%），
   * 足以让杂兵在后半程不再是纸片，但不会翻盘。
   */
  private gainCardXp(card: HandCard, count: number): void {
    card.xp += CARD_LEVEL.xpPerPlace * count;
    while (card.level < CARD_LEVEL.maxLevel && card.xp >= card.level * CARD_LEVEL.xpPerLevel) {
      card.level += 1;
      const def = CARDS[card.defIdx];
      this.events.toast(`${def?.name ?? card.id} 强化到 Lv.${card.level}`, 'good');
    }
  }

  private applyStacks(slot: number): void {
    this.store.maxHp[slot] = (this.store.maxHp[slot] ?? 0) * (1 + 0.18 * this.hpStack);
    this.store.hp[slot] = this.store.maxHp[slot] ?? 0;
    this.store.atk[slot] = (this.store.atk[slot] ?? 0) * (1 + 0.14 * this.atkStack);
    this.store.atkInterval[slot] = (this.store.atkInterval[slot] ?? 1) / (1 + 0.1 * this.atkSpeedStack);
    // 护甲是加法叠层：新召唤的怪也要吃到已经选过的权能
    this.store.armor[slot] = (this.store.armor[slot] ?? 0) + 2 * this.armorStack;
    this.store.atkInterval[slot] = (this.store.atkInterval[slot] ?? 1) / this.atkSpeedMul;
  }

  // ---------------------------------------------------------------- 权能

  /**
   * 这一轮权能的"额外效果"（v2.9）：星级上限提升、以及正好落在本节点的解锁。
   *
   * 用户原话：「对于每次星级上限提升和部分节点的新魔物解锁，以额外效果（紫色文字）
   * 追加到描述中」。这些事**不论选哪张卡都会发生**，所以必须写出来，
   * 否则玩家会以为"我选的这张卡才带来了 +5 星"。
   */
  public powerupExtras(): readonly string[] {
    const extras: string[] = [];
    const elapsed = RUN.duration - this.timeLeft;
    const capNow = starCapAt(elapsed, this.starBonus);
    const capBefore = starCapAt(Math.max(0, elapsed - POWERUP.interval), this.starBonus);
    const gain = capNow - capBefore;
    if (gain > 0) extras.push(`星级上限 +${gain}`);
    for (const step of CARD_UNLOCK) {
      // 只报"这一个节点"的解锁：错开一两秒也算，避免浮点误差漏掉
      if (Math.abs(step.at - elapsed) > 2) continue;
      const def = findCard(step.id);
      if (def === undefined) continue;
      if (this.hand.some((card) => card.id === def.id)) continue;
      extras.push(`解锁魔物 · ${def.name}`);
    }
    return extras;
  }

  private openPowerup(): void {
    // 七宗罪里抽 3 个，互不重复（v2.7）。以前是"升星固定 + 2 随机"，
    // 现在升星就是「傲慢」，和其他六条一样参与抽签 —— 池子永远只有 7 条。
    const pool = [...POWERUPS];
    const options: PowerupOption[] = [];
    for (let i = 0; i < 3 && pool.length > 0; i += 1) {
      const idx = Math.floor(this.rng.next() * pool.length);
      const picked = pool.splice(idx, 1)[0];
      if (picked) options.push(picked);
    }
    this.pendingPowerup = options;
    // 前摇：面板不是"啪"地弹出来的。
    // 玩家此时手正在场地上点召唤，突然盖一层三选一 → 手指/鼠标还按着就选中了最上面那张。
    // 所以先给 1.1 秒预告（世界照常跑，HUD 出倒计时），再停世界开面板。
    this.powerupWindup = POWERUP_WINDUP;
    this.events.onPowerupWarning(POWERUP_WINDUP);
  }

  /** 预告结束 → 真正暂停世界并开面板。 */
  private commitPowerup(): void {
    const options = this.pendingPowerup;
    if (!options) return;
    this.powerupWindup = 0;
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
        // 攻速走"间隔除法"：乘算叠加不会像加成那样越叠越没用，
        // 而且立刻重算场上已有的魔物，玩家能马上看到它们打得更密。
        this.atkSpeedMul *= 1 + picked.value;
        for (let i = 0; i < this.store.activeCount; i += 1) {
          const slot = this.store.active[i];
          if (slot === undefined) continue;
          this.store.atkInterval[slot] = (this.store.atkInterval[slot] ?? 1) / (1 + picked.value);
        }
        break;
      case 'charge':
        // 充能扩容：直接让每张牌能连放的次数变多，手感变化比数值更直观
        for (const card of this.hand) {
          card.maxCharges += picked.value;
          card.charges += picked.value;
        }
        break;
      case 'starcap':
        this.starBonus += picked.value;
        break;
      case 'star':
        this.upgradeRandomCard();
        break;
      case 'heroSlow':
        // 反向成长：只改他的移速与出手频率，"让对手变笨"比"让自己变强"更有实感
        this.hero.moveMul *= 1 - picked.value;
        this.hero.skillCdMul *= 1 + picked.value * 0.8;
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
      charges: CARD_STACK.charges,
      maxCharges: CARD_STACK.charges,
      level: 1,
      xp: 0,
      unlockAt: 0,
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
    this.hero.takeDamage(amount * (1 + 0.05 * star) * MONSTER_DMG_MUL, this.heroHooks);
    // 反伤：天赋给的"回敬"。放在这里是因为只有 game 知道打他的是哪一只。
    if (this.hero.thorns > 0 && slot >= 0 && this.store.alive[slot] === 1) {
      const back = amount * this.hero.thorns;
      const hp = (this.store.hp[slot] ?? 0) - back;
      this.store.hp[slot] = hp;
      this.store.flash[slot] = 1;
      if (hp <= 0) this.killMonster(slot, true);
    }
  }

  private readonly heroHooks: HeroHooks = {
    hitMonster: (slot, damage, crit) => {
      const hp = (this.store.hp[slot] ?? 0) - damage;
      this.store.hp[slot] = hp;
      this.store.flash[slot] = 1;
      this.events.onMonsterHit(this.store.x[slot] ?? 0, this.store.y[slot] ?? 0, damage, crit);
      if (hp <= 0) this.killMonster(slot, true);
    },
    onQi: (x, y, dirX, dirY) => {
      this.statQi += 1;
      this.events.onQi(x, y, dirX, dirY);
      this.events.onSkillLabel('剑气', 'qi');
    },
    onShot: (x, y, dirX, dirY) => {
      this.statShot += 1;
      this.events.onShot(x, y, dirX, dirY);
    },
    onBomb: (x, y, radius, damage) => {
      this.statBomb += 1;
      // 落点有预警，到点才炸 —— 玩家有时间把怪散开
      this.pendingAoe.push({ x, y, radius, damage, delay: SKILL_TUNING.bombDelay });
      this.events.onTelegraph(x, y, radius, SKILL_TUNING.bombDelay);
      this.events.onSkillLabel('落雷', 'bomb');
    },
    onHealSelf: (x, y, amount) => {
      this.statSelfHeal += 1;
      this.events.onEffect('heal', x, y, 70);
      this.events.onSkillLabel('干粮', 'heal');
      this.events.toast(`锅巴吃了干粮，回了 ${Math.round(amount)} 血`, 'bad');
    },
    onRoll: (fromX, fromY, toX, toY) => {
      this.statRoll += 1;
      this.events.onRoll(fromX, fromY, toX, toY);
      this.events.onSkillLabel('翻滚', 'roll');
    },
    onLevelUp: (level, passive, passiveLevel) => {
      this.events.onHeroLevel(level, passive, passiveLevel ?? 0);
      this.events.toast(`锅巴 Lv${level} · ${passive}`, 'bad');
    },
    onHurt: (amount) => this.events.onHeroHurt(amount),
  };

  /** `grantXp` 为 false 表示这只不算战果（召唤物到期的骷髅兵）。 */
  private killMonster(slot: number, grantXp: boolean): void {
    const star = this.store.star[slot] ?? 1;
    this.store.kill(slot);
    this.store.refreshActive();
    this.events.onDeath(slot);
    if (!grantXp) return;
    this.kills += 1;
    this.hero.onKill();
    this.hero.addXp(star * XP.perStar, this.heroHooks);
  }

  /** 单张卡的回充间隔：与旧版放完就冷却完全一致，叠加冷却缩减权能。 */
  private cardCd(star: number): number {
    return cardCdSeconds(star) * Math.pow(1 - 0.08, this.cdStack);
  }

  public get handLimit(): number {
    return HAND_BASE + this.handBonus;
  }

  /** 调试 / 冒烟测试用：把下一次权能提前到 `seconds` 秒后。 */
  public deferPowerup(seconds: number): void {
    this.powerupTimer = seconds;
  }
}
