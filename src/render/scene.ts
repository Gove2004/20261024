import { Container, Graphics, Sprite } from 'pixi.js';
import { ARENA, PILLARS, PLACE, THRONE, VIEW, WORLD } from '../content/config';
import { CARDS, type CardShape } from '../content/cards';
import { COLOR } from '../content/palette';
import { AI } from '../content/heroAi';
import type { Game } from '../gameplay/game';
import type { Rng } from '../core/rng';
import { FxLayer } from './fx';
import type { Stage } from './stage';

const HERO_RADIUS_SCALE = 1;

/** 把一只魔物的占位造型画出来。正式贴图接入后整段替换成 Sprite。 */
function drawMonster(g: Graphics, shape: CardShape, color: number, radius: number): void {
  g.clear();

  const outline = { color: 0x0b0a14, width: 2.5, alpha: 0.9 };
  const body = { color, alpha: 0.95 };

  switch (shape) {
    case 'blob': {
      g.ellipse(0, 0, radius, radius * 0.82).fill(body).stroke(outline);
      g.ellipse(0, -radius * 0.72, radius * 0.55, radius * 0.28).fill({ color, alpha: 0.7 });
      g.circle(-radius * 0.32, -radius * 0.1, radius * 0.14).fill({ color: 0x0b0a14 });
      g.circle(radius * 0.32, -radius * 0.1, radius * 0.14).fill({ color: 0x0b0a14 });
      break;
    }
    case 'wisp': {
      g.moveTo(0, -radius * 1.15);
      g.lineTo(radius * 0.85, radius * 0.55);
      g.lineTo(-radius * 0.85, radius * 0.55);
      g.closePath().fill(body).stroke(outline);
      g.circle(0, -radius * 0.1, radius * 0.28).fill({ color: 0xffffff, alpha: 0.85 });
      break;
    }
    case 'skull': {
      g.roundRect(-radius * 0.72, -radius, radius * 1.44, radius * 1.7, radius * 0.42)
        .fill(body)
        .stroke(outline);
      g.circle(-radius * 0.28, -radius * 0.2, radius * 0.16).fill({ color: 0x2a1f1a });
      g.circle(radius * 0.28, -radius * 0.2, radius * 0.16).fill({ color: 0x2a1f1a });
      g.rect(-radius * 0.3, radius * 0.35, radius * 0.6, radius * 0.12).fill({ color: 0x2a1f1a });
      break;
    }
    case 'spider': {
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * radius * 1.5, Math.sin(a) * radius * 1.5);
        g.stroke({ color: 0x0b0a14, width: 2.5, alpha: 0.85 });
      }
      g.circle(0, 0, radius * 0.85).fill(body).stroke(outline);
      g.circle(0, -radius * 0.2, radius * 0.22).fill({ color: 0x0b0a14 });
      break;
    }
  }
}

/**
 * 世界渲染：静态地面 + 实体层 + 预警层 + 特效层。
 *
 * 所有实体都走「贴图/造型 + 容器变换」的摇摆动画（策划案 §8.2）：
 * 移动时左右摇摆，攻击时前后倾，死亡交给粒子爆发。
 */
export class Scene {
  public readonly fx: FxLayer;
  /** 落点预览层（最上层，独立于实体排序） */
  public readonly previewLayer = new Container();

  private readonly entityLayer = new Container();
  private readonly warn = new Graphics();
  private readonly preview = new Graphics();
  private readonly heroNode = new Container();
  private readonly heroBody = new Graphics();
  private readonly heroSword = new Graphics();
  private readonly monsters = new Map<number, Graphics>();
  private readonly monsterDef = new Map<number, number>();

  constructor(
    private readonly stage: Stage,
    rng: Rng,
  ) {
    const world = stage.world;
    world.removeChildren();

    const ground = new Graphics();
    this.drawGround(ground);
    // 静态地面烘焙成一张贴图：否则每帧都要重绘几十个半透明大圆，
    // 软件渲染下直接掉到 10fps（这是实测过的，不是猜的）。
    const floorTexture = stage.app.renderer.generateTexture(ground);
    ground.destroy();
    const floor = new Sprite(floorTexture);
    world.addChild(floor);

    this.entityLayer.sortableChildren = true;
    world.addChild(this.entityLayer);

    this.buildHero();
    this.entityLayer.addChild(this.heroNode);
    this.entityLayer.addChild(this.warn);

    // 特效必须挂在 world 里（跟着相机走）；stage.fx 是屏幕层，留给未来的全屏滤镜
    const fxLayer = new Container();
    world.addChild(fxLayer);
    this.fx = new FxLayer(fxLayer, rng);

    this.previewLayer.addChild(this.preview);
    world.addChild(this.previewLayer);
  }

  /** 召唤落点预览：绿=可放，红=不可放。 */
  public setPreview(target: { x: number; y: number; ok: boolean } | null): void {
    const g = this.preview;
    g.clear();
    if (!target) return;
    const color = target.ok ? 0x7be05f : 0xff3b5c;
    g.circle(target.x, target.y, PLACE.minDistHero * 0.5).fill({ color, alpha: 0.16 });
    g.circle(target.x, target.y, PLACE.minDistHero * 0.5).stroke({ color, width: 2, alpha: 0.85 });
    g.circle(target.x, target.y, 4).fill({ color, alpha: 0.9 });
  }

  // ------------------------------------------------------------------ 静态

  private drawGround(g: Graphics): void {
    g.rect(0, 0, WORLD.w, WORLD.h).fill({ color: COLOR.void });

    // 大厅地面
    g.circle(ARENA.cx, ARENA.cy, ARENA.r + 26).fill({ color: 0x100d1c });
    g.circle(ARENA.cx, ARENA.cy, ARENA.r).fill({ color: COLOR.floor0 });
    g.circle(ARENA.cx, ARENA.cy, ARENA.r).stroke({ color: COLOR.lava, width: 8, alpha: 0.35 });
    g.circle(ARENA.cx, ARENA.cy, ARENA.r - 14).stroke({ color: COLOR.lavaHot, width: 2, alpha: 0.18 });

    // 地面砖纹：几圈同心环，让镜头平移时有参照物
    for (let i = 1; i <= 5; i += 1) {
      g.circle(ARENA.cx, ARENA.cy, (ARENA.r / 6) * i).stroke({
        color: COLOR.stone0,
        width: 1,
        alpha: 0.25,
      });
    }
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      g.moveTo(ARENA.cx + Math.cos(a) * 120, ARENA.cy + Math.sin(a) * 120);
      g.lineTo(ARENA.cx + Math.cos(a) * ARENA.r, ARENA.cy + Math.sin(a) * ARENA.r);
      g.stroke({ color: COLOR.stone0, width: 1, alpha: 0.14 });
    }

    // 王座台
    g.circle(THRONE.x, THRONE.y, THRONE.r + 22).fill({ color: 0x1a1428 });
    g.circle(THRONE.x, THRONE.y, THRONE.r).fill({ color: 0x241c36 });
    g.circle(THRONE.x, THRONE.y, THRONE.r).stroke({ color: COLOR.stone2, width: 4, alpha: 0.7 });
    g.roundRect(THRONE.x - 42, THRONE.y - 60, 84, 96, 10).fill({ color: 0x120e1e });
    g.roundRect(THRONE.x - 24, THRONE.y - 44, 48, 64, 6).fill({ color: COLOR.lava, alpha: 0.18 });

    // 石柱
    for (const pillar of PILLARS) {
      g.circle(pillar.x, pillar.y + 8, pillar.r + 6).fill({ color: 0x05040a, alpha: 0.55 });
      g.circle(pillar.x, pillar.y, pillar.r).fill({ color: COLOR.stone0 });
      g.circle(pillar.x, pillar.y, pillar.r).stroke({ color: COLOR.stone2, width: 3, alpha: 0.6 });
      g.circle(pillar.x, pillar.y, pillar.r * 0.55).stroke({ color: COLOR.stone1, width: 2, alpha: 0.5 });
    }

    // 入口
    const doorY = ARENA.cy + ARENA.r - 6;
    g.roundRect(ARENA.cx - 70, doorY - 12, 140, 26, 8).fill({ color: COLOR.lava, alpha: 0.25 });
  }

  private buildHero(): void {
    // 影子
    const shadow = new Graphics();
    shadow.ellipse(0, 2, 20, 7).fill({ color: COLOR.shadow, alpha: 0.55 });
    this.heroNode.addChild(shadow);

    this.heroBody.clear();
    // 身体：窄长皮甲
    this.heroBody
      .roundRect(-11, -34 * HERO_RADIUS_SCALE, 22, 34, 7)
      .fill({ color: COLOR.leather })
      .stroke({ color: 0x0b0a14, width: 3, alpha: 0.95 });
    // 护肩
    this.heroBody.ellipse(-11, -30, 8, 6).fill({ color: COLOR.leatherDark });
    // 头
    this.heroBody
      .circle(0, -46, 12)
      .fill({ color: COLOR.hero })
      .stroke({ color: 0x0b0a14, width: 3, alpha: 0.95 });
    // 眼睛
    this.heroBody.circle(4, -47, 2.2).fill({ color: 0x0b0a14 });
    this.heroNode.addChild(this.heroBody);

    // 剑：锚点在握把处，绕它旋转做挥砍
    this.heroSword.clear();
    this.heroSword
      .rect(0, -2.5, 34, 5)
      .fill({ color: COLOR.steel })
      .stroke({ color: 0x0b0a14, width: 2, alpha: 0.9 });
    this.heroSword.rect(0, -5, 6, 10).fill({ color: 0x6d5b3e });
    this.heroSword.position.set(10, -26);
    this.heroSword.rotation = -0.35;
    this.heroNode.addChild(this.heroSword);

    this.heroNode.zIndex = 0;
  }

  // ------------------------------------------------------------------ 每帧

  public sync(game: Game, alpha: number, time: number): void {
    const hero = game.hero;

    // 相机：世界反向平移（不动 stage.scale，否则 UI 会一起缩）
    this.stage.world.position.set(VIEW.w / 2 - game.camX, VIEW.h / 2 - game.camY);

    this.syncMonsters(game, time);

    // 勇者
    this.heroNode.position.set(hero.x, hero.y);
    this.heroNode.zIndex = hero.y + 1;
    const wobble = hero.moving ? Math.sin(time * 15) * 0.075 : Math.sin(time * 2.4) * 0.012;
    this.heroNode.rotation = hero.windup > 0 ? -0.1 : wobble;
    const bob = hero.moving ? Math.sin(time * 30) * 2 : 0;
    this.heroBody.y = bob;
    this.heroNode.alpha = hero.alive ? 1 : 0;

    // 挥砍：前摇收剑 → 后摇出剑
    const swingTarget = hero.windup > 0 ? -0.5 : hero.recover > 0 ? 0.75 : -0.35;
    this.heroSword.rotation += (swingTarget - this.heroSword.rotation) * 0.35;

    // 阶段配色
    const stageTint = hero.level >= 10 ? 0xffb0a0 : hero.level >= 5 ? 0xd9c4a8 : 0xffffff;
    this.heroBody.tint = hero.flash > 0.4 ? 0xffffff : stageTint;

    this.drawTelegraphs(hero, time);
    this.fx.update(1 / 60);
    void alpha;
  }

  private syncMonsters(game: Game, time: number): void {
    const store = game.store;

    for (let i = 0; i < store.activeCount; i += 1) {
      const slot = store.active[i];
      if (slot === undefined) continue;
      const defIdx = store.defIdx[slot] ?? 0;
      const def = CARDS[defIdx];
      if (!def) continue;

      let gfx = this.monsters.get(slot);
      if (!gfx || this.monsterDef.get(slot) !== defIdx) {
        if (gfx) gfx.destroy();
        gfx = new Graphics();
        drawMonster(gfx, def.shape, def.color, def.radius);
        this.entityLayer.addChild(gfx);
        this.monsters.set(slot, gfx);
        this.monsterDef.set(slot, defIdx);
      }

      const x = store.x[slot] ?? 0;
      const y = store.y[slot] ?? 0;
      const star = store.star[slot] ?? 1;
      const size = 1 + 0.055 * (star - 1);
      gfx.position.set(x, y);
      gfx.zIndex = y;
      gfx.scale.set(size);

      const phase = store.phase[slot] ?? 0;
      const moving = Math.abs(store.vx[slot] ?? 0) + Math.abs(store.vy[slot] ?? 0) > 12;
      gfx.rotation = moving ? Math.sin(time * 13 + phase) * 0.14 : Math.sin(time * 2 + phase) * 0.03;
      gfx.y += moving ? Math.sin(time * 26 + phase) * 1.6 : 0;

      const flash = store.flash[slot] ?? 0;
      gfx.tint = flash > 0.35 ? 0xffffff : 0xffffff;

      // 残血时轻微变暗，方便一眼看出谁快死了
      const maxHp = store.maxHp[slot] ?? 1;
      const hp = store.hp[slot] ?? 0;
      gfx.alpha = maxHp > 0 && hp / maxHp < 0.3 ? 0.75 : 1;
    }

    // 回收已死的图形占位
    if (this.monsters.size > store.activeCount) {
      for (const [slot, gfx] of this.monsters) {
        if (store.alive[slot] === 1) continue;
        gfx.destroy();
        this.monsters.delete(slot);
        this.monsterDef.delete(slot);
      }
    }
  }

  private drawTelegraphs(hero: Game['hero'], time: number): void {
    const g = this.warn;
    g.clear();

    if (hero.windup > 0) {
      const r = AI.engageRange + 26;
      const a0 = Math.atan2(hero.facingY, hero.facingX) - AI.halfArc;
      const a1 = a0 + AI.halfArc * 2;
      g.moveTo(hero.x, hero.y);
      g.arc(hero.x, hero.y, r, a0, a1);
      g.closePath();
      g.fill({ color: 0xff3b5c, alpha: 0.14 });
    }

    if (hero.qiWindup > 0) {
      const progress = 1 - hero.qiWindup / AI.qiWindup;
      const len = AI.qiLength * Math.min(1, progress * 1.6);
      const angle = Math.atan2(hero.qiDirY, hero.qiDirX);
      g.rect(0, -AI.qiHalfWidth, len, AI.qiHalfWidth * 2).fill({
        color: 0x9dd7ff,
        alpha: 0.1 + Math.sin(time * 30) * 0.03,
      });
      g.position.set(hero.x, hero.y);
      g.rotation = angle;
    } else {
      g.position.set(0, 0);
      g.rotation = 0;
    }
  }

  public reset(): void {
    for (const gfx of this.monsters.values()) gfx.destroy();
    this.monsters.clear();
    this.monsterDef.clear();
    this.fx.clear();
  }
}
