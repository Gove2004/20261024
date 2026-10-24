# 技术选型与资产管线

> 目标：用 **TypeScript + Vite + PixiJS 8** 在浏览器里跑出一个 60fps、有完整表现层（贴图/粒子/镜头/转场/音效/BGM）的 2D 反向肉鸽，**美术由生成式模型产出，音乐音效 100% 程序合成**。
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
| 音频 | 自研 WebAudio 封装（音序器 BGM + 合成 SFX + 三条总线） | **零音频资源**：BGM 与音效全部实时合成，能随战况动态变化 |
| 状态/存档 | 自研 + `localStorage` | 无服务端，无需框架 |
| 测试 | Vitest（逻辑）+ Playwright（真机 E2E / 截图回归） | 逻辑层可无渲染跑 1000 局做数值校准 |
| 部署 | 静态托管（GitHub Pages / 任意 CDN） | 评委点开就能玩，不需要后端 |
| 图像模型 | `gpt-image-2` / `gemini-3-pro-image` / `doubao-seedream-5-0-pro` | ✅ 已实测出图（22s/张） |
| BGM / SFX | **WebAudio 程序合成**（音序器 + 合成器配方） | ✅ 方案确定：0 KB 音频资源，不依赖任何外部音频服务 |
| 视频（可选） | `sora-2` / `veo3.1` → `/v1/video/generations` | ⚠️ 端点存在，参数契约未确认；仅用于标题过场，**不阻塞交付** |

**一句话**：渲染、玩法、音频全部不依赖外部服务，随时可以交付；图像生成是**锦上添花且可降级**的部分。

> 音频不再使用 Suno / TTS：`/suno/submit/music` 实测返回 403、`/v1/audio/speech` 返回 429，
> 且程序化方案本身更轻、更可控（能随勇者强度实时改变音乐），因此**直接采用程序生成，不做退路**。

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

**音频**（本作**不使用**，仅供参考平台能力）
`suno-v4.5` / `tts-1(-hd)` / `speech-1.6` / `qwen3-tts-flash` / `whisper-1`
> 实测：`/suno/submit/music` 403（无权限）、`/v1/audio/speech` 429（限流）。
> 本项目已改为 **WebAudio 程序合成**，不再依赖上述任何一个。

**文本**（用于批量写 prompt、生成卡牌文案）
`gpt-4.1-mini` 等（✅ 已验证）

### 3.3 分工：哪个模型干什么

| 任务 | 首选 | 理由 | 备选 |
| --- | --- | --- | --- |
| 风格锚点图（1 张） | `gpt-image-2` | 综合质量最好 | `gemini-3-pro-image` |
| 勇者锅巴 3 形态（同角色变体） | `gemini-3-pro-image` / `nano-banana` | **支持参考图，角色一致性最强** | `gpt-image-2` + 参考图 |
| 魔物 9 张（4 族） | `doubao-seedream-5-0` | 便宜、快、风格化强 | `gpt-image-1.5` |
| 魔王殿（正俯视大图） | `gpt-image-2` | 大场景细节 | `gemini-3-pro-image` |
| UI 图标 18 个 | `gpt-image-1.5` | 小图足够，批量便宜 | 生成 4×4 拼版后切图 |
| 卡面/框 | `gpt-image-2` | 需要质感 | CSS 渐变兜底 |
| 特效贴图 | `gpt-image-1.5` | 单色发光图即可 | **程序化 Canvas 生成**（更可控） |
| 标题主视觉 + 主角卡 | `gpt-image-2` / `gemini-3-pro-image` | 宣传级质量 | — |
| **BGM 4 段** | **WebAudio 音序器（程序合成）** | 零资源、可随战况分层 | — |
| **音效 25 个** | **WebAudio 合成器配方** | 零资源、可随机音高 | — |
| 标题过场 4s | `sora-2` / `veo3.1-fast` | 加分项 | 静态大图 + 视差动画（足够好） |

### 3.4 待确认的接口（不阻塞交付）

| 接口 | 需要确认 | 怎么确认 |
| --- | --- | --- |
| `/v1/video/generations` | 请求字段（`size`? `seconds`? `aspect_ratio`?）与是否异步轮询 | 拿到平台「图像与视频」文档的视频 tab，或用 `sora-2` 试一次最小请求看返回 |

**已确定不需要的**
1. BGM / 音效 → 全部 WebAudio 程序合成（见 §5），不调任何音频接口。
2. 过场 → 默认"静态大图 + 视差 + 光效"；视频模型可用再升级为加分项。
3. 台词 → 文字气泡 + 程序化"铁锅闷响"音效，不需要 TTS。

### 3.5 调用封装约定

所有生成请求**必须**走 `tools/media/`，不允许在业务代码里直连：

```
tools/media/
  client.mjs        # 统一 fetch + 重试 + 并发闸门 + 日志（脱敏）
  gen-image.mjs     # 出图（支持 --model --prompt --out）
  gen-video.mjs     # 出视频（可选，待接口确认）
  manifest.json     # 每个资产的 prompt + 模型 + 用量 + 生成时间（可复现）
```

- 读 Key：`process.env.CREDIT_MEDIA_API_KEY`，缺失直接 exit 1 并提示复制 `.env.example`。
- 日志里 Key 一律打码为 `sk-****`。
- `manifest.json` **提交进仓库**（不含 Key），这样"这张图是怎么来的"永远可追溯 —— 也是赛事"AI 生成"要求的最好证明。

### 3.6 成本估算（首版）

| 项 | 次数 | 说明 |
| --- | --- | --- |
| 批量出图 | ~120 次（含淘汰） | `gpt-image-2` ≈1056 / `gpt-image-1` ≈4200 image tokens 每张 |
| 精选重出 | ~30 次 | 风格统一返工 |
| 音频 | **0 次** | 程序合成，零 API 消耗 |
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

## 5. 音频管线（全程序生成，0 KB 资源）

> 不加载任何音频文件。音乐与音效都在运行时用 WebAudio 合成。
> 好处：零加载/零解码、无版权问题、能随战况实时改变（勇者越强音乐越凶）、不依赖外部音频服务。

### 5.1 架构

```
src/audio/
  context.ts     # AudioContext 首次 pointerdown 解锁；三级总线 + 压缩器
  synth.ts       # 基础发声单元：osc / noise / ADSR / filter / reverb（Convolver 用程序生成的脉冲）
  sfx.ts         # 25 个音效配方（纯函数：参数 → 一次性播放）
  music.ts       # 步进音序器：120 BPM、16 步、D 弗里吉亚、i–♭VI–♭III–♭VII
  layer.ts       # 动态分层：按勇者阶段 / 血量增删音轨、调低通、提速 8%
```

### 5.2 音乐

| 项 | 设计 |
| --- | --- |
| 音序器 | 120 BPM，16 分步进；`setTimeout` 不用于计时，改用 `AudioContext.currentTime` 预排 100ms 内的音符，避免抖动 |
| 音轨 | drone / bass / pad / 鼓 / 旋律，五层独立增益，按阶段淡入淡出 |
| 鼓 | 底鼓=正弦 120→45Hz 下滑；军鼓=噪声 + 带通 1.8kHz；镲=高通噪声 6kHz 短衰减 |
| 混响 | 用程序生成的衰减噪声当 Convolver 脉冲，省一个文件 |
| 危机处理 | 勇者 HP < 30%：心跳层（0.9s 两次 55Hz 脉冲）+ BGM 低通截止推到 18kHz（变亮变刺） |

### 5.3 音效

| 类型 | 配方 |
| --- | --- |
| 命中 | 白噪声 40ms + 带通 1.2kHz + 快衰减，音高随机 ±8%（同一种音效听 500 次不腻） |
| 暴击 | 方波 400→120Hz 下滑 + 失真 + 噪声 |
| 死亡 | 噪声 + 低通 2k→200Hz 扫频 240ms |
| 升级 | 大三和弦琶音 + 上升扫频 + 1.2s 混响 |
| 铁锅格挡 | 三角波 180Hz + 金属泛音（×2.7、×5.4），**这是锅巴的"声音签名"** |
| 献祭 | 80Hz 下坠 400ms + 失真 + 噪声爆 |
| UI | 方波 1kHz 8ms |

### 5.4 混音与性能

- `Master → DynamicsCompressor → destination`；`BGM` / `SFX` / `UI` 三条子总线。
- 命中时对 BGM 侧链压低 3dB、200ms 恢复，让打击感"顶出来"。
- 同时发声 ≤ 40 个；振荡器用完立即 `disconnect()`；40ms 内同类音效合并，防止爆音。
- 首次 `pointerdown` 再 `resume()` AudioContext（浏览器自动播放策略）。
- 设置面板：「音乐 / 音效」两条滑杆，默认 70% / 85%。

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
