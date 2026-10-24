# 技术选型与资产管线

> 目标：用 **TypeScript + Vite + PixiJS 8** 在浏览器里跑出一个 60fps、有完整表现层（贴图/粒子/镜头/转场/音效/BGM）的 2D 反向肉鸽，**所有美术与音频由生成式模型产出**。
>
> 本文所有结论都标注了**验证状态**：✅ 已实测通过 / ⚠️ 端点存在但未跑通 / ❓ 未验证。

---

## 1. 结论摘要

| 层 | 选型 | 一句话理由 |
| --- | --- | --- |
| 语言 | TypeScript 5.x（strict） | 24 小时内多 Agent 并行写代码，类型是唯一可靠的接口契约 |
| 构建 | Vite 7/8 | 秒级 HMR，静态产物，`base: './'` 可直接丢到任意静态托管 |
| 渲染 | **PixiJS 8**（WebGL2 / WebGPU 自动回退） | 2D 精灵批处理最强，粒子/滤镜/图集生态完整，无 3D 包袱 |
| 动画/缓动 | GSAP 3（仅 core + CSSPlugin） | 时间线、弹性缓动、UI 动效一把梭，比自写 tween 省 6 小时 |
| 粒子 | 自研对象池 + `ParticleContainer` | 600 粒子零 GC；不引第三方发射器（API 变动风险） |
| 后期 | `pixi-filters`（Bloom / Vignette / CRT / Displacement） | 一晚上就有"成品感"，且移动端可一键降级 |
| UI | **DOM 覆盖层 + CSS**（不用 Pixi 排版文字） | 中文排版清晰、可访问、开发快 3 倍；卡片 3D 悬停 CSS 直接做 |
| 音频 | 自研 WebAudio 封装（总线/侧链/程序化 SFX） | 短音效实时合成，零资源体积；BGM 用解码后的 buffer 循环 |
| 状态/存档 | 自研 + `localStorage` | 无服务端，无需框架 |
| 测试 | Vitest（逻辑）+ Playwright（真机 E2E / 截图回归） | 逻辑层可无渲染跑 1000 局做数值校准 |
| 部署 | 静态托管（GitHub Pages / 任意 CDN） | 评委点开就能玩，不需要后端 |
| 图像模型 | `gpt-image-2` / `gemini-3-pro-image` / `doubao-seedream-5-0-pro` | ✅ 已实测出图（22s/张） |
| 音乐模型 | Suno（`suno-v4.5`，`/suno/submit/music`） | ⚠️ 端点存在，当前 Key 返回 403，需确认额度；有程序化 BGM 退路 |
| 语音 | `tts-1` / `speech-1.6` | ⚠️ 端点存在，当前返回 429（限流/额度） |
| 视频 | `sora-2` / `veo3.1` → `/v1/video/generations` | ⚠️ 端点存在，参数契约未确认；仅用于标题页过场，**不阻塞交付** |

**一句话**：渲染和玩法完全不依赖外部服务，随时可以交付；生成式媒体是**锦上添花且可降级**的部分。

---

## 2. 为什么是这套 Web 技术栈

### 2.1 横向对比

| 方案 | 优点 | 为什么没选 |
| --- | --- | --- |
| **PixiJS 8**（选） | 2D 批处理最快、图集/滤镜/粒子齐全、API 稳定、体积小 | — |
| Phaser 3 | 全家桶、文档多 | 内置系统与我们自研 ECS/循环冲突；包体大；自定义表现受限 |
| Three.js | 3D 强 | **需求明确不要 3D**；2D 用 3D 引擎是纯负担 |
| Cocos Creator | 编辑器强 | 重工具链、导出体积大、Agent 难以无头操作 |
| 原生 Canvas 2D | 零依赖 | 500 实体 + 粒子 + 滤镜会掉到 20fps，做不出"成品感" |
| WebGPU 手写 | 上限最高 | 24 小时做不完，且移动端兼容性差 |

### 2.2 PixiJS 8 的关键用法（实现时直接照抄）

```ts
// 启动：自管循环，不用 ticker 驱动逻辑
const app = new Application();
await app.init({
  canvas, width: 1280, height: 720,
  autoDensity: true, resolution: Math.min(devicePixelRatio, 2),
  autoStart: false, preference: 'webgl',   // webgl 兼容性优于 webgpu
  background: 0x0b0a14,
});

// 固定步长逻辑 + 插值渲染
loop.onStep((dt) => world.update(dt));
loop.onRender((alpha) => { world.interpolate(alpha); app.render(); });
```

- 图集：`Assets.load` + spritesheet manifest，**所有角色/特效走同一张图集**，减少 draw call。
- 粒子：`ParticleContainer`（v8 的新实现）+ 对象池，热路径不 new。
- 滤镜：`pixi-filters` 的 `BloomFilter` 只挂在一张"发光层"容器上，不要挂根容器（性能悬崖）。
- 文本：**一律 DOM**。Pixi 的 `Text` 在中文小字号下会糊，且无法选中/无障碍。

### 2.3 分辨率与适配

- 设计分辨率 1280×720，`resize` 时按 `min(w/1280, h/720)` 等比缩放并居中（letterbox）。
- 移动端竖屏：不重排 UI，而是把画布缩到顶部，手牌区改为底部固定 DOM 条（CSS 媒体查询处理）。
- 触屏判定区最小 44×44 CSS px。

### 2.4 性能预算（超过就砍内容，不改架构）

| 项 | 预算 |
| --- | --- |
| 同屏实体 | ≤ 400（怪物 30 + 弹幕/特效实体余量） |
| 同屏粒子 | ≤ 600 |
| Draw call | ≤ 120 |
| 首屏资源 | ≤ 3MB（图集压到 WebP/PNG-8，BGM 用 96kbps Opus） |
| 帧时间 | 逻辑 ≤ 4ms，渲染 ≤ 8ms |

---

## 3. 生成式媒体接入（OpenAI Next Credits）

Base URL：`https://api.openai-next.com`
鉴权：`Authorization: Bearer $CREDIT_MEDIA_API_KEY`

> Key 放在 `.env.local`（已 gitignore），队友复制 `.env.example` 填自己的 Key。**任何脚本都不允许把 Key 写进源码、日志或提交记录。**

### 3.1 实测记录（2026-10-24 16:00–16:20，本地实测）

| 调用 | 结果 | 说明 |
| --- | --- | --- |
| `GET /v1/models` | ✅ 200，**390 个模型** | 含图像/视频/音频/文本全系 |
| `POST /v1/images/generations` `gpt-image-1` | ✅ **200，22 秒** | 返回 `{data:[{url}]}`，PNG 1254×1254 / 1.1MB，4208 image tokens |
| `POST /v1/images/generations` `gpt-image-2` | ✅ **200，28.9 秒** | PNG 1254×1254 / 1.26MB，**仅 1056 image tokens**（性价比更高） |
| `POST /v1/chat/completions` `gpt-4.1-mini` | ✅ 200 | Key 有效，文本侧可用 |
| `POST /v1/images/edits` | ⚠️ 503（探测用假模型） | 端点存在，可用于"参考图 → 一致性生成" |
| `POST /v1/video/generations` `sora-2` | ⚠️ 400 / 503 | 端点存在，参数 schema 未探明（见 3.4） |
| `POST /v1/audio/speech` `tts-1` | ⚠️ **429** | 端点存在，被限流或额度受限 |
| `POST /suno/submit/music` `suno-v4.5` | ⚠️ **403** | Endpoint 存在（new-api 风格），模型无权限 |
| `POST /suno/fetch` | ⚠️ 503 | 同上 |

**已验证的图片响应格式**：

```json
{ "created": 1792829396,
  "data": [{ "revised_prompt": "", "url": "https://pro.filesystem.site/cdn/.../x.png" }],
  "usage": { "total_tokens": 4208, "output_tokens": 4175 } }
```

要点：
1. 返回的是 **CDN URL，不是 base64** → 管线必须先下载再落盘（URL 有时效）。
2. `size: "1024x1024"` 被网关忽略，实际出 1254×1254 → **不要依赖 size 精确控制，一律在后处理里缩放**。
3. 单张 22 秒 → **批量生成务必并发 3–4 路**，并做失败重试（幂等，重复出图可接受）。
4. 计费按输出 token（≈4200/张），跑批量前先确认账户剩余算力。

### 3.2 可用模型（从 `/v1/models` 中筛出）

**图像**
`gpt-image-1` / `gpt-image-1.5` / `gpt-image-2` / `gpt-image-2.5` / `gpt-image-2-vip`
`gemini-2.5-flash-image` / `gemini-3-pro-image(-preview)` / `gemini-3.1-flash-image` / `gemini-nano-banana-2.1`
`doubao-seedream-5-0-pro-260628` / `doubao-seedream-5-0-260128`
`grok-imagine-image(-2.0/-quality)` / `dall-e-3` / `gpt-4o-image`

**视频**
`sora-2` / `veo3.1(-fast/-pro)` / `kling-video-pro-5s|10s` / `doubao-seedance-2-0…2-5` / `grok-imagine-video`

**音频**
`suno-v4.5` / `suno-v4.5+` / `tts-1(-hd)` / `speech-1.5` / `speech-1.6` / `qwen3-tts-flash` / `whisper-1`

**文本**（用于批量写 prompt、生成卡牌文案）
`gpt-4.1-mini` 等（✅ 已验证）

### 3.3 分工：哪个模型干什么

| 任务 | 首选 | 理由 | 备选 |
| --- | --- | --- | --- |
| 风格锚点图（1 张） | `gpt-image-2` | 综合质量最好 | `gemini-3-pro-image` |
| 锅巴 3 形态（同角色变体） | `gemini-3-pro-image` / `nano-banana` | **支持参考图，角色一致性最强** | `gpt-image-2` + 参考图 |
| 小怪 9 张（4 族） | `doubao-seedream-5-0` | 便宜、快、风格化强 | `gpt-image-1.5` |
| 场地祭坛（正俯视大图） | `gpt-image-2` | 大场景细节 | `gemini-3-pro-image` |
| UI 图标 18 个 | `gpt-image-1.5` | 小图足够，批量便宜 | 生成 4×4 拼版后切图 |
| 卡面/框 | `gpt-image-2` | 需要质感 | CSS 渐变兜底 |
| 特效贴图 | `gpt-image-1.5` | 单色发光图即可 | **程序化 Canvas 生成**（更可控） |
| 标题主视觉 + 主角卡 | `gpt-image-2` / `gemini-3-pro-image` | 宣传级质量 | — |
| BGM 4 首 | Suno `suno-v4.5` | 唯一可选 | **WebAudio 程序化音序器**（退路） |
| 锅巴 4 句台词 | `tts-1` / `speech-1.6` | 现成 | 无配音，只用文字气泡 |
| 标题过场 4s | `sora-2` / `veo3.1-fast` | 加分项 | 静态大图 + 视差动画（足够好） |

### 3.4 待确认的接口（不阻塞，但影响加分项）

| 接口 | 需要确认 | 怎么确认 |
| --- | --- | --- |
| `/v1/video/generations` | 请求字段（`size`? `seconds`? `aspect_ratio`?）与是否异步轮询 | 拿到平台「图像与视频」文档的视频 tab，或用 `sora-2` 试一次最小请求看返回 |
| `/suno/submit/music` | 是否有权限、任务轮询路径与产物字段 | 请平台确认该 Key 是否开通音乐模型 |
| `/v1/audio/speech` | 429 是限流还是无额度 | 隔 1 分钟重试一次 |

**降级策略（默认执行，不等确认）**
1. BGM：先写 WebAudio 程序化 BGM（8 小节循环 + 3 层叠加），Suno 能用了再替换 —— 音频接口 100% 可插拔。
2. 过场：默认用"静态大图 + 视差 + 光效"，视频模型可用再升级。
3. 台词：默认用文字气泡 + 程序化"咔嚓"音效。

### 3.5 调用封装约定

所有生成请求**必须**走 `tools/media/`，不允许在业务代码里直连：

```
tools/media/
  client.mjs        # 统一 fetch + 重试 + 并发闸门 + 日志（脱敏）
  gen-image.mjs     # 出图（支持 --model --prompt --out --ref）
  gen-music.mjs     # 出 BGM（Suno，含轮询）
  gen-tts.mjs       # 出配音
  gen-video.mjs     # 出视频（可选）
  manifest.json     # 每个资产的 prompt + 模型 + seed + 生成时间（可复现）
```

- 读 Key：`process.env.CREDIT_MEDIA_API_KEY`，缺失直接 exit 1 并提示复制 `.env.example`。
- 日志里 Key 一律打码为 `sk-****`。
- `manifest.json` **提交进仓库**（不含 Key），这样"这张图是怎么来的"永远可追溯 —— 也是赛事"AI 生成"要求的最好证明。

### 3.6 成本估算（首版）

| 项 | 次数 | 说明 |
| --- | --- | --- |
| 批量出图 | ~120 次（含淘汰） | `gpt-image-2` ≈1056 / `gpt-image-1` ≈4200 image tokens 每张 |
| 精选重出 | ~30 次 | 风格统一返工 |
| BGM | 4–8 次 | 每次可能出 2 首 |
| TTS | ~10 次 | 台词试音 |
| 视频 | 0–2 次 | 可选 |

> 先跑 6 张验证风格，确认账户额度后再批量。**不要一次性跑 120 张。**

---

## 4. 美术管线（AI 生图 → 游戏可用资源）

AI 生图最大的问题不是"好不好看"，而是**不一致**和**不能直接进游戏**（透明背景、尺寸、锚点、图集）。所以必须有一条确定性管线。

```
prompt/manifest
   ↓ ① 生成（并发 3–4，失败重试）
art/raw/*.png                     ← 原始出图（1254×1254，带背景）
   ↓ ② 去背（白/纯色底 → alpha）
   ↓ ③ 裁边（trim 透明边）
   ↓ ④ 缩放（长边 512/384/256/128，按用途）
   ↓ ⑤ 锚点对齐（脚底中心 → 统一 pivot）
art/clean/*.png
   ↓ ⑥ 图集打包（TexturePacker 格式 / 自写 grid packer）
public/assets/atlas/*.{png,json}
   ↓ ⑦ 运行时 Assets.load + manifest 分包
```

**工具**：Python 3 + Pillow（环境已自带，零安装）写 `tools/art/clean.py`、`tools/art/pack.py`。
去背策略：优先要求模型出**纯色深底**（`#0B0A14`），用"四角取色 + 容差 flood fill"去背，比抠白底干净得多。

**动画策略（关键取舍）**

> ❌ 不用 AI 直接生成 sprite sheet（帧间不一致，24 小时调不完）。
> ✅ **单张立绘 + 运行时程序化动画**：缩放/挤压、倾斜、位移、旋转、帧序列（3 个姿态做呼吸/攻击）。

一个角色只需 3 张图（idle / attack / hurt）就能做出"有生命感"的动作，成本降低一个数量级。

---

## 5. 音频管线

| 类型 | 方案 |
| --- | --- |
| SFX（命中/放置/死亡/UI/升级…） | **WebAudio 实时合成**：噪声/振荡器 + ADSR 包络 + 滤波 + 随机音高。约 15 个合成器函数，覆盖 25 个音效，0 KB 资源 |
| BGM | 优先 Suno 生成 mp3 → 转 96kbps Opus；退路：WebAudio 音序器（方波/三角波 + 噪声鼓 + 侧链压缩） |
| 混音 | `Master → Compressor → Destination`；`BGM 总线`、`SFX 总线`、`UI 总线` 三条，命中时对 BGM 做 3dB 侧链压低 |
| 首次交互解锁 | 必须等第一次 `pointerdown` 再 `resume()` AudioContext（浏览器策略） |

---

## 6. 工程结构与约定

```
20261024/
├─ docs/                 # 策划、技术选型、主角卡、赛事物料
├─ public/assets/        # 构建产物：图集、音频、字体
├─ art/                  # AI 原始出图（gitignore 大文件，仅保留精选）
├─ tools/
│  ├─ media/             # 生成式 API 封装 + manifest
│  ├─ art/               # 去背/裁边/打包
│  └─ simulate.mjs       # 无渲染跑 1000 局做数值校准
├─ src/
│  ├─ main.ts
│  ├─ app/               # 启动装配、加载流程、场景切换
│  ├─ core/              # 固定步长循环、事件总线、种子随机、数学
│  ├─ ecs/               # 稀疏集合实体表
│  ├─ gameplay/          # 战斗、锅巴 AI、卡牌、魂、星级、强化、结算
│  ├─ content/           # 纯数据：卡池、强化池、台词、调色板
│  ├─ render/            # Pixi 渲染、图集、粒子、镜头、后期
│  ├─ ui/                # DOM 覆盖层
│  ├─ audio/             # WebAudio 封装 + 程序化 SFX
│  └─ save/              # localStorage、每日种子
├─ tests/                # Vitest
├─ .env.example          # 模板（提交）
├─ .env.local            # 真实 Key（不提交）
└─ README.md
```

**代码约定**

- 严格模式 TS，`verbatimModuleSyntax`，**禁止 `any`**（用 `unknown` + 收窄）。
- 分层依赖单向：`core` 不认识 Pixi，`gameplay` 不认识 DOM，`render` 只读 `gameplay` 的状态。
- 热路径零分配：`update` 里不 new 对象、不闭包捕获、不用 `Array.prototype.filter/map`。
- 随机一律走注入的 `Rng`（种子化），不允许裸 `Math.random()`（否则"每日深渊"失效、模拟不可复现）。
- 中文 TSDoc 写清"为什么"，不写"做了什么"。

---

## 7. 测试与验收

| 层 | 手段 | 通过标准 |
| --- | --- | --- |
| 数值/规则 | `tools/simulate.mjs` 跑 1000 局 | 终局等级均值 10±1，胜率 25–70% 区间随熟练度移动 |
| 逻辑单测 | Vitest | 星级预算、经验曲线、强化抽卡、献祭、结算公式全覆盖 |
| E2E | Playwright + 本地 Edge | 开局 → 放置 → 升级 → 结算 → 重开 全链路；无 console error |
| 性能 | 内置 FPS 面板（F3 开启） | 1080p 桌面 ≥ 55fps；无长任务 > 50ms |
| 视觉 | E2E 截图 + 人工过目 | 无错位、无糊字、无贴图缺失 |
| 移动端 | 真机（或视口模拟 390×844） | 能完整玩一局，触控无死角 |

---

## 8. 部署

- `vite build` → `dist/`，纯静态。
- `vite.config.ts` 设 `base: './'`，产物可在任意子路径托管。
- 首选 GitHub Pages（`gh-pages` 分支或 Actions），URL 直接作为参赛链接。
- 产物需支持离线（可选）：`vite-plugin-singlefile` 打单 HTML，方便发给评委。

---

## 9. 安全约定（务必遵守）

1. `.env*` 全部 gitignore，只提交 `.env.example`。
2. Key 只存在于本地环境变量与 `tools/media/client.mjs` 的读取处。
3. 所有日志/截图/提交信息脱敏（`sk-****`）。
4. 前端代码**永不直连**生成式 API（否则 Key 会随构建产物发布到公网）。
5. 一旦怀疑泄露：立刻在平台重置 Key，并 `git filter-repo` 清理历史。
