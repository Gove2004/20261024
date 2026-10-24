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

/**
 * 空页面基线：fps 断言必须能区分"游戏慢"和"机器被别的进程占满"。
 * 这台机器上微信/Doubao/一堆 webview 常年吃掉一半 CPU，只报绝对 fps 会天天飘红。
 */
const measureFps = () =>
  page.evaluate(
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
await page.goto('about:blank');
const baselineFps = await measureFps();

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

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });// 贴图异步加载完成后才置 __dshReady；不等它就直接读 __game 会偶发 undefined
await page.waitForFunction(() => window.__dshReady === true, { timeout: 20_000 });

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
// 手动推进 3 秒：不依赖真实帧率，断言才稳定（headless 下 RAF 会被节流）
// 5 秒：开局手牌只有 3 张低星怪，他蓄力 0.22s，两发命中才够杀一只
await page.evaluate(() => {
  const g = window.__game;
  for (let i = 0; i < 300; i += 1) g.update(1 / 60);
});

const combat = await page.evaluate(() => {
  const g = window.__game;
  let monsterHpRatio = 1;
  if (g.store.activeCount > 0) {
    let hp = 0;
    let maxHp = 0;
    for (let i = 0; i < g.store.activeCount; i += 1) {
      const slot = g.store.active[i];
      if (slot === undefined) continue;
      hp += g.store.hp[slot] ?? 0;
      maxHp += g.store.maxHp[slot] ?? 0;
    }
    monsterHpRatio = maxHp > 0 ? hp / maxHp : 1;
  }
  return {
    active: g.store.activeCount,
    kills: g.kills,
    heroHp: g.hero.hp,
    heroMaxHp: g.hero.maxHp,
    heroLevel: g.hero.level,
    heroState: g.hero.state,
    gameState: g.state,
    heroTarget: g.hero.target,
    heroWindup: Number(g.hero.windup.toFixed(2)),
    timeLeft: g.timeLeft,
    monsterHpRatio,
    heroDist: g.store.activeCount > 0
      ? Math.round(Math.hypot((g.store.x[g.store.active[0]] ?? 0) - g.hero.x, (g.store.y[g.store.active[0]] ?? 0) - g.hero.y))
      : -1,
  };
});
check('魔物存活并被追击', combat.active > 0, `active=${combat.active} 状态=${combat.heroState} game=${combat.gameState}`);
check('他在输出（已击杀魔物）', combat.kills > 0, `击杀 ${combat.kills}`);
check(
  '他会拉开距离（不贴脸硬顶）',
  combat.heroDist > 60 || combat.active === 0,
  `与最近的怪 ${combat.heroDist}px`,
);
// 再推进 10 秒：他是远程、会边打边退，所以先摆一圈怪把他围住 —— 他必须真的会挨打
const late = await page.evaluate(() => {
  const g = window.__game;
  g.debugFillHand();
  let put = 0;
  for (let i = 0; i < 8; i += 1) {
    const card = g.hand[i];
    if (!card) continue;
    card.charges = card.maxCharges; card.cd = 0;
    g.selectCard(i);
    const a = (i / 8) * Math.PI * 2;
    const ok = g.place(g.hero.x + Math.cos(a) * 120, g.hero.y + Math.sin(a) * 120);
    g.selected = -1;
    if (ok) put += 1;
  }
  for (let i = 0; i < 600; i += 1) g.update(1 / 60);
  return {
    put,
    hp: g.hero.hp,
    maxHp: g.hero.maxHp,
    level: g.hero.level,
    kills: g.kills,
    state: g.state,
  };
});
check(
  '他最终会受伤或升级',
  late.hp < late.maxHp || late.level > 1,
  `围了${late.put}只 hp=${Math.round(late.hp)}/${Math.round(late.maxHp)} Lv${late.level} 击杀${late.kills}`,
);
check('倒计时在走', combat.timeLeft < 300, `剩余 ${combat.timeLeft.toFixed(1)}s`);

// ---- 纯远程：把一只怪摆在 260px 外，他必须能打到（近战单位打不到） ----
const ranged = await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.debugFillHand();
  const idx = g.hand.findIndex((card) => card.id === 'shaman');
  if (idx < 0) return { ok: false, reason: 'no card' };
  g.selectCard(idx);
  const dist = 268;
  const placed = g.place(g.hero.x + dist, g.hero.y);
  g.selected = -1;
  if (!placed) return { ok: false, reason: 'place failed' };
  g.store.refreshActive();
  const slot = g.store.active[0];
  const startHp = g.store.hp[slot] ?? 0;
  // 让他有时间瞄准 + 开火，但不要久到怪自己走上来贴身
  for (let i = 0; i < 60 * 2; i += 1) g.update(1 / 60);
  const nowHp = g.store.hp[slot] ?? 0;
  const d = Math.hypot((g.store.x[slot] ?? 0) - g.hero.x, (g.store.y[slot] ?? 0) - g.hero.y);
  return { ok: nowHp < startHp, startHp, nowHp, dist: Math.round(d) };
});
check(
  '纯远程：260px 外他能打到',
  ranged.ok === true,
  `hp ${Math.round(ranged.startHp ?? 0)}→${Math.round(ranged.nowHp ?? 0)}，开火时距离 ${ranged.dist ?? '-'}px`,
);

// ---- 魔物主动特性（M2）：每张功能性卡都必须真的动起来 ----
const abilities = await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.debugFillHand();
  // 摆成一圈围住他：他是远程会往后撤，摆在对角线上他就打不到、也聚不起来
  let n = 0;
  const put = (id, dist) => {
    const idx = g.hand.findIndex((card) => card.id === id);
    if (idx < 0) return false;
    g.debugRefill();
    g.selectCard(idx);
    const a = (n / 8) * Math.PI * 2 + 0.4;
    n += 1;
    const ok = g.place(g.hero.x + Math.cos(a) * dist, g.hero.y + Math.sin(a) * dist);
    g.selected = -1;
    return ok;
  };
  const placed = {
    boom: put('boom', 130),
    shaman: put('shaman', 160),
    spider: put('spider', 220),
    ghost: put('ghost', 120),
    slime: put('slime', 110),
  };
  let steps = 0;
  for (let i = 0; i < 60 * 14; i += 1) {
    g.update(1 / 60);
    steps += 1;
    if (g.state !== 'playing') break;
  }
  return {
    placed,
    boom: g.statBoom,
    heal: g.statHeal,
    spiderShot: g.statRanged,
    alive: g.store.activeCount,
    steps,
  };
});
check('自爆虫会点引信并引爆', abilities.boom > 0, `引爆 ${abilities.boom} 次`);
check('巫医会治疗友军', abilities.heal > 0, `治疗 ${abilities.heal} 次`);
check('毒蜘蛛会远程开火', abilities.spiderShot > 0, `远程弹 ${abilities.spiderShot} 次`);

// ---- M3：勇者技能池必须真的轮得动 ----
const skills = await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.debugFillHand();
  // 全部压成 1 星：debugFillHand 给的是高星怪，20 秒内他打不死任何一只，
  // 就测不出"升级 → 拿被动"这条链路了。
  for (const card of g.hand) card.star = 1;
  // 摆一大坨：散射/爆弹要"够多"才会触发，围住才会触发翻滚
  let put = 0;
  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < 6; i += 1) {
      const idx = (i + round * 6) % g.hand.length;
      const card = g.hand[idx];
      if (!card) continue;
      card.charges = card.maxCharges; card.cd = 0;
      g.selectCard(idx);
      const a = (i / 6) * Math.PI * 2 + round;
      const ok = g.place(g.hero.x + Math.cos(a) * (120 + round * 60), g.hero.y + Math.sin(a) * (120 + round * 60));
      g.selected = -1;
      if (ok) put += 1;
    }
  }
  // 逼出「干粮」：把血压到 35%，他才会吃
  g.hero.hp = g.hero.maxHp * 0.35;
  let topUp = 0;
  for (let i = 0; i < 60 * 45; i += 1) {
    // 每 3 秒补两只 1 星怪：不补的话他会把场上清空，后半程就在空跑
    if (i % 180 === 0) {
      for (let k = 0; k < 2; k += 1) {
        const idx = (i / 180 + k) % g.hand.length;
        const card = g.hand[idx];
        if (!card) continue;
        card.charges = card.maxCharges; card.cd = 0;
        g.selectCard(idx);
        const a = (i / 180 + k) * 1.9;
        const ok = g.place(g.hero.x + Math.cos(a) * (150 + k * 40), g.hero.y + Math.sin(a) * (150 + k * 40));
        g.selected = -1;
        if (ok) topUp += 1;
      }
    }
    // 30 秒会弹权能三选一，测试里直接选升星继续，别让对局停在那儿
    if (g.state === 'powerup') g.choosePowerup('star');
    g.update(1 / 60);
    if (g.state === 'lost' || g.state === 'won') break;
  }
  return {
    put,
    shot: g.statShot,
    qi: g.statQi,
    bomb: g.statBomb,
    selfHeal: g.statSelfHeal,
    roll: g.statRoll,
    level: g.hero.level,
    kills: g.kills,
    xp: g.hero.xp,
    state: g.state,
    hp: Math.round(g.hero.hp),
    banner: document.querySelector('[data-levelup-level]')?.textContent ?? '',
    pendingSkills: Object.entries(g.hero.cds).map(([k, v]) => `${k}:${Number(v).toFixed(1)}`),
  };
});
check('普攻射击在跑', skills.shot > 0, `射击 ${skills.shot} 次`);
check('剑气会放', skills.qi > 0, `剑气 ${skills.qi} 次`);
check('爆米花弹会放', skills.bomb > 0, `爆弹 ${skills.bomb} 次`);
check('干粮会吃', skills.selfHeal > 0, `回血 ${skills.selfHeal} 次`);
check('翻滚会滚', skills.roll > 0, `翻滚 ${skills.roll} 次`);
check('他升级了（有被动成长）', skills.level > 1, `Lv${skills.level} 击杀${skills.kills} xp${Math.round(skills.xp)} hp${skills.hp} ${skills.state}`);
check('升级横幅播报过', /Lv\.\d+/.test(skills.banner), `横幅="${skills.banner}"`);

// 横幅位置：截图里看着"压血条"是模型误判，用 DOM 实测才准
const bannerBox = await page.evaluate(() => {
  const g = window.__game;
  g.hero.addXp(400, g.heroHooks);
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const hit = (a, b) =>
    Boolean(a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
  const lv = rect('.levelup');
  return {
    top: hit(lv, rect('.hud-top')),
    hand: hit(lv, rect('.hand')),
    hint: hit(lv, rect('.hint-bar')),
    visible: document.querySelector('[data-levelup]')?.hidden === false,
  };
});
check(
  '升级横幅不压血条和手牌',
  bannerBox.visible && !bannerBox.top && !bannerBox.hand && !bannerBox.hint,
  `可见=${bannerBox.visible} 压血条=${bannerBox.top} 压手牌=${bannerBox.hand} 压提示=${bannerBox.hint}`,
);

// 截图前先塞几只怪：空场截图看不出"围杀"这件事，也做不了视觉自检
await page.evaluate(() => {
  const g = window.__game;
  g.start();
  // 前面的技能块跑过 45 秒，可能留下一个开着的权能面板 —— 截图和 fps 都得在没有覆盖层时做
  document.querySelector('.overlay')?.classList.remove('is-open');
  g.starBonus = 55;
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2;
    const r = 110 + (i % 3) * 55;
    g.debugRefill();
    g.selectCard(i % g.hand.length);
    g.place(g.hero.x + Math.cos(a) * r, g.hero.y + Math.sin(a) * r);
  }
  g.selected = -1;
});
await page.waitForTimeout(1400);

await page.screenshot({ path: join(SHOTS, '02-arena.png') });

// ---- 帧率（在满场对局里测，空场数字没有意义） ----
// 先确保没有任何覆盖层开着：.overlay 带 backdrop-filter，
// 只要它还在合成树里，软件渲染的帧率就不是"游戏"的帧率（实测 10fps vs 41fps）。
const overlayDiag = await page.evaluate(() => {
  const o = document.querySelector('.overlay');
  if (!o) return 'no overlay';
  const before = { cls: o.className, display: getComputedStyle(o).display };
  o.dataset['prevCls'] = o.className;
  o.classList.remove('is-open');
  o.style.display = 'none';
  return `${before.cls} / ${before.display}`;
});
const fpsSample1 = await measureFps();
const fpsSample2 = await measureFps();
// 取两次里较好的那次：这台机器上微信/豆包/若干 webview 常年抢 CPU，
// 单次采样 ±40% 抖动（同一构建上测到过 23 和 41），取最大值才是"这个游戏能跑多快"。
const fps = Math.max(fpsSample1, fpsSample2);
// 复原：后面还要用这个覆盖层做权能三选一
await page.evaluate(() => {
  const o = document.querySelector('.overlay');
  if (!o) return;
  o.style.display = '';
  o.className = o.dataset['prevCls'] ?? 'overlay';
  delete o.dataset['prevCls'];
});
// 20fps 是"策略游戏还能玩"的下限（这游戏不需要 60fps 的输入手感）；
// 同时要求达到空页面基线的 40%，把"机器本身慢"和"游戏渲染退化"分开看。
// 注意无头浏览器走的是 swiftshader 纯软件光栅化 —— 真机有 GPU，帧率是这个的数倍。
const fpsFloor = Math.max(20, Math.round(baselineFps * 0.4));
check(
  '帧率（软件渲染）',
  fps >= fpsFloor,
  `${fps} fps（两次采样 ${fpsSample1}/${fpsSample2}，空页面基线 ${baselineFps}，下限 ${fpsFloor}；测前 overlay=${overlayDiag}）`,
);

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
