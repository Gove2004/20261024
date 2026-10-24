# Git 协作流程

> 仓库多人 / 多 Agent 共享，远端历史里可能混入测试提交与占位文件。
> 完整操作手册见 [`.dsh/skills/git-sync/SKILL.md`](../.dsh/skills/git-sync/SKILL.md)，本文是给人看的速查版。

## 日常四步

```powershell
git status -sb                      # 1. 看清楚
git add -A; git commit -m "feat(xxx): 简述"
git pull --rebase origin main       # 2. 拉取（rebase，不留 merge 节点）
git push origin main                # 3. 推送
```

或者一条命令：

```powershell
pwsh -File tools/git-sync.ps1 -Push
```

脚本会检查工作区是否干净、`.env.local` 是否泄漏、落后/领先多少，然后 rebase 并推送。
**遇到冲突会停下并列出文件，不会自动选边。**

## 冲突怎么办

1. `git status` 看冲突文件。
2. 判断该保留谁：
   - 远端是测试/占位内容（例如只写着"测试仓库""我是锅巴"的 README）→ **保留本地正式版**；
   - 远端是队友真实改动 → **手工合并两边**，不要整文件覆盖。
3. 保留本地版本（rebase 场景下最稳）：

   ```powershell
   git checkout <本地提交SHA> -- README.md
   ```

   > rebase 里 `--ours` 是远端、`--theirs` 才是自己的提交，容易搞反，所以直接用 SHA 还原。
4. `git add <file>` → `git -c core.editor=true rebase --continue`。

放弃重来：`git rebase --abort`。

## 红线

| 禁止 | 原因 |
| --- | --- |
| `git push --force` | 会回滚队友历史 |
| 提交 `.env.local` | Key 会进公网；万一提交了，立刻 `git rm --cached` 并在平台重置 Key |
| 提交 `art/raw/`、`dist/`、`node_modules/` | 已在 `.gitignore` 里，出现即说明 ignore 被改坏 |
| 冲突整文件覆盖 | 会丢队友工作 |

## 无害的噪音

- `git push` 报 `git-credential-manager.exe: No such file or directory` —— 只要最后有 `xxxx..yyyy  main -> main` 就是成功的。
- `LF will be replaced by CRLF` —— Windows 行尾提示，可忽略。
- 文件内容变成 `閿呭反` 或开头多 `EF BB BF` —— 编码被 PowerShell 改坏，用 `git checkout <SHA> -- <file>` 按字节还原。

## 提交信息

`feat | fix | chore | docs | art | test` + 范围 + 中文简述：

```
feat(gameplay): 锅巴吃到怪物获得经验并升级
fix(ui): 手牌在 1280×720 下错位
art(guoba): 三形态立绘首批候选
```
