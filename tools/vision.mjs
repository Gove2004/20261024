/**
 * 看图工具：把本地截图交给多模态模型，拿回中文描述。
 *
 * 用途：本项目的美术/UI 判断不能靠"我觉得应该没问题"——
 * agent 本身看不到图，必须外部模型当眼睛。
 *
 * 用法：
 *   node tools/vision.mjs shots/02-arena.png
 *   node tools/vision.mjs before.png after.png -p "对比两张图，说差异"
 *   node tools/vision.mjs shots/03-powerup.png -p "只报可读性问题" -m gemini-2.5-pro
 *
 * Key 从 .env.local 读（不提交）。模型默认走 gemini 系，失败按顺序回退。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const BASE = 'https://api.openai-next.com';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'chatgpt-4o-latest', 'claude-sonnet-4-5-20250929'];

const DEFAULT_PROMPT =
  '你是一名游戏 UI/美术评审。请用中文描述这张游戏截图：' +
  '1) 画面里有什么（角色、怪物、UI 元素分别在哪）；' +
  '2) 布局是否失衡、有没有元素重叠或被裁切；' +
  '3) 可读性问题（对比度、字号、颜色混淆）；' +
  '4) 一句话结论：能直接给玩家看，还是必须改。只描述你真正看到的，不要推测代码。';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function parseArgs(argv) {
  const files = [];
  let prompt = DEFAULT_PROMPT;
  let model = process.env.VISION_MODEL ?? FALLBACK_MODELS[0];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--prompt') {
      prompt = argv[i + 1] ?? prompt;
      i += 1;
    } else if (arg === '-m' || arg === '--model') {
      model = argv[i + 1] ?? model;
      i += 1;
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }
  return { files, prompt, model };
}

async function readKey() {
  const envPath = resolve('.env.local');
  if (!existsSync(envPath)) throw new Error('缺少 .env.local（里面要有 OPENAI_API_KEY=...）');
  const text = await readFile(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]*KEY[A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && m[2]) return m[2].replace(/^["']|["']$/g, '');
  }
  throw new Error('.env.local 里没有找到 KEY 变量');
}

async function toDataUri(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`找不到图片：${file}`);
  const buf = await readFile(abs);
  const mime = MIME[extname(abs).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function ask(key, model, prompt, dataUris) {
  const content = [{ type: 'text', text: prompt }];
  for (const uri of dataUris) content.push({ type: 'image_url', image_url: { url: uri } });

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 1400,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const answer = json?.choices?.[0]?.message?.content;
  if (typeof answer === 'string' && answer.trim()) return answer.trim();
  if (Array.isArray(answer)) {
    const joined = answer.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n').trim();
    if (joined) return joined;
  }
  throw new Error(`响应里没有文本：${text.slice(0, 300)}`);
}

const { files, prompt, model } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('用法：node tools/vision.mjs <图片> [更多图片] [-p 提示词] [-m 模型]');
  process.exit(2);
}

const key = await readKey();
const dataUris = [];
for (const file of files) dataUris.push(await toDataUri(file));

const order = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
const errors = [];
for (const candidate of order) {
  try {
    const started = Date.now();
    const answer = await ask(key, candidate, prompt, dataUris);
    console.log(`# 模型：${candidate}（${((Date.now() - started) / 1000).toFixed(1)}s，${files.length} 张图）\n`);
    console.log(answer);
    process.exit(0);
  } catch (error) {
    errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.error('所有模型都失败了：\n' + errors.join('\n'));
process.exit(1);
