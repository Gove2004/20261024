import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".webp": "image/webp" };
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  let file = join(ROOT, normalize(url));
  if (url.endsWith("/")) file = join(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(4321, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto("http://127.0.0.1:4321/", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__game), { timeout: 20000 });
const out = await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.debugFillHand();
  g.starBonus = 999;
  const pts = [];
  for (let i = 0; i < 60 * 120; i += 1) {
    g.update(1 / 60);
    if (g.state === "powerup") { const o = g.pendingPowerup?.[0]; if (o) g.choosePowerup(o.id); continue; }
    if (g.state !== "playing") break;
    if (i % 24 === 0) {
      g.debugRefill();
      for (let c = 0; c < g.hand.length; c += 1) {
        g.selectCard(c);
        const a = Math.random() * Math.PI * 2;
        const r = 150 + Math.random() * 250;
        if (g.place(g.hero.x + Math.cos(a) * r, g.hero.y + Math.sin(a) * r)) break;
      }
      g.selected = -1;
    }
    if (i % 20 === 0) pts.push([Math.round(g.hero.x), Math.round(g.hero.y), g.store.activeCount]);
  }
  return { pts, hp: Math.round(g.hero.hp), maxHp: Math.round(g.hero.maxHp), elapsed: Math.round(g.elapsed), state: g.state };
});
// ASCII 轨迹图：1200 见方的房间，30x30 网格
const W = 30, H = 30;
const grid = Array.from({ length: H }, () => Array(W).fill(" "));
for (const [x, y] of out.pts) {
  const gx = Math.max(0, Math.min(W - 1, Math.floor(((x - 200) / 1200) * W)));
  const gy = Math.max(0, Math.min(H - 1, Math.floor(((y - 200) / 1200) * H)));
  grid[gy][gx] = grid[gy][gx] === " " ? "." : grid[gy][gx] === "." ? "+" : "#";
}
console.log(`轨迹采样 ${out.pts.length} 点 / ${out.elapsed}s / ${out.state} hp=${out.hp}/${out.maxHp}`);
console.log(grid.map((row) => "|" + row.join("") + "|").join("\n"));
await browser.close();
server.close();
