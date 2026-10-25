import './style.css';
// 移动端覆盖层必须在 style.css 之后导入：它整段都是媒体查询，
// 靠"后出现"压过基础规则（同优先级下后者胜）。
// 走 JS 导入而不是 index.html 里的 <link>：Vite 构建时会把 html 里指向
// /src/*.css 的 link 直接丢掉，样式表就静默消失了（踩过）。
import './style-mobile.css';
import { audio, updateAudio } from './audio';
import { FixedStepLoop } from './core/loop';
import { createRng } from './core/rng';
import { CAM_ZOOM, RUN, VIEW } from './content/config';
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

  /** 静音是纯 UI 状态，不需要进 Game 的确定性状态里 */
  let muted = false;

  const stage = await createStage(canvas);
  const scene = new Scene(stage, createRng(0x5eed1));

  // 贴图异步加载，缺图就继续用程序化造型 —— 美术不该阻塞开局
  const art = await loadArt();
  scene.setArt(art);
  const gaps = missingArt(art);
  if (gaps.length > 0) console.warn(`缺贴图（用占位造型）：${gaps.join(', ')}`);

  // 进游戏后立刻渲染第一帧，避免标题页是一片纯色
  let game!: Game;
  /** 顿帧剩余帧数（见主循环） */
  let hitStop = 0;
/** 普通命中的飘字节流：每 4 下发 3 个，暴击永远发（防糊屏，见 onMonsterHit） */
let hitTick = 0;
  /** 星级里程碑去重（见渲染回调） */
  let lastStarTier = 0;
  /** 跑动尘土的锚点（见渲染回调） */
  let dustX = 0;
  let dustY = 0;

  const events: GameEvents = {
    onSpawn: (slot) => {
      const def = game.store;
      const sx = def.x[slot] ?? 0;
      const sy = def.y[slot] ?? 0;
      // 召唤落地：一圈紫环 + 向上溅的碎屑，"从地里冒出来"比凭空出现好读
      scene.fx.ring(sx, sy, 26, 0x9b6bff, 3);
      scene.fx.burst(sx, sy, 0x9b6bff, 10, 30);
      audio.onSpawn(def.star[slot] ?? 1);
    },
    onDeath: (slot) => {
      const store = game.store;
      scene.fx.burst(store.x[slot] ?? 0, store.y[slot] ?? 0, 0xd8d0e8, 12, 26);
      scene.fx.ring(store.x[slot] ?? 0, store.y[slot] ?? 0, 22, 0xff3b5c, 2);
      // 大怪死才有分量：5★ 以上给一次抖动 + 两帧顿帧，杂兵死了不该顿
      const star = store.star[slot] ?? 1;
      if (star >= 5) {
        scene.shake(2 + star * 0.35);
        hitStop = Math.max(hitStop, 2);
      }
      audio.onDeath();
    },
    onHeroHurt: (amount) => {
      scene.shake(2.2);
      // 锅巴掉血必须有数字：上帝视角下"我以为我的怪在打他"和"他真的在掉血"是两件事
      scene.fx.heroDamage(game.hero.x, game.hero.y, amount);
      audio.onHeroHurt();
    },
    onMonsterHit: (x, y, amount, crit) => {
      // 普通命中只抖一半的数字：屏幕上有 20 只怪时，每一下都飘一个数字
      // 会糊成一片（用户反馈「特效有点散」）。暴击永远显示。
      if (crit || (hitTick = (hitTick + 1) & 3) !== 3) scene.fx.damage(x, y, amount, crit);
      // 普通命中每 3 次给一次小火星（方向 = 他→目标）：
      // 不加火星，多只怪互殴时屏幕上完全没有"命中"的反馈；全都加又糊屏。
      if (!crit && (hitTick & 1) === 0) {
        scene.fx.burst(x, y, 0xfff0d0, 3, 12, x - game.hero.x, y - game.hero.y);
      }
      // 打击感：只有暴击才给火花 + 顿帧。每一下都炸火花会糊屏，也会拖死软件渲染
      // （爆发池只有 20 个），所以把"重"留给稀有的那一下。
      if (crit) {
        // 溅射方向取"他→目标"，看起来就是被这一发打飞的
        scene.fx.burst(x, y, 0xffd08a, 6, 18, x - game.hero.x, y - game.hero.y);
        scene.shake(1.4);
        hitStop = Math.max(hitStop, 1);
        audio.onCritHit();
      }
    },
    onSkillLabel: (text, kind) => {
      const color =
        kind === 'qi' ? 0xa9e7ff : kind === 'bomb' ? 0xffc46b : kind === 'roll' ? 0xc7b6ff : 0x9be07a;
      scene.fx.label(game.hero.x, game.hero.y, text, color);
      // 同一条信息也给 HUD 一份：飘字在战场中央一闪就过，
      // 而玩家看勇者进度时的视线在左上角（用户反馈「看不出来他在用什么技能」）
      hud.skillCast(text);
    },
    onHeroLevel: (level, passive) => {
      scene.fx.ring(game.hero.x, game.hero.y, 90, 0xffb347, 5);
      scene.fx.burst(game.hero.x, game.hero.y - 20, 0xffb347, 18, 50);
      hud.levelUp(level, passive);
      audio.onHeroLevel();
    },
    onShot: (x, y, dirX, dirY) => {
      // 弹丸：一小段发亮的短划 + 一点火星，朝射击方向飞出
      scene.fx.slash(x + dirX * 22, y + dirY * 22 - 12, dirX, dirY, 34, 5);
      scene.fx.burst(x + dirX * 26, y + dirY * 26 - 12, 0xffe1a8, 4, 10);
      // 弹弓释放暂时复用挥击音（都是"快速空气声"），M5 再单独做弓弦
      audio.onSwing();
    },
    onQi: (x, y, dirX, dirY) => {
      scene.fx.slash(x, y, dirX, dirY, AI.qiLength, AI.qiHalfWidth * 2);
      audio.onQi();
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
    onBlast: (x, y, radius) => {
      scene.fx.ring(x, y, radius, 0xff7a3c, 6);
      scene.fx.burst(x, y, 0xff7a3c, 22, radius);
      scene.shake(4.5);
      hitStop = Math.max(hitStop, 3);
      // 语义一致：都是"范围爆炸"，直接沿用引爆音
      audio.onDetonate();
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
      } else if (kind === 'summon') {
        scene.fx.ring(x, y, radius, 0x9b5bff, 5);
        scene.fx.burst(x, y, 0xc79bff, 16, radius * 0.8);
      } else {
        scene.fx.burst(x, y, 0xff7a3c, 26, radius);
      }
    },
    toast: (text, kind) => hud.toast(text, kind ?? 'info'),
    onPowerupWarning: (seconds) => {
      hud.showPowerupWarning(seconds);
      audio.onPowerupWarning();
    },
    onPowerup: (options) => {
      audio.onPowerupOpen();
      // 波次报幕放在面板弹出之前：玩家先读到"第 N 波"，再看到三选一，
      // 顺序反了就成了"面板突然糊你一脸"。
      const wave = Math.floor((RUN.duration - game.timeLeft) / 30) + 1;
      hud.sceneBanner(`第 ${wave} 波`, '权能降临 · 3 选 1', 1200);
      hud.showPowerup(options);
    },
    onFinish: (won) => {
      audio.onFinish(won);
      hud.showResult(won, game);
    },
  };

  const hud = new Hud(uiRoot, {
    onStart: () => {
      // 标题页的"开始"是第一个可靠手势，AudioContext 必须在这里创建
      audio.unlock();
      game.start();
      scene.reset();
      hud.clearPerks();
      hud.hideOverlay();
      hud.setVisible(true);
      // 分段报幕：先"魔王殿"，再"第 1 波 + 怎么玩"。副标题在 1.6s 后换掉，
      // 是因为玩家第一个动作发生在那儿 —— 报幕结束正好接上操作提示。
      hud.playIntro();
    },
    onRestart: () => {
      audio.unlock();
      game.start();
      scene.reset();
      hud.clearPerks();
      hud.hideOverlay();
      hud.setVisible(true);
      hud.playIntro();
    },
    onCard: (index) => game.selectCard(index),
    onPowerup: (id) => {
      game.choosePowerup(id);
      hud.hideOverlay();
      audio.onPowerupClose();
    },
    onPause: () => {
      // 暂停必须有可见反馈：之前只改了 game.state，画面上毫无变化，
      // 玩家会以为按钮坏了（这是用户实测反馈）。
      if (game.state === 'playing' || game.state === 'paused') {
        game.togglePause();
        if (game.state === 'paused') hud.showPause();
        else hud.hideOverlay();
        audio.setPaused(game.state === 'paused');
      }
    },
    onToggleMute: () => {
      muted = !muted;
      audio.setMuted(muted);
      hud.setMuted(muted);
    },
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
    // 世界层有 CAM_ZOOM 缩放：设计坐标要除回去才是世界坐标，
    // 否则指针位置和召唤落点会整体偏移（缩放越大偏得越多）。
    return {
      x: designX / CAM_ZOOM + (game.camX - VIEW.w / 2 / CAM_ZOOM),
      y: designY / CAM_ZOOM + (game.camY - VIEW.h / 2 / CAM_ZOOM),
    };
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (game.state !== 'playing') return;
    if (game.selected < 0) return;
    const point = toWorld(event.clientX, event.clientY);
    game.place(point.x, point.y);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (game.state !== 'playing' || game.selected < 0) {
      scene.setPreview(null);
      return;
    }

    const point = toWorld(event.clientX, event.clientY);
    scene.setPreview({ x: point.x, y: point.y, ok: game.placementError(point.x, point.y) === null });
  });

  canvas.addEventListener('pointerleave', () => {
    scene.setPreview(null);
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      if (game.state === 'playing' || game.state === 'paused') {
        game.togglePause();
        if (game.state === 'paused') hud.showPause();
        else hud.hideOverlay();
        audio.setPaused(game.state === 'paused');
      }
    }
    if (event.code === 'Escape') game.selected = -1;
    if (event.code === 'KeyM') {
      muted = !muted;
      audio.setMuted(muted);
      hud.setMuted(muted);
    }
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
      // 顿帧：命中瞬间把逻辑停 2–3 帧（约 33–50ms），渲染照跑。
      // 这是打击感里性价比最高的一件事 —— 不做它，再漂亮的粒子也像"贴图在动"。
      if (hitStop > 0) {
        hitStop -= 1;
        return;
      }
      game.update(dt);
    },
    () => {
      const now = performance.now();
      scene.sync(game, 0, (now - startTime) / 1000);
      updateAudio(game);

      // 跑动尘土：他每走 34px 撒一点灰。
      // 这是让玩家"看见他在拉扯"最便宜的办法 —— 走位本身是抽象的，
      // 地面上留下的尘土轨迹会让"他在绕圈"变成一眼就能读出来的画面。
      if (game.state === 'playing') {
        const dx = game.hero.x - dustX;
        const dy = game.hero.y - dustY;
        if (dx * dx + dy * dy > 60 * 60) {
          dustX = game.hero.x;
          dustY = game.hero.y;
          scene.fx.burst(dustX, dustY + 10, 0x6b6478, 2, 8);
        }
      }
      // 星级里程碑（20/40/60）：玩家在上帝视角里数不清星，靠声音判断"这波铺大了"
      const tier = game.peakStars >= 60 ? 3 : game.peakStars >= 40 ? 2 : game.peakStars >= 20 ? 1 : 0;
      if (tier !== lastStarTier) {
        lastStarTier = tier;
        if (tier > 0) audio.onStarMilestone(tier);
      }
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
  // 截图工具用：相机平时跟着锅巴，看不到完整房间，改布局时没法验收
  (window as unknown as { __stage?: unknown }).__stage = stage;
  (window as unknown as { __dshReady?: boolean }).__dshReady = true;
}

void bootstrap();
