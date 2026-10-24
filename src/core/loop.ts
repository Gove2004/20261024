/**
 * 固定步长主循环。
 *
 * 逻辑永远以 1/60 秒为单位推进（物理与战斗的确定性来源），渲染按剩余时间做插值，
 * 因此高刷新率屏幕不会让游戏"跑得更快"，掉帧也不会让物理"穿透"。
 *
 * 一次 `requestAnimationFrame` 最多补 8 步（`maxSteps`），超出部分直接丢弃 ——
 * 这是防止切后台回来后"时间债"把整局瞬间推完的保险丝。
 */

/** 每个逻辑步的回调，`dt` 恒等于固定步长。 */
export type StepFn = (dt: number) => void;

/** 每个渲染帧的回调，`alpha` 是当前帧在两个逻辑步之间的插值系数（0–1）。 */
export type RenderFn = (alpha: number, frameDt: number) => void;

export class FixedStepLoop {
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;
  private paused = false;

  /** 便于调试/压测：临时改变时间流速（1 = 正常）。 */
  public timeScale = 1;

  constructor(
    private readonly onStep: StepFn,
    private readonly onRender: RenderFn,
    private readonly fixedDt: number = 1 / 60,
    private readonly maxSteps: number = 8,
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** 暂停时仍然渲染（画面不黑），但不推进逻辑。 */
  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    // 恢复时清空时间债，否则暂停期间的累积时间会一次性补完。
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  /** 手动推进一次逻辑（供测试与"跳过动画"使用）。 */
  public advance(steps: number): void {
    for (let i = 0; i < steps; i += 1) this.onStep(this.fixedDt);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    if (!this.paused) {
      this.accumulator += frameDt * this.timeScale;

      let steps = 0;
      while (this.accumulator >= this.fixedDt && steps < this.maxSteps) {
        this.onStep(this.fixedDt);
        this.accumulator -= this.fixedDt;
        steps += 1;
      }

      // 步数被截断（例如刚切回前台）：丢弃时间债，避免"追帧雪崩"。
      if (steps === this.maxSteps) this.accumulator = 0;
    }

    this.onRender(this.accumulator / this.fixedDt, frameDt);
  };
}
