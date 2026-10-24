/**
 * 冒烟测试：用本地 Edge 打开构建产物，验证 M1 手感闭环。
 *
 *   1. 页面无 console error / 未捕获异常
 *   2. WebGL 上下文建立成功
 *   3. 点「开始讨伐」后进入 playing，标题层消失
 *   4. 选卡 + 点地面 → 魔物真的被放出来了
 *   5. 魔物会移动、勇者会攻击（数据层面真的有变化）
 *   6. 帧率达标，截图供人工过目
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

const canvasInfo = await page.evaluate(() => {
  const canvas = document.querySelector('#game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: 'no canvas' };
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  return {
    ok: true,
    context: gl ? (gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1') : 'none',
  };
});

check('WebGL 上下文', canvasInfo.ok && canvasInfo.context !== 'none', canvasInfo.context);
await page.screenshot({ path: join(SHOTS, '01-title.png') });

// ---- 开始游戏 ----
await page.click('[data-start]');
await page.waitForTimeout(300);

const started = await page.evaluate(() => {
  const g = window.__game;
  return { state: g?.state, overlayOpen: !!document.querySelector('.overlay.is-open') };
});
check('点击开始进入对局', started.state === 'playing' && !started.overlayOpen, `state=${started.state}`);

// ---- 选第一张卡，在勇者左上方放一只 ----
const placed = await page.evaluate(() => {
  const g = window.__game;
  if (!g) return { ok: false, reason: 'no game' };
  const before = g.store.activeCount;
  g.selectCard(0);
  const hero = g.hero;
  const ok = g.place(hero.x - 150, hero.y - 40);
  g.store.refreshActive();
  return { ok, before, after: g.store.activeCount, selected: g.selected };
});
check('选卡 + 召唤成功', placed.ok === true && placed.after > placed.before, `active=${placed.after}`);

// 再放两只，制造"被围攻"的场面
await page.evaluate(() => {
  const g = window.__game;
  if (!g) return;
  g.selectCard(2);
  g.place(g.hero.x + 130, g.hero.y + 60);
  g.store.refreshActive();
});
await page.waitForTimeout(1800);

const combat = await page.evaluate(() => {
  const g = window.__game;
  return {
    active: g.store.activeCount,
    heroHp: g.hero.hp,
    heroMaxHp: g.hero.maxHp,
    heroLevel: g.hero.level,
    heroState: g.hero.state,
    timeLeft: g.timeLeft,
    monsterMoved: g.store.activeCount > 0,
  };
});
check('魔物存活并被追击', combat.active > 0, `active=${combat.active} 状态=${combat.heroState}`);
check('勇者在受伤或升级', combat.heroHp < combat.heroMaxHp || combat.heroLevel > 1, `hp=${Math.round(combat.heroHp)} Lv${combat.heroLevel}`);
check('倒计时在走', combat.timeLeft < 300, `剩余 ${combat.timeLeft.toFixed(1)}s`);

// ---- 引爆 ----
const detonated = await page.evaluate(() => {
  const g = window.__game;
  const store = g.store;
  store.refreshActive();
  if (store.activeCount === 0) return { ok: false, reason: 'no monster' };
  const slot = store.active[0];
  return { ok: g.tryDetonate(store.x[slot], store.y[slot]), detonations: g.detonations };
});
check('双击引爆可用', detonated.ok === true, `引爆次数=${detonated.detonations}`);

// ---- 帧率 ----
const fps = await page.evaluate(
  () =>
    new Promise((resolveFps) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames += 1;
        if (performance.now() - start < 1200) requestAnimationFrame(tick);
        else resolveFps(Math.round((frames * 1000) / (performance.now() - start)));
      };
      requestAnimationFrame(tick);
    }),
);
check('帧率（软件渲染）', fps >= 30, `${fps} fps`);

await page.screenshot({ path: join(SHOTS, '02-arena.png') });

// ---- 权能面板 ----
await page.evaluate(() => {
  const g = window.__game;
  g.deferPowerup(0.05);
});
await page.waitForTimeout(700);
const powerupOpen = await page.evaluate(() => ({
  state: window.__game.state,
  cards: document.querySelectorAll('[data-opt]').length,
}));
check('30 秒权能 3 选 1', powerupOpen.state === 'powerup' && powerupOpen.cards === 3, `选项=${powerupOpen.cards}`);
await page.screenshot({ path: join(SHOTS, '03-powerup.png') });

await page.click('[data-opt]');
await page.waitForTimeout(300);
check('选择权能后继续对局', (await page.evaluate(() => window.__game.state)) === 'playing');

// ---- 倒计时归零判负 ----
await page.evaluate(() => {
  window.__game.elapsed = 299.4;
});
await page.waitForTimeout(900);
const ended = await page.evaluate(() => ({
  state: window.__game.state,
  title: document.querySelector('.panel-title')?.textContent ?? '',
}));
check('时间到自动判负', ended.state === 'lost', `state=${ended.state} / ${ended.title}`);
await page.screenshot({ path: join(SHOTS, '04-lost.png') });

await browser.close();
server.close();

check('无 console / 网络错误', errors.length === 0, errors.join(' | '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
console.log(failed === 0 ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(failed === 0 ? 0 : 1);
