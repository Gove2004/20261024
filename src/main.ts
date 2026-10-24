import './style.css';
import { FixedStepLoop } from './core/loop';
import { createRng } from './core/rng';
import { VIEW } from './content/config';
import { AI } from './content/heroAi';
import { Game, type GameEvents } from './gameplay/game';
import { loadArt, missingArt } from './render/art';
import { Scene } from './render/scene';
import { createStage } from './render/stage';
import { Hud } from './ui/hud';

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  const uiRoot = document.querySelector<HTMLElement>('#ui');
  if (!canvas || !uiRoot) throw new Error('缺少 #game-canvas 或 #ui');

  const stage = await createStage(canvas);
  const scene = new Scene(stage, createRng(0x5eed1));

  // 贴图异步加载，缺图就继续用程序化造型 —— 美术不该阻塞开局
  const art = await loadArt();
  scene.setArt(art);
  const gaps = missingArt(art);
  if (gaps.length > 0) console.warn(`缺贴图（用占位造型）：${gaps.join(', ')}`);

  // 进游戏后立刻渲染第一帧，避免标题页是一片纯色
  let game!: Game;

  const events: GameEvents = {
    onSpawn: (slot) => {
      const def = game.store;
      scene.fx.burst(def.x[slot] ?? 0, def.y[slot] ?? 0, 0x9b6bff, 10, 34);
    },
    onDeath: (slot) => {
      const store = game.store;
      scene.fx.burst(store.x[slot] ?? 0, store.y[slot] ?? 0, 0xd8d0e8, 12, 26);
      scene.fx.ring(store.x[slot] ?? 0, store.y[slot] ?? 0, 22, 0xff3b5c, 2);
    },
    onHeroHurt: () => undefined,
    onHeroLevel: () => {
      scene.fx.ring(game.hero.x, game.hero.y, 90, 0xffb347, 5);
      scene.fx.burst(game.hero.x, game.hero.y - 20, 0xffb347, 18, 50);
    },
    onSwing: () => undefined,
    onQi: (x, y, dirX, dirY) => {
      scene.fx.slash(x, y, dirX, dirY, AI.qiLength, AI.qiHalfWidth * 2);
    },
    onRangedShot: (_slot, fromX, fromY, toX, toY) => {
      // 只画"飞在半路的一段"：全长实线会被看成一根绑在勇者身上的白绳，
      // 短促的斜光带才像弹道。
      const dx = toX - fromX;
      const dy = toY - fromY;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const start = len * 0.5;
      scene.fx.slash(fromX + ux * start, fromY + uy * start, ux, uy, Math.min(58, len * 0.4), 2);
    },
    onDetonate: (x, y, radius) => {
      scene.fx.ring(x, y, radius, 0xc06bd8, 6);
      scene.fx.burst(x, y, 0xc06bd8, 22, radius);
    },
    onTelegraph: (x, y, radius, duration) => {
      scene.fx.telegraph(x, y, radius, duration);
    },
    onEffect: (kind, x, y, radius) => {
      if (kind === 'heal') {
        scene.fx.ring(x, y, radius, 0x7be05f, 3);
        scene.fx.burst(x, y, 0x9be07a, 12, radius * 0.7);
      } else if (kind === 'freeze') {
        scene.fx.ring(x, y, radius, 0x8fd7ff, 5);
        scene.fx.burst(x, y, 0x8fd7ff, 20, radius);
      } else if (kind === 'taunt') {
        scene.fx.ring(x, y, radius, 0xffb347, 4);
      } else {
        scene.fx.burst(x, y, 0xff7a3c, 26, radius);
      }
    },
    toast: (text, kind) => hud.toast(text, kind ?? 'info'),
    onPowerup: (options) => hud.showPowerup(options),
    onFinish: (won) => hud.showResult(won, game),
  };

  const hud = new Hud(uiRoot, {
    onStart: () => {
      game.start();
      scene.reset();
      hud.hideOverlay();
      hud.setVisible(true);
    },
    onRestart: () => {
      game.start();
      scene.reset();
      hud.hideOverlay();
      hud.setVisible(true);
    },
    onCard: (index) => game.selectCard(index),
    onPowerup: (id) => {
      game.choosePowerup(id);
      hud.hideOverlay();
    },
    onPause: () => game.togglePause(),
  });

  game = new Game(events);
  hud.setVisible(false);
  hud.showTitle();

  // ---------------------------------------------------------------- 输入

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const scale = stage.screen.scale.x || 1;
    const designX = (clientX - rect.left - stage.screen.position.x) / scale;
    const designY = (clientY - rect.top - stage.screen.position.y) / scale;
    return {
      x: designX + (game.camX - VIEW.w / 2),
      y: designY + (game.camY - VIEW.h / 2),
    };
  };

  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    if (game.state !== 'playing') return;
    const point = toWorld(event.clientX, event.clientY);

    if (game.selected >= 0) {
      game.place(point.x, point.y);
      return;
    }

    const now = performance.now();
    const isDouble =
      now - lastClickAt < 300 && Math.hypot(event.clientX - lastClickX, event.clientY - lastClickY) < 30;
    if (isDouble) {
      game.tryDetonate(point.x, point.y);
      lastClickAt = 0;
      return;
    }
    lastClickAt = now;
    lastClickX = event.clientX;
    lastClickY = event.clientY;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (game.state !== 'playing' || game.selected < 0) {
      scene.setPreview(null);
      return;
    }
    const point = toWorld(event.clientX, event.clientY);
    scene.setPreview({ x: point.x, y: point.y, ok: game.placementError(point.x, point.y) === null });
  });

  canvas.addEventListener('pointerleave', () => scene.setPreview(null));

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      if (game.state === 'playing' || game.state === 'paused') game.togglePause();
    }
    if (event.code === 'Escape') game.selected = -1;
    if (event.code === 'F3') {
      document.body.classList.toggle('debug');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') game.togglePause();
  });

  // ---------------------------------------------------------------- 主循环

  const startTime = performance.now();
  let frames = 0;
  let fpsAt = startTime;
  let hudTick = 0;

  const loop = new FixedStepLoop(
    (dt) => {
      game.update(dt);
    },
    () => {
      const now = performance.now();
      scene.sync(game, 0, (now - startTime) / 1000);
      // HUD 走 DOM，每帧都写会触发大量样式重算；15Hz 足够读，且省下主线程时间
      hudTick = (hudTick + 1) % 4;
      if (hudTick === 0) hud.update(game);
      stage.app.render();

      frames += 1;
      if (now - fpsAt >= 1000) {
        // 冒烟测试读这个值判断是不是卡死
        (window as unknown as { __fps?: number }).__fps = frames;
        frames = 0;
        fpsAt = now;
      }
    },
  );

  loop.start();

  // 供冒烟测试 / 调试台使用
  (window as unknown as { __game?: Game }).__game = game;
  (window as unknown as { __dshReady?: boolean }).__dshReady = true;
}

void bootstrap();
