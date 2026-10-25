/**
 * 程序化 BGM：步进音序器 + 三档强度层 + 侧链。
 *
 * 为什么单独一个模块：旧版音乐是把 4 小节循环硬塞在 engine 的同一个 playStep 里，
 * 想加"分幕"就得在音效代码中间插状态判断。这里把"曲子"和"音效"彻底分开：
 * 音乐只跟时间轴/强度走，音效只跟事件走，两边共用 SynthKit 的声部预算。
 *
 * 曲式：120 BPM、D 弗里几亚、16 分音符一格、4 小节（64 格）一循环 ≈ 8 秒。
 * 选小调 + 增二度（D–E♭）是因为它天生"不安"，正好是魔王殿大厅该有的味道；
 * 8 秒一循环足够短，玩家不会听出重复的接缝（整局 300 秒 = 37 圈）。
 *
 * 分幕（默认按 game.elapsed 自动切，也可由 engine 强制）：
 *   0：0–90s   平和   —— 低音 drone + 稀疏钟声 + 一条长音旋律
 *   1：90–210s 紧张   —— 加 8 分贝斯、底鼓、反拍踩镲、琶音、更密的旋律
 *   2：210s+   高潮   —— 加军鼓、16 分踩镲、琶音加倍、旋律升八度
 *
 * 所有时间都是 `AudioContext.currentTime` 的绝对秒数，由 engine 的 25ms 轮询
 * 提前 140ms 排期 —— 不用 setInterval 直接发声，所以主线程卡一下也不会掉拍。
 */

import type { SynthKit } from './synth';

const BPM = 120;
const STEPS_PER_BEAT = 4;
const STEPS_PER_BAR = 16;
const LOOP_BARS = 4;
const LOOP_STEPS = STEPS_PER_BAR * LOOP_BARS;

/** 16 分音符时值（秒）。120 BPM 下 = 0.125s。 */
const STEP_DUR = 60 / BPM / STEPS_PER_BEAT;

/** 预排视界。100–200ms 之间：太短会被主线程卡顿拖出空档，太长则暂停/切幕反应迟钝。 */
const LOOKAHEAD = 0.14;

/** D2。所有音高都从它按半音推。 */
const ROOT_HZ = 73.42;

/** 四小节的根音走向：D – B♭ – F – E♭（弗里几亚的经典下行）。 */
const BAR_ROOTS = [0, 8, 3, 1] as const;

/** 弗里几亚音阶（相对根音的半音数）。七级音用 10 而不是 11，是全曲"苦味"的来源。 */
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10] as const;

/** 琶音用的音级顺序（上行后回落，比纯上行更像"呼吸"）。 */
const ARP = [0, 3, 7, 8, 10, 8, 7, 3] as const;

/** 每个强度层可独立调音量的声部。 */
type LayerId =
  | 'drone'
  | 'pad'
  | 'bass'
  | 'kick'
  | 'hat'
  | 'snare'
  | 'arp'
  | 'lead'
  | 'bell'
  | 'heart'
  | 'fx';

type Mix = Readonly<Record<LayerId, number>>;

/**
 * 三个强度层的分层增益。
 *
 * 数值都 <1 且是**乘在**音乐总线（engine 里 0.16 ≈ −16dB）之前的：分层的意义是
 * "相对比例" —— 切幕时不能让总响度翻倍，否则音效立刻被埋掉。
 */
const MIX_CALM: Mix = {
  drone: 0.6,
  pad: 0.32,
  bass: 0,
  kick: 0.5,
  hat: 0,
  snare: 0,
  arp: 0,
  lead: 0.5,
  bell: 0.65,
  heart: 0.7,
  fx: 0.7,
};

const MIX_TENSE: Mix = {
  drone: 0.55,
  pad: 0.46,
  bass: 0.6,
  kick: 0.78,
  hat: 0.5,
  snare: 0,
  arp: 0.55,
  lead: 0.66,
  bell: 0.5,
  heart: 0.8,
  fx: 0.7,
};

const MIX_CLIMAX: Mix = {
  drone: 0.5,
  pad: 0.58,
  bass: 0.78,
  kick: 0.95,
  hat: 0.72,
  snare: 0.62,
  arp: 0.8,
  lead: 0.8,
  bell: 0.55,
  heart: 0.45,
  fx: 0.7,
};

const MIX: readonly Mix[] = [MIX_CALM, MIX_TENSE, MIX_CLIMAX];

/**
 * 旋律动机：每小节独立重复（小节根音不同，所以动机自动移调）。
 * 三元组 = [小节内第几格, 音级, 时值(格)]。
 */
const LEAD_CALM: readonly (readonly [number, number, number])[] = [
  [2, 4, 5],
  [10, 2, 4],
];

const LEAD_TENSE: readonly (readonly [number, number, number])[] = [
  [0, 0, 3],
  [3, 2, 2],
  [6, 3, 2],
  [10, 4, 4],
  [14, 2, 2],
];

const LEAD_CLIMAX: readonly (readonly [number, number, number])[] = [
  [0, 4, 2],
  [2, 5, 2],
  [4, 4, 2],
  [7, 6, 1],
  [8, 4, 2],
  [11, 5, 2],
  [13, 3, 3],
];

const LEAD: readonly (readonly (readonly [number, number, number])[])[] = [LEAD_CALM, LEAD_TENSE, LEAD_CLIMAX];

const semitone = (base: number, n: number): number => base * Math.pow(2, n / 12);

/** 音级 → 频率。音级会先对 7 取模，防止表写越界时算出离谱的音。 */
const degreeHz = (root: number, degree: number, octave: number): number => {
  const idx = ((degree % PHRYGIAN.length) + PHRYGIAN.length) % PHRYGIAN.length;
  return semitone(root, octave * 12 + (PHRYGIAN[idx] ?? 0));
};

export class MusicDirector {
  private readonly ctx: AudioContext;
  private readonly kit: SynthKit;
  private readonly duckGain: GainNode;
  private readonly fader: GainNode;
  private readonly layers: Record<LayerId, GainNode>;

  private step = 0;
  private nextNoteTime = 0;
  private tier = 0;
  private urgency = 0;
  private playing = false;
  private paused = false;
  private fading = false;

  /** `out` 是 engine 的音乐总线（暂停/静音/滤波都在那一侧）。 */
  public constructor(ctx: AudioContext, kit: SynthKit, out: AudioNode) {
    this.ctx = ctx;
    this.kit = kit;

    // 侧链（kick 一响就把整条音乐压一下）→ 淡出闸门 → 音乐总线。
    // 分两个节点是为了让"换幕淡出/结算淡出"和"底鼓侧链"互不打架：
    // 同一个 AudioParam 上跑两套自动化，cancelScheduledValues 会互相清掉。
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    this.fader = ctx.createGain();
    this.fader.gain.value = 1;
    this.duckGain.connect(this.fader);
    this.fader.connect(out);

    const layers = {} as Record<LayerId, GainNode>;
    const ids: readonly LayerId[] = [
      'drone',
      'pad',
      'bass',
      'kick',
      'hat',
      'snare',
      'arp',
      'lead',
      'bell',
      'heart',
      'fx',
    ];
    for (const id of ids) {
      const g = ctx.createGain();
      g.gain.value = MIX_CALM[id];
      g.connect(this.duckGain);
      layers[id] = g;
    }
    this.layers = layers;
  }

  public get running(): boolean {
    return this.playing && !this.paused && !this.fading;
  }

  /** 从 `now` 附近开始播（重置到循环开头，保证"开局第一拍"落在小节线上）。 */
  public start(now: number): void {
    this.playing = true;
    this.paused = false;
    this.fading = false;
    this.step = 0;
    this.nextNoteTime = now + 0.12;
    const t = this.ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(1, t);
  }

  public stop(): void {
    this.playing = false;
  }

  /** 结算淡出：已排期的音照常响，只是整条总线滑到静音，然后不再排新音。 */
  public fadeOut(seconds: number): void {
    if (!this.playing) return;
    this.fading = true;
    const t = this.ctx.currentTime;
    const g = this.fader.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + Math.max(0.2, seconds));
  }

  /** 下一局开始：把淡出过的总线推回 1，并从循环头重来。 */
  public restart(now: number): void {
    this.start(now);
  }

  /**
   * 切强度层。每帧被调用也可以 —— 只有真的变了才动节点。
   * 用 setTargetAtTime 而不是线性 ramp：指数逼近听感上更像"雾散开"，不会有台阶感。
   */
  public setTier(tier: number): void {
    const next = Math.max(0, Math.min(MIX.length - 1, Math.floor(tier)));
    if (next === this.tier) return;
    const prev = this.tier;
    this.tier = next;
    const mix = MIX[next] ?? MIX_CALM;
    const t = this.ctx.currentTime;
    for (const id of Object.keys(mix) as LayerId[]) {
      this.layers[id].gain.setTargetAtTime(mix[id], t, 0.35);
    }
    // 切幕要有一个"耳朵能抓到"的事件，否则玩家只觉得"好像变了"。
    // 上行噪声扫风 + 一声钟，比单纯调音量更能标记"换阶段了"。
    if (next > prev) {
      this.kit.noise({
        time: t + 0.05,
        dur: 1.4,
        gain: 0.1,
        dest: this.layers.fx,
        filter: 'bandpass',
        freq: 300,
        freqEnd: 4200,
        q: 1.2,
        attack: 0.5,
      });
      this.bell(t + 0.1, next === 2 ? 3 : 2);
    }
  }

  /**
   * 暂停：停掉"排练期"的解算（不再往前排音），恢复时把时钟重新锚到 now。
   * 音量侧的下压由 engine 的音乐总线负责 —— 这里不碰总线，避免和静音打架。
   */
  public setPaused(paused: boolean, now: number): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) this.nextNoteTime = now + 0.08;
  }

  /** 由 engine 每帧喂 0..1 的紧迫感（最后 60 秒爬升），心跳随之变重。 */
  public setUrgency(value: number): void {
    this.urgency = Math.max(0, Math.min(1, value));
  }

  /** 重音效时压一下音乐（侧链），让打击感顶出来。 */
  public duck(now: number, depth = 0.55, release = 0.3): void {
    const g = this.duckGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.min(1, g.value), now);
    g.linearRampToValueAtTime(depth, now + 0.02);
    g.linearRampToValueAtTime(1, now + Math.max(0.08, release));
  }

  /** 音序器的"泵"。由 engine 的 25ms 轮询驱动，`now` = AudioContext.currentTime。 */
  public tick(now: number): void {
    if (!this.playing || this.paused || this.fading) return;

    // 标签页切走再回来时 currentTime 会跳很远，不夹一下会一次性补上百个音
    if (this.nextNoteTime < now) this.nextNoteTime = now + 0.05;

    const horizon = now + LOOKAHEAD;
    // STEP_DUR 是常量且远大于 0，循环必然收敛；保险起见仍限制单次补排的上限，
    // 避免极端情况下（调试器断点、睡眠唤醒）一帧里 new 出上千个节点。
    let budget = 64;
    while (this.nextNoteTime < horizon && budget > 0) {
      this.playStep(this.step, this.nextNoteTime);
      this.step = (this.step + 1) % LOOP_STEPS;
      this.nextNoteTime += STEP_DUR;
      budget -= 1;
    }
  }

  private playStep(step: number, time: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const root = semitone(ROOT_HZ, BAR_ROOTS[bar] ?? 0);
    const tier = this.tier;

    // ── 铺底：drone + pad ──
    if (inBar === 0) {
      this.kit.tone({
        freq: root * 0.5,
        time,
        dur: 2.1,
        type: 'sawtooth',
        gain: 0.5,
        dest: this.layers.drone,
        attack: 0.25,
      });
    }
    // pad 每 2 小节换一次和声，起音很长：它是"空气"，不是旋律
    if (step % 32 === 0) {
      const chord = [0, 3, 7];
      for (let i = 0; i < chord.length; i += 1) {
        const f = semitone(root * 2, chord[i] ?? 0);
        this.kit.tone({
          freq: f,
          time,
          dur: 3.8,
          type: 'sawtooth',
          gain: 0.2,
          dest: this.layers.pad,
          attack: 0.9,
          detune: i === 1 ? -9 : 7,
        });
      }
    }

    // ── 节奏组 ──
    // 底鼓：层 0 只在双数小节给一记，其它层 1/3 拍都给
    const kickHere = tier === 0 ? inBar === 0 && bar % 2 === 0 : inBar === 0 || inBar === 8;
    if (kickHere) {
      this.kit.tone({
        freq: 130,
        time,
        dur: 0.17,
        type: 'sine',
        gain: 0.5,
        dest: this.layers.kick,
        glide: 44,
      });
      this.duckNow(time, 0.6, 0.19);
    }

    // 贝斯：8 分音符，每拍后半拍跳八度（老派的"蹦"）
    if (tier >= 1 && step % 4 === 0) {
      const octave = step % 8 === 4 ? 2 : 1;
      this.kit.tone({
        freq: root * octave,
        time,
        dur: 0.14,
        type: 'square',
        gain: 0.34,
        dest: this.layers.bass,
        glide: root * octave * 0.98,
      });
    }

    // 踩镲：层 1 只给反拍，层 2 补满 16 分（音量砍半，避免"沙沙"糊住旋律）
    if (tier >= 1 && step % 4 === 2) {
      this.kit.noise({
        time,
        dur: 0.05,
        gain: 0.16,
        dest: this.layers.hat,
        filter: 'highpass',
        freq: 7000,
      });
    }
    if (tier >= 2 && step % 2 === 1) {
      this.kit.noise({
        time,
        dur: 0.03,
        gain: 0.09,
        dest: this.layers.hat,
        filter: 'highpass',
        freq: 8200,
      });
    }

    // 军鼓：层 2 的 2、4 拍。噪声 + 一点 180Hz 的"桶身"，否则只有"嘶"没有"啪"
    if (tier >= 2 && (inBar === 4 || inBar === 12)) {
      this.kit.noise({
        time,
        dur: 0.13,
        gain: 0.24,
        dest: this.layers.snare,
        filter: 'bandpass',
        freq: 1900,
        q: 1.1,
      });
      this.kit.tone({
        freq: 184,
        time,
        dur: 0.08,
        type: 'triangle',
        gain: 0.12,
        dest: this.layers.snare,
        glide: 120,
      });
    }

    // ── 琶音 ──
    if (tier >= 1 && step % 2 === 0) {
      const degree = ARP[(step / 2) % ARP.length] ?? 0;
      this.kit.tone({
        freq: degreeHz(root, degree, 3),
        time,
        dur: 0.09,
        type: 'triangle',
        gain: 0.2,
        dest: this.layers.arp,
      });
    }
    // 层 2：高潮段给小节后半加一条高八度的"回声"，密度够了才像"打起来"
    if (tier >= 2 && step % 4 === 2) {
      const degree = ARP[(step / 2) % ARP.length] ?? 0;
      this.kit.tone({
        freq: degreeHz(root, degree, 4),
        time: time + 0.02,
        dur: 0.07,
        type: 'triangle',
        gain: 0.12,
        dest: this.layers.arp,
      });
    }

    // ── 旋律：固定动机，跟着小节根音移调 ──
    const motif = LEAD[tier] ?? LEAD_CALM;
    for (let i = 0; i < motif.length; i += 1) {
      const entry = motif[i];
      if (entry === undefined) continue;
      if (entry[0] !== inBar) continue;
      this.kit.tone({
        freq: degreeHz(root, entry[1], tier >= 2 ? 3 : 2),
        time,
        dur: entry[2] * STEP_DUR,
        type: tier >= 2 ? 'sawtooth' : 'triangle',
        gain: tier >= 2 ? 0.26 : 0.3,
        dest: this.layers.lead,
        attack: 0.02,
      });
    }

    // ── 钟：魔王殿的"远处在敲钟"，8 秒循环里 1–3 记（强度越高越密） ──
    if (step % 32 === 0) this.bell(time, 1);
    if (tier >= 2 && bar === 1 && inBar === 8) this.bell(time, 2);
    if (tier >= 1 && bar === 3 && inBar === 8) this.bell(time, 1);

    // ── 心跳：整曲的情绪底座，用 7 格（0.875s）的错位周期，避免和鼓点重合 ──
    if (step % 7 === 0) {
      const gain = 0.2 + this.urgency * 0.2;
      this.kit.tone({
        freq: 58,
        time,
        dur: 0.13,
        type: 'sine',
        gain,
        dest: this.layers.heart,
        glide: 36,
      });
      this.kit.tone({
        freq: 50,
        time: time + 0.145,
        dur: 0.16,
        type: 'sine',
        gain: gain * 0.72,
        dest: this.layers.heart,
        glide: 32,
      });
    }
  }

  /**
   * 钟：三个非谐分音（1 / 2.01 / 2.76）。
   * 纯正弦会像"提示音"，加上 2.76 倍那个不成谐的分音才有金属味 —— 这是钟声的物理特征。
   * `weight` 只是音量档位：换幕用 2–3，曲子里用 1。
   */
  private bell(time: number, weight: number): void {
    const level = Math.max(1, Math.min(3, weight));
    const base = semitone(ROOT_HZ, 12);
    const gain = 0.16 * (1 + (level - 1) * 0.25);
    this.kit.tone({
      freq: base,
      time,
      dur: 1.8 + level * 0.2,
      type: 'sine',
      gain,
      dest: this.layers.bell,
    });
    this.kit.tone({
      freq: base * 2.01,
      time,
      dur: 1.3,
      type: 'sine',
      gain: gain * 0.4,
      dest: this.layers.bell,
    });
    this.kit.tone({
      freq: base * 2.76,
      time,
      dur: 0.9,
      type: 'sine',
      gain: gain * 0.26,
      dest: this.layers.bell,
    });
    this.kit.noise({
      time,
      dur: 0.6,
      gain: 0.05 * level,
      dest: this.layers.bell,
      filter: 'bandpass',
      freq: 1500,
      q: 1.6,
    });
  }

  /** 侧链压缩：底鼓在**未来**的 `time` 上发声，所以也用绝对时间排自动化。 */
  private duckNow(time: number, depth: number, hold: number): void {
    const g = this.duckGain.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(depth, time + 0.012);
    g.linearRampToValueAtTime(1, time + hold);
  }
}
