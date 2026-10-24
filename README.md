# 反向肉鸽 · 工作代号《锅巴必须死》

> **标题待定**（候选见 [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) §0.3）　|　仓库名 `guoba-must-die` 仅为工作代号
>
> **反向肉鸽**：你是魔王。放置魔物，在 5 分钟内杀掉来讨伐你的勇者「锅巴」。
> 双方都在成长——他杀掉你的魔物就会变强，你的权能让魔物变强。比的是谁长得更快。
>
> 2D 俯视角 · 单局 5 分钟 · 浏览器直接玩 · 美术由图像模型生成，**音乐音效 100% 程序合成**

参赛作品：WaytoAGI 1024 切磋大会 · 游戏赛道

---

## 目录

- [现在是什么状态](#现在是什么状态)
- [这个游戏怎么玩](#这个游戏怎么玩)
- [快速开始](#快速开始)
- [配置生成式 API Key](#配置生成式-api-key)
- [项目结构](#项目结构)
- [协作约定](#协作约定)
- [AI 资产管线](#ai-资产管线)
- [进度与分工](#进度与分工)
- [交付清单](#交付清单)

---

## 现在是什么状态

| 模块 | 状态 |
| --- | --- |
| 策划案 | ✅ 完成 · [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md)（v2.2，已同步"去掉引爆 + 纯远程"改版） |
| 技术选型 | ✅ 完成 · [`docs/TECH_STACK.md`](docs/TECH_STACK.md) |
| 工程骨架 | ✅ 可运行（固定步长循环 + Pixi 渲染 + DOM UI） |
| **M1 手感闭环** | ✅ **可玩**：大地图 + 相机跟随锅巴 + 画面内召唤 + 勇者 AI 三态 + 经验升级 + 倒计时判负 |
| **M2 卡池与星级** | ✅ **12 张卡全上**（6 张带主动特性：自爆/冰霜/治疗/嘲讽/火球/召唤）、1–10 星、CD 曲线、星数上限、升星权能、≥7★ 光环 |
| **M3 双成长** | ✅ **锅巴 7 个主动技能 + 14 条被动 + 权能 10 选 3**（每次升级中屏播报"Lv.N + 获得被动：X"） |
| **勇者改版** | ✅ **纯远程**（Y 字弹弓，单体射击 + 7 技能，无近战判定）；放技能时站定，被贴脸会翻滚 |
| **引爆** | ❌ **已移除**。魔王的唯一动作是"召唤"——决策全在"放什么、放哪、什么时候放" |
| **美术资产** | ✅ **19 张 AI 贴图已进游戏，统一可爱 Q 版平面风**（12 怪 + 主角双形态 + 王座 + 4 张环境：地面/墙/石柱/火盆），卡面直接用同一张图；出图/抠图/评审全自动，见 [`gen-image` 技能](.dsh/skills/gen-image/SKILL.md) |
| **M4 环境与画面** | ✅ **深色魔王殿质感升级**（手绘不规则石板地面 + 双层错尺度平铺 + 磨损裂纹 + 四角火盆暖光池 / 王座冷光 + 浮尘余烬粒子 + 暗角）；配色按既定方向**保持不变** |
| **M5 音频与移动端** | ✅ **WebAudio 全合成音频已接入**（120BPM D 弗里几亚 BGM + 10 类音效 + 紧迫度爬升 + 静音键 M）；**手机可玩**（360×640 实测无横向滚动、手牌横滑、卡牌 62×78 ≥ 44px 可点） |
| 部署上线 | ⬜ 待做 |

**现在就能玩**：`npm run dev` → 点「开始讨伐」。

美术怎么改（一条命令一批，4 路并发约 25 秒/张）：

```powershell
node tools/media/batch.mjs --plan tools/media/plans/monsters.json --only slime --force  # 重出某一张提示词改了之后
python tools/art/clean.py     # 抠背景 + 裁白边 + 统一 256
python tools/art/sheet.py     # 总览图，交给 vision.mjs 筛崩坏
```

自动化验证：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 19 条规则单测（星数曲线 / CD 曲线 / 成长公式 / 卡池 / 几何判定 / 技能与被动池一致性 / AI 参数红线） |
| `node tools/smoke.mjs` | 26 项端到端冒烟：进局 → 召唤 → 围杀 → **纯远程（260px 外能打到）** → **7 技能逐个触发** → 升级播报 → 六个魔物特性各触发一次 → 权能 → 倒计时判负 → 帧率 |
| `node tools/audio-probe.mjs` | 证明 BGM 与音效**真的被调度**（安静 3 秒统计振荡器 = 只有 BGM；再放怪统计战斗音效增量） |
| `node tools/mobile-probe.mjs` | 手机布局数值断言：360×640 / 430×932 / 844×390 三种视口下无横向滚动、手牌不溢出、卡牌 ≥44px、静音键可切换 |
| `node tools/simulate.mjs 8` | 快进跑 8 整局，输出胜率 / 终局等级 / 血量曲线，用来调平衡 |
| `node tools/shot.mjs out.png --clip 0,0,1280,200` | 定点截图（2x），用来看边距、字号这类局部问题 |
| `node tools/vision.mjs out.png` | **让多模态模型当眼睛**看截图；改完 UI / 渲染必须跑一次 |

> 里程碑与时间点见下方[进度与分工](#进度与分工)。**先看策划案的 §3 核心循环，十分钟能读懂整个游戏。**

---

## 这个游戏怎么玩

**你不是英雄，你是魔王——没有身体，看不见，也打不了。你只能放怪。**

1. **魔王殿是一张大地图（2400×1600）**，镜头**始终以锅巴为中心**跟着他走——他打到哪，你就看到哪。
2. 勇者「锅巴」是**远程弹弓手**：会走到你魔物的 250px 外站定射击，被贴到 120px 就翻滚后撤。**他没有近战判定**，也打不到你（找不到你）。
3. 你点卡 → 点画面里的地面召唤魔物，魔物自动攻击他。限制只有三条：
   - 每张卡自己的**放置 CD**
   - 场上存活魔物的**星级总和上限**（随时间提升）
   - **只能在当前画面内**放（你是魔王的眼睛，看不到的地方放不了）
4. **每张卡有 1–10 星**：星级 = 强度 = 占地。1 只 10★ 和 10 只 1★ 战力等价，但打法完全不同。
5. **他每亲手杀掉一只魔物就获得魔气、升级**：每级随机获得 1 条被动，并且解锁 7 个主动技能（散射、剑气、爆米花弹、蓄力重击、干粮、翻滚…）。
6. 你也在变强：每 **30 秒**「魔王权能」3 选 1（升星、缩 CD、加星数上限、诅咒他、封印他…）。
7. **5 分钟内把他打死 = 胜利**；**倒计时归零他还活着 = 失败**（立即弹结算）。

**核心张力**：魔物既是你的输出，也是他的经验 —— 放得少打不动，放得多他长得比你快。

**关键操作**：点卡 → 点地召唤。就这一个动作。

> 为什么没有"引爆"：原型里双击魔物引爆（范围伤害 + 阻断经验）能把任何劣势一键抹平，
> 结果玩家的操作退化成"点卡 → 摆 → 双击"。删掉它之后，唯一的止损手段是
> **提前把怪铺在必经之路上** —— 这才是"反派布阵"该有的思考量。

完整规则、数值表、卡池、强化池见 **[`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md)**。

---

## 快速开始

环境要求：Node.js ≥ 20。

```bash
npm install
npm run dev           # 本地开发 http://localhost:5173
npm run build         # 类型检查 + 产出 dist/
npm run preview       # 预览构建产物
npm test              # 单元测试（Vitest）
node tools/smoke.mjs  # 无头 Edge 冒烟测试：加载 dist、点开始、量帧率、出截图到 shots/
npm run sim           # 无渲染跑 1000 局做数值校准（待实现）
```

**当前骨架已验证**：`npm run build` 通过（dist ≈ 150KB gzip），`node tools/smoke.mjs` → `SMOKE PASS`（WebGL2 上下文建立、标题层正常隐藏、无 console error、软件渲染下 40fps）。

> **Node 不在 PATH 时（本机常见）**：先 `$env:PATH="D:\Nodejs;$env:PATH"`。
> npm 缓存若遇到权限问题，加 `--cache "$PWD\.npm-cache"`。

---

## 配置生成式 API Key

项目用 [OpenAI Next Credits](https://credits.openai-next.com/guide/handbook) 生成贴图（角色、魔物、场景、UI）。
**音乐与音效不使用任何外部服务** —— 全部 WebAudio 程序合成，见 `docs/TECH_STACK.md` §5。

1. **复制模板**
   ```bash
   cp .env.example .env.local
   ```
2. **填入你自己的 Key**（找 owner 要，或用自己的账号申请）
   ```
   CREDIT_MEDIA_API_KEY=sk-你的key
   ```
3. **确认被 git 忽略**
   ```bash
   git check-ignore -v .env.local     # 应该输出一条匹配规则
   ```

⚠️ **`src/` 里的前端代码永远不要直接调用生成式 API** —— Key 会随构建产物发布到公网。
所有生成只走 `tools/media/*.mjs` 命令行脚本，产物落盘后再提交。

`.env.local` 已被 `.gitignore` 忽略，**不会**进入仓库。

---

## 项目结构

```
20261024/
├─ docs/
│  ├─ GAME_DESIGN.md        # 完整策划案（先读这个）
│  ├─ TECH_STACK.md         # 技术选型 + API 实测记录 + 资产管线
│  └─ CHARACTER_CARD.md     # 参赛主角卡底稿与素材台账
├─ public/assets/           # 构建产物：图集、音频、字体
├─ art/raw/                 # AI 原始出图（不提交）
├─ tools/
│  ├─ media/
│  │  ├─ client.mjs         # API 封装：重试、限流、下载、manifest
│  │  ├─ gen-image.mjs      # 出图命令行
│  │  └─ manifest.json      # 每个资产的 prompt / 模型 / 用量（提交，凭证）
│  ├─ art/                  # 去背、裁边、图集打包（待实现）
│  ├─ smoke.mjs             # 无头浏览器冒烟测试 + 截图
│  └─ simulate.mjs          # 无渲染数值模拟（待实现）
├─ src/
│  ├─ main.ts               # 入口：装配骨架场景
│  ├─ core/loop.ts          # 固定步长循环（已实现）
│  ├─ render/stage.ts       # Pixi 初始化 + letterbox 适配（已实现）
│  ├─ app/                  # 场景装配、加载流程（待实现）
│  ├─ ecs/                  # 稀疏集合实体表（待实现）
│  ├─ gameplay/             # 战斗、勇者 AI、相机、卡牌 CD、星数、权能、结算（待实现）
│  ├─ content/              # 纯数据：卡池、权能池、台词、调色板（待实现）
│  ├─ ui/                   # DOM 覆盖层（待实现）
│  ├─ audio/                # 音序器 BGM + 合成音效 + 总线（待实现，零音频文件）
│  └─ save/                 # localStorage、每日种子（待实现）
├─ tests/                   # Vitest 单元测试
├─ .env.example             # API Key 模板（提交）
├─ .env.local               # 真实 Key（不提交）
└─ README.md
```

**分层依赖单向，不许反向引用**：

```
core  →  ecs / gameplay  →  render / ui  →  app
```

`core` 不认识 Pixi；`gameplay` 不认识 DOM；`render` 只读取 `gameplay` 的状态，不写回。

---

## 协作约定

### 代码

- TypeScript **strict**，`verbatimModuleSyntax`，**禁止 `any`**（用 `unknown` + 类型收窄）。
- 组件用**相对路径**导入，不用路径别名（避免 Vite / Vitest / tsc 三处配置漂移）。
- 热路径（`update` / 渲染循环）**零分配**：不 `new`、不闭包捕获、不用 `filter/map`。
- 随机**必须**用注入的 `Rng`（种子化），禁止裸 `Math.random()` —— 否则「每日魔殿」和数值模拟都失效。
- 注释用中文 TSDoc，写**为什么**，不写**做了什么**。

### 提交

- 一个可验证的改动一次提交；提交信息 `feat|fix|chore|docs|art(范围): 中文简述`。
- 提交前跑 `npm test`；改了战斗数值要跑 `npm run sim` 并把曲线贴到 `docs/GAME_DESIGN.md` §5.2。
- **永远不要提交 `.env.local`、`node_modules`、`dist`、`art/raw`。**

### 拉取 / 冲突 / 推送

```powershell
git pull --rebase origin main     # 永远 rebase，不留 merge 节点
git push origin main
```

冲突处理、rebase 里 `--ours` 反坑、编码被改坏的救法，见 **[`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md)**。
一键同步：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/git-sync.ps1 -Push`（遇冲突会停下，不自动选边）。

> Agent 侧同一套规则已写成**仓库级技能** `.dsh/skills/git-sync/SKILL.md`，
> 对 Agent 说一句"拉取并推一下"就会自动按这个流程走。

### 并行开发

多人 / 多 Agent 同时干活时，**按目录切分写入范围**，不要两个人同时改同一个文件：

| 线 | 目录 | 内容 |
| --- | --- | --- |
| A 核心战斗 | `src/gameplay/**`, `src/ecs/**` | 实体、碰撞、锅巴 AI、经验 |
| B 卡牌成长 | `src/content/**`, `src/gameplay/cards/**` | 卡池、魂、星级、强化池、结算 |
| C 表现 | `src/render/**`, `src/ui/**` | 渲染、粒子、镜头、动效、UI |
| D 资产 | `tools/**`, `public/assets/**`, `art/**` | AI 生图、音乐、切图、图集 |

共享的类型定义（`src/core/types.ts`）改动前先在群里说一声。

---

## AI 资产管线

```
提示词 → 生成 → art/raw → 去背 → 裁边 → 缩放 → 图集 → public/assets
```

命令（出图已可用，切图脚本待实现）：

```bash
# 出图：自动读取 .env.local 的 Key，失败重试，产物落盘并写入 manifest.json
node tools/media/gen-image.mjs --model gpt-image-2 --prompt "..." --out art/raw/hero_lv1.png
node tools/media/gen-image.mjs --model gemini-3-pro-image --prompt-file tools/media/prompts/hero.txt --out art/raw/hero_lv2.png

# 去背 + 裁边 + 缩放 + 打包图集（待实现）
node tools/art/clean.py
node tools/art/pack.py
```

- 每个资产的 prompt / 模型 / 生成时间 / token 用量记录在 `tools/media/manifest.json`（**提交进仓库**，这是"AI 生成"的凭证）。
- 风格统一靠**一张风格锚点图** + 所有后续生成都带参考图。
- **音乐音效不走 API**：全部 WebAudio 程序合成，零音频文件，见 `docs/TECH_STACK.md` §5。
- 实测结论（2026-10-24）：
  - `gpt-image-2` **✅ 可用，28.9 秒/张，1056 image tokens**（比 `gpt-image-1` 的 22s/4208 tokens 更划算）
  - 音频端点（Suno 403 / TTS 429）不可用 → 已改为程序生成，不再依赖
  - 详见 [`docs/TECH_STACK.md`](docs/TECH_STACK.md) §3

---

## 进度与分工

| 时间 | 阶段 | 目标 |
| --- | --- | --- |
| 10/24 16:30–19:00 | M0 骨架 | 循环 + 场景 + 资源加载，60fps |
| 10/24 19:00–23:00 | M1 战斗闭环 | **能玩一局** ✅ |
| 10/24 23:00–02:00 | M2 卡牌星级 | 三幕结构成立 ✅ |
| 10/25 02:00–05:00 | M3 双成长 | 每局构筑不同 ✅（技能/被动/权能池已上） |
| 10/25 08:00–11:00 | M4 美术接入 | 截图能当宣传图 ✅（角色贴图重出 + 环境质感升级 + 光池/粒子） |
| 10/25 11:00–13:30 | M5 音频与收尾 | 手机能玩 ✅（全合成音频 + 移动端 3 视口断言通过） |
| 10/25 13:30–15:00 | M6 交付 | 主角卡 + 部署上线 |
| 截止 | **10/25 16:00** | 提交作品 |

---

## 交付清单

赛事要求（对照 [游戏赛道](https://1024.waytoagi.com/tracks/game)）：

- [ ] **浏览器/手机可直接玩的链接** — 构建已推到 `gh-pages` 分支，等仓库 Settings → Pages 里选 `gh-pages` 分支即可上线：https://gove2004.github.io/20261024/
- [x] **从开始到重开能完整玩一局**（`node tools/smoke.mjs` 26 项覆盖：进局 → 召唤 → 围杀 → 升级 → 权能 → 倒计时判负 → 重开）
- [x] **操作提示在游戏内**（底部常驻提示条 + 标题页三步说明 + 手机可见）
- [x] **主角卡 1 张** — `shots/guoba-card.png`（`python tools/art/card.py` 重出），配套文案见 [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
- [x] 角色与道具为 AI 生成（保留 `tools/media/manifest.json` 作为凭证）
- [ ] 提交截止：**2026-10-25 16:00**

投稿文案、三段式介绍、主角设定全在 [`docs/SUBMISSION.md`](docs/SUBMISSION.md)，可直接粘到报名页。

---

## 许可证

本项目为参赛作品，未授权前请勿商用或二次分发美术资产。
