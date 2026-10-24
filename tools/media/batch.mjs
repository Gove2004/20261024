/**
 * 批量出图：读一份 plan（JSON 数组），并发跑完所有任务。
 *
 * 为什么需要批量并发：单张约 22–30 秒，13 张串行要 6 分钟；
 * 4 路并发只要 1.5–2 分钟，而且失败的任务可以只重跑失败的（`--only`）。
 *
 * 用法：
 *   node tools/media/batch.mjs --plan tools/media/plans/monsters.json
 *   node tools/media/batch.mjs --plan tools/media/plans/monsters.json --only slime,ghost
 *   node tools/media/batch.mjs --plan tools/media/plans/monsters.json --force
 *   node tools/media/batch.mjs --plan tools/media/plans/monsters.json --concurrency 5
 *   node tools/media/batch.mjs --plan tools/media/plans/monsters.json --dry-run
 *
 * 已存在的文件默认跳过（除非 --force）：出图有成本，改一张就只重跑一张。
 */
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendManifest, download, generateImage, getConfig, mapWithLimit, mask, saveBase64 } from './client.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.plan) {
  console.log('用法：node tools/media/batch.mjs --plan <plan.json> [--only a,b] [--force] [--concurrency 4] [--dry-run]');
  process.exit(1);
}

const config = await getConfig();
const concurrency = Number(args.concurrency ?? config.concurrency);
const force = args.force === true;
const dryRun = args['dry-run'] === true;
const only = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim())) : null;

const planPath = resolve(PROJECT_ROOT, String(args.plan));
const plan = JSON.parse(await readFile(planPath, 'utf8'));
if (!Array.isArray(plan)) {
  console.error('plan 必须是 JSON 数组');
  process.exit(1);
}

const jobs = plan.filter((job) => {
  if (!job || typeof job.id !== 'string' || typeof job.prompt !== 'string') return false;
  return only === null || only.has(job.id);
});

const exists = (rel) => access(resolve(PROJECT_ROOT, rel)).then(
  () => true,
  () => false,
);

const todo = [];
for (const job of jobs) {
  const file = job.file ?? `art/raw/${job.id}.png`;
  if (!force && (await exists(file))) {
    console.log(`跳过 ${job.id}（已存在 ${file}）`);
    continue;
  }
  todo.push({ ...job, file });
}

console.log(`\n计划 ${jobs.length} 项，待生成 ${todo.length} 项，并发 ${concurrency}\n`);
if (dryRun) {
  for (const job of todo) console.log(`- ${job.id} → ${job.file}\n    ${job.prompt.slice(0, 100)}…`);
  process.exit(0);
}
if (todo.length === 0) process.exit(0);

// manifest 是"读整份再写整份"，并发写会互相覆盖 —— 串行化
let manifestChain = Promise.resolve();
const record = (entry) => {
  manifestChain = manifestChain.then(() => appendManifest(entry)).catch((error) => {
    console.warn(`manifest 写入失败：${mask(error.message)}`);
  });
  return manifestChain;
};

let done = 0;
let failed = 0;
const startedAll = Date.now();

await mapWithLimit(todo, concurrency, async (job) => {
  const started = Date.now();
  const model = String(job.model ?? process.env.IMG_MODEL ?? 'gpt-image-2');
  const size = String(job.size ?? '1024x1024');
  try {
    const { url, base64, usage } = await generateImage({ model, prompt: job.prompt, size });
    const file = base64 ? await saveBase64(base64, job.file) : await download(url, job.file);
    done += 1;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✅ ${job.id}  ${(file.bytes / 1024).toFixed(0)}KB  ${secs}s  (${done}/${todo.length})`);
    await record({
      kind: 'image',
      id: job.id,
      model,
      prompt: job.prompt,
      size,
      file: job.file,
      bytes: file.bytes,
      sourceUrl: url ?? '(b64_json)',
      usage,
    });
  } catch (error) {
    failed += 1;
    console.error(`❌ ${job.id}  ${mask(error.message)}`);
  }
});

await manifestChain;
const total = ((Date.now() - startedAll) / 1000).toFixed(1);
console.log(`\n完成 ${done} 张，失败 ${failed} 张，总耗时 ${total}s`);
process.exit(failed > 0 ? 1 : 0);
