/**
 * 移动端布局探针：用数值断言代替"截图看着没溢出"。
 *
 * 手机（360×640 竖屏）与手机横屏（844×390）各测一次：
 *   - 页面没有横向滚动（scrollWidth <= innerWidth + 1）
 *   - 手牌区不溢出（要么放得下，要么可横向滑动且第一张完整可见）
 *   - 卡牌点击区域不小于 44×44（手指最小可点尺寸）
 *   - 顶部 HUD 与手牌不重叠
 *
 *   node tools/mobile-probe.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const PORT = 4783;
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const cases = [
  { name: '竖屏 360×640', width: 360, height: 640, touch: true },
  { name: '竖屏 430×932', width: 430, height: 932, touch: true },
  { name: '横屏 844×390', width: 844, height: 390, touch: true },
];

let fail = 0;
for (const item of cases) {
  const page = await browser.newPage({
    viewport: { width: item.width, height: item.height },
    hasTouch: item.touch,
    isMobile: item.touch,
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__dshReady === true, { timeout: 20000 });
  await page.click('[data-start]');
  await page.waitForTimeout(300);
  // 塞满手牌：6 张卡同时在场才是最挤的情况
  await page.evaluate(() => window.__game.debugFillHand());
  await page.waitForTimeout(200);

  const m = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const hand = document.querySelector('.hand');
    const cards = [...document.querySelectorAll('.card')].filter((el) => el.style.display !== 'none');
    const firstCard = cards[0]?.getBoundingClientRect() ?? null;
    const top = document.querySelector('.hud-top')?.getBoundingClientRect() ?? null;
    const handRect = hand?.getBoundingClientRect() ?? null;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cards: cards.length,
      firstCard: firstCard ? { w: firstCard.width, h: firstCard.height, x: firstCard.x } : null,
      handScroll: hand ? { client: hand.clientWidth, scroll: hand.scrollWidth } : null,
      overlap: Boolean(top && handRect && top.bottom > handRect.top),
      hudTop: rect('.hud-top'),
      handBox: rect('.hand'),
      timerFont: getComputedStyle(document.querySelector('.timer') ?? document.body).fontSize,
    };
  });

  const rows = [
    ['无横向滚动', m.scrollWidth <= m.innerWidth + 1, `scrollWidth=${m.scrollWidth} viewport=${m.innerWidth}`],
    ['手牌区不顶出屏幕', Boolean(m.handBox && m.handBox.right <= m.innerWidth + 1), `hand.right=${m.handBox?.right?.toFixed(0)}`],
    ['第一张卡完整可见', Boolean(m.firstCard && m.firstCard.x >= -1), `card.x=${m.firstCard?.x?.toFixed(0)}`],
    ['卡牌可点尺寸 ≥44px', Boolean(m.firstCard && m.firstCard.w >= 44 && m.firstCard.h >= 44), `${m.firstCard?.w?.toFixed(0)}×${m.firstCard?.h?.toFixed(0)}`],
    ['顶部 HUD 不压手牌', !m.overlap, m.overlap ? '重叠' : '分离'],
  ];

  // 静音按钮：手机上最容易被忽略的控件，必须能点、且点了有反馈
  const mute = await page.evaluate(() => {
    const btn = document.querySelector('[data-mute]');
    if (!btn) return null;
    const before = btn.textContent;
    btn.click();
    const after = btn.textContent;
    const off = btn.classList.contains('is-off');
    btn.click();
    return { before, after, off, restored: btn.textContent };
  });
  rows.push([
    '静音按钮可切换',
    Boolean(mute && mute.before !== mute.after && mute.off && mute.restored === mute.before),
    mute ? `${mute.before}→${mute.after}→${mute.restored}` : '缺少 [data-mute]',
  ]);

  console.log(`\n${item.name}（${m.cards} 张卡，计时器 ${m.timerFont}）`);
  for (const [name, ok, detail] of rows) {
    if (!ok) fail += 1;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name} — ${detail}`);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(fail === 0 ? '\nMOBILE PASS' : `\nMOBILE FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
