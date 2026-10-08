# 站点配置引导脚本。新用户 clone 仓库后跑一次。
# 用法: powershell -ExecutionPolicy Bypass -File .\setup.ps1

param(
    [string]$Domain          = "",
    [string]$GitHubOwner     = "",
    [string]$GitHubRepo      = "",
    [string]$GitHubBranch    = "main",
    [string]$MapboxToken     = "",
    [string]$DoubanId        = "",
    [string]$WereadApiKey    = ""
)

$ErrorActionPreference = "Stop"
$site = $PSScriptRoot

Write-Host ""
Write-Host "=== 站点配置 ===" -ForegroundColor Cyan
Write-Host ""

function Ask($label, $example, $secret) {
    Write-Host "  $label" -ForegroundColor Yellow -NoNewline
    Write-Host " (例: $example)" -ForegroundColor DarkGray -NoNewline
    Write-Host " > " -NoNewline
    if ($secret) {
        $secure = Read-Host -AsSecureString
        [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    } else {
        Read-Host
    }
}

if (-not $Domain)       { $Domain       = Ask "站点域名"          "https://myblog.com"   $false }
if (-not $GitHubOwner)  { $GitHubOwner  = Ask "GitHub 用户名"     "myname"               $false }
if (-not $GitHubRepo)   { $GitHubRepo   = Ask "GitHub 仓库名"      "blog"                $false }
if (-not $MapboxToken)  { $MapboxToken  = Ask "Mapbox 令牌(pk.)"  "pk.xxx"               $true  }
if (-not $DoubanId)     { $DoubanId     = Ask "豆瓣 ID(可选)"     "12345678"            $false }
if (-not $WereadApiKey) { $WereadApiKey = Ask "微信读书key(可选)"  "wrk-xxx"             $true  }

$cfg = Join-Path $site "config/_default"
$ht  = Join-Path $cfg "hugo.toml"
$pt  = Join-Path $cfg "params.toml"

# hugo.toml: baseURL
$htc = Get-Content -LiteralPath $ht -Raw -Encoding UTF8
$htc = $htc -replace "(baseURL\s*=\s*\"").*?(\")", "`${1}${Domain}`$2"
Set-Content -LiteralPath $ht -Value $htc -Encoding UTF8
Write-Host ""
Write-Host "  baseURL = $Domain"

# params.toml
$ptc = Get-Content -LiteralPath $pt -Raw -Encoding UTF8
$ptc = $ptc -replace "(owner\s*=\s*\").*?(\")",           "`${1}${GitHubOwner}`$2"
$ptc = $ptc -replace "(name\s*=\s*\")YOUR_REPO_NAME(\")",  "`${1}${GitHubRepo}`$2"
$ptc = $ptc -replace "(url\s*=\s*\").*?(\")",              "`${1}https://github.com/${GitHubOwner}/${GitHubRepo}`$2"
$ptc = $ptc -replace "(workerUrl\s*=\s*\").*?(\")",        "`${1}https://your-publisher.your-subdomain.workers.dev`$2"
$ptc = $ptc -replace "(imageBaseUrl\s*=\s*\").*?(\")",    "`${1}https://pub-xxxxx.r2.dev`$2"
Set-Content -LiteralPath $pt -Value $ptc -Encoding UTF8

Write-Host ""
Write-Host "=== GitHub Actions 配置 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "  请在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加："
Write-Host ""
Write-Host "    变量 (Variables):"
if ($DoubanId) { Write-Host "      DOUBAN_ID = $DoubanId" }
Write-Host ""
Write-Host "    密钥 (Secrets):"
Write-Host "      CLOUDFLARE_API_TOKEN = 你的 Cloudflare API 令牌"
if ($WereadApiKey) { Write-Host "      WEREAD_API_KEY   = $WereadApiKey" }
Write-Host "      ADMIN_TOKEN        = 网页编辑器口令（随机字符串）"
Write-Host ""

Write-Host "=== 完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "  git add -A && git commit -m ""configure site"" && git push"
Write-Host ""

