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
 */

import { RUN } from '../content/config';
import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import type { Game } from '../gameplay/game';

/** 同时发声的声部上限。超了就直接丢掉新音——宁可少一个音，也不要爆音卡顿。 */
const MAX_VOICES = 40;

/** 120 BPM，D 弗里几亚。16 分音符一格，4 小节一循环。 */
const BPM = 120;
const STEPS_PER_BEAT = 4;
const LOOP_STEPS = 64;

/** D2。所有音高都从它按半音推。 */
const ROOT_HZ = 73.42;

/** 四小节的根音走向：D – B♭ – F – E♭（弗里几亚的经典下行）。 */
const BAR_ROOTS = [0, 8, 3, 1] as const;

/** 琶音用的音级（相对高八度根音的半音数）。 */
const ARP = [0, 3, 7, 8, 10, 8, 7, 3] as const;

const semitone = (base: number, n: number): number => base * Math.pow(2, n / 12);

interface ToneOptions {
  readonly freq: number;
  readonly time: number;
  readonly dur: number;
  readonly type: OscillatorType;
  readonly gain: number;
  readonly dest: AudioNode;
  /** 有值时做指数滑音，用来做"下坠"的打击感。 */
  readonly glide?: number;
  readonly attack?: number;
}

interface NoiseOptions {
  readonly time: number;
  readonly dur: number;
  readonly gain: number;
  readonly dest: AudioNode;
  readonly filter: BiquadFilterType;
  readonly freq: number;
  readonly q?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private readonly rng: Rng = createRng(0xa0d10);

  private voices = 0;
  private intensity = 0;
  /** 低血量心跳节流 / 状态（见 update） */
  private dying = false;
  private nextBeat = 0;
  private step = 0;
  private nextNoteTime = 0;
  private timer: number | null = null;
  private muted = false;
  private paused = false;

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
    master.gain.value = 0.55;

    // 低通只挂音乐：强度越高开口越大，是"局势升温"最省事的听感信号
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;

    const music = ctx.createGain();
    music.gain.value = 0.42;

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.7;

    music.connect(filter);
    filter.connect(master);
    sfxBus.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
    this.music = music;
    this.sfxBus = sfxBus;
    this.filter = filter;

    // 已经处在用户手势里了，顺手 resume 一次：某些浏览器建出来的上下文是 suspended
    if (ctx.state === 'suspended') void ctx.resume();

    this.nextNoteTime = ctx.currentTime + 0.12;
    // 25ms 轮询 + 120ms 预排：用 setInterval 做粗调度，用 currentTime 做精确定时。
    // 直接在 setInterval 里 start() 会受主线程卡顿影响，听起来像掉拍。
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    const master = this.master;
    const ctx = this.ctx;
    if (master === null || ctx === null) return;
    master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.05);
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    const music = this.music;
    const ctx = this.ctx;
    if (music === null || ctx === null) return;
    music.gain.setTargetAtTime(paused ? 0.1 : 0.42, ctx.currentTime, 0.12);
  }

  public dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null) void ctx.close();
  }

  /** 每帧调用：把局面翻译成"音乐强度"和"紧迫感"。 */
  public update(game: Game): void {
    const ctx = this.ctx;
    const filter = this.filter;
    if (ctx === null || filter === null) return;

    // 星数多 = 场面热，锅巴等级高 = 你快输了，两者都该让音乐更满
    const starLoad = Math.min(1, game.peakStars / 40);
    const levelLoad = Math.min(1, (game.hero.level - 1) / 10);
    const level = Math.min(5, Math.floor((starLoad * 0.6 + levelLoad * 0.4) * 6));
    if (level !== this.intensity) {
      this.intensity = level;
      filter.frequency.setTargetAtTime(900 + level * 3200, ctx.currentTime, 0.8);
    }

    // 斩杀前的最后一段：他真的快死了 —— 心跳 + 音乐闷成"耳朵里的血"
    // （这是玩家最需要"知道自己快赢了"的时刻，只靠血条读不出来）
    const dying = game.hero.hpRatio <= 0.25;
    const now = ctx.currentTime;
    if (dying && !this.dying) {
      this.dying = true;
      filter.frequency.setTargetAtTime(1500, now, 0.6);
    } else if (!dying && this.dying) {
      this.dying = false;
      filter.frequency.setTargetAtTime(900 + this.intensity * 3200, now, 0.6);
    }
    if (dying && now >= this.nextBeat) {
      this.nextBeat = now + 0.62;
      this.sfxHeartbeat(now);
    }
  }

  /** 心跳：两个低频短促撞击，第二个稍弱 —— 生理上就是"咚·咚"。 */
  private sfxHeartbeat(t: number): void {
    const bus = this.sfxBus;
    if (bus === null) return;
    this.tone({ freq: 62, time: t, dur: 0.16, type: 'sine', gain: 0.3, dest: bus, glide: 40 });
    this.tone({ freq: 54, time: t + 0.2, dur: 0.14, type: 'sine', gain: 0.2, dest: bus, glide: 36 });
  }

  /**
   * 星级里程碑（20 / 40 / 60）：场面压过某个量级时给一次上扬音。
   * 玩家在上帝视角里很难用眼睛数星，声音是更可靠的"我这波铺大了"反馈。
   */
  public onStarMilestone(tier: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    const base = 220 * Math.pow(1.12, tier);
    this.tone({ freq: base, time: t, dur: 0.5, type: 'triangle', gain: 0.1, dest: bus, glide: base * 2.2 });
    this.noise({ time: t, dur: 0.4, gain: 0.08, dest: bus, filter: 'highpass', freq: 2600 });
  }

  /** 消费一帧里的事件。必须在 `clearEvents` 之前调用。 */
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

  /** 权能预告：一声低沉的"钟"，比面板本身早 1.1 秒，玩家有时间收手 */
  public onPowerupWarning(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.tone({ freq: 174, time: t, dur: 1.0, type: 'sine', gain: 0.12, dest: bus, glide: 168 });
    this.tone({ freq: 261, time: t + 0.02, dur: 0.8, type: 'triangle', gain: 0.06, dest: bus, glide: 258 });
  }
  public onCritHit(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.tone({ freq: 1480, time: t, dur: 0.1, type: 'square', gain: 0.07, dest: bus, glide: 2100 });
    this.noise({ time: t, dur: 0.06, gain: 0.06, dest: bus, filter: 'highpass', freq: 4200 });
  }
  public onDeath(): void {
    if (this.ctx === null) return;
    this.sfxDeath();
  }

  /** 锅巴被打。 */
  public onHeroHurt(): void {
    if (this.ctx === null) return;
    this.sfxMonsterHit();
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
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.noise({ time: t, dur: 0.22, gain: 0.12, dest: bus, filter: 'bandpass', freq: 3000, q: 2.2 });
    this.tone({ freq: 720, time: t, dur: 0.2, type: 'triangle', gain: 0.09, dest: bus, glide: 320 });
  }

  public onDetonate(): void {
    if (this.ctx === null) return;
    this.sfxDetonate();
  }

  public onFinish(won: boolean): void {
    if (this.ctx === null) return;
    this.sfxGameOver(won);
  }

  /** 权能面板打开时世界降到 0.15 倍速，音乐也跟着闷下去。 */
  public onPowerupOpen(): void {
    const ctx = this.ctx;
    const filter = this.filter;
    if (ctx === null || filter === null) return;
    filter.frequency.setTargetAtTime(600, ctx.currentTime, 0.15);
  }

  public onPowerupClose(): void {
    const ctx = this.ctx;
    const filter = this.filter;
    if (filter === null || ctx === null) return;
    filter.frequency.setTargetAtTime(900 + this.intensity * 3200, ctx.currentTime, 0.3);
  }

  // ── 调度 ──────────────────────────────────────────────

  private schedule(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const stepDur = 60 / BPM / STEPS_PER_BEAT;

    // 标签页切走再回来时 currentTime 会跳很远，不夹一下会一次性补上百个音
    if (this.nextNoteTime < ctx.currentTime) this.nextNoteTime = ctx.currentTime + 0.05;

    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextNoteTime);
      this.step = (this.step + 1) % LOOP_STEPS;
      this.nextNoteTime += stepDur;
    }
  }

  private playStep(step: number, time: number): void {
    const music = this.music;
    if (music === null) return;

    const bar = Math.floor(step / 16);
    const root = semitone(ROOT_HZ, BAR_ROOTS[bar] ?? 0);

    // 第 0 层：持续低音铺底，每小节换一次
    if (step % 16 === 0) {
      this.tone({
        freq: root * 0.5,
        time,
        dur: 2.1,
        type: 'sawtooth',
        gain: 0.1,
        dest: music,
        attack: 0.25,
      });
    }

    // 第 1 层：底鼓（1、3 拍）+ 侧链压缩，让音乐跟着"呼吸"
    if (step % 16 === 0 || step % 16 === 8) {
      this.tone({
        freq: 130,
        time,
        dur: 0.17,
        type: 'sine',
        gain: 0.5,
        dest: music,
        glide: 44,
      });
      this.duck(time);
    }

    // 第 2 层：8 分音符贝斯
    if (this.intensity >= 1 && step % 4 === 0) {
      const octave = step % 8 === 4 ? 2 : 1;
      this.tone({
        freq: root * octave,
        time,
        dur: 0.14,
        type: 'square',
        gain: 0.11,
        dest: music,
        glide: root * octave * 0.98,
      });
    }

    // 第 3 层：16 分琶音，场面热起来才出现
    if (this.intensity >= 3 && step % 2 === 0) {
      const degree = ARP[(step / 2) % ARP.length] ?? 0;
      this.tone({
        freq: semitone(root * 4, degree),
        time,
        dur: 0.09,
        type: 'triangle',
        gain: 0.05,
        dest: music,
      });
    }

    // 第 4 层：稀疏的高音刺，只在最紧张时冒头
    if (this.intensity >= 4 && (step % 32 === 0 || step % 32 === 20)) {
      this.tone({
        freq: semitone(root * 8, 0),
        time,
        dur: 0.42,
        type: 'sawtooth',
        gain: 0.055,
        dest: music,
        attack: 0.02,
      });
    }

    // 心跳：0.875 秒一次的双搏动（lub-dub），是整个游戏的情绪底座
    if (step % 7 === 0) {
      this.heartbeat(time);
    }
  }

  /** 侧链：底鼓一响就把音乐压下去，再放回来。 */
  private duck(time: number): void {
    const music = this.music;
    if (music === null) return;
    music.gain.cancelScheduledValues(time);
    music.gain.setValueAtTime(music.gain.value, time);
    music.gain.linearRampToValueAtTime(0.3, time + 0.012);
    music.gain.linearRampToValueAtTime(this.paused ? 0.1 : 0.42, time + 0.19);
  }

  private heartbeat(time: number): void {
    const music = this.music;
    if (music === null) return;
    // 剩下时间越少，心跳越重
    const urgency = this.urgency;
    const gain = 0.2 + urgency * 0.2;
    this.tone({ freq: 58, time, dur: 0.13, type: 'sine', gain, dest: music, glide: 36 });
    this.tone({ freq: 50, time: time + 0.145, dur: 0.16, type: 'sine', gain: gain * 0.72, dest: music, glide: 32 });
  }

  private urgency = 0;

  /** 由 update 之外单独喂：`boot` 每帧把剩余时间折算成 0..1。 */
  public setUrgency(value: number): void {
    this.urgency = Math.max(0, Math.min(1, value));
  }

  // ── 音效 ──────────────────────────────────────────────

  private sfxSummon(star: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    // 星越高，音越亮：玩家不看 UI 也能听出"这次放的怪更强"
    const base = 300 + star * 40;
    this.tone({ freq: base, time: t, dur: 0.12, type: 'triangle', gain: 0.16, dest: bus, glide: base * 1.6 });
    this.noise({ time: t, dur: 0.16, gain: 0.07, dest: bus, filter: 'bandpass', freq: 1400, q: 1.1 });
  }

  private sfxSwing(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    // 挥砍 = 一段快速扫频的带通噪声，比任何合成音都更像"刀风"
    this.noise({ time: ctx.currentTime, dur: 0.12, gain: 0.1, dest: bus, filter: 'bandpass', freq: 2200, q: 1.6 });
  }

  private sfxHeroHit(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.tone({ freq: 180, time: t, dur: 0.14, type: 'square', gain: 0.14, dest: bus, glide: 90 });
    this.noise({ time: t, dur: 0.1, gain: 0.08, dest: bus, filter: 'lowpass', freq: 800 });
  }

  private sfxMonsterHit(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    this.noise({ time: ctx.currentTime, dur: 0.07, gain: 0.06, dest: bus, filter: 'highpass', freq: 1800 });
  }

  private sfxDeath(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.tone({ freq: 260, time: t, dur: 0.26, type: 'sawtooth', gain: 0.09, dest: bus, glide: 60 });
  }

  private sfxLevelUp(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    // 纯四度上行：不协和但很"庄严"，符合"他变强了"的坏消息感
    this.tone({ freq: 392, time: t, dur: 0.18, type: 'triangle', gain: 0.13, dest: bus });
    this.tone({ freq: 523, time: t + 0.09, dur: 0.3, type: 'triangle', gain: 0.12, dest: bus });
  }

  private sfxDetonate(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    this.tone({ freq: 150, time: t, dur: 0.42, type: 'sine', gain: 0.34, dest: bus, glide: 32 });
    this.noise({ time: t, dur: 0.38, gain: 0.2, dest: bus, filter: 'lowpass', freq: 2400 });
  }

  private sfxGameOver(won: boolean): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (ctx === null || bus === null) return;
    const t = ctx.currentTime;
    if (won) {
      // 胜：小调转大调的三音上行
      const notes = [0, 4, 7, 12];
      for (let i = 0; i < notes.length; i += 1) {
        this.tone({
          freq: semitone(ROOT_HZ * 4, notes[i] ?? 0),
          time: t + i * 0.13,
          dur: 0.5,
          type: 'triangle',
          gain: 0.14,
          dest: bus,
        });
      }
    } else {
      // 负：一路下行到根音以下，配"倒计时归零"
      const notes = [0, -2, -5, -12];
      for (let i = 0; i < notes.length; i += 1) {
        this.tone({
          freq: semitone(ROOT_HZ * 2, notes[i] ?? 0),
          time: t + i * 0.19,
          dur: 0.7,
          type: 'sawtooth',
          gain: 0.13,
          dest: bus,
        });
      }
    }
  }

  // ── 底层音源 ──────────────────────────────────────────

  private claim(): boolean {
    if (this.voices >= MAX_VOICES) return false;
    this.voices += 1;
    return true;
  }

  private tone(opts: ToneOptions): void {
    const ctx = this.ctx;
    if (ctx === null || !this.claim()) return;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(1, opts.freq), opts.time);
    if (opts.glide !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.glide), opts.time + opts.dur);
    }

    // 指数包络不能到 0，用一个极小值代替，否则会抛异常
    const attack = opts.attack ?? 0.006;
    env.gain.setValueAtTime(0.0001, opts.time);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), opts.time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, opts.time + opts.dur);

    osc.connect(env);
    env.connect(opts.dest);
    osc.start(opts.time);
    osc.stop(opts.time + opts.dur + 0.02);
    osc.onended = (): void => {
      this.voices = Math.max(0, this.voices - 1);
      osc.disconnect();
      env.disconnect();
    };
  }

  private noise(opts: NoiseOptions): void {
    const ctx = this.ctx;
    if (ctx === null || !this.claim()) return;

    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);

    const band = ctx.createBiquadFilter();
    band.type = opts.filter;
    band.frequency.setValueAtTime(opts.freq, opts.time);
    band.Q.value = opts.q ?? 1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, opts.time);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), opts.time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, opts.time + opts.dur);

    src.connect(band);
    band.connect(env);
    env.connect(opts.dest);
    src.start(opts.time);
    src.stop(opts.time + opts.dur + 0.02);
    src.onended = (): void => {
      this.voices = Math.max(0, this.voices - 1);
      src.disconnect();
      band.disconnect();
      env.disconnect();
    };
  }

  /** 噪声源只生成一次、全局复用：每帧新建 AudioBuffer 会明显掉帧。 */
  private getNoise(ctx: AudioContext): AudioBuffer {
    const cached = this.noiseBuffer;
    if (cached !== null) return cached;

    const length = Math.floor(ctx.sampleRate * 1.2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // 用注入的 Rng 而不是 Math.random：项目约定随机数必须种子化，音色才可复现
    for (let i = 0; i < length; i += 1) data[i] = this.rng.range(-1, 1);

    this.noiseBuffer = buffer;
    return buffer;
  }
}
