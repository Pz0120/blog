# 发布站点到 peixy.xyz
#
# 用法（在站点根目录执行）：
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
#
# 做三件事：严格构建 → 上传静态资源到 Cloudflare Worker → 验证
# 部署脚本在 jingzhe-mobile/cf-deploy/，通过 CF_DEPLOY_DIR 环境变量指定。

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
