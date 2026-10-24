/**
 * 线上版本探针：直接打开 GitHub Pages 上的构建，跑一遍"能不能真的玩"。
 *
 * 和 smoke.mjs 的区别：smoke 测的是本地 dist（构建产物本身），
 * 这个测的是**部署后的真实 URL** —— 相对路径、Pages 的子目录、缓存头、
 * 贴图 404 这些都只有部署后才会暴露。
 *
 *   node tools/live-probe.mjs
 *   node tools/live-probe.mjs https://example.com/game/
 */
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'https://gove2004.github.io/20261024/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForFunction(() => window.__dshReady === true, { timeout: 30000 });

const before = await page.evaluate(() => ({
  title: document.title,
  artLoaded: document.querySelectorAll('img').length,
  canvas: Boolean(document.querySelector('#game-canvas')),
}));

// 真的点一次"开始讨伐"，再放两只怪 —— 只加载不开始的探针什么都不算数
await page.click('[data-start]');
await page.waitForTimeout(600);
const played = await page.evaluate(() => {
  const g = window.__game;
  g.hand.forEach((card) => {
    card.cd = 0;
  });
  g.selectCard(0);
  const ok1 = g.place(g.hero.x + 160, g.hero.y + 40);
  g.selected = -1;
  return { state: g.state, placed: ok1, monsters: g.store.activeCount, timeLeft: Math.round(g.timeLeft) };
});
await page.waitForTimeout(2500);
const after = await page.evaluate(() => ({
  state: window.__game.state,
  fps: window.__fps ?? 0,
  monsters: window.__game.store.activeCount,
  missing: document.querySelectorAll('.card img[src=""]').length,
}));

const rows = [
  ['页面标题正确', before.title.includes('锅巴必须死'), before.title],
  ['WebGL 画布挂载', before.canvas, 'canvas #game-canvas'],
  ['游戏初始化完成（__dshReady）', true, 'true'],
  ['点开始后真的进局', played.state === 'playing', `state=${played.state} 剩余=${played.timeLeft}s`],
  ['能成功召唤', played.placed, `activeCount=${played.monsters}`],
  ['运行 2.5 秒无崩溃', after.state === 'playing' || after.state === 'won' || after.state === 'lost', `state=${after.state} 在场=${after.monsters}`],
  ['资源无 4xx/加载失败', failed.length === 0, failed.slice(0, 3).join(' | ') || '全部 200'],
  ['无运行时报错', errors.length === 0, errors.slice(0, 2).join(' | ') || '干净'],
];

let fail = 0;
for (const [name, ok, detail] of rows) {
  if (!ok) fail += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name} — ${detail}`);
}
console.log(`\nURL: ${URL}\n帧率（软件渲染，仅供参考）：${after.fps}`);
await browser.close();
console.log(fail === 0 ? '\nLIVE PASS' : `\nLIVE FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
