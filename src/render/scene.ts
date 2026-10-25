import { Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import { CAM_ZOOM, HALL, HALL_CENTER, HALL_WALL, MAGIC_CIRCLE, PILLARS, PLACE, THRONE, VIEW, WORLD } from '../content/config';
import { CARDS, type CardShape } from '../content/cards';
import { COLOR } from '../content/palette';
import { AI } from '../content/heroAi';
import { SKILL_BY_ID, SKILL_TUNING } from '../content/heroSkills';
import type { Game } from '../gameplay/game';
import type { Rng } from '../core/rng';
import { FxLayer } from './fx';
import { Ambient } from './ambient';
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
  private readonly heroNode = new Container();
  private readonly heroBody = new Graphics();
  private readonly heroSword = new Graphics();
  private readonly monsters = new Map<number, Container>();
  private readonly monsterDef = new Map<number, number>();
  /** 每只魔物的基准缩放（贴图按尺寸换算，占位造型是 1） */
  private readonly monsterBase = new Map<number, number>();
  private art: ArtMap = new Map();
  private heroArt: Sprite | null = null;
  private floorSprite: Sprite | null = null;
  private magicCircle: Sprite | null = null;
  private readonly ambient: Ambient;
  /** 镜头抖动幅度（px），每帧衰减 */
  private shakeMag = 0;
  /** 环境贴图只在第一次拿到时铺一次 */
  private envBuilt = false;

  constructor(
    private readonly stage: Stage,
    private readonly rng: Rng,
  ) {
    const world = stage.world;
    world.removeChildren();

    const ground = new Graphics();
    this.drawGround(ground, rng);
    // 静态地面烘焙成一张贴图：否则每帧都要重绘几十个半透明大圆，
    // 软件渲染下直接掉到 10fps（这是实测过的，不是猜的）。
    const floorTexture = stage.app.renderer.generateTexture(ground);
    ground.destroy();
    const floor = new Sprite(floorTexture);
    this.floorSprite = floor;
    world.addChild(floor);

    this.entityLayer.sortableChildren = true;
    world.addChild(this.entityLayer);

    // 环境粒子：浮尘 + 火盆余烬。挂在 world 里跟着相机走，和实体同层之前，
    // 这样它们永远在魔物/勇者下面，不会糊在角色脸上。
    this.ambient = new Ambient(
      world,
      (color, radius) => {
        const g = new Graphics();
        g.circle(0, 0, radius).fill({ color });
        const tex = stage.app.renderer.generateTexture(g);
        g.destroy();
        return tex;
      },
      rng,
    );
    const vignette = Ambient.buildVignette();
    world.addChildAt(vignette, world.getChildIndex(this.entityLayer));

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

  /**
   * 注入贴图。贴图是异步加载的，Scene 构造时可能还没有，
   * 所以这里允许随时注入；缺图的实体保持程序化造型不变。
   */
  public setArt(art: ArtMap): void {
    this.art = art;
    this.buildEnv();
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

  /**
   * 环境贴图（M4）。方向已定稿：**保留深色大厅，只做质感升级**，
   * 所以这里是把手绘石头贴图叠在原来的程序化烘焙地面上，而不是换配色。
   *
   * 性能教训（实测，不是猜）：第一版用 TilingSprite + Graphics 遮罩铺地面和墙体，
   * 软件渲染直接从 40fps 掉到 13fps —— 遮罩会多一遍 stencil pass，
   * 1640×1240 的平铺混合在 CPU 光栅化下极其昂贵。
   * 现在改成：平铺贴图**只在启动时烤一次**成单张纹理，运行时就是一个 Sprite。
   * 墙体和石柱保留程序化造型（形状本来就对，贴图带来的收益不抵一遍遮罩）。
   */
  private buildEnv(): void {
    if (this.envBuilt) return;
    const floorTex = this.art.get('env-floor');
    if (!floorTex) return;
    this.envBuilt = true;

    const world = this.stage.world;
    const w = HALL.right - HALL.left;
    const h = HALL.bottom - HALL.top;
    const insertAt = world.getChildIndex(this.entityLayer);

    // 两层不同尺度的平铺叠在一起：单层 2×2 平铺的重复感是肉眼级的
    // （评审两次都指出"像浴室瓷砖"），错开尺度 + 相位之后周期变成 2.7×2.9 倍，
    // 屏幕上再也看不到同一个图案出现两次。启动时烤一次，运行时零成本。
    const layerA = new TilingSprite({ texture: floorTex, width: w, height: h });
    layerA.tileScale.set(1.6);
    layerA.alpha = 0.3;
    layerA.position.set(HALL.left, HALL.top);
    const layerB = new TilingSprite({ texture: floorTex, width: w, height: h });
    layerB.tileScale.set(2.7);
    layerB.tilePosition.set(311, 197);
    layerB.alpha = 0.22;
    layerB.position.set(HALL.left, HALL.top);

    const overlayBaked = this.stage.app.renderer.generateTexture(
      (() => {
        const stage = new Container();
        stage.addChild(layerA, layerB);
        return stage;
      })(),
    );
    layerA.destroy();
    layerB.destroy();

    if (this.floorSprite) {
      const compose = new Container();
      const base = new Sprite(this.floorSprite.texture);
      const over = new Sprite(overlayBaked);
      over.position.set(HALL.left, HALL.top);
      const wear = new Graphics();
      this.drawWear(wear);
      compose.addChild(base, over, wear);
      const merged = this.stage.app.renderer.generateTexture(compose);
      compose.destroy({ children: true });
      this.floorSprite.texture = merged;
      this.floorSprite.position.set(0, 0);
    } else {
      const floorOverlay = new Sprite(overlayBaked);
      floorOverlay.position.set(HALL.left, HALL.top);
      floorOverlay.alpha = 0.5;
      world.addChildAt(floorOverlay, insertAt);
    }

    // 2) 石柱：孤立物体，直接用透明贴图，不用遮罩
    const pillarTex = this.art.get('env-pillar');
    if (pillarTex) {
      for (const pillar of PILLARS) {
        const sprite = new Sprite(pillarTex);
        sprite.anchor.set(0.5);
        const size = (pillar.r + 16) * 2;
        sprite.width = size;
        sprite.height = size;
        sprite.position.set(pillar.x, pillar.y);
        world.addChildAt(sprite, insertAt + 1);
      }
    }

    // 3) 中央魔法阵：纯观赏。用具象的两层环 + 符文程序化画，慢转 + 呼吸。
    //    它是这张图唯一的"发光中心"（火盆已经按需求删掉了），
    //    没有它，深色地面上就是一片没有焦点的平地。
    const circleTex = this.makeMagicCircleTexture(MAGIC_CIRCLE.r);
    const circle = new Sprite(circleTex);
    circle.anchor.set(0.5);
    circle.position.set(MAGIC_CIRCLE.x, MAGIC_CIRCLE.y);
    circle.blendMode = 'add';
    circle.alpha = 0.6;
    world.addChildAt(circle, insertAt + 1);
    this.magicCircle = circle;

    const cool = this.makeGlowTexture(0x7d6bd0, 0x2a2048);
    const centerGlow = new Sprite(cool);
    centerGlow.anchor.set(0.5);
    centerGlow.width = MAGIC_CIRCLE.r * 2.6;
    centerGlow.height = MAGIC_CIRCLE.r * 2.6;
    centerGlow.position.set(MAGIC_CIRCLE.x, MAGIC_CIRCLE.y);
    centerGlow.alpha = 0.34;
    centerGlow.blendMode = 'add';
    world.addChildAt(centerGlow, insertAt + 1);

    // 4) 王座挪到北墙正中方，只当装饰（用户要求中央留给魔法阵）
    const throneTex = this.art.get('throne');
    if (throneTex) {
      const throne = new Sprite(throneTex);
      throne.anchor.set(0.5, 0.8);
      throne.width = 300;
      throne.height = 300;
      throne.position.set(THRONE.x, THRONE.y);
      throne.alpha = 0.92;
      world.addChildAt(throne, insertAt + 2);
    }
  }

  /** 魔法阵贴图：同心环 + 齿状符文 + 中心六芒，加色混合下很"魔"。 */
  private makeMagicCircleTexture(radius: number): Texture {
    const g = new Graphics();
    const pi2 = Math.PI * 2;
    // 外环
    g.circle(0, 0, radius).stroke({ width: 3, color: 0x9b7bff, alpha: 0.5 });
    g.circle(0, 0, radius * 0.94).stroke({ width: 1.5, color: 0x6f5bd8, alpha: 0.32 });
    g.circle(0, 0, radius * 0.66).stroke({ width: 2, color: 0x9b7bff, alpha: 0.42 });
    g.circle(0, 0, radius * 0.3).stroke({ width: 2, color: 0xc0a8ff, alpha: 0.5 });
    // 齿状符文（外环 24 短刻线 + 内环 12 长刻线）
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * pi2;
      const r0 = radius * 0.96;
      const r1 = radius * (i % 3 === 0 ? 0.88 : 0.92);
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    }
    g.stroke({ width: 2, color: 0x8f74ff, alpha: 0.55 });
    // 六芒星
    for (let k = 0; k < 2; k += 1) {
      const phase = (k * Math.PI) / 3;
      g.moveTo(0, 0);
      for (let i = 0; i <= 3; i += 1) {
        const a = phase + (i / 3) * pi2;
        const x = Math.cos(a) * radius * 0.8;
        const y = Math.sin(a) * radius * 0.8;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    g.stroke({ width: 1.5, color: 0xb49bff, alpha: 0.3 });
    const tex = this.stage.app.renderer.generateTexture(g);
    g.destroy();
    return tex;
  }

  /** 径向渐变光斑贴图：一圈圈递减的半透明圆叠出来，预烤一次反复用。 */
  private makeGlowTexture(inner: number, outer: number): Texture {
    const g = new Graphics();
    const steps = 16;
    for (let i = steps; i >= 1; i -= 1) {
      const t = i / steps;
      // 0.045 太客气了：叠 14 层之后在深底上几乎看不见（评审："还是平光"）。
      // 现在外层就给到 0.1，中心累计到接近 0.5，才看得出"这里有个火盆在照"。
      g.circle(0, 0, 128 * t).fill({
        color: i > steps * 0.5 ? outer : inner,
        alpha: 0.1 + (1 - t) * 0.16,
      });
    }
    const tex = this.stage.app.renderer.generateTexture(g);
    g.destroy();
    return tex;
  }

  /**
   * 磨损与污渍：地面贴图是 2×2 平铺，纯靠它一眼就能看出重复（评审原话："像浴室瓷砖"）。
   * 不规则斑块 + 随机裂缝是打碎重复感最便宜的手段 —— 只在启动时烤一次，运行时零成本。
   * 必须画在贴图**之上**，否则会被 0.42 的叠图压灰。
   */
  private drawWear(g: Graphics): void {
    const rng = this.rng;
    for (let i = 0; i < 54; i += 1) {
      const x = HALL.left + rng.next() * (HALL.right - HALL.left);
      const y = HALL.top + rng.next() * (HALL.bottom - HALL.top);
      const r = 26 + rng.next() * 96;
      const dark = rng.next() > 0.3;
      g.circle(x, y, r).fill({
        color: dark ? 0x07050d : 0x3c3350,
        alpha: dark ? 0.06 + rng.next() * 0.06 : 0.03 + rng.next() * 0.035,
      });
    }

    for (let i = 0; i < 8; i += 1) {
      let x = HALL.left + rng.next() * (HALL.right - HALL.left);
      let y = HALL.top + rng.next() * (HALL.bottom - HALL.top);
      g.moveTo(x, y);
      const steps = 5 + Math.floor(rng.next() * 4);
      for (let s = 0; s < steps; s += 1) {
        x += (rng.next() - 0.5) * 96;
        y += (rng.next() - 0.5) * 96;
        g.lineTo(x, y);
      }
      g.stroke({ color: 0x05040a, width: 1 + rng.next() * 1.6, alpha: 0.18 });
    }
  }

  /** 屏幕震动：取最大值而不是累加，否则连爆时镜头会飞出画面。 */
  public shake(power: number): void {
    if (power > this.shakeMag) this.shakeMag = Math.min(power, 14);
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

  private drawGround(g: Graphics, rng: Rng): void {
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
    // 地砖网格：加了手绘贴图之后，这条硬网格线就成了"像瓷砖"的元凶
    // （评审两次都点它）。留一点点当空间参照，把视觉重量交给贴图。
    g.stroke({ color: COLOR.stone0, width: 2, alpha: 0.1 });

    // 中心到四角的斜线，视觉上把房间收成一个"仪轨场"
    g.moveTo(HALL.left + 40, HALL.top + 40);
    g.lineTo(HALL.right - 40, HALL.bottom - 40);
    g.moveTo(HALL.right - 40, HALL.top + 40);
    g.lineTo(HALL.left + 40, HALL.bottom - 40);
    g.stroke({ color: COLOR.lava, width: 2, alpha: 0.05 });

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

    // 弹弓（占位造型用）：锚点在握把处，拉弓时往回收
    this.heroSword.clear();
    this.heroSword
      .moveTo(0, -12)
      .lineTo(0, 6)
      .moveTo(0, -12)
      .lineTo(12, 0)
      .moveTo(0, 6)
      .lineTo(12, 0)
      .stroke({ color: 0x8a6a3c, width: 4, alpha: 1 });
    this.heroSword.position.set(8, -30);
    this.heroSword.rotation = 0.2;
    this.heroNode.addChild(this.heroSword);

    this.heroNode.zIndex = 0;
  }

  // ------------------------------------------------------------------ 每帧

  public sync(game: Game, alpha: number, time: number): void {
    const hero = game.hero;

    // 相机：世界反向平移（不动 stage.scale，否则 UI 会一起缩）
    // 抖动叠在这上面，衰减很快（每帧 ×0.86）：90ms 内只剩 1px，
    // 所以我们是在做"打击感的标点"，不是"地震"。
    const shake = this.shakeMag;
    const sx = shake > 0.2 ? Math.sin(time * 96) * shake : 0;
    const sy = shake > 0.2 ? Math.cos(time * 71) * shake : 0;
    this.shakeMag = shake * 0.86;
    this.stage.world.position.set(
      VIEW.w / 2 - game.camX * CAM_ZOOM + sx,
      VIEW.h / 2 - game.camY * CAM_ZOOM + sy,
    );

    // 魔法阵：慢转 + 呼吸。观赏性物件必须自己在动，否则就是一张贴在地上的图。
    if (this.magicCircle) {
      this.magicCircle.rotation = time * 0.08;
      this.magicCircle.alpha = 0.5 + Math.sin(time * 1.3) * 0.12;
    }

    this.syncMonsters(game, time);

    // 勇者
    this.heroNode.position.set(hero.x, hero.y);
    this.heroNode.zIndex = hero.y + 1;
    const wobble = hero.moving ? Math.sin(time * 15) * 0.075 : Math.sin(time * 2.4) * 0.012;
    this.heroNode.rotation = hero.windup > 0 ? -0.1 : wobble;
    const bob = hero.moving ? Math.sin(time * 30) * 2 : 0;
    this.heroNode.alpha = hero.alive ? 1 : 0;

    // 拉弓：前摇把弹弓往后拉，出手后回弹
    const drawTarget = hero.windup > 0 ? -0.35 : hero.recover > 0 ? 0.45 : 0.2;
    this.heroSword.rotation += (drawTarget - this.heroSword.rotation) * 0.3;

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
    this.ambient.update(1 / 60);
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
        const texture: Texture | undefined = this.art.get(def.art ?? def.id);
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
    g.position.set(0, 0);
    g.rotation = 0;

    const skill = hero.pendingSkill;
    const pulse = 0.18 + Math.sin(time * 26) * 0.05;
    const angle = Math.atan2(hero.facingY, hero.facingX);

    // 瞄准线：他是远程，所以预警不是"扇形范围"而是一条指向目标的细线。
    // 玩家能据此判断"他要先打谁"，从而决定要不要把那只撤下来。
    if (skill === 'shot' || skill === 'spread') {
      g.position.set(hero.x, hero.y);
      g.rotation = angle;
      const range = skill === 'spread' ? 300 : AI.shootRange * 0.9;
      g.rect(26, -1.5, range, 3).fill({ color: 0xff3b5c, alpha: pulse });
      g.circle(26 + range, 0, 4).fill({ color: 0xff3b5c, alpha: pulse + 0.25 });
      // 散射额外画出扇面，玩家才知道"别站成一排"
      if (skill === 'spread') {
        const half = 0.42;
        g.moveTo(20, 0);
        g.arc(20, 0, range, -half, half);
        g.lineTo(20, 0);
        g.fill({ color: 0xff3b5c, alpha: 0.1 });
      }
    } else if (skill === 'qi') {
      const progress = 1 - hero.windup / Math.max(0.01, SKILL_BY_ID.qi.windup);
      const len = AI.qiLength * Math.min(1, progress * 1.6);
      g.position.set(hero.x, hero.y);
      g.rotation = Math.atan2(hero.qiDirY, hero.qiDirX);
      g.rect(0, -AI.qiHalfWidth, len, AI.qiHalfWidth * 2).fill({
        color: 0x9dd7ff,
        alpha: 0.1 + Math.sin(time * 30) * 0.03,
      });
    } else if (skill === 'heavy') {
      // 重击：更粗、更红、带蓄力收缩感 —— 这是最该被躲的一发
      const charge = 1 - hero.windup / Math.max(0.01, SKILL_BY_ID.heavy.windup);
      g.position.set(hero.x, hero.y);
      g.rotation = angle;
      g.rect(24, -3, SKILL_TUNING.heavyRange * (0.35 + charge * 0.65), 6).fill({
        color: 0xff2a44,
        alpha: 0.22 + charge * 0.2,
      });
    } else if (skill === 'bomb') {
      const r = SKILL_TUNING.bombRadius;
      g.circle(hero.bombX, hero.bombY, r).fill({ color: 0xff7a3c, alpha: 0.12 });
      g.circle(hero.bombX, hero.bombY, r).stroke({ color: 0xff9a5c, width: 2.5, alpha: 0.7 });
      g.circle(hero.bombX, hero.bombY, r * 0.4).stroke({ color: 0xffc08a, width: 1.5, alpha: 0.5 });
    } else if (skill === 'heal') {
      g.circle(hero.x, hero.y, 62).stroke({ color: 0x7be05f, width: 2, alpha: 0.45 });
    } else if (skill === 'roll') {
      g.circle(hero.x, hero.y, 26).stroke({ color: 0x9dd7ff, width: 2.5, alpha: 0.75 });
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
