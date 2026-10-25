import { Application, Container } from 'pixi.js';
import { CAM_ZOOM } from '../content/config';

/** 设计分辨率。所有关卡/UI 坐标都以此为准，实际屏幕靠等比缩放适配。 */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

export interface Stage {
  readonly app: Application;
  /** 1280×720 设计坐标系；负责等比缩放与居中（letterbox）。 */
  readonly screen: Container;
  /** 逻辑世界层：镜头变换只作用于这一层。 */
  readonly world: Container;
  /** 特效层：位于世界之上，同样受镜头影响。 */
  readonly fx: Container;
  /** 重算画布尺寸与缩放，窗口变化时调用。 */
  resize(): void;
  destroy(): void;
}

/**
 * 判断当前 WebGL 是不是**软件光栅化**（SwiftShader / llvmpipe / 没有独显的兜底）。
 *
 * 为什么要问这个：这套画面是"暗底 + 大量半透明贴图 + 全屏地面"，
 * MSAA（`antialias: true`）在软件光栅化下要把每个像素采样 4 次 ——
 * 实测同一台机器、同一个场景：开 MSAA 12~18fps，关掉 34~49fps。
 * 真机有 GPU 时 MSAA 的代价可以忽略，所以这里只在"确认是软件渲染"时降级：
 * 宁可边缘有一点点锯齿，也不能让人看着幻灯片玩游戏。
 */
function isSoftwareRenderer(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (gl === null) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(String(name));
  } catch {
    return false;
  }
}

/**
 * 初始化 Pixi 应用。
 *
 * 关键选择：
 * - `autoStart: false` —— 渲染时机由我们的 FixedStepLoop 控制，避免 Pixi 自己的
 *   ticker 与逻辑循环各跑各的（这是"手感发飘"的常见根源）。
 * - `preference: 'webgl'` —— 移动端 WebGPU 驱动仍不稳定，WebGL2 的兼容性收益更大。
 * - `resolution` 上限 2 —— 3x 屏上用 3 倍分辨率，像素数翻 2.25 倍但肉眼无差。
 * - `antialias` 见 `isSoftwareRenderer()`：只有软件渲染才关，硬件渲染保持开启。
 */
export async function createStage(canvas: HTMLCanvasElement): Promise<Stage> {
  const app = new Application();

  await app.init({
    canvas,
    width: DESIGN_WIDTH,
    height: DESIGN_HEIGHT,
    autoDensity: true,
    antialias: !isSoftwareRenderer(),
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoStart: false,
    preference: 'webgl',
    background: 0x0b0a14,
  });

  const screen = new Container();
  screen.label = 'screen';

  const world = new Container();
  world.label = 'world';
  // 世界层整体缩放（见 config.CAM_ZOOM）：镜头仍然跟随，但看得见大半个战场
  world.scale.set(CAM_ZOOM);

  const fx = new Container();
  fx.label = 'fx';

  screen.addChild(world, fx);
  app.stage.addChild(screen);

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    app.renderer.resize(width, height);

    const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
    screen.scale.set(scale);
    screen.position.set(
      Math.round((width - DESIGN_WIDTH * scale) / 2),
      Math.round((height - DESIGN_HEIGHT * scale) / 2),
    );
  };

  resize();
  window.addEventListener('resize', resize);

  return {
    app,
    screen,
    world,
    fx,
    resize,
    destroy: (): void => {
      window.removeEventListener('resize', resize);
      app.destroy(true, { children: true });
    },
  };
}
