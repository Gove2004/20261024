/**
 * 音频探针：证明"BGM 与 SFX 真的被调度了"，而不是"看代码觉得对"。
 *
 * 无头浏览器里 AudioContext 可能处于 suspended（没有真实用户手势时），
 * 所以这里不要求 state === 'running'，而是统计**振荡器/缓冲源被创建了几次** ——
 * 只要调度次数 > 0，就说明合成链路是通的，真机上只要有手势就会出声。
 *
 *   node tools/audio-probe.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const PORT = 4782;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const body = await readFile(join(ROOT, 'dist', rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('nf');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// 在页面脚本之前挂钩子：统计所有振荡器/增益的创建
await page.addInitScript(() => {
  const stats = { oscillators: 0, gains: 0, buffers: 0, contexts: 0 };
  window.__audioStats = stats;
  const AC = window.AudioContext;
  if (AC) {
    const patched = function patched(...args) {
      stats.contexts += 1;
      const ctx = new AC(...args);
      const createOsc = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = () => {
        stats.oscillators += 1;
        return createOsc();
      };
      const createGain = ctx.createGain.bind(ctx);
      ctx.createGain = () => {
        stats.gains += 1;
        return createGain();
      };
      const createBuffer = ctx.createBuffer.bind(ctx);
      ctx.createBuffer = (...a) => {
        stats.buffers += 1;
        return createBuffer(...a);
      };
      return ctx;
    };
    window.AudioContext = patched;
  }
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__dshReady === true, { timeout: 20000 });

const before = await page.evaluate(() => ({ ...window.__audioStats }));
await page.click('[data-start]');

// 安静窗口：场上没有魔物，只有 BGM 应该在响。
// 这一段的意义是"证明 BGM 真的在跑"，否则总量里全是战斗音效，测不出背景音乐。
await page.waitForTimeout(3000);
const quiet = await page.evaluate(() => ({ ...window.__audioStats }));

// 手动触发一组有代表性的音效事件（都走游戏自己的事件钩子）
await page.evaluate(() => {
  const g = window.__game;
  for (const card of g.hand) card.cd = 0;
  for (let i = 0; i < 6; i += 1) {
    g.selectCard(i % g.hand.length);
    g.place(g.hero.x + Math.cos(i) * 150, g.hero.y + Math.sin(i) * 150);
  }
  g.selected = -1;
});
await page.waitForTimeout(2500);

const after = await page.evaluate(() => ({
  stats: { ...window.__audioStats },
  ctxState: (() => {
    try {
      return window.__game?.audio?.context?.()?.state ?? 'n/a';
    } catch {
      return 'n/a';
    }
  })(),
  hasAudio: Boolean(window.__game && 'audio' in window.__game),
}));

const delta = {
  oscillators: after.stats.oscillators - before.oscillators,
  gains: after.stats.gains - before.gains,
  contexts: after.stats.contexts - before.contexts,
};
const quietOsc = quiet.oscillators - before.oscillators;
const combatOsc = after.stats.oscillators - quiet.oscillators;

const rows = [
  ['AudioContext 被创建', after.stats.contexts > 0, `contexts=${after.stats.contexts}`],
  ['安静时 BGM 在调度', quietOsc >= 4, `安静 3 秒 +${quietOsc} oscillators`],
  ['战斗音效被调度', combatOsc >= 6, `+${combatOsc} oscillators`],
  ['增益节点被调度', delta.gains > 0, `+${delta.gains} gains`],
  ['无运行时报错', errors.length === 0, errors.slice(0, 2).join(' | ') || '干净'],
];

let fail = 0;
for (const [name, ok, detail] of rows) {
  if (!ok) fail += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name} — ${detail}`);
}
console.log(`\nAudioContext state: ${after.ctxState}`);
await browser.close();
server.close();
console.log(fail === 0 ? '\nAUDIO PASS' : `\nAUDIO FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
