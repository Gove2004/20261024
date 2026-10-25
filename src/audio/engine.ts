/**
 * WebAudio 程序合成引擎。
 *
 * 策划案要求音乐音效 **100% 程序合成、零音频资源**，所以这里没有任何 mp3/ogg，
 * 全部是振荡器 + 噪声 + 包络。好处是包体极小、能随局面实时变化；代价是所有音色
 * 都得手调参数。
 *
 * 三条硬约束：
 * 1. **不能在模块顶层创建 AudioContext** —— 浏览器要求必须由用户手势触发，
 *    否则会建出一个永远 suspended 的上下文，表现为"整局没有声音且不报错"。
 * 2. 必须能在 Node 里安全 import（`npm test` / `npm run sim` 会加载到这条链路），
 *    所以所有入口都要先判 `typeof AudioContext === 'undefined'`。
 * 3. 随机数走注入的 `Rng`，不用裸 `Math.random()`（项目约定）。
 *
 * 分层：
 * - `synth.ts`  —— 一次性振荡器/噪声 + 全局声部预算（音乐与音效共用，防削顶）
 * - `music.ts`  —— 步进音序器 BGM（三档强度层、侧链、淡出）
 * - 本文件       —— 总线/生命周期/事件入口，即对外唯一的门面
 */

import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import type { Game } from '../gameplay/game';
import { MusicDirector } from './music';
import { SynthKit } from './synth';

/** 主音量。压缩器之前先留 6dB 余量：程序合成的瞬态峰值很容易削顶。 */
const MASTER_LEVEL = 0.55;

/** SFX 总线。比音乐高：音效是"信息"，信息必须永远听得清。 */
const SFX_LEVEL = 0.75;

/**
 * 音乐总线 ≈ −17.7dB（0.13）。
 *
 * 旧版是 0.42（≈−7.5dB），底鼓峰值 0.5×0.42×0.55 ≈ 0.115，比音效（0.16×0.7×0.55
 * ≈ 0.062）还响一倍 —— 这就是"打起来听不见音效"的根因。压低总线后音乐靠
 * **加层数**（pad/贝斯/琶音/钟）来变厚，而不是靠音量变大。
 *
 * 0.13 是实测算出来的：高潮层所有声部包络相加的峰值 ≈ 0.285/0.16×0.13 ≈ 0.23，
 * 仍低于最响的音效瞬态（引爆 0.34×0.75 = 0.255），音效永远压得住 BGM。
 */
const MUSIC_LEVEL = 0.13;

/** 暂停：音乐压到几乎听不见，但不归零 —— 留一点"世界还活着"的动静。 */
const MUSIC_PAUSED = 0.03;
/** 权能选择时保留低音量循环，比战斗更轻，给读卡留出空间。 */
const MUSIC_POWERUP = 0.045;

/** 分幕时间点（秒）：0–90 平和 / 90–210 紧张 / 210+ 高潮。 */
const TIER_TENSE_AT = 90;
const TIER_CLIMAX_AT = 210;

/** 普通命中的音效节流（秒）。同一帧里十几只怪互殴时，每个都发就成了噪声墙。 */
const HIT_SFX_GAP = 0.055;

const semitone = (base: number, n: number): number => base * Math.pow(2, n / 12);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  /** 底层发声单元：所有振荡器/噪声都从这里出，声部预算全局共用。 */
  private kit: SynthKit | null = null;
  /** BGM 音序器。ctx 建好之后才存在。 */
  private director: MusicDirector | null = null;

  private readonly rng: Rng = createRng(0xa0d10);

  private intensity = 0;
  /** 当前分幕（0/1/2）。只用来算音乐的滤波亮度。 */
  private tier = 0;
  /** 低血量心跳节流 / 状态（见 update） */
  private dying = false;
  private nextBeat = 0;
  private timer: number | null = null;
  private muted = false;
  /** >0 时由外部强制分幕（`setMusicIntensity`）；-1 = 按 elapsed 自动分幕。 */
  private tierOverride = -1;
  /** 已经淡出（结算）。用于"下一局开始"时自动把音乐推回来。 */
  private musicEnded = false;
  /** 上一次普通命中音的时间，用于节流。 */
  private lastHitAt = 0;

  /** 上下文建好了没有。没建好时所有 play/update 都是空操作。 */
  public get ready(): boolean {
    return this.ctx !== null;
  }

  /**
   * 由用户手势调用（点击开始、点击画布、按键）。
   *
   * 重复调用是安全的：已经建好就直接返回，另外顺手 resume 一次，
   * 因为标签页切回来之后上下文可能被浏览器挂起。
   */
  public unlock(): void {
    if (this.ctx !== null) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }

    const Ctor = typeof AudioContext === 'undefined' ? null : AudioContext;
    if (Ctor === null) return;

    const ctx = new Ctor();

    // 总线：music/sfx → master → 压缩器 → 输出。
    // 压缩器是必需品而不是装饰：程序合成的瞬态峰值很容易削顶爆音。
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;

    // 低通只挂音乐：强度越高开口越大，是"局势升温"最省事的听感信号
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;

    const music = ctx.createGain();
    music.gain.value = MUSIC_LEVEL;

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_LEVEL;

    music.connect(filter);
    filter.connect(master);
    sfxBus.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);

    const kit = new SynthKit(ctx, this.rng);
    const director = new MusicDirector(ctx, kit, music);

    this.ctx = ctx;
    this.master = master;
    this.music = music;
    this.sfxBus = sfxBus;
    this.filter = filter;
    this.kit = kit;
    this.director = director;

    // 已经处在用户手势里了，顺手 resume 一次：某些浏览器建出来的上下文是 suspended
    if (ctx.state === 'suspended') void ctx.resume();

    // BGM 一解锁就起：标题页点"开始"的那一下就是它进来的时机
    director.start(ctx.currentTime);
    this.musicEnded = false;

    // 25ms 轮询 + 140ms 预排：用 setInterval 做粗调度，用 currentTime 做精确定时。
    // 直接在 setInterval 里 start() 会受主线程卡顿影响，听起来像掉拍。
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    const master = this.master;
    const ctx = this.ctx;
    if (master === null || ctx === null) return;
    // 静音走 master，所以 BGM 和音效一起静音（"只关音效"会把 BGM 变成孤零零的底噪）
    master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.04);
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public setPaused(paused: boolean): void {
    this.setMusicPaused(paused, MUSIC_PAUSED);
  }

  /** 普通暂停停止排期；权能面板只降低总线，保持原有乐句连续循环。 */
  private setMusicPaused(paused: boolean, level: number): void {
    const music = this.music;
    const ctx = this.ctx;
    if (music === null || ctx === null) return;
    music.gain.setTargetAtTime(paused ? level : MUSIC_LEVEL, ctx.currentTime, 0.12);
    this.director?.setPaused(paused, ctx.currentTime);
  }

  public dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.director?.stop();
    this.director = null;
    this.kit = null;
    const ctx = this.ctx;
    // 先摘掉所有节点引用再关上下文：否则之后任何一次 setMuted/setPaused 都会
    // 对已经关闭的 AudioParam 排自动化（Chrome 下会抛 InvalidStateError）。
    this.ctx = null;
    this.master = null;
    this.music = null;
    this.sfxBus = null;
    this.filter = null;
    if (ctx !== null) void ctx.close();
  }

  // ── BGM 控制（供主循环/开局流程显式调用） ──────────────

  /** 起播 BGM。`unlock()` 里已经自动调用过一次；重开局/从暂停恢复可以再调。 */
  public startMusic(): void {
    const ctx = this.ctx;
    const director = this.director;
    if (ctx === null || director === null) return;
    this.musicEnded = false;
    director.restart(ctx.currentTime);
  }

  /** 停播（不淡出，立即停排期）。一般只在 dispose 前用。 */
  public stopMusic(): void {
    this.director?.stop();
  }

  /**
   * 强制分幕：0 平和 / 1 紧张 / 2 高潮；传 -1 交回"按 game.elapsed 自动分幕"。
   *
   * 给了这个方法是为了让装配层能按自己的节奏接（比如按波次而不是按秒），
   * 不调用时本文件会自己按 90s / 210s 切。
   */
  public setMusicIntensity(level: number): void {
    if (!Number.isFinite(level)) return;
    const next = Math.floor(level);
    this.tierOverride = Math.max(-1, Math.min(2, next));
    // -1 时不要在这里硬切到层 0：下一帧 update() 会按 elapsed 算出正确的那一层，
    // 否则"交回自动"会先被打回平和层、再跳上去，听感上像掉了一拍。
    if (this.tierOverride >= 0) this.director?.setTier(this.tierOverride);
  }

  /** 结算淡出：2–3 秒内把 BGM 收干净，给胜利/失败动机让路。 */
  public fadeOutMusic(seconds: number): void {
    const director = this.director;
    if (director === null) return;
    this.musicEnded = true;
    director.fadeOut(Math.max(0.2, seconds));
  }

  /** 每帧调用：把局面翻译成"音乐强度"和"紧迫感"。 */
  public update(game: Game): void {
    const ctx = this.ctx;
    const filter = this.filter;
    if (ctx === null || filter === null) return;

    const now = ctx.currentTime;
    const director = this.director;

    // 分幕：默认按局内时间走。用 elapsed 而不是墙钟，暂停时音乐阶段不会偷偷往前跑。
    const tier = this.tierOverride >= 0
      ? this.tierOverride
      : game.elapsed >= TIER_CLIMAX_AT
        ? 2
        : game.elapsed >= TIER_TENSE_AT
          ? 1
          : 0;
    if (tier !== this.tier) {
      this.tier = tier;
      // 换幕同时把音乐的"亮度"开一档：低通一直卡在 900Hz 的话，高潮段的踩镲和
      // 高八度琶音会被削得听不见，分幕就白做了。
      if (!this.dying) filter.frequency.setTargetAtTime(this.cutoff(), now, 0.8);
    }
    if (director !== null) director.setTier(tier);

    // 星数多 = 场面热，锅巴等级高 = 你快输了，两者都该让音乐更亮
    const starLoad = Math.min(1, game.peakStars / 40);
    const levelLoad = Math.min(1, (game.hero.level - 1) / 10);
    const level = Math.min(5, Math.floor((starLoad * 0.6 + levelLoad * 0.4) * 6));
    if (level !== this.intensity) {
      this.intensity = level;
      if (!this.dying) filter.frequency.setTargetAtTime(this.cutoff(), now, 0.8);
    }

    // 斩杀前的最后一段：他真的快死了 —— 心跳 + 音乐闷成"耳朵里的血"
    // （这是玩家最需要"知道自己快赢了"的时刻，只靠血条读不出来）
    const dying = game.hero.hpRatio <= 0.25;
    if (dying && !this.dying) {
      this.dying = true;
      filter.frequency.setTargetAtTime(1500, now, 0.6);
    } else if (!dying && this.dying) {
      this.dying = false;
      filter.frequency.setTargetAtTime(this.cutoff(), now, 0.6);
    }
    if (dying && now >= this.nextBeat) {
      this.nextBeat = now + 0.62;
      this.sfxHeartbeat(now);
    }

    // 结算淡出之后再开局：Game.start() 会把 elapsed 归零，用它当"新一局"的信号，
    // 这样装配层不需要为"重新开播 BGM"再加一条调用。
    if (this.musicEnded && director !== null && game.state === 'playing' && game.elapsed < 0.5) {
      this.musicEnded = false;
      director.restart(now);
    }
  }

  /** 由 index.ts 每帧喂 0..1 的紧迫感（最后 60 秒爬升），音乐心跳随之变重。 */
  public setUrgency(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.director?.setUrgency(v);
  }

  /** 音序器泵：只排期、不发声，真正的发声时刻交给 AudioContext 时钟。 */
  private tick(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    this.director?.tick(ctx.currentTime);
  }

  /** 音乐低通的目标截止频率：分幕给底，星数/等级给亮度。 */
  private cutoff(): number {
    return 900 + this.tier * 1400 + this.intensity * 2600;
  }

  /** 心跳音效（低血量）：两个低频短促撞击，第二个稍弱 —— 生理上就是"咚·咚"。 */
  private sfxHeartbeat(t: number): void {
    const kit = this.kit;
    const bus = this.sfxBus;
    if (kit === null || bus === null) return;
    kit.tone({ freq: 62, time: t, dur: 0.16, type: 'sine', gain: 0.3, dest: bus, glide: 40 });
    kit.tone({ freq: 54, time: t + 0.2, dur: 0.14, type: 'sine', gain: 0.2, dest: bus, glide: 36 });
  }

  /**
   * 星级里程碑（20 / 40 / 60）：场面压过某个量级时给一次上扬音。
   * 玩家在上帝视角里很难用眼睛数星，声音是更可靠的"我这波铺大了"反馈。
   */
  public onStarMilestone(tier: number): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    const base = 220 * Math.pow(1.12, tier);
    kit.tone({ freq: base, time: t, dur: 0.5, type: 'triangle', gain: 0.1, dest: bus, glide: base * 2.2 });
    kit.noise({ time: t, dur: 0.4, gain: 0.08, dest: bus, filter: 'highpass', freq: 2600 });
  }

  /** 消费一帧里的事件。当前所有事件都由装配层直连，这里保留为空实现。 */
  public consume(game: Game): void {
    if (this.ctx === null) return;
    void game;
  }

  // ── 事件入口 ──────────────────────────────────────────
  //
  // 由装配层把它接到 `GameEvents` 的回调上。每个方法都自己判空 ctx，
  // 所以音频没解锁时装配层可以照常无条件调用，不需要到处写 if。

  /** 召唤落点。星级越高音越亮，玩家不看 UI 也能听出这次放的怪更强。 */
  public onSpawn(star: number): void {
    if (this.ctx === null) return;
    this.sfxSummon(star);
  }

  /**
   * 大怪落地（精英/高星）：闷响 + 地面震动。
   * 和 `onSpawn` 的区别是"重量"：低频下潜到 34Hz、时长 0.55s，且按星级整体升 key。
   */
  public onSummonLarge(star: number): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    const s = Math.max(1, Math.min(8, Math.floor(star)));
    // 星级升 key（每个星级 +6%，8 星约 +42%）：同一套配方，强者听起来更"高更硬"
    const base = 92 * Math.pow(1.06, s);
    kit.tone({ freq: base, time: t, dur: 0.55, type: 'sine', gain: 0.3, dest: bus, glide: 34 });
    kit.noise({ time: t, dur: 0.45, gain: 0.18, dest: bus, filter: 'lowpass', freq: 620, freqEnd: 150, q: 0.9 });
    kit.tone({ freq: base * 2.01, time: t + 0.03, dur: 0.5, type: 'triangle', gain: 0.07, dest: bus, glide: base * 1.7 });
    this.director?.duck(t, 0.5, 0.32);
  }

  /**
   * 翻滚：破风声。
   * 旧版翻滚是"纯闪现"，没有任何反馈 —— 这是用户明确抱怨的点。
   * 配方是一条 380→2200Hz 的带通扫频噪声（风）加一记很轻的低频推挤（起步），
   * 落点再补一小撮高频沙（落地）。
   */
  public onRoll(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.noise({ time: t, dur: 0.3, gain: 0.12, dest: bus, filter: 'bandpass', freq: 380, freqEnd: 2200, q: 1.2 });
    kit.tone({ freq: 120, time: t, dur: 0.18, type: 'sine', gain: 0.09, dest: bus, glide: 60 });
    kit.noise({ time: t + 0.26, dur: 0.1, gain: 0.05, dest: bus, filter: 'highpass', freq: 3000 });
  }

  /** 权能预告：一声低沉的"钟"，比面板本身早 1.1 秒，玩家有时间收手 */
  public onPowerupWarning(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 174, time: t, dur: 1.0, type: 'sine', gain: 0.12, dest: bus, glide: 168 });
    kit.tone({ freq: 261, time: t + 0.02, dur: 0.8, type: 'triangle', gain: 0.06, dest: bus, glide: 258 });
  }

  public onCritHit(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 1480, time: t, dur: 0.1, type: 'square', gain: 0.07, dest: bus, glide: 2100 });
    kit.noise({ time: t, dur: 0.06, gain: 0.06, dest: bus, filter: 'highpass', freq: 4200 });
    this.director?.duck(t, 0.7, 0.18);
  }

  /**
   * 普通命中。会自己节流（55ms）：一帧里七八只怪互殴时，每个都发就成了噪声墙。
   * 只给一个很薄的"嗒"，重音还是留给暴击（onCritHit）。
   */
  public onMonsterHit(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    if (t - this.lastHitAt < HIT_SFX_GAP) return;
    this.lastHitAt = t;
    // 固定音高表轮换（不随机）：同一配方连续响也不会完全一样，且可复现
    const pitches = [1180, 1360, 1260, 1450] as const;
    const idx = Math.floor(t * 4) % pitches.length;
    kit.noise({ time: t, dur: 0.045, gain: 0.05, dest: bus, filter: 'bandpass', freq: pitches[idx] ?? 1200, q: 2.4 });
  }

  public onDeath(): void {
    if (this.ctx === null) return;
    this.sfxDeath();
  }

  /** 锅巴被打。用低频方波 + 闷噪声：这是"自己掉血"，必须比杂兵命中沉。 */
  public onHeroHurt(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 180, time: t, dur: 0.14, type: 'square', gain: 0.14, dest: bus, glide: 90 });
    kit.noise({ time: t, dur: 0.1, gain: 0.08, dest: bus, filter: 'lowpass', freq: 800 });
    this.director?.duck(t, 0.65, 0.2);
  }

  public onHeroLevel(): void {
    if (this.ctx === null) return;
    this.sfxLevelUp();
  }

  public onSwing(): void {
    if (this.ctx === null) return;
    this.sfxSwing();
  }

  /** 剑气：比普攻更亮更长，因为它是一条穿透的远程技。 */
  public onQi(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.noise({ time: t, dur: 0.22, gain: 0.12, dest: bus, filter: 'bandpass', freq: 3000, q: 2.2 });
    kit.tone({ freq: 720, time: t, dur: 0.2, type: 'triangle', gain: 0.09, dest: bus, glide: 320 });
  }

  public onDetonate(): void {
    if (this.ctx === null) return;
    this.sfxDetonate();
  }

  /** 结算。`won` 只是转发到 onVictory / onDefeat，所以装配层原本那行不用改。 */
  public onFinish(won: boolean): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    // 结算动机先落下，BGM 再平滑退场，避免双重淡出造成突然静音。
    this.fadeOutMusic(2.6);
    if (won) this.onVictory();
    else this.onDefeat();
  }

  /**
   * 胜利动机：D 大调味的五音上行 + 一记低音铺底，约 2 秒结束。
   * 用小调曲子结束在大三和弦上，是"胜利"最省字的写法。
   */
  public onVictory(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    const notes = [0, 7, 12, 16, 19] as const;
    for (let i = 0; i < notes.length; i += 1) {
      kit.tone({
        freq: semitone(293.66, notes[i] ?? 0),
        time: t + i * 0.15,
        dur: 0.45,
        type: 'triangle',
        gain: 0.12,
        dest: bus,
      });
    }
    // 低音铺底：把"结束"这件事压稳，同时避免短促动机听起来像 UI 提示音
    kit.tone({ freq: 146.83, time: t, dur: 1.9, type: 'sine', gain: 0.16, dest: bus, attack: 0.05 });
    kit.tone({ freq: 220, time: t + 0.3, dur: 1.6, type: 'triangle', gain: 0.07, dest: bus, attack: 0.2 });
    kit.noise({ time: t + 0.02, dur: 1.3, gain: 0.05, dest: bus, filter: 'highpass', freq: 4800 });
  }

  /**
   * 失败动机：半音下行 + 一记沉到底的 sub，约 2 秒结束。
   * 下行用锯齿（有泛音，像"远处关门"），sub 用正弦（没有泛音，像"胸腔被压住"）。
   */
  public onDefeat(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    const notes = [12, 8, 3, 0, -1] as const;
    for (let i = 0; i < notes.length; i += 1) {
      kit.tone({
        freq: semitone(146.83, notes[i] ?? 0),
        time: t + i * 0.22,
        dur: 0.7,
        type: 'sawtooth',
        gain: 0.1,
        dest: bus,
      });
    }
    kit.tone({ freq: 55, time: t + 0.9, dur: 1.1, type: 'sine', gain: 0.22, dest: bus, glide: 30 });
    kit.noise({ time: t + 0.9, dur: 1.0, gain: 0.06, dest: bus, filter: 'lowpass', freq: 420, freqEnd: 120 });
  }

  /**
   * 权能面板打开（三选一展开）：世界同时降到 0.15 倍速，音乐跟着闷下去，
   * 再上一组 D 小三和弦的**慢起音上扫** —— 长起音是"时间变慢"的听觉翻译。
   */
  public onPowerupOpen(): void {
    const ctx = this.ctx;
    const filter = this.filter;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || filter === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    this.music?.gain.setTargetAtTime(MUSIC_POWERUP, t, 0.15);
    filter.frequency.setTargetAtTime(600, t, 0.15);

    const chord = [0, 3, 7, 12] as const;
    for (let i = 0; i < chord.length; i += 1) {
      kit.tone({
        freq: semitone(293.66, chord[i] ?? 0),
        time: t + i * 0.055,
        dur: 2.4,
        type: 'triangle',
        gain: 0.1,
        dest: bus,
        attack: 0.3,
      });
    }
    // 高频微光：让"展开"有一点点金属空气感，不至于是一块闷和弦
    kit.noise({ time: t + 0.05, dur: 1.6, gain: 0.05, dest: bus, filter: 'highpass', freq: 4200 });
  }

  /**
   * 权能确认（点某一张）：纯五度上行 + 一点高频"咔"，0.5 秒内结束。
   * 和 `onPowerupOpen` 的长和弦必须拉开差别，否则玩家分不清"打开了"和"选好了"。
   */
  public onPowerupChoose(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 523.25, time: t, dur: 0.12, type: 'triangle', gain: 0.13, dest: bus });
    kit.tone({ freq: 783.99, time: t + 0.07, dur: 0.3, type: 'triangle', gain: 0.11, dest: bus });
    kit.noise({ time: t, dur: 0.05, gain: 0.05, dest: bus, filter: 'highpass', freq: 5200 });
  }

  public onPowerupClose(): void {
    const ctx = this.ctx;
    const filter = this.filter;
    if (filter === null || ctx === null) return;
    const t = ctx.currentTime;
    filter.frequency.setTargetAtTime(this.cutoff(), t, 0.3);
    this.music?.gain.setTargetAtTime(MUSIC_LEVEL, t, 0.3);
  }

  /**
   * 换幕（每 30 秒）：一记低钟，波次越靠后音越高（每幕 +1 半音）。
   * 选低钟而不是号角，是因为"魔王殿"的氛围里号角太英雄，钟只是"又过了一段"。
   */
  public onWaveStart(wave = 1): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    const idx = Math.max(0, Math.min(4, Math.floor(wave) - 1));
    const base = semitone(87.31, idx);
    kit.tone({ freq: base, time: t, dur: 2.2, type: 'sine', gain: 0.16, dest: bus });
    kit.tone({ freq: base * 2.01, time: t, dur: 1.5, type: 'sine', gain: 0.07, dest: bus });
    kit.tone({ freq: base * 2.76, time: t, dur: 1.0, type: 'sine', gain: 0.05, dest: bus });
    kit.noise({ time: t, dur: 0.9, gain: 0.05, dest: bus, filter: 'bandpass', freq: 1100, q: 1.3 });
  }

  /** UI 点击（按钮/卡牌）。极短、极轻，只为"按到了"这点反馈。 */
  public onUiClick(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 1046.5, time: t, dur: 0.035, type: 'square', gain: 0.05, dest: bus });
    kit.tone({ freq: 1568, time: t + 0.02, dur: 0.05, type: 'triangle', gain: 0.04, dest: bus });
  }

  // ── 音效配方 ──────────────────────────────────────────

  private sfxSummon(star: number): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    // 星越高，音越亮：玩家不看 UI 也能听出"这次放的怪更强"
    const base = 300 + star * 40;
    kit.tone({ freq: base, time: t, dur: 0.12, type: 'triangle', gain: 0.16, dest: bus, glide: base * 1.6 });
    kit.noise({ time: t, dur: 0.16, gain: 0.07, dest: bus, filter: 'bandpass', freq: 1400, q: 1.1 });
  }

  private sfxSwing(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    // 挥砍 = 一段快速扫频的带通噪声，比任何合成音都更像"刀风"
    kit.noise({ time: ctx.currentTime, dur: 0.12, gain: 0.1, dest: bus, filter: 'bandpass', freq: 2200, q: 1.6 });
  }

  private sfxDeath(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 260, time: t, dur: 0.26, type: 'sawtooth', gain: 0.09, dest: bus, glide: 60 });
  }

  private sfxLevelUp(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    // 纯四度上行：不协和但很"庄严"，符合"他变强了"的坏消息感
    kit.tone({ freq: 392, time: t, dur: 0.18, type: 'triangle', gain: 0.13, dest: bus });
    kit.tone({ freq: 523, time: t + 0.09, dur: 0.3, type: 'triangle', gain: 0.12, dest: bus });
  }

  private sfxDetonate(): void {
    const ctx = this.ctx;
    const kit = this.kit;
    const bus = this.sfxBus;
    if (ctx === null || kit === null || bus === null) return;
    const t = ctx.currentTime;
    kit.tone({ freq: 150, time: t, dur: 0.42, type: 'sine', gain: 0.34, dest: bus, glide: 32 });
    kit.noise({ time: t, dur: 0.38, gain: 0.2, dest: bus, filter: 'lowpass', freq: 2400 });
    this.director?.duck(t, 0.45, 0.34);
  }
}
