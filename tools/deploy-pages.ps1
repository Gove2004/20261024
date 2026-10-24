# 把 dist/ 发布到 gh-pages（GitHub Pages）。
#
# 为什么不用 `git subtree push --prefix dist origin gh-pages`：
#   dist/ 在 .gitignore 里，subtree split 切出来是**空的**，
#   这时命令会退化成 `git push origin :refs/heads/gh-pages` ——
#   **直接把线上分支删掉**（2026-10-25 真踩过一次，站点 404）。
#   所以这里用 orphan 分支 + 临时目录：工作区不动，失败也不会破坏远端。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/deploy-pages.ps1

$ErrorActionPreference = "Stop"
$repo = "D:\Data\Projects\20261024"
$remote = "https://github.com/Gove2004/20261024.git"
$tmp = Join-Path $env:TEMP "ghdeploy-20261024"

Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "构建失败，未发布" }
} finally {
  Pop-Location
}

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
git clone --depth 1 $remote $tmp | Out-Null

Push-Location $tmp
try {
  git config user.email "gove2004@users.noreply.github.com"
  git config user.name "Gove2004"
  git checkout --orphan gh-pages | Out-Null
  git rm -rf --quiet . 2>$null
  Copy-Item -Path (Join-Path $repo "dist\*") -Destination $tmp -Recurse -Force
  # .nojekyll：不加的话 Pages 会走 Jekyll，把 assets/ 里带下划线的文件名吞掉
  New-Item -Path (Join-Path $tmp ".nojekyll") -ItemType File -Force | Out-Null
  git add -A
  git commit -q -m "deploy: v2.4 势场走位 + 5 卡池 + 复合天赋 + 飘字"
  git push origin gh-pages --force
  Write-Host "已推送到 gh-pages。等 1 分钟后跑 node tools/live-probe.mjs 验证。"
} finally {
  Pop-Location
}
