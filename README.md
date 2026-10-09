# peixy

个人博客。基于 [惊蛰](https://github.com/koobai/blog) 主题构建，部署在 Cloudflare。

- 线上地址：https://peixy.xyz/
- 架构与部署：见 [部署说明.md](部署说明.md)
- 写作与同步：见 [内容发布指南.md](内容发布指南.md)

## 本地开发

```bash
hugo server
```

需要 **Hugo Extended ≥ 0.158.0** —— 主题声明了 `extended = true`，
且样式用 `css.Build` 解析 `@import`，普通版无法构建。

本地构建若要看地图，需要注入地图令牌（文件已 gitignore，**绝不提交**）：

```powershell
$env:MAPBOX_TOKEN = (Get-Content .mapbox-token -Raw).Trim()
hugo server
```

## 内容模块

| 模块 | 网页版编辑器 | 数据位置 |
|---|---|---|
| 随笔（长文） | `/newsuibi/` | `content/posts/` |
| 唠叨（短句） | `/newlaodao/` | `content/laodao/` |
| 走过（地点） | 在 `/newsuibi/` 里勾选「同时记到走过地图」 | `content/zouguo/` 或文章 front matter 的 `zouguo` 块 |
| 观影 | — | `assets/data/movies.json`（豆瓣同步） |
| 书架 | — | `assets/data/books.json`（微信读书同步） |

## 许可

本站程序代码与合成示例内容采用根目录 `LICENSE` 中的 MIT License；
第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
