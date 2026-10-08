# 发布站点到 peixy.xyz
#
# 用法（在站点根目录执行）：
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
#
# 做四件事：注入 Mapbox token → 严格构建 → 上传静态资源到 Cloudflare Worker → 验证
#
# 注意：本文件保存为 UTF-8 带 BOM。Windows PowerShell 5.1 读取无 BOM 的
# UTF-8 文件时会按 GBK 解释，中文会变成乱码并导致语法错误。改这个文件时
# 请保持 BOM。

param(
    [string]$DeployDir = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$site = $PSScriptRoot

if (-not $DeployDir) {
    # 默认按相对位置找
    $candidates = @(
        (Join-Path $site '..\jingzhe-mobile\cf-deploy'),
        (Join-Path $site 'jingzhe-mobile\cf-deploy'),
        'C:\Users\Pz\Documents\deepseek-harness\default-workspace\jingzhe-mobile\cf-deploy'
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'workers_site.py')) { $DeployDir = $c; break }
    }
}

if (-not $DeployDir -or -not (Test-Path (Join-Path $DeployDir 'workers_site.py'))) {
    Write-Host "找不到部署脚本 workers_site.py" -ForegroundColor Red
    Write-Host "请用 -DeployDir 指定 jingzhe-mobile\cf-deploy 的路径"
    exit 1
}

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Write-Host ""
Write-Host "发布到 peixy.xyz" -ForegroundColor Cyan
Write-Host "  站点目录 $site"
Write-Host "  部署脚本 $DeployDir"
Write-Host ("=" * 58)

# ── 注入 Mapbox token ────────────────────────────────────────────────
# token 存在站点根目录的 .mapbox-token（已 gitignore），不进仓库。
# 不这么做的话 GitHub 的推送保护会把它判定为密钥并直接拒绝推送（GH013），
# 而且公开仓库里的 token 会被爬虫扫走、消耗你的额度。
# 模板里用 os.Getenv "MAPBOX_TOKEN" 读取，见 themes/jingzhe_v3/layouts/zouguo.html
$tokenFile = Join-Path $site '.mapbox-token'
if (Test-Path -LiteralPath $tokenFile) {
    $env:MAPBOX_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim()
    Write-Host "  Mapbox token 已注入（$($env:MAPBOX_TOKEN.Length) 字符）"
} else {
    Write-Host "  警告：没找到 .mapbox-token —— 地图会加载不出来" -ForegroundColor Yellow
    Write-Host "        该文件应包含一行 pk. 开头的 Mapbox 令牌"
}

if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "── 1. 严格构建" -ForegroundColor Cyan
    Push-Location $site
    hugo --minify --panicOnWarning
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) {
        Write-Host "构建失败，已中止（线上站点不受影响）" -ForegroundColor Red
        exit 1
    }
    Write-Host "  构建成功"
}

Write-Host ""
Write-Host "── 2. 上传并部署" -ForegroundColor Cyan
python (Join-Path $DeployDir 'workers_site.py')
if ($LASTEXITCODE -ne 0) {
    Write-Host "部署失败" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "完成。访问 https://peixy.xyz/" -ForegroundColor Green
Write-Host ""
