# 一键把当前站点变成可部署模板。
#
# 用法（在站点根目录）：
#   powershell -ExecutionPolicy Bypass -File .\make-template.ps1

param(
    [string]$SiteName = "我的博客",
    [string]$Domain   = "https://example.com"
)

$ErrorActionPreference = 'Stop'
$site = $PSScriptRoot

Write-Host ''
Write-Host '=== 站点模板化 ===' -ForegroundColor Cyan

# ── 1. 替换个性化内容 ─────────────────────────────────────────
Write-Host ''
Write-Host '[1/4] 替换个性化内容为通用示例'

# 唠叨：合成短动态 -> 通用示例
$laodaoPath = Join-Path $site 'content/laodao/2026/10/20261008-125646.md'
if (Test-Path -LiteralPath $laodaoPath) {
    Set-Content -LiteralPath $laodaoPath -Value (
        "---`r`ndate: 2026-10-08T13:00:00+08:00`r`n---`r`n`r`n今天天气不错，适合出门走动。`r`n"
    ) -Encoding UTF8
    Write-Host '  ✓ 唠叨示例已替换'
} else {
    Write-Host '  - 个人唠叨文件不存在，跳过'
}

# 走过：补一个通用示例
$zouguoExample = Join-Path $site 'content/zouguo/_template-example.md'
if (-not (Test-Path -LiteralPath $zouguoExample)) {
    Set-Content -LiteralPath $zouguoExample -Value (
        "---`r`ntitle: 示例地点`r`ndate: 2024-05-01T10:00:00+08:00`r`ntype: zouguo`r`ndraft: false`r`nzouguo:`r`n  occurred_at: 2024-05-01T10:00:00+08:00`r`n  place:`r`n    id: osm:relation:8847697`r`n    name: 天安门, 北京市, 中国`r`n    longitude: 116.391263`r`n    latitude: 39.907359`r`n    precision: poi`r`n    privacy: public`r`n    country: 中国`r`n    country_code: CN`r`n    region: 北京市`r`n    locality: 北京市`r`n    provider: mapbox`r`n    provider_id: mapbox:poi.xxxxxxxx`r`n---`r`n`r`n这是一条示例走过记录。`r`n`r`n> 本文件仅为模板示例，可在上线后删除。`r`n"
    ) -Encoding UTF8
    Write-Host '  ✓ 走过示例已生成'
}

# ── 2. 配置参数化（直接写入，避免编码问题）─────────────────────
Write-Host ''
Write-Host '[2/4] 配置文件参数化'

$brandName = ([string]$SiteName -replace '[^\w\-]', '')
if (-not $brandName) { $brandName = "MyBlog" }

# params.toml — 直接写入模板版本
$paramsContent = @"
profile = "core"
description = "在此描述你的站点"
contentTypeName = "posts"
addDot = false
RSSNoContent = false

[author]
  name = "$brandName"
  email = ""

[brand]
  name = "$brandName"
  footerName = "$brandName"
  footerTagline = "在这里写一句你的心情"
  favicon = ""
  appleTouchIcon = ""
  avatar = ""
  avatarAlt = ""
  webAppTitle = "$brandName"
  manifestPath = "/manifest.webmanifest"

[repository]
  owner = "YOUR_GITHUB_USERNAME"
  name = "YOUR_REPO_NAME"
  branch = "main"
  url = "https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME"

[assets]
  fontRegularUrl = ""
  fontBoldUrl = ""

[features]
  core = true
  publisher = true
  social = false
  movies = true
  books = true
  exercise = false
  aiCoach = false
  externalShop = false

[services.social]
  commentsApi = ""
  likesApi = ""
  likesSubmitUrl = ""
  turnstileSiteKey = ""
  turnstileScriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  adminEmail = ""
  avatarBaseUrl = "https://weavatar.com/avatar"

[services.publisher]
  workerUrl = "https://your-publisher.your-subdomain.workers.dev"
  draftUrl = ""
  imageBaseUrl = "https://pub-xxxxx.r2.dev"

[services.images]
  enabled = false
  sourceOrigin = ""
  deliveryOrigin = ""
  thumbWidth = 128
  smallWidth = 640
  largeWidth = 960
  quality = 75

[services.exercise]
  mapboxToken = ""
  mapboxApiOrigin = "https://api.mapbox.com"
  mapboxEventsOrigin = "https://events.mapbox.com"
  mapboxCssUrl = "https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.css"
  mapboxJsUrl = "https://registry.npmmirror.com/mapbox-gl/3.26.0/files/dist/mapbox-gl.js"
  mapboxLightStyle = "mapbox://styles/mapbox/light-v11"
  mapboxDarkStyle = "mapbox://styles/mapbox/dark-v11"
  mapCenter = [0.0, 0.0]
  posterFilePrefix = "JingzheExercise"

[services.rss]
  followFeedId = ""
  followUserId = ""

[about]
  photos = []
"@

Set-Content -LiteralPath (Join-Path $site 'config/_default/params.toml') -Value $paramsContent -Encoding UTF8
Write-Host "  ✓ params.toml 已参数化（品牌: $brandName）"

# hugo.toml — 直接写入模板版本
$hugoContent = @"
baseURL = "$Domain"
locale = "zh-CN"
title = "$brandName"
theme = "jingzhe_v3"

enableRobotsTXT = true
hasCJKLanguage = true
cleanDestinationDir = true

[module]
  [module.hugoVersion]
    extended = true
    min = "0.158.0"

[permalinks]
  posts = "/:slug/"

[markup]
  [markup.highlight]
    guessSyntax = true
    lineNos = false
    noClasses = false

  [markup.goldmark.renderer]
    unsafe = true

[taxonomies]
  category = "categories"
  tag = "tags"
  laodaotag = "laodaotags"

[related]
  includeNewer = true
  threshold = 80
  toLower = true

  [[related.indices]]
    name = "laodaotags"
    weight = 100

  [[related.indices]]
    name = "date"
    pattern = "200601"
    weight = 10

[outputs]
  home = ["HTML", "RSS"]
  section = ["HTML", "RSS", "JSON"]

[menu]
  [[menu.main]]
    identifier = "home"
    name = "首页"
    url = "/"
    weight = 1
  [[menu.main]]
    identifier = "posts"
    name = "随笔"
    url = "/posts/"
    weight = 2
"@

Set-Content -LiteralPath (Join-Path $site 'config/_default/hugo.toml') -Value $hugoContent -Encoding UTF8
Write-Host "  ✓ hugo.toml 已参数化（域名: $Domain）"

# ── 3. 生成 setup.ps1 ─────────────────────────────────────────
Write-Host ''
Write-Host '[3/4] 生成 setup.ps1'

$setupContent = @'
# 站点配置引导脚本。
#
# 新用户 clone 仓库后跑一次：
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1

param(
    [string]$Domain          = '',
    [string]$GitHubOwner     = '',
    [string]$GitHubRepo      = '',
    [string]$GitHubBranch    = 'main',
    [string]$MapboxToken     = '',
    [string]$DoubanId        = '',
    [string]$WereadApiKey    = ''
)

$ErrorActionPreference = 'Stop'
$site = $PSScriptRoot

Write-Host ''
Write-Host '=== 站点配置 ===' -ForegroundColor Cyan
Write-Host ''

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

if (-not $Domain)       { $Domain       = Ask '站点域名'          'https://myblog.com'   $false }
if (-not $GitHubOwner)  { $GitHubOwner  = Ask 'GitHub 用户名'     'myname'               $false }
if (-not $GitHubRepo)   { $GitHubRepo   = Ask 'GitHub 仓库名'      'blog'                $false }
if (-not $MapboxToken)  { $MapboxToken  = Ask 'Mapbox 令牌 (pk.)'  'pk.xxx'               $true  }
if (-not $DoubanId)     { $DoubanId     = Ask '豆瓣 ID (可选)'     '12345678'            $false }
if (-not $WereadApiKey) { $WereadApiKey = Ask '微信读书 key (可选)' 'wrk-xxx'             $true  }

# 写配置
$cfg = Join-Path $site 'config/_default'
$ht  = Join-Path $cfg 'hugo.toml'
$pt  = Join-Path $cfg 'params.toml'

# hugo.toml: baseURL
$htc = Get-Content -LiteralPath $ht -Raw -Encoding UTF8
$htc = $htc -replace '(baseURL\s*=\s*")[^"]*(")', "`${1}${Domain}`$2"
Set-Content -LiteralPath $ht -Value $htc -Encoding UTF8
Write-Host ''
Write-Host "  baseURL = $Domain"

# params.toml
$ptc = Get-Content -LiteralPath $pt -Raw -Encoding UTF8
$ptc = $ptc -replace '(owner\s*=\s*")[^"]*(")',           "`${1}${GitHubOwner}`$2"
$ptc = $ptc -replace '(name\s*=\s*")YOUR_REPO_NAME(")',   "`${1}${GitHubRepo}`$2"
$ptc = $ptc -replace '(url\s*=\s*")[^"]*(")',             "`${1}https://github.com/${GitHubOwner}/${GitHubRepo}`$2"
$ptc = $ptc -replace '(workerUrl\s*=\s*")[^"]*(")',       "`${1}https://your-publisher.your-subdomain.workers.dev`$2"
$ptc = $ptc -replace '(imageBaseUrl\s*=\s*")[^"]*(")',   "`${1}https://pub-xxxxx.r2.dev`$2"
Set-Content -LiteralPath $pt -Value $ptc -Encoding UTF8

Write-Host ''
Write-Host '=== GitHub Actions 配置 ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '  请在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加：'
Write-Host ''
Write-Host '    变量 (Variables):'
if ($DoubanId) { Write-Host "      DOUBAN_ID = $DoubanId" }
Write-Host ''
Write-Host '    密钥 (Secrets):'
Write-Host '      CLOUDFLARE_API_TOKEN = 你的 Cloudflare API 令牌'
if ($WereadApiKey) { Write-Host "      WEREAD_API_KEY   = $WereadApiKey" }
Write-Host '      ADMIN_TOKEN        = 网页编辑器口令（随机字符串）'
Write-Host ''

Write-Host '=== 完成 ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '  git add -A && git commit -m "configure site" && git push'
Write-Host ''
'@

Set-Content -LiteralPath (Join-Path $site 'setup.ps1') -Value $setupContent -Encoding UTF8
Write-Host '  ✓ setup.ps1 已生成'

# ── 4. 更新 README ────────────────────────────────────────────
Write-Host ''
Write-Host '[4/4] 更新 README'

$readmeContent = @'
# 个人博客模板

基于 [惊蛰](https://github.com/koobai/blog) 主题，部署在 Cloudflare。

## 快速部署

### 前提

- [Hugo Extended](https://gohugo.io/installation/) >= 0.158.0
- 一个 Cloudflare 账户
- 一个 GitHub 仓库（公开或私有均可）

### 步骤

#### 1. 创建你的站点

```powershell
git clone https://github.com/你的用户名/你的仓库.git my-blog
cd my-blog

powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

#### 2. 在 Cloudflare 上准备资源

| 资源 | 怎么建 |
|---|---|
| R2 桶 | 建一个桶，开启公开访问，把公开 URL 记下来 |
| Workers 子域 | Account Home -> Workers -> 创建 -> 记下 `.workers.dev` 子域 |
| Pages 项目 | Workers & Pages -> Pages -> 直接上传（先建一个占位） |
| Mapbox 令牌 | Mapbox 控制台 -> 创建一个公开令牌 (pk.) |

#### 3. 配置 GitHub Actions Secrets/Variables

GitHub 仓库 -> Settings -> Secrets and variables -> Actions：

**变量 (Variables):**
- `DOUBAN_ID` — 你的豆瓣用户 ID（可选）

**密钥 (Secrets):**
- `CLOUDFLARE_API_TOKEN` — Cloudflare API 令牌（需要 Workers Scripts 写入权限）
- `MAPBOX_TOKEN` — 构建用地图令牌
- `ADMIN_TOKEN` — 网页编辑器登录口令（随机字符串即可）
- `WEREAD_API_KEY` — 微信读书 API 密钥（可选）

#### 4. 配置 wrangler.toml

编辑 `wrangler.toml`：
- `name` 改成你的 Worker 名称
- `account_id` 改成你的 Cloudflare 账户 ID
- 在 Worker 的 Secrets 里设置 `ADMIN_TOKEN`、`GH_TOKEN`、`MAPBOX_TOKEN`

#### 5. 推送上线

```powershell
git add -A
git commit -m "configure my site"
git push
```

Cloudflare 自动构建部署，通常一两分钟上线。

## 写内容

| 内容 | 网页地址 |
|---|---|
| 发唠叨 | `https://你的域名/newlaodao/` |
| 写长文 | `https://你的域名/newsuibi/` |
| 记走过 | `https://你的域名/newzouguo/` |

第一次打开要输入登录口令（`ADMIN_TOKEN`），输一次浏览器就记住了。

## 同步观影和书架

两个 GitHub Actions 工作流每天自动跑：
- `douban.yml` -> 同步豆瓣观影
- `weread.yml` -> 同步微信读书书架

有更新自动提交 -> Cloudflare 自动构建 -> 上线。

## 本地开发

```powershell
$env:MAPBOX_TOKEN = (Get-Content .mapbox-token -Raw).Trim()
hugo server
```

## 鸣谢

- 主题基于 [惊蛰 / Jingzhe](https://github.com/koobai/blog)（MIT License）
- 地图由 [Mapbox](https://www.mapbox.com/) 提供
- 地理数据 &copy; [OpenStreetMap](https://www.openstreetmap.org/) 贡献者
'@

Set-Content -LiteralPath (Join-Path $site 'README.md') -Value $readmeContent -Encoding UTF8
Write-Host '  ✓ README.md 已更新'

Write-Host ''
Write-Host '=== 模板化完成 ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '  git add -A && git commit -m "make template" && git push'
Write-Host ''
