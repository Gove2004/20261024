/**
 * 生成式媒体 API 客户端（仅限 Node 脚本使用）。
 *
 * 安全约定：
 * - Key 只从 `.env.local` / 环境变量读取，绝不写入源码或日志。
 * - 所有日志里的 Key 一律脱敏成 `sk-****`。
 * - 前端代码禁止导入本文件（否则 Key 会随构建产物发布）。
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENV_FILE = resolve(PROJECT_ROOT, '.env.local');
const MANIFEST = resolve(PROJECT_ROOT, 'tools/media/manifest.json');

/** 极简 .env 解析：只支持 KEY=VALUE 与 # 注释，不引第三方依赖。 */
async function loadEnv() {
  const exists = await access(ENV_FILE).then(
    () => true,
    () => false,
  );
  if (exists) {
    const text = await readFile(ENV_FILE, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }

  const key = process.env.CREDIT_MEDIA_API_KEY;
  if (!key || key.startsWith('sk-请')) {
    console.error('缺少 CREDIT_MEDIA_API_KEY。\n请先：cp .env.example .env.local，然后填入你自己的 Key。');
    process.exit(1);
  }
  return {
    key,
    base: (process.env.CREDIT_API_BASE ?? 'https://api.openai-next.com').replace(/\/+$/, ''),
    concurrency: Number(process.env.GEN_CONCURRENCY ?? 3),
    retries: Number(process.env.GEN_RETRIES ?? 2),
  };
}

let configPromise = null;
export function getConfig() {
  configPromise ??= loadEnv();
  return configPromise;
}

/** 日志脱敏。 */
export function mask(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-****');
}

/**
 * 带超时与重试的 JSON POST。
 * 生成式接口失败率不低（网关 5xx / 限流），所以重试是必需品而不是优化。
 */
async function postJson(url, headers, body, timeoutMs = 300_000) {
  const { retries } = await getConfig();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${mask(text).slice(0, 400)}`);
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const wait = 1500 * (attempt + 1);
        console.warn(`  第 ${attempt + 1} 次失败，${wait}ms 后重试：${mask(error.message)}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * 出图。
 * @returns {Promise<{ url: string, usage: unknown }>}
 */
export async function generateImage({ model, prompt, size = '1024x1024' }) {
  const { key, base } = await getConfig();
  const data = await postJson(
    `${base}/v1/images/generations`,
    { authorization: `Bearer ${key}` },
    { model, prompt, size, n: 1 },
  );

  const item = data?.data?.[0];
  if (!item?.url) {
    throw new Error(`响应里没有图片 URL：${JSON.stringify(data).slice(0, 300)}`);
  }
  return { url: item.url, usage: data.usage };
}

/** 下载生成的资源到本地（CDN URL 有时效，必须立刻落盘）。 */
export async function download(url, outPath) {
  const target = resolve(PROJECT_ROOT, outPath);
  await mkdir(dirname(target), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

/** 记录资产来源，作为"AI 生成"的可追溯凭证（提交进仓库，不含密钥）。 */
export async function appendManifest(entry) {
  let list = [];
  try {
    list = JSON.parse(await readFile(MANIFEST, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }

  list.push({ ...entry, createdAt: new Date().toISOString() });
  await mkdir(dirname(MANIFEST), { recursive: true });
  await writeFile(MANIFEST, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/** 并发闸门：生成任务限流，避免把网关打爆。 */
export async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
