---
name: git-sync
description: 在本仓库（D:\Data\Projects\20261024）提交、拉取、解决合并冲突并推送时使用。当需要 commit / pull / rebase / 处理冲突 / push，或队友推送后本地落后、出现 non-fast-forward、抛 README 或其他文件冲突时加载本技能。
---

# 仓库同步流程（commit → pull → 解决冲突 → push）

本仓库是多人 / 多 Agent 共享的参赛仓库。**远端历史里可能混入他人的测试提交与占位文件**，
所以"能推上去"不等于"推对了"。按下面的顺序做，每一步都先看状态再动手。

## 0. 铁律

1. **永远不 force push**（`--force` / `--force-with-lease` 都不要）。历史被回滚会毁掉队友的工作。
2. **永远不提交 `.env.local`**。提交前必须 `git status` 看一眼，出现 `.env*`（除 `.env.example`）就停下。
3. **冲突不要用默认策略一把梭**。逐文件判断，宁可多花两分钟。
4. 二进制/大文件（`art/raw/`、`dist/`、`node_modules/`）已被 `.gitignore` 忽略；如果它们出现在待提交列表里，说明 `.gitignore` 被改坏了，先查原因。

## 1. 提交前

```powershell
git status -sb                 # 分支 + 待提交文件
git check-ignore -v .env.local # 必须输出一条匹配规则
```

如果有改动：

```powershell
git add -A
git commit -m "feat(范围): 中文简述"      # 一个可验证改动一次提交
```

提交信息前缀：`feat | fix | chore | docs | art | test`，范围用目录名（`gameplay`、`ui`、`media`…）。

## 2. 拉取

```powershell
git fetch origin
git log --oneline HEAD..origin/main    # 远端多了什么（先看清楚）
git log --oneline origin/main..HEAD    # 本地多了什么
```

**推荐 rebase**（线性历史，冲突一次处理完，不留 merge 提交）：

```powershell
git pull --rebase origin main
```

若仓库里已有他人推的 merge 提交，rebase 依然可用；**不要**改成 `git pull`（会产生无意义的 merge 节点）。

## 3. 解决冲突

出现冲突时：

```powershell
git status            # 看清 AA / UU 标记的文件
```

### 3.1 判断"该保留谁的"

| 情况 | 做法 |
| --- | --- |
| 远端是测试/占位内容（如只写"测试仓库""我是锅巴"的 README） | **保留本地正式版本** |
| 远端是队友的真实改动 | **两边都要**：先读两边内容，手工合并，不要整文件覆盖 |
| 纯格式 / 行尾差异（CRLF 警告） | 忽略，自动能过 |
| 二进制文件冲突 | `git checkout --ours <file>`（本地）或 `--theirs`（远端），然后**重新生成**该资源 |

> ⚠️ **rebase 时 `--ours` / `--theirs` 是反的**：rebase 中 `ours` = 远端（上游），`theirs` = 你正在重放的提交。
> 想保留本地版本时，别用 `--ours`，用下面 3.2 的办法。

### 3.2 保留本地版本（最稳的方式，绕开上面那个坑）

```powershell
git show HEAD:README.md | Set-Content -Encoding utf8 README.md   # 会带 BOM，不推荐
git checkout <提交SHA> -- README.md                              # 推荐：按字节还原，无 BOM
```

`<提交SHA>` 取本地提交（rebase 前分支的 tip，即 `ORIG_HEAD` 之前的那个）。

### 3.3 两边合并

直接用编辑器打开带冲突标记的文件，删掉 `<<<<<<< ======= >>>>>>>` 并把两边内容按业务需要组合，
然后 `git add <file>`。

### 3.4 完成

```powershell
git add <已解决的文件>
git -c core.editor=true rebase --continue      # 避免弹出编辑器卡住
# 卡住了就：git rebase --abort                 # 回到 rebase 前，重新想一遍
```

## 4. 推送与验证

```powershell
git push origin main
git status -sb          # 期望输出：## main...origin/main（没有 ahead / behind）
git log --oneline -3
git log origin/main --oneline -1   # 与 HEAD 一致
```

`git push` 输出里那条 `git-credential-manager.exe: No such file or directory` 是**无害**的，
只要最后出现 `xxxx..yyyy  main -> main` 就成功了。

## 5. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `! [rejected] main -> main (non-fast-forward)` | 远端有新提交 | 回到第 2 步 fetch + rebase |
| `error: cannot pull with rebase: You have unstaged changes` | 工作区不干净 | 先 commit 或 `git stash` |
| 文件内容变成 `锟斤拷` / `閿呭反` | 编码被转成 GBK，或 PowerShell 管道写入 | 用 `git checkout <SHA> -- <file>` 按字节还原 |
| 文件开头多出 `EF BB BF`（BOM） | `Set-Content` / `Out-File -Encoding utf8` 在 PS 5.1 会写 BOM | 同上，用 `git checkout` 还原；校验：`[System.IO.File]::ReadAllBytes($f)[0..2]` |
| `.git/index.lock` Permission denied | 并发 git 进程或沙箱拦截 | 确认没有其他 git 在跑；必要时 `.git/index.lock` 手动删（先确认无进程） |
| 提交里混进了 `.env.local` | 忘了检查 | `git rm --cached .env.local`，并**立即在平台重置 Key** |

## 6. 一键同步脚本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/git-sync.ps1          # fetch + rebase + 冲突提示
powershell -NoProfile -ExecutionPolicy Bypass -File tools/git-sync.ps1 -Push    # 干净时直接 push
```

脚本遇到冲突会停下并列出文件，**不会**自动选边站 —— 冲突永远由人来判断。

> 本机只有 Windows PowerShell 5.1（没有 `pwsh`），所以用上面的写法。
> ⚠️ `tools/git-sync.ps1` 必须保存为 **UTF-8 with BOM**：PS 5.1 会按 ANSI(GBK) 读取无 BOM 的 .ps1，
> 中文会变成乱码并直接语法报错。修改该脚本后先确认 BOM：
> ```powershell
> [System.IO.File]::ReadAllBytes('tools/git-sync.ps1')[0..2]   # 应为 239 187 191
> ```
