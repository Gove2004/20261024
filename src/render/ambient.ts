import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { HALL, HALL_WALL } from '../content/config';
import type { Rng } from '../core/rng';

/**
 * 环境粒子：浮尘 + 火盆余烬。
 *
 * 为什么不走 FxLayer：FxLayer 是"战斗反馈"，用对象池 + 生命周期管理；
 * 环境粒子是**永续**的，每帧都要动，用固定数量的 Sprite 反过来更省 ——
 * 每个粒子就是一个 sprite 的位置/透明度写入，没有生成销毁，也没有 Graphics 重建。
 *
 * 贴图用 renderer.generateTexture 现烤一个小圆点：几十个粒子共用一张 16×16，
 * 软件渲染下比每帧画 arc 便宜得多。
 */
const DUST_COUNT = 34;
const EMBER_COUNT = 26;

interface Mote {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  speed: number;
}

export class Ambient {
  private readonly dust: Mote[] = [];
  private readonly embers: Mote[] = [];
  private time = 0;
  private readonly dustTexture: Texture;
  private readonly emberTexture: Texture;
  private readonly layer: Container;

  constructor(
    parent: Container,
    private readonly makeTexture: (color: number, radius: number) => Texture,
    private readonly rng: Rng,
  ) {
    this.layer = new Container();
    this.layer.eventMode = 'none';
    parent.addChild(this.layer);

    this.dustTexture = makeTexture(0xd9cdf0, 3);
    this.emberTexture = makeTexture(0xffa04a, 3);

    for (let i = 0; i < DUST_COUNT; i += 1) {
      const sprite = new Sprite(this.dustTexture);
      sprite.anchor.set(0.5);
      sprite.alpha = 0.1 + rng.next() * 0.12;
      this.layer.addChild(sprite);
      this.dust.push(this.spawn(sprite, 'dust'));
    }
    for (let i = 0; i < EMBER_COUNT; i += 1) {
      const sprite = new Sprite(this.emberTexture);
      sprite.anchor.set(0.5);
      sprite.alpha = 0.5 + rng.next() * 0.4;
      this.layer.addChild(sprite);
      this.embers.push(this.spawn(sprite, 'ember'));
    }
  }

  private spawn(sprite: Sprite, kind: 'dust' | 'ember'): Mote {
    const x = HALL.left + this.rng.next() * (HALL.right - HALL.left);
    const y = HALL.top + this.rng.next() * (HALL.bottom - HALL.top);
    const mote: Mote = {
      sprite,
      x,
      y,
      vx: 0,
      vy: 0,
      phase: this.rng.next() * Math.PI * 2,
      speed: 0.6 + this.rng.next() * 0.8,
    };
    if (kind === 'dust') {
      mote.vx = (this.rng.next() - 0.5) * 14;
      mote.vy = (this.rng.next() - 0.5) * 10;
    } else {
      // 余烬从四角火盆升起，之后自由上飘
      const corner = Math.floor(this.rng.next() * 4);
      mote.x = (corner % 2 === 0 ? HALL.left + 90 : HALL.right - 90) + (this.rng.next() - 0.5) * 54;
      mote.y = (corner < 2 ? HALL.top + 90 : HALL.bottom - 90) + (this.rng.next() - 0.5) * 40;
      mote.vx = (this.rng.next() - 0.5) * 16;
      mote.vy = -16 - this.rng.next() * 22;
    }
    sprite.position.set(mote.x, mote.y);
    return mote;
  }

  public update(dt: number): void {
    this.time += dt;

    for (const mote of this.dust) {
      mote.x += mote.vx * dt;
      mote.y += mote.vy * dt;
      // 缓慢绕流：纯直线会显得像"雪花屏"
      const swirl = Math.sin(this.time * 0.6 + mote.phase) * 6 * dt;
      mote.x += swirl;
      if (mote.x < HALL.left - 20) mote.x = HALL.right + 20;
      if (mote.x > HALL.right + 20) mote.x = HALL.left - 20;
      if (mote.y < HALL.top - 20) mote.y = HALL.bottom + 20;
      if (mote.y > HALL.bottom + 20) mote.y = HALL.top - 20;
      mote.sprite.position.set(mote.x, mote.y);
      mote.sprite.alpha = 0.07 + Math.abs(Math.sin(this.time * 0.8 + mote.phase)) * 0.12;
    }

    for (const mote of this.embers) {
      mote.x += (mote.vx + Math.sin(this.time * 1.7 + mote.phase) * 10) * dt;
      mote.y += mote.vy * dt;
      mote.vy -= 4 * dt;
      // 升到一半就淡出并重新点火，比"飘满全屏"克制
      const progress = Math.min(1, (this.time * 0.5 + mote.phase) % 1);
      mote.sprite.alpha = Math.max(0, 0.7 * (1 - progress)) * (0.6 + 0.4 * Math.sin(this.time * 6 + mote.phase));
      mote.sprite.position.set(mote.x, mote.y);
      if (mote.vy < -46 || progress > 0.985) {
        const corner = Math.floor(this.rng.next() * 4);
        mote.x = (corner % 2 === 0 ? HALL.left + 90 : HALL.right - 90) + (this.rng.next() - 0.5) * 54;
        mote.y = (corner < 2 ? HALL.top + 90 : HALL.bottom - 90) + (this.rng.next() - 0.5) * 40;
        mote.vx = (this.rng.next() - 0.5) * 16;
        mote.vy = -16 - this.rng.next() * 22;
        mote.phase = this.rng.next() * Math.PI * 2;
      }
    }
  }

  /** 墙外的暗角：压边让视线回到大厅中央，不额外增加绘制对象。 */
  public static buildVignette(): Graphics {
    const g = new Graphics();
    const pad = 220;
    g.roundRect(
      HALL.left - HALL_WALL - pad,
      HALL.top - HALL_WALL - pad,
      HALL.right - HALL.left + (HALL_WALL + pad) * 2,
      HALL.bottom - HALL.top + (HALL_WALL + pad) * 2,
      40,
    ).stroke({ color: 0x05040a, width: pad, alpha: 0.55 });
    g.eventMode = 'none';
    return g;
  }
}
