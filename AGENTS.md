# AGENTS.md — 给 AI 助手的项目说明

> 团队共用，三人（Gove2004 / yutong-2hou / Miku7767）都会读到。
> 这里只写**怎么干活**，不写**做到哪了** —— 进度以 `README.md` 的状态表为准，不要在此复制，避免两处打架。
> 单机特有的坑写进 `AGENTS.local.md`，那个文件不提交。

## 项目

反向肉鸽《锅巴必须死》：2D 俯视角，单局 5 分钟，浏览器直接玩。
参赛：WaytoAGI 1024 切磋大会 · 游戏赛道，**截止 2026-10-25 16:00**。
Vite + TypeScript(strict) + PixiJS；美术由图像模型生成，音乐音效 **100% WebAudio 程序合成**（零音频资源）。

动手前先读，不要猜：

- `README.md` — 现状、怎么跑、交付清单
- `docs/GAME_DESIGN.md` §3 核心循环 — 十分钟读懂玩法
- `docs/TECH_STACK.md` — 选型与理由

## 协作

- 远端 `https://github.com/Gove2004/20261024`（公开），只有 `main` 一条分支
- 三人共用 `main`，都有 push 权限，没有 PR 流程 → **动手前先 `git pull --rebase origin main`**
- 按目录切分写入范围，不要和人同时改同一个文件（见 README「并行开发」表）
- 改 `src/core/types.ts` 前先在群里打招呼

## Git

```powershell
git status -sb
git add -A; git commit -m "feat(范围): 中文简述"
git pull --rebase origin main
git push origin main
```

一键：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/git-sync.ps1 -Push`

- 提交信息：`feat|fix|chore|docs|art|test(范围): 中文简述`
- **禁止 `git push --force`** —— 会回滚队友历史
- 冲突不要整文件覆盖。rebase 里 `--ours` 是远端、`--theirs` 才是自己，容易搞反 → 用 `git checkout <SHA> -- <文件>` 按提交还原
- 细节与编码救援见 `docs/GIT_WORKFLOW.md`

## 绝对不能提交

`.env.local`（Key 会进公开仓库）、`node_modules/`、`dist/`、`art/raw/`。
`.gitignore` 已覆盖。若 `git status` 里出现它们，说明 ignore 被改坏了 —— 先查原因，不要直接 add。

## 代码约定（摘要）

- TS strict、禁止 `any`（用 `unknown` + 类型收窄）；相对路径导入，不用路径别名
- 随机数必须用注入的 `Rng`（种子化），禁止裸 `Math.random()`
- 热路径零分配：不 `new`、不闭包捕获、不用 `filter/map`
- 分层：`core` 不认识 Pixi，`gameplay` 不认识 DOM，`render` 只读 `gameplay` 状态
- 注释写「为什么」，不写「做了什么」
- 全文见 README「协作约定」

## 命令

```powershell
npm install
npm run dev          # http://localhost:5173
npm run build        # 类型检查 + dist/
npm test             # Vitest
node tools/smoke.mjs # 无头 Edge 冒烟测试，截图到 shots/
```

## 改完的自检

- 改逻辑 → `npm test`
- 改构建 / 渲染 → `npm run build`，且 `node tools/smoke.mjs` 出现 `SMOKE PASS`
- 改战斗数值 → `npm run sim`，把曲线贴到 `docs/GAME_DESIGN.md` §5.2

## 给 AI 的边界

- 不要为了让测试通过去改测试或放宽断言
- 不确定的需求先问，不要替人做玩法决策
- `docs/` 里的策划案是团队共识，不是可以随手重写的草稿；要改先说明理由
