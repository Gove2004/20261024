/**
 * 平衡探针：不开窗口，直接在页面里把一整局快进跑完。
 *
 * 用一个"中等水平玩家"的策略自动放怪（有卡就放、随机落在勇者周围），
 * 输出终局等级 / 剩余血量 / 击杀数 / 峰值星数，用来判断数值是不是离谱。
 *
 * 用法：node tools/balance.mjs [局数]
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = normalize(resolve(fileURLToPath(new URL('../dist', import.meta.url))));
const PORT = 4319;
const RUNS = Number(process.argv[2] ?? 3);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
// 贴图是异步加载的，__game 在 loadArt 之后才挂上去 —— 必须等，不能假设立刻可用
await page.waitForFunction(() => Boolean(window.__game), { timeout: 20000 });

const runs = [];
for (let run = 0; run < RUNS; run += 1) {
  const result = await page.evaluate(() => {
    const g = window.__game;
    /** 最近魔物（测量用） */
    const nearestSlotOf = (store, hx, hy) => {
      let best = -1;
      let bestD = 1e9;
      for (let k = 0; k < store.activeCount; k += 1) {
        const slot = store.active[k];
        if (slot === undefined) continue;
        const dx = store.x[slot] - hx;
        const dy = store.y[slot] - hy;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = slot;
        }
      }
      return best;
    };
    g.start();
    let placed = 0;
    const traces = [];
    // 走位指标：验证"会拉扯 / 会跑圈 / 不会进墙角"这三件事到底成立没有。
    // 这些数字比截图和感觉都可靠 —— 用户在意的就是这些行为。
    let wallTicks = 0;
    let moveTicks = 0;

    let travel = 0;
    let nearSum = 0;
    let nearCount = 0;
    let pressedTicks = 0;
    let orbitTicks = 0;
    let dirSumX = 0;
    let dirSumY = 0;
    let prevX = g.hero.x;
    let prevY = g.hero.y;
    const wallBand = 150;
    const nearBand = 200;
    for (let i = 0; i < 60 * 305; i += 1) {
      g.update(1 / 60);
      if (i % 1800 === 0) {
        traces.push([Math.round(g.elapsed), Math.round(g.hero.hp), g.hero.level, g.store.activeCount]);
      }
      // 行为采样（每 6 帧一次，够密且不影响模拟本身）
      if (g.state === 'playing' && i % 6 === 0) {
        const hx = g.hero.x;
        const hy = g.hero.y;
        const dWall = Math.min(hx - 200, 1400 - hx, hy - 200, 1400 - hy);
        if (dWall < wallBand) wallTicks += 1;
        const step = Math.hypot(hx - prevX, hy - prevY);
        travel += step;
        if (step > 0.5) {
          moveTicks += 1;
          dirSumX += (hx - prevX) / step;
          dirSumY += (hy - prevY) / step;
        }
        // 最近魔物距离：拉扯是否成立，看这个值稳不稳定地停在 keepRange 附近
        let nearest = 1e6;
        for (let k = 0; k < g.store.activeCount; k += 1) {
          const slot = g.store.active[k];
          if (slot === undefined) continue;
          const d = Math.hypot(g.store.x[slot] - hx, g.store.y[slot] - hy);
          if (d < nearest) nearest = d;
        }
        if (nearest < 1e6) {
          nearSum += Math.min(nearest, 600);
          nearCount += 1;
          if (nearest < 120) pressedTicks += 1;
        }
        prevX = hx;
        prevY = hy;
      }
      if (g.state === 'powerup') {
        const options = g.pendingPowerup ?? [];
        // 优先升星 > 星数上限 > 其他；这里没有升星，就随机拿
        const pick = options[Math.floor(Math.random() * options.length)];
        if (pick) g.choosePowerup(pick.id);
        continue;
      }
      if (g.state !== 'playing') break;
      if (i % 24 === 0) {
        for (let c = 0; c < g.hand.length; c += 1) {
          if (g.hand[c].cd > 0) continue;
          g.selectCard(c);
          const a = Math.random() * Math.PI * 2;
          const r = 140 + Math.random() * 260;
          if (g.place(g.hero.x + Math.cos(a) * r, g.hero.y + Math.sin(a) * r)) {
            placed += 1;
            break;
          }
        }
        g.selected = -1;
      }
    }
    return {
      state: g.state,
      elapsed: Math.round(g.elapsed * 10) / 10,
      level: g.hero.level,
      hp: Math.round(g.hero.hp),
      maxHp: Math.round(g.hero.maxHp),
      kills: g.kills,
      peakStars: g.peakStars,
      placed,
      detonations: g.detonations,
      score: g.score,
      alive: g.store.activeCount,
      traces,
      wallRatio: wallTicks / Math.max(1, wallTicks + moveTicks),
      movedRatio: moveTicks / Math.max(1, wallTicks + moveTicks),
      // 拉扯质量：平均最近魔物距离（越大越稳，目标 ~220 以上）与"被贴脸"时间占比
      kiteDist: nearSum / Math.max(1, nearCount),
      pressedRatio: pressedTicks / Math.max(1, nearCount),
      // 行走距离（像素/秒）：站桩会是 0，放风筝应该是持续的大数字
      travelPerSec: travel / Math.max(1, g.elapsed),
    };
  });
  runs.push(result);
  console.log(
    `第 ${run + 1} 局：${result.state === 'won' ? '胜利' : '失败'}  时长=${result.elapsed}s  锅巴Lv${result.level}  hp=${result.hp}/${result.maxHp}  击杀=${result.kills}  峰值星=${result.peakStars}  召唤=${result.placed}  在场=${result.alive}  贴墙率=${(result.wallRatio * 100).toFixed(0)}%  拉扯距离=${result.kiteDist.toFixed(0)}  被贴脸=${(result.pressedRatio * 100).toFixed(0)}%`,
  );
  if (result.traces.length > 0) {
    const line = result.traces.map((t) => t[0] + 's:' + t[1] + '/L' + t[2] + '/!' + t[3]).join('  ');
    console.log('   血量曲线(秒/HP/Lv/在场)：' + line);
  }
}

const avg = (pick) => Math.round((runs.reduce((s, r) => s + pick(r), 0) / runs.length) * 10) / 10;
console.log(
  `\n均值：等级 ${avg((r) => r.level)} / 击杀 ${avg((r) => r.kills)} / 峰值星 ${avg((r) => r.peakStars)} / 剩余血量比 ${avg((r) => (r.hp / r.maxHp) * 100)}%`,
);
console.log(
  `走位：贴墙率 ${avg((r) => r.wallRatio * 100).toFixed(1)}% / 平均拉扯距离 ${avg((r) => r.kiteDist).toFixed(0)}px / 被贴脸时间 ${avg((r) => r.pressedRatio * 100).toFixed(1)}% / 移动 ${avg((r) => r.travelPerSec).toFixed(0)}px每s`,
);

await browser.close();
server.close();
