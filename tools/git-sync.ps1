#Requires -Version 5.1
<#
.SYNOPSIS
    仓库同步助手：fetch → rebase → 冲突提示 →（可选）push。

.DESCRIPTION
    刻意"胆小"：冲突时不自动选边，失败时明确停下，绝不 force push。
    冲突解决规则见 .dsh/skills/git-sync/SKILL.md 或 docs/GIT_WORKFLOW.md。

.EXAMPLE
    pwsh -File tools/git-sync.ps1
    pwsh -File tools/git-sync.ps1 -Push
#>
[CmdletBinding()]
param(
    [switch]$Push,
    [string]$Remote = 'origin',
    [string]$Branch = 'main'
)

# 注意：PS 5.1 里 native 命令写 stderr 时会被包成 ErrorRecord，
# 若 ErrorActionPreference=Stop 会误判成致命错误（git push 成功也走 stderr）。
# 所以统一用 Continue + 显式检查 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "   $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "   $text" -ForegroundColor Yellow }
function Write-Err2($text) { Write-Host "   $text" -ForegroundColor Red }

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Err2 "git $($GitArgs -join ' ') 失败（exit $LASTEXITCODE）"
        exit 1
    }
}

# 0. 前置检查 ---------------------------------------------------------------
Write-Step '检查工作区'
$dirty = & git status --porcelain
if ($dirty) {
    Write-Err2 '工作区有未提交的改动：'
    $dirty | ForEach-Object { Write-Host "     $_" }
    Write-Err2 '请先 commit 或 git stash，再运行本脚本。'
    exit 1
}
Write-Ok '工作区干净'

$tracked = & git ls-files -- .env.local 2>$null
if ($tracked) {
    Write-Err2 '.env.local 已被 git 跟踪！立即处理：git rm --cached .env.local，并重置该 Key。'
    exit 1
}
Write-Ok '.env.local 未被跟踪'

# 1. fetch ----------------------------------------------------------------
Write-Step "拉取 $Remote/$Branch"
Invoke-Git fetch $Remote
$behind = & git rev-list --count "HEAD..$Remote/$Branch"
$ahead = & git rev-list --count "$Remote/$Branch..HEAD"
Write-Ok "落后 $behind 个提交，领先 $ahead 个提交"

if ($behind -gt 0) {
    Write-Step '远端新增的提交'
    & git log --oneline "HEAD..$Remote/$Branch" | ForEach-Object { Write-Host "     $_" }
}

# 2. rebase ---------------------------------------------------------------
if ($behind -gt 0) {
    Write-Step 'rebase 到远端'
    & git -c core.editor=true pull --rebase $Remote $Branch
    if ($LASTEXITCODE -ne 0) {
        $conflicts = & git diff --name-only --diff-filter=U
        Write-Err2 'rebase 中断（有冲突）。需要人工处理的文件：'
        $conflicts | ForEach-Object { Write-Host "     $_" -ForegroundColor Yellow }
        Write-Warn2 ''
        Write-Warn2 '解决后执行：'
        Write-Warn2 '  git add <文件>'
        Write-Warn2 '  git -c core.editor=true rebase --continue'
        Write-Warn2 '想放弃则：git rebase --abort'
        Write-Warn2 '注意：rebase 中 --ours 是远端、--theirs 才是你的提交。保留本地版本请用 git checkout <SHA> -- <file>'
        exit 1
    }
    Write-Ok 'rebase 完成'
} else {
    Write-Ok '无需 rebase'
}

# 3. push -----------------------------------------------------------------
if ($Push) {
    $ahead = & git rev-list --count "$Remote/$Branch..HEAD"
    if ($ahead -eq 0) {
        Write-Ok '没有需要推送的提交'
    } else {
        Write-Step "推送到 $Remote/$Branch"
        Invoke-Git push $Remote $Branch
        Write-Ok "已推送 $ahead 个提交"
    }
} else {
    Write-Warn2 '未加 -Push，已跳过推送'
}

# 4. 结果 -----------------------------------------------------------------
Write-Step '最终状态'
& git status -sb
& git log --oneline -3 | ForEach-Object { Write-Host "     $_" }
Write-Ok '同步结束'
