import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  let file = join(ROOT, normalize(url));
  if (url.endsWith("/")) file = join(file, "index.html");
  try { const body = await readFile(file); res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(4323, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto("http://127.0.0.1:4323/", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__game), { timeout: 20000 });
const rows = await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.selectCard(0);
  g.place(g.hero.x - 150, g.hero.y - 40);
  g.selected = -1;
  g.debugRefill(); g.selectCard(0); g.place(g.hero.x + 130, g.hero.y + 60); g.selected = -1;
  g.debugRefill(); g.selectCard(0); g.place(g.hero.x + 60, g.hero.y - 150); g.selected = -1;
  g.debugRefill(); g.selectCard(0); g.place(g.hero.x - 170, g.hero.y + 120); g.selected = -1;
  const out = [];
  for (let i = 0; i < 60 * 8; i += 1) {
    g.update(1 / 60);
    if (i % 30 === 0) {
      const s = g.store.active[0];
      out.push({
        t: +(i / 60).toFixed(1),
        hx: Math.round(g.hero.x), hy: Math.round(g.hero.y),
        st: g.hero.state, mv: g.hero.moving, tg: g.hero.target,
        boss: Math.round(g.hero.steerX * 100) / 100, sbosy: Math.round(g.hero.steerY * 100) / 100,
        spd: Math.round(g.hero.speed),
        d: s === undefined ? -1 : Math.round(Math.hypot(g.store.x[s] - g.hero.x, g.store.y[s] - g.hero.y)),
        mhp: s === undefined ? 0 : Math.round(g.store.hp[s]),
      });
    }
  }
  return out;
});
for (const r of rows) console.log(JSON.stringify(r));
await browser.close(); server.close();
