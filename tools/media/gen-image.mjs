/**
 * 出图命令行工具。
 *
 * 示例：
 *   node tools/media/gen-image.mjs --prompt "焦黄的锅巴勇者" --out art/raw/guoba_lv1.png
 *   node tools/media/gen-image.mjs --model gemini-3-pro-image --prompt "..." --out art/raw/x.png
 *   node tools/media/gen-image.mjs --prompt-file tools/media/prompts/guoba.txt --out ...
 *
 * 产物同时写入 tools/media/manifest.json，记录模型与完整提示词。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendManifest, download, generateImage, getConfig, mask, saveBase64 } from './client.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.prompt && !args['prompt-file'])) {
  console.log(`用法：node tools/media/gen-image.mjs --prompt "描述" --out art/raw/xxx.png [--model gpt-image-2]`);
  process.exit(args.help ? 0 : 1);
}

const config = await getConfig();
const prompt = args['prompt-file']
  ? (await readFile(resolve(PROJECT_ROOT, args['prompt-file']), 'utf8')).trim()
  : String(args.prompt);

const model = String(args.model ?? process.env.IMG_MODEL ?? 'gpt-image-2');
const out = String(args.out ?? `art/raw/${Date.now()}.png`);
const size = String(args.size ?? '1024x1024');

console.log(`模型 ${model}`);
console.log(`提示 ${prompt.slice(0, 90)}${prompt.length > 90 ? '…' : ''}`);
console.log(`输出 ${out}`);

const started = Date.now();
const { url, base64, usage } = await generateImage({ model, prompt, size });
const file = base64 ? await saveBase64(base64, out) : await download(url, out);

console.log(`✅ 完成 ${(file.bytes / 1024).toFixed(0)}KB · ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (usage) console.log(`   用量 ${mask(JSON.stringify(usage))}`);

await appendManifest({
  kind: 'image',
  model,
  prompt,
  size,
  file: out,
  bytes: file.bytes,
  sourceUrl: url,
  usage,
});
