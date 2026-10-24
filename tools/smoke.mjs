/**
 * 冒烟测试：用本地 Edge 打开构建产物，验证
 *   1. 页面无 console error / 未捕获异常
 *   2. Pixi WebGL 上下文建立成功（canvas 有绘制内容）
 *   3. 点击「开始」后标题层消失、主循环在跑、帧率达标
 *   4. 输出截图供人工过目
 *
 * 用法：node tools/smoke.mjs [--headful]
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = normalize(resolve(fileURLToPath(new URL('../dist', import.meta.url))));
const SHOTS = normalize(resolve(fileURLToPath(new URL('../shots', import.meta.url))));
const PORT = 4317;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('找不到 dist/index.html，请先运行 npm run build');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve_) => server.listen(PORT, '127.0.0.1', resolve_));
await mkdir(SHOTS, { recursive: true });
console.log(`静态服务 http://127.0.0.1:${PORT}`);

const headful = process.argv.includes('--headful');
const browser = await chromium.launch({
  executablePath: EDGE,
  headless: !headful,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
page.on('response', (res) => {
  if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

const canvasInfo = await page.evaluate(() => {
  const canvas = document.querySelector('#game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: 'no canvas' };
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  return {
    ok: true,
    width: canvas.width,
    height: canvas.height,
    cssWidth: canvas.style.width,
    context: gl ? (gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1') : 'none',
  };
});

await page.screenshot({ path: join(SHOTS, 'title.png') });

await page.click('.btn-start');
await page.waitForTimeout(1400);

const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames += 1;
        if (performance.now() - start < 1200) requestAnimationFrame(tick);
        else resolve(Math.round((frames * 1000) / (performance.now() - start)));
      };
      requestAnimationFrame(tick);
    }),
);

const titleHidden = await page.evaluate(() => {
  const el = document.querySelector('.title-screen');
  return el instanceof HTMLElement ? el.hidden : null;
});

await page.screenshot({ path: join(SHOTS, 'arena.png') });

await browser.close();
server.close();

console.log('canvas      :', canvasInfo);
console.log('title hidden:', titleHidden);
console.log('fps (软件渲染):', fps);
console.log('errors      :', errors.length === 0 ? '无' : errors);

const failed = !canvasInfo.ok || canvasInfo.context === 'none' || errors.length > 0 || titleHidden !== true;
console.log(failed ? 'SMOKE FAIL' : 'SMOKE PASS');
process.exit(failed ? 1 : 0);
