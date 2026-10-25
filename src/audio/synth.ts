/**
 * 底层发声单元：一次性的振荡器 / 噪声 + 包络，以及全局"声部预算"。
 *
 * 为什么从 engine 里拆出来：BGM 音序器（music.ts）和音效要用同一套底层配方，
 * 而且**必须共享同一个声部计数** —— 两套独立的预算等于把上限翻倍，
 * 高潮段（音乐 6 层 + 连打音效）一定会削顶爆音。
 *
 * 这里的每个方法都是"排一个音到未来的某个时刻"，不自己做定时：
 * 定时由调用方用 `AudioContext.currentTime` 提前排期（见 engine 的 25ms 轮询）。
 * 用 setInterval 直接 start() 会受主线程卡顿影响，听起来像掉拍。
 */

import type { Rng } from '../core/rng';

/**
 * 同时发声的声部上限。
 *
 * 比旧值（40）高：BGM 分三层之后，高潮段单帧里可能同时挂着鼓、贝斯、琶音、
 * 主旋律和两三个音效。超了仍然直接丢掉新音 —— 宁可少一个音，也不要爆音。
 */
export const MAX_VOICES = 64;

export interface ToneOptions {
  readonly freq: number;
  readonly time: number;
  readonly dur: number;
  readonly type: OscillatorType;
  readonly gain: number;
  readonly dest: AudioNode;
  /** 有值时做指数滑音，用来做"下坠"或"上扬"的打击感。 */
  readonly glide?: number;
  /** 起音时间（秒）。默认 6ms：再短会有"咔"声，再长就没了打击感。 */
  readonly attack?: number;
  /** 失谐（音分）。两条锯齿 + 一点失谐 = 便宜的"合唱"厚度。 */
  readonly detune?: number;
}

export interface NoiseOptions {
  readonly time: number;
  readonly dur: number;
  readonly gain: number;
  readonly dest: AudioNode;
  readonly filter: BiquadFilterType;
  readonly freq: number;
  /** 有值时把滤波器从 freq 扫到 freqEnd —— 风声/破空的来源。 */
  readonly freqEnd?: number;
  readonly q?: number;
  readonly attack?: number;
}

export class SynthKit {
  private voices = 0;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly ctx: AudioContext;
  private readonly rng: Rng;

  public constructor(ctx: AudioContext, rng: Rng) {
    this.ctx = ctx;
    this.rng = rng;
  }

  /** 当前占用的声部数（调试/断言用）。 */
  public get activeVoices(): number {
    return this.voices;
  }

  public tone(opts: ToneOptions): void {
    if (!this.claim()) return;
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = opts.type;
    if (opts.detune !== undefined) osc.detune.setValueAtTime(opts.detune, opts.time);
    osc.frequency.setValueAtTime(Math.max(1, opts.freq), opts.time);
    if (opts.glide !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.glide), opts.time + opts.dur);
    }

    // 指数包络不能到 0，用一个极小值代替，否则 WebAudio 抛异常。
    // attack 夹在 dur 的一半以内：起音比时值还长时两条 ramp 会互相覆盖。
    const attack = Math.min(opts.dur * 0.5, opts.attack ?? 0.006);
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

  public noise(opts: NoiseOptions): void {
    if (!this.claim()) return;
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    // 循环 + 随机起点：既能让 2 秒长的钟声/风声一直有底噪可包络，
    // 又不会因为每次都从第 0 个样本起播而听出"同一段噪声"。
    src.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = opts.filter;
    band.frequency.setValueAtTime(Math.max(20, opts.freq), opts.time);
    if (opts.freqEnd !== undefined) {
      band.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), opts.time + opts.dur);
    }
    band.Q.value = opts.q ?? 1;

    const env = ctx.createGain();
    const attack = Math.min(opts.dur * 0.5, opts.attack ?? 0.006);
    env.gain.setValueAtTime(0.0001, opts.time);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), opts.time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, opts.time + opts.dur);

    src.connect(band);
    band.connect(env);
    env.connect(opts.dest);
    src.start(opts.time, this.rng.range(0, 1.2));
    src.stop(opts.time + opts.dur + 0.02);
    src.onended = (): void => {
      this.voices = Math.max(0, this.voices - 1);
      src.disconnect();
      band.disconnect();
      env.disconnect();
    };
  }

  private claim(): boolean {
    if (this.voices >= MAX_VOICES) return false;
    this.voices += 1;
    return true;
  }

  /** 噪声源只生成一次、全局复用：每次新建 AudioBuffer 会明显掉帧。 */
  private getNoise(ctx: AudioContext): AudioBuffer {
    const cached = this.noiseBuffer;
    if (cached !== null) return cached;

    // 2.5 秒：最长的一次是换幕钟声的底噪尾巴，短了会提前静音。
    const length = Math.floor(ctx.sampleRate * 2.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // 用注入的 Rng 而不是 Math.random：项目约定随机数必须种子化，音色才可复现
    for (let i = 0; i < length; i += 1) data[i] = this.rng.range(-1, 1);

    this.noiseBuffer = buffer;
    return buffer;
  }
}
