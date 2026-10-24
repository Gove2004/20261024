---
name: gen-image
description: 在本仓库生成、批量重出、抠图与评审游戏美术贴图时使用。当需要出怪物/角色/场景/UI 贴图，改造现有的 art/raw 与 public/art 资产，或调整出图提示词风格时加载本技能。也适用于"某张贴图崩了要重出"、"换画风"、"补一批新卡面"这类请求。
---

# 生图（gen-image）

美术由图像模型生成，**不手绘、不下载第三方素材**。全部走 `tools/media/` 下的脚本，
Key 只存在 `.env.local`（`CREDIT_MEDIA_API_KEY` / `CREDIT_API_BASE`），**前端永远不碰这个 API**。

## 一、配置（opendev 那套）

| 变量 | 用途 |
| --- | --- |
| `CREDIT_MEDIA_API_KEY` | 唯一凭证，只被 `tools/media/*.mjs` 读 |
| `CREDIT_API_BASE` | `https://api.openai-next.com` |
| `IMG_MODEL` | 默认出图模型，当前 `gpt-image-2`（返 CDN `url`，约 25–35s/张） |
| `IMG_MODEL_CHAR` | 角色一致性模型，当前 `gemini-3-pro-image`（返 `b64_json`，约 26s/张） |
| `GEN_CONCURRENCY` | 并发数，**默认 4**；再高容易被网关限流 |
| `GEN_RETRIES` | 失败重试次数，默认 2 |

`tools/media/client.mjs` 已经处理了两件必须处理的事，不要绕过它自己写 fetch：

1. **两种返回形态**：`url`（gpt-image-2）与 `b64_json`（gemini-3-pro-image）。
   只认 url 的代码在换模型时会直接报"响应里没有图片 URL"。
2. **并发闸门 + manifest**：每次生成都把模型、完整提示词、字节数写进
   `tools/media/manifest.json`（随仓库提交，作为"AI 生成"的可追溯凭证，不含密钥）。

## 二、四条命令

```powershell
# 1. 批量出图（并发；已存在的跳过，改一张就只重跑一张）
node tools/media/batch.mjs --plan tools/media/plans/monsters.json
node tools/media/batch.mjs --plan tools/media/plans/monsters.json --only slime,ghost --force
node tools/media/batch.mjs --plan tools/media/plans/monsters.json --dry-run

# 2. 抠背景 + 裁白边 + 缩放到 256（输出到 public/art/，这个目录要提交）
python tools/art/clean.py                # 或 --only slime --tolerance 26
# 3. 总览图（一次调用评审整批）
python tools/art/sheet.py --cols 5 --size 192
# 4. 单张放大（评风格/细节必须单张 ≥384px）
python tools/art/peek.py guoba --size 512
```

Windows 上 python 用 `C:\Users\Gove2\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（带 Pillow）。

## 三、提示词模板

同一批必须共享前缀，否则风格会分裂。当前锁定的前缀：

```
半写实暗黑奇幻风格，DQ 系怪物图鉴风，3/4 俯视角，单一角色居中、全身完整、
无场景、无落地阴影，背景是纯深色 #0E0C14 无渐变，2px 深色描边，
游戏角色贴图，无文字无边框。<主体描述>
```

规则：

- **背景必须写"纯深色 #0E0C14 无渐变"** —— 抠图靠四角取样 + 边缘连通 flood fill，
  有渐变或场景就会抠不干净，游戏里会出现一块方块。
- **主体描述控制在 60–100 字**，只写能看见的东西（材质、颜色、装备、姿态）。
  写心情、写设定、写背景故事都没用，模型只画得出可见特征。
- **否定项要写进正向句**："剪影封闭无破洞" 比 "不要碎片化" 有效得多。
- 主角要额外压制 Q 版：「写实比例 4 头身、写实人体结构（不要 Q 版、不要卡通大眼、不要积木/方块头）」。

## 四、评审（必须做）

```powershell
node tools/vision.mjs shots/art-sheet.png -p "<中文问题>"
node tools/vision.mjs shots/peek-guoba.png -p "<中文问题>"
```

- **总览图只能筛"崩坏"，不能判风格。** 一格 192px 时模型的"Q版/风格不统一"结论不可靠
  —— 实测同一张 guoba 贴图在 192px 下被判"Q 版积木头"，放大到 512px 单独看则判
  "写实CG、材质扎实、与暗黑写实完全一致"。**判风格一律先 `peek.py --size 512`。**
- 崩坏的典型特征：多手多脚、断肢、重影、主体被裁切、残留不透明背景块。
- 模型答"能不能进游戏"时有随机性，只采信**具体位置的具体缺陷**；一句话结论可以忽略。

## 五、坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `响应里没有图片 URL` | 该模型返 `b64_json` | 已修：client 两种都接 |
| 游戏里出现深色方块 | 提示词背景不是纯色，抠图失败 | `clean.py` 会打印 `⚠️ 只抠掉 x%`，看到就重出图 |
| 贴图大小不一 | 没跑 `clean.py`，或主体占比差异大 | clean 会统一裁白边 + 撑满画布 |
| 一张要重出但跑了整批 | 没加 `--only` | `--only id --force` |
| 抠图把怪物的深色部位也抠掉 | 用了全图色差而不是边缘连通 | 本工具就是按连通性做的，不要自己换算法 |
| `UnicodeEncodeError: gbk` | Windows 控制台默认 GBK | 脚本已 `reconfigure(encoding="utf-8")`；新脚本照抄 |

## 六、入库约定

| 目录 | 入库 | 说明 |
| --- | --- | --- |
| `art/raw/` | ❌ 不入库（`.gitignore`） | 1MB+/张，且可由提示词复现 |
| `public/art/` | ✅ 入库 | 256×256、透明、总几十 KB/张，构建需要 |
| `tools/media/manifest.json` | ✅ 入库 | 模型 + 提示词 + 字节数，可追溯 |
| `tools/media/plans/*.json` | ✅ 入库 | 提示词的正本，改画风从改它开始 |
