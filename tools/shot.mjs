/**
 * 定点截图：进局 → 等一会 → 按需要裁一块区域放大拍下来。
 *
 * 存在的理由：整屏截图里 46px 的字只有几个像素，视觉模型看不清，
 * 也没法判断"边距差 6px"这种问题。要看局部就裁局部，并且 2x 放大。
 *
 * 用法：
 *   node tools/shot.mjs shots/top.png --clip 0,0,1280,200
 *   node tools/shot.mjs shots/hand.png --clip 300,560,680,160 --wait 2000
 *   node tools/shot.mjs shots/full.png
 *   node tools/shot.mjs shots/x.png --no-start      # 不点开始，停在标题页
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = normalize(resolve(fileURLToPath(new URL('../dist', import.meta.url))));
const PORT = 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('-')) ?? 'shots/shot.png';
const getFlag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const clipRaw = getFlag('--clip', null);
const wait = Number(getFlag('--wait', '1200'));
const doStart = !args.includes('--no-start');
const allCards = args.includes('--all-cards');

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__dshReady === true, { timeout: 20_000 });

if (doStart) {
  await page.click('[data-start]');
  await page.waitForTimeout(wait);
  // 让画面里有东西：塞几只怪（截图用，不影响任何断言）
  await page.evaluate((fillAll) => {
    const g = window.__game;
    if (g.state !== 'playing') return;
    if (fillAll) g.debugFillHand();
    g.starBonus = 55;
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const r = 110 + (i % 3) * 55;
      for (const card of g.hand) card.cd = 0;
      g.selectCard(i % g.hand.length);
      g.place(g.hero.x + Math.cos(a) * r, g.hero.y + Math.sin(a) * r);
    }
    g.selected = -1;
  }, allCards);
  await page.waitForTimeout(1200);
}

const abs = resolve(out);
await mkdir(dirname(abs), { recursive: true });

const options = { path: abs };
if (clipRaw) {
  const [x, y, width, height] = clipRaw.split(',').map(Number);
  options.clip = { x, y, width, height };
}
await page.screenshot(options);

console.log(`已保存 ${out}${clipRaw ? `（裁剪 ${clipRaw}，2x）` : '（整屏 2x）'}`);

await browser.close();
server.close();
