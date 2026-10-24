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
await new Promise((r) => server.listen(4322, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto("http://127.0.0.1:4322/", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__game), { timeout: 20000 });
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.selectCard(0);
  g.place(g.hero.x - 150, g.hero.y - 40);
  g.selected = -1;
  const log = [];
  for (let i = 0; i < 60 * 6; i += 1) {
    g.update(1 / 60);
    if (i % 60 === 0) log.push({ t: i / 60, state: g.hero.state, target: g.hero.target, windup: Number(g.hero.windup.toFixed(2)), dmg: g.kills, hp: Math.round(g.hero.hp), mhp: Math.round(g.store.hp[g.store.active[0]] ?? -1) });
  }
  return { log, hand: g.hand.map((c) => c.id), kills: g.kills };
}), null, 1));
await browser.close(); server.close();
