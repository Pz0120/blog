# 个人博客模板

基于 [惊蛰](https://github.com/koobai/blog) 主题，部署在 Cloudflare。

## 快速部署

### 前提
- [Hugo Extended](https://gohugo.io/installation/) >= 0.158.0
- 一个 Cloudflare 账户
- 一个 GitHub 仓库

### 步骤

#### 1. 创建站点
```powershell
git clone https://github.com/你的用户名/你的仓库.git my-blog
cd my-blog
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

#### 2. Cloudflare 资源
| 资源 | 怎么建 |
|---|---|
| R2 桶 | 建桶 → 开启公开访问 → 记下公开 URL |
| Workers 子域 | Account Home → Workers → 记下 `.workers.dev` |
| Mapbox 令牌 | Mapbox 控制台 → 创建公开令牌 (pk.) |

#### 3. GitHub Actions 变量/密钥
Settings → Secrets and variables → Actions：
- 变量 `DOUBAN_ID`（可选）
- 密钥 `CLOUDFLARE_API_TOKEN`、`MAPBOX_TOKEN`、`ADMIN_TOKEN`、`WEREAD_API_KEY`（可选）

#### 4. wrangler.toml
改 `name`、`account_id`，设置 Worker Secrets。

#### 5. 推送上线
```powershell
git add -A && git commit -m "configure my site" && git push
```

## 写内容
| 内容 | 地址 |
|---|---|
| 发唠叨 | `/newlaodao/` |
| 写长文 | `/newsuibi/` |
| 记走过 | `/newzouguo/` |

## 自动同步
- `douban.yml` 每天同步豆瓣观影
- `weread.yml` 每天同步微信读书

## 本地开发
```powershell
$env:MAPBOX_TOKEN = (Get-Content .mapbox-token -Raw).Trim()
hugo server
```

## 鸣谢
- 主题 [惊蛰/Jingzhe](https://github.com/koobai/blog)（MIT）
- 地图 [Mapbox](https://www.mapbox.com/)
- 地理数据 © [OpenStreetMap](https://www.openstreetmap.org/)
