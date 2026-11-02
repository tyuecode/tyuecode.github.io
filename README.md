# TY的博客（tyuecode.github.io）

基于 Jekyll（`jekyll-theme-minimal` 主题）的静态博客，通过 GitHub Actions 自动构建并部署到 GitHub Pages，正式域名为 **https://tangyue.me**。

## 目录结构

```
_config.yml                       # 站点配置（标题/作者/主题/插件/SEO/分页）
_layouts/
  default.html                    # 基础布局（head/header/section/footer）
_includes/
  head-custom.html                # 自定义 <head>（favicon 等）
_posts/                           # 博客文章（文件名格式 YYYY-MM-DD-slug.md）
index.md                          # 首页（文章列表 + 分页）
about.md                          # 关于页
tags.md                           # 标签归档页
404.md                            # 404 页面
assets/img/MiLogo.jpg             # 站点 logo / favicon
Gemfile                           # 构建依赖（github-pages gem 栈）
.github/workflows/jekyll-gh-pages.yml  # CI/CD：push main 自动构建部署
```

## 本地预览

```bash
bundle install
bundle exec jekyll serve
# 打开 http://localhost:4000
```

## 发布新文章

1. 在 `_posts/` 下新建文件，命名为 `YYYY-MM-DD-标题英文slug.md`；
2. 顶部加上 front matter：
   ```yaml
   ---
   layout: post
   title: "文章标题"
   date: YYYY-MM-DD
   categories: [分类]
   tags: [标签1, 标签2]
   excerpt: "一句话摘要"
   ---
   ```
3. 正文用 `<!--more-->` 分隔摘要与正文；
4. 推送到 `main` 分支，GitHub Actions 会自动重新部署（通常 1–2 分钟生效）。

## 功能

- RSS 订阅：`/feed.xml`
- 站点地图：`/sitemap.xml`
- SEO：`jekyll-seo-tag` 自动生成 canonical / Open Graph / Twitter 卡片
- 分页：`jekyll-paginate`，每页 5 篇
