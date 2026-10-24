import './style.css';
import { Container, Graphics } from 'pixi.js';
import { FixedStepLoop } from './core/loop';
import { DESIGN_HEIGHT, DESIGN_WIDTH, createStage } from './render/stage';

/** 全局调色板，数值与 `src/style.css` / `docs/GAME_DESIGN.md §6.1` 一致。 */
const COLOR = {
  abyss: 0x0b0a14,
  stone0: 0x2e2740,
  stone1: 0x43395c,
  soul: 0x5ff2d0,
  lava: 0xff6b4a,
  guoba: 0xf5c24b,
  blood: 0xff3b5c,
} as const;

const ARENA_RADIUS = 330;

/** 骨架阶段的占位实体：等 M1 接入 ECS 后删除。 */
interface Placeholder {
  readonly gfx: Graphics;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  readonly r: number;
  readonly color: number;
}

/**
 * 画一个"看起来像那么回事"的祭坛占位场景。
 *
 * 目的不是好看，而是验证整条渲染链路（分层、坐标、缩放、剖切、动态图形）
 * 能在 60fps 下跑通，让美术接入时只需要替换 Graphics 为 Sprite。
 */
function buildArena(world: Container): void {
  const cx = DESIGN_WIDTH / 2;
  const cy = DESIGN_HEIGHT / 2 + 8;

  const floor = new Graphics();
  floor.circle(cx, cy, ARENA_RADIUS).fill({ color: COLOR.stone0, alpha: 0.34 });
  floor.circle(cx, cy, ARENA_RADIUS).stroke({ width: 3, color: COLOR.stone1, alpha: 0.9 });
  floor.circle(cx, cy, ARENA_RADIUS * 0.72).stroke({ width: 1, color: COLOR.stone1, alpha: 0.45 });
  floor.circle(cx, cy, ARENA_RADIUS * 0.42).stroke({ width: 1, color: COLOR.stone1, alpha: 0.45 });

  // 内环裂隙：给玩家一个"这里是核心"的视觉锚点
  floor.circle(cx, cy, ARENA_RADIUS * 0.42).fill({ color: COLOR.soul, alpha: 0.05 });
  floor.circle(cx, cy, 26).fill({ color: COLOR.soul, alpha: 0.18 });
  floor.circle(cx, cy, 26).stroke({ width: 2, color: COLOR.soul, alpha: 0.55 });

  world.addChild(floor);
}

/** 锅巴占位：一个会呼吸的方块，M4 换成正式立绘。 */
function buildGuoba(world: Container): Graphics {
  const guoba = new Graphics();
  guoba.roundRect(-34, -34, 68, 68, 10).fill({ color: COLOR.guoba, alpha: 0.95 });
  guoba.roundRect(-34, -34, 68, 68, 10).stroke({ width: 3, color: 0x241a14, alpha: 0.9 });
  guoba.circle(-13, -8, 6).fill({ color: 0x241a14 });
  guoba.circle(13, -8, 6).fill({ color: 0x241a14 });
  guoba.ellipse(0, 13, 13, 6).fill({ color: 0x241a14, alpha: 0.85 });
  guoba.position.set(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2 + 8);
  world.addChild(guoba);
  return guoba;
}

/** 会乱走的占位小怪，用来确认同屏多实体的更新与绘制开销。 */
function buildMonsters(): Placeholder[] {
  const list: Placeholder[] = [];
  const colors = [COLOR.soul, COLOR.lava, COLOR.blood, 0x9b6bff];
  const cx = DESIGN_WIDTH / 2;
  const cy = DESIGN_HEIGHT / 2 + 8;

  for (let i = 0; i < 14; i += 1) {
    const gfx = new Graphics();
    const r = 9 + (i % 3) * 3;
    const color = colors[i % colors.length] ?? COLOR.soul;
    gfx.circle(0, 0, r).fill({ color, alpha: 0.9 });
    gfx.circle(0, 0, r).stroke({ width: 2, color: 0x0b0a14, alpha: 0.7 });

    const angle = (i / 14) * Math.PI * 2;
    const dist = 90 + (i % 5) * 32;
    const x = cx + Math.cos(angle) * dist;
    const y = cy + Math.sin(angle) * dist;
    gfx.position.set(x, y);

    list.push({
      gfx,
      x,
      y,
      px: x,
      py: y,
      vx: Math.cos(angle + 1.7) * 46,
      vy: Math.sin(angle + 1.7) * 46,
      r,
      color,
    });
  }
  return list;
}

function createTitleScreen(uiRoot: HTMLElement, onStart: () => void): () => void {
  const screen = document.createElement('div');
  screen.className = 'title-screen';
  screen.innerHTML = `
    <div class="title-kicker">Reverse Roguelike</div>
    <h1 class="title-main">锅巴必须死</h1>
    <p class="title-sub">你是深渊，他是来讨伐你的勇者。</p>
    <p class="title-hook">
      把怪物摆上祭坛喂给他 —— 他吃得越肥，你杀死他时拿的分越高。<br />
      但喂得太肥，<em>翻车的就会是你。</em>
    </p>
    <button class="btn-start" type="button">开 始</button>
    <p class="title-foot">鼠标点卡 → 点地放置　·　双击怪物献祭　·　<kbd>Space</kbd> 暂停　·　<kbd>F3</kbd> 调试</p>
  `;
  uiRoot.appendChild(screen);

  const button = screen.querySelector<HTMLButtonElement>('.btn-start');
  button?.addEventListener('click', () => {
    screen.classList.add('is-leaving');
    window.setTimeout(() => {
      screen.hidden = true;
    }, 450);
    onStart();
  });

  return () => screen.remove();
}

function createDebugBadge(uiRoot: HTMLElement): { el: HTMLElement; toggle(): void; set(text: string): void } {
  const el = document.createElement('div');
  el.className = 'debug-badge';
  el.hidden = true;
  uiRoot.appendChild(el);
  return {
    el,
    toggle: (): void => {
      el.hidden = !el.hidden;
    },
    set: (text: string): void => {
      if (!el.hidden) el.textContent = text;
    },
  };
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  const uiRoot = document.querySelector<HTMLElement>('#ui');
  if (!canvas || !uiRoot) throw new Error('index.html 缺少 #game-canvas 或 #ui');

  const stage = await createStage(canvas);

  buildArena(stage.world);
  const guoba = buildGuoba(stage.world);

  const monsters = buildMonsters();
  for (const monster of monsters) stage.world.addChild(monster.gfx);

  const debug = createDebugBadge(uiRoot);
  let fps = 60;
  let elapsed = 0;
  let running = false;
  let paused = false;

  const step = (dt: number): void => {
    if (!running) return;
    elapsed += dt;

    const cx = DESIGN_WIDTH / 2;
    const cy = DESIGN_HEIGHT / 2 + 8;

    for (const monster of monsters) {
      monster.px = monster.x;
      monster.py = monster.y;
      monster.x += monster.vx * dt;
      monster.y += monster.vy * dt;

      // 撞到祭坛边缘就反弹，制造"场地有边界"的直觉
      const dx = monster.x - cx;
      const dy = monster.y - cy;
      const dist = Math.hypot(dx, dy);
      const limit = ARENA_RADIUS - monster.r - 6;
      if (dist > limit && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        monster.x = cx + nx * limit;
        monster.y = cy + ny * limit;
        const dot = monster.vx * nx + monster.vy * ny;
        monster.vx = (monster.vx - 2 * dot * nx) * -1;
        monster.vy = (monster.vy - 2 * dot * ny) * -1;
      }
    }
  };

  const render = (alpha: number, frameDt: number): void => {
    if (frameDt > 0) fps = fps * 0.92 + (1 / frameDt) * 0.08;

    for (const monster of monsters) {
      monster.gfx.position.set(
        monster.px + (monster.x - monster.px) * alpha,
        monster.py + (monster.y - monster.py) * alpha,
      );
    }

    // 呼吸感：缩放 + 轻微浮动，验证"不用 sprite sheet 也能有生命"
    const breathe = 1 + Math.sin(elapsed * 2.6) * 0.045;
    guoba.scale.set(breathe, 2 - breathe);
    guoba.y = DESIGN_HEIGHT / 2 + 8 + Math.sin(elapsed * 1.8) * 3;

    stage.app.render();

    debug.set(`FPS ${fps.toFixed(0)}　实体 ${monsters.length + 1}\n设计分辨率 ${DESIGN_WIDTH}×${DESIGN_HEIGHT}`);
  };

  const loop = new FixedStepLoop(step, render);
  loop.start();

  createTitleScreen(uiRoot, () => {
    running = true;
  });

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.code === 'F3') {
      event.preventDefault();
      debug.toggle();
    } else if (event.code === 'Space') {
      event.preventDefault();
      paused = !paused;
      loop.setPaused(paused);
    }
  });
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="color:#ff6b4a;font:13px/1.7 monospace;padding:24px;white-space:pre-wrap">启动失败：${message}</pre>`;
});
