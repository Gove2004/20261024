import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { HALL, HALL_CENTER, HALL_WALL, PILLARS, PLACE, THRONE, VIEW, WORLD } from '../content/config';
import { CARDS, type CardShape } from '../content/cards';
import { COLOR } from '../content/palette';
import { AI } from '../content/heroAi';
import type { Game } from '../gameplay/game';
import type { Rng } from '../core/rng';
import { FxLayer } from './fx';
import type { ArtMap } from './art';
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
  private readonly detonateHint = new Graphics();
  private readonly heroNode = new Container();
  private readonly heroBody = new Graphics();
  private readonly heroSword = new Graphics();
  private readonly monsters = new Map<number, Container>();
  private readonly monsterDef = new Map<number, number>();
  /** 每只魔物的基准缩放（贴图按尺寸换算，占位造型是 1） */
  private readonly monsterBase = new Map<number, number>();
  private art: ArtMap = new Map();
  private heroArt: Sprite | null = null;

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
    this.previewLayer.addChild(this.detonateHint);
    world.addChild(this.previewLayer);
  }

  /**
   * 注入贴图。贴图是异步加载的，Scene 构造时可能还没有，
   * 所以这里允许随时注入；缺图的实体保持程序化造型不变。
   */
  public setArt(art: ArtMap): void {
    this.art = art;
    const texture = art.get('guoba');
    if (!texture || this.heroArt) return;

    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 0.82);
    const size = 118;
    sprite.width = size;
    sprite.height = size;
    this.heroBody.visible = false;
    this.heroSword.visible = false;
    this.heroNode.addChild(sprite);
    this.heroArt = sprite;
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

  /**
   * 引爆提示：指针悬停在一只魔物上时，给它套一圈紫环。
   * 双击引爆是隐藏操作，没有这个反馈玩家永远发现不了。
   */
  public setDetonateHint(target: { x: number; y: number } | null): void {
    const g = this.detonateHint;
    g.clear();
    if (!target) return;
    g.circle(target.x, target.y, 30).stroke({ color: 0xc06bd8, width: 2.5, alpha: 0.9 });
    g.circle(target.x, target.y, 38).stroke({ color: 0xc06bd8, width: 1, alpha: 0.35 });
    g.circle(target.x, target.y, 6).fill({ color: 0xc06bd8, alpha: 0.55 });
  }

  // ------------------------------------------------------------------ 静态

  private drawGround(g: Graphics): void {
    g.rect(0, 0, WORLD.w, WORLD.h).fill({ color: COLOR.void });

    // 方形大厅：外墙 → 地面 → 内墙描边。方形的边角给了玩家"这是房间"的直觉，
    // 也让镜头平移时有四条直线参照，比圆弧更好读方向。
    const w = HALL.right - HALL.left;
    const h = HALL.bottom - HALL.top;

    // 墙体外沿（含灼热缝隙）
    g.roundRect(HALL.left - HALL_WALL, HALL.top - HALL_WALL, w + HALL_WALL * 2, h + HALL_WALL * 2, 26).fill({
      color: 0x0d0a16,
    });
    g.roundRect(HALL.left - HALL_WALL, HALL.top - HALL_WALL, w + HALL_WALL * 2, h + HALL_WALL * 2, 26).stroke({
      color: COLOR.lava,
      width: 3,
      alpha: 0.22,
    });

    // 地面
    g.roundRect(HALL.left, HALL.top, w, h, 14).fill({ color: COLOR.floor0 });
    g.roundRect(HALL.left, HALL.top, w, h, 14).stroke({ color: COLOR.stone1, width: HALL_WALL, alpha: 0.5 });
    g.roundRect(HALL.left, HALL.top, w, h, 14).stroke({ color: COLOR.stone2, width: 6, alpha: 0.8 });

    // 地砖：等距方格，给镜头平移一个空间参照
    const tile = 205;
    for (let x = HALL.left + tile; x < HALL.right - 40; x += tile) {
      g.moveTo(x, HALL.top + 6);
      g.lineTo(x, HALL.bottom - 6);
    }
    for (let y = HALL.top + tile; y < HALL.bottom - 40; y += tile) {
      g.moveTo(HALL.left + 6, y);
      g.lineTo(HALL.right - 6, y);
    }
    g.stroke({ color: COLOR.stone0, width: 2, alpha: 0.35 });

    // 中心到四角的斜线，视觉上把房间收成一个"仪轨场"
    g.moveTo(HALL.left + 40, HALL.top + 40);
    g.lineTo(HALL.right - 40, HALL.bottom - 40);
    g.moveTo(HALL.right - 40, HALL.top + 40);
    g.lineTo(HALL.left + 40, HALL.bottom - 40);
    g.stroke({ color: COLOR.lava, width: 2, alpha: 0.07 });

    // 四角火盆
    const corners: readonly (readonly [number, number])[] = [
      [HALL.left + 90, HALL.top + 90],
      [HALL.right - 90, HALL.top + 90],
      [HALL.left + 90, HALL.bottom - 90],
      [HALL.right - 90, HALL.bottom - 90],
    ];
    for (const [cx, cy] of corners) {
      g.circle(cx, cy, 46).fill({ color: 0x0b0812, alpha: 0.9 });
      g.circle(cx, cy, 34).fill({ color: COLOR.lava, alpha: 0.16 });
      g.circle(cx, cy, 18).fill({ color: COLOR.lavaHot, alpha: 0.5 });
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

    // 南面大门：他进来、也出去的方向
    const gateY = HALL.bottom - 6;
    g.roundRect(HALL_CENTER.x - 80, gateY - 34, 160, 44, 8).fill({ color: COLOR.lava, alpha: 0.22 });
    g.roundRect(HALL_CENTER.x - 52, gateY - 18, 104, 30, 6).fill({ color: 0x0a0712, alpha: 0.9 });
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
    this.heroNode.alpha = hero.alive ? 1 : 0;

    // 挥砍：前摇收剑 → 后摇出剑
    const swingTarget = hero.windup > 0 ? -0.5 : hero.recover > 0 ? 0.75 : -0.35;
    this.heroSword.rotation += (swingTarget - this.heroSword.rotation) * 0.35;

    // 阶段配色：5 级起偏暖，10 级狂化贴图整张换掉
    const stageTint = hero.level >= 10 ? 0xffb0a0 : hero.level >= 5 ? 0xd9c4a8 : 0xffffff;
    const wantTint = hero.flash > 0.4 ? 0xffffff : stageTint;

    if (this.heroArt) {
      const rage = hero.level >= 10;
      const texture = this.art.get(rage ? 'guoba-rage' : 'guoba');
      if (texture && this.heroArt.texture !== texture) this.heroArt.texture = texture;
      this.heroArt.y = bob;
      if (this.heroArt.tint !== wantTint) this.heroArt.tint = wantTint;
    } else {
      this.heroBody.y = bob;
      if (this.heroBody.tint !== wantTint) this.heroBody.tint = wantTint;
    }

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
        const texture: Texture | undefined = this.art.get(def.id);
        if (texture) {
          // 贴图是 256 见方、主体已撑满画布，按半径换算显示尺寸；
          // anchor 压在脚底，这样 y 排序（zIndex = y）和分离力才对得上。
          const sprite = new Sprite(texture);
          sprite.anchor.set(0.5, 0.8);
          const size = def.radius * 4.2;
          sprite.width = size;
          sprite.height = size;

          // 高星魔物脚下有光环：7 星以上是"这只值一半预算"，必须一眼认出来。
          // 星级在放下时就固定，所以光环只在创建时判断一次，不进每帧热路径。
          const star = store.star[slot] ?? 1;
          if (star >= 7) {
            const holder = new Container();
            const glow = new Graphics();
            const color = star >= 9 ? 0xffd27a : 0xb07cff;
            glow.ellipse(0, 0, size * 0.46, size * 0.2).fill({ color, alpha: 0.16 });
            glow.ellipse(0, 0, size * 0.46, size * 0.2).stroke({ color, width: 2, alpha: 0.55 });
            holder.addChild(glow);
            holder.addChild(sprite);
            gfx = holder;
          } else {
            gfx = sprite;
          }
          this.monsterBase.set(slot, size / texture.width);
        } else {
          const placeholder = new Graphics();
          drawMonster(placeholder, def.shape, def.color, def.radius);
          gfx = placeholder;
          this.monsterBase.set(slot, 1);
        }
        this.entityLayer.addChild(gfx);
        this.monsters.set(slot, gfx);
        this.monsterDef.set(slot, defIdx);
      }

      const x = store.x[slot] ?? 0;
      const y = store.y[slot] ?? 0;
      const star = store.star[slot] ?? 1;
      const size = 1 + 0.055 * (star - 1);
      const base = this.monsterBase.get(slot) ?? 1;
      gfx.position.set(x, y);
      gfx.zIndex = y;
      gfx.scale.set(base * size);

      const phase = store.phase[slot] ?? 0;
      const moving = Math.abs(store.vx[slot] ?? 0) + Math.abs(store.vy[slot] ?? 0) > 12;
      gfx.rotation = moving ? Math.sin(time * 13 + phase) * 0.14 : Math.sin(time * 2 + phase) * 0.03;
      gfx.y += moving ? Math.sin(time * 26 + phase) * 1.6 : 0;

      const flash = store.flash[slot] ?? 0;
      // 受击闪白：tint 只在状态切换时写，逐帧写会让 Pixi 重算批次
      const wantTint = flash > 0.35 ? 0xffffff : 0xffffff;
      if (gfx.tint !== wantTint) gfx.tint = wantTint;

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
    this.monsterBase.clear();
    this.fx.clear();
  }
}
