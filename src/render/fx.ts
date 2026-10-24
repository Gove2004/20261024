import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Rng } from '../core/rng';

interface NumberFx {
  text: Text;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
}

interface BurstFx {
  gfx: Graphics;
  life: number;
  maxLife: number;
  startScale: number;
}

const NUMBER_POOL = 28;
const BURST_POOL = 20;

/**
 * 特效层：伤害飘字 + 粒子爆发。
 *
 * 全部走对象池 —— 战斗里每秒会产生几十次特效，
 * 每次 new 一个 Text/Graphics 会在移动端直接拉出 GC 卡顿。
 */
export class FxLayer {
  private readonly numbers: NumberFx[] = [];
  private readonly bursts: BurstFx[] = [];
  private numberCursor = 0;
  private burstCursor = 0;

  constructor(
    private readonly layer: Container,
    private readonly rng: Rng,
  ) {
    const style = new TextStyle({
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 20,
      fontWeight: '700',
      fill: 0xffffff,
      stroke: { color: 0x0b0a14, width: 4 },
    });

    for (let i = 0; i < NUMBER_POOL; i += 1) {
      const text = new Text({ text: '', style });
      text.anchor.set(0.5);
      text.visible = false;
      layer.addChild(text);
      this.numbers.push({ text, life: 0, maxLife: 1, vx: 0, vy: 0 });
    }

    for (let i = 0; i < BURST_POOL; i += 1) {
      const gfx = new Graphics();
      gfx.visible = false;
      layer.addChild(gfx);
      this.bursts.push({ gfx, life: 0, maxLife: 1, startScale: 1 });
    }
  }

  public damage(x: number, y: number, amount: number, crit: boolean): void {
    const fx = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % NUMBER_POOL;
    if (!fx) return;
    fx.text.text = String(Math.round(amount));
    fx.text.style.fontSize = crit ? 26 : 18;
    fx.text.style.fill = crit ? 0xffb347 : 0xffd9d9;
    fx.text.position.set(x + this.rng.range(-6, 6), y - 16);
    fx.text.alpha = 1;
    fx.text.scale.set(crit ? 1.2 : 1);
    fx.text.visible = true;
    fx.vx = this.rng.range(-18, 18);
    fx.vy = -52;
    fx.life = crit ? 0.7 : 0.55;
    fx.maxLife = fx.life;
  }

  /**
   * 锅巴被打的伤害飘字：红色、更大、往下沉一点。
   *
   * 和"打怪"的数字必须一眼分得清 —— 玩家在上帝视角看整场，
   * 分不清"谁在掉血"的飘字等于没做（用户原话「不然都不知道为啥」）。
   */
  public heroDamage(x: number, y: number, amount: number): void {
    const fx = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % NUMBER_POOL;
    if (!fx) return;
    fx.text.text = `-${Math.round(amount)}`;
    fx.text.style.fontSize = 24;
    fx.text.style.fill = 0xff6b7a;
    fx.text.position.set(x + this.rng.range(-8, 8), y - 34);
    fx.text.alpha = 1;
    fx.text.scale.set(1.25);
    fx.text.visible = true;
    fx.vx = this.rng.range(-26, 26);
    fx.vy = -78;
    fx.life = 0.8;
    fx.maxLife = fx.life;
  }

  /**
   * 技能名飘字：「剑气」「落雷」「翻滚」这类。
   *
   * 光有特效不够 —— 玩家不知道那一道白光是什么技能、为什么怪死了。
   * 技能名只在施放瞬间飘一次，频率远低于伤害数字，不会糊屏。
   */
  public label(x: number, y: number, text: string, color: number): void {
    const fx = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % NUMBER_POOL;
    if (!fx) return;
    fx.text.text = text;
    fx.text.style.fontSize = 22;
    fx.text.style.fill = color;
    fx.text.position.set(x, y - 58);
    fx.text.alpha = 1;
    fx.text.scale.set(1);
    fx.text.visible = true;
    fx.vx = 0;
    fx.vy = -34;
    fx.life = 0.9;
    fx.maxLife = 0.9;
  }

  /**
   * 粒子爆发：一次画完所有碎屑，之后只做缩放与淡出。
   *
   * `dirX/dirY` 可选：给了方向就变成**朝那个方向的溅射**（扇形 ±55°），
   * 不给就是均匀爆开。这是"打击感"里最便宜的一条 —— 同样的粒子数，
   * 有方向的看起来像"被他打飞了"，没方向的像"原地放了个烟花"。
   */
  public burst(
    x: number,
    y: number,
    color: number,
    count: number,
    radius = 26,
    dirX = 0,
    dirY = 0,
  ): void {
    const fx = this.bursts[this.burstCursor];
    this.burstCursor = (this.burstCursor + 1) % BURST_POOL;
    if (!fx) return;

    const directed = Math.abs(dirX) + Math.abs(dirY) > 0.001;
    const baseAngle = directed ? Math.atan2(dirY, dirX) : 0;
    const g = fx.gfx;
    g.clear();
    for (let i = 0; i < count; i += 1) {
      const angle = directed
        ? baseAngle + this.rng.range(-0.96, 0.96)
        : this.rng.next() * Math.PI * 2;
      // 有方向时距离分布更"贴边"：碎屑都堆在扇形外沿，看起来是被推出去的
      const dist = directed
        ? this.rng.range(radius * 0.45, radius)
        : this.rng.range(radius * 0.2, radius);
      const size = this.rng.range(1.6, 4.2);
      const px = Math.cos(angle) * dist;
      const py = Math.sin(angle) * dist;
      if (directed) {
        // 细长条：沿着飞行方向拉长，读起来就是"速度"
        g.roundRect(px - size * 1.6, py - size * 0.42, size * 3.2, size * 0.84, size * 0.42).fill({
          color,
          alpha: this.rng.range(0.5, 1),
          rotation: angle,
        });
      } else {
        g.circle(px, py, size).fill({ color, alpha: this.rng.range(0.5, 1) });
      }
    }
    g.position.set(x, y);
    g.scale.set(0.7);
    g.alpha = 1;
    g.visible = true;
    fx.life = 0.45;
    fx.maxLife = 0.45;
    fx.startScale = 1;
  }

  /** 冲击环：用于暴击、引爆、升级。 */
  public ring(x: number, y: number, radius: number, color: number, width = 4): void {
    const fx = this.bursts[this.burstCursor];
    this.burstCursor = (this.burstCursor + 1) % BURST_POOL;
    if (!fx) return;

    const g = fx.gfx;
    g.clear();
    g.circle(0, 0, radius).stroke({ color, width, alpha: 0.9 });
    g.position.set(x, y);
    g.scale.set(0.3);
    g.alpha = 1;
    g.visible = true;
    fx.life = 0.4;
    fx.maxLife = 0.4;
    fx.startScale = 1;
  }

  /** 剑气刀光：一条快速淡出的长条。 */
  public slash(x: number, y: number, dirX: number, dirY: number, length: number, width: number): void {
    const fx = this.bursts[this.burstCursor];
    this.burstCursor = (this.burstCursor + 1) % BURST_POOL;
    if (!fx) return;

    const g = fx.gfx;
    g.clear();
    // 剑气：外沿宽而淡、中轴细而亮。全是实心白条会被看成"一根白绳"（实测过）
    g.rect(width / 2, -width / 2, length, width).fill({ color: 0x8fb8d8, alpha: 0.32 });
    g.rect(width / 2, -1.6, length * 0.92, 3.2).fill({ color: 0xf2fbff, alpha: 0.85 });
    g.position.set(x, y);
    g.rotation = Math.atan2(dirY, dirX);
    g.alpha = 1;
    g.scale.set(1);
    g.visible = true;
    fx.life = 0.28;
    fx.maxLife = 0.28;
    fx.startScale = 1;
  }

  /**
   * 地面预警圈：`duration` 秒内从外圈收缩到内圈，收缩结束就是判定时刻。
   * 全体 AoE 都必须走这个（策划案 §5.9 反模式：不许无预兆的瞬间伤害）。
   */
  public telegraph(x: number, y: number, radius: number, duration: number): void {
    const fx = this.bursts[this.burstCursor];
    this.burstCursor = (this.burstCursor + 1) % BURST_POOL;
    if (!fx) return;

    const g = fx.gfx;
    g.clear();
    g.circle(0, 0, radius).fill({ color: 0xff3b5c, alpha: 0.14 });
    g.circle(0, 0, radius).stroke({ color: 0xff3b5c, width: 4, alpha: 0.85 });
    g.circle(0, 0, radius * 0.55).stroke({ color: 0xffb347, width: 2, alpha: 0.6 });
    g.position.set(x, y);
    g.scale.set(1);
    g.alpha = 1;
    g.visible = true;
    fx.life = duration;
    fx.maxLife = duration;
    fx.startScale = 1;
  }

  public update(dt: number): void {
    for (const fx of this.numbers) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.text.visible = false;
        continue;
      }
      fx.text.x += fx.vx * dt;
      fx.text.y += fx.vy * dt;
      fx.vy += 120 * dt;
      const t = fx.life / fx.maxLife;
      fx.text.alpha = Math.min(1, t * 2);
    }

    for (const fx of this.bursts) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.gfx.visible = false;
        continue;
      }
      const t = 1 - fx.life / fx.maxLife;
      fx.gfx.scale.set(0.7 + t * 1.1);
      fx.gfx.alpha = 1 - t;
    }
  }

  public clear(): void {
    for (const fx of this.numbers) {
      fx.life = 0;
      fx.text.visible = false;
    }
    for (const fx of this.bursts) {
      fx.life = 0;
      fx.gfx.visible = false;
    }
  }
}
