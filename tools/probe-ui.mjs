// UI 贴图自检：面板/卡牌/按钮上的贴图是否真的生效（computed style，不看图省事也不靠眼睛）。
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  let file = join(ROOT, normalize(url));
  if (url.endsWith("/")) file = join(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("no");
  }
});
await new Promise((r) => server.listen(4324, "127.0.0.1", r));

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failed = [];
page.on("response", (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});
await page.goto("http://127.0.0.1:4324/", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__game), { timeout: 20000 });

const result = await page.evaluate(async () => {
  const g = window.__game;
  g.start();
  g.deferPowerup(0.01);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const panel = document.querySelector('.overlay.is-open .panel');
  const after = panel ? getComputedStyle(panel, '::after') : null;
  const card = document.querySelector('.panel__x, .card, .powerup-card');
  const btn = document.querySelector('.btn-primary');
  return {
    state: g.state,
    panelFound: Boolean(panel),
    panelBg: after?.backgroundImage ?? 'none',
    panelBgSize: after?.backgroundSize ?? '',
    holdBar: Boolean(document.querySelector('.powerup-hold')),
    popupCards: document.querySelectorAll('.powerup-card').length,
    cardFrame: card ? getComputedStyle(card, '::after').backgroundImage : 'no-card',
    btnBg: btn ? getComputedStyle(btn).backgroundImage.slice(0, 120) : 'no-btn',
  };
});

console.log(JSON.stringify(result, null, 1));
if (failed.length > 0) console.log('4xx/5xx:', failed.slice(0, 6).join(' | '));
await page.screenshot({ path: 'shots/15-powerup.png' });
await browser.close();
server.close();
