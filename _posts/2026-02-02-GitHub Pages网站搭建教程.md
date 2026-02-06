---
layout: post
title: "Jekyll+GitHub Pages网站搭建指南"
date: 2026-02-02 10:00:00 +0800
categories: [博客教程]  # 精准分类（两级）
tags: [github, jekyll, 静态博客]     # 细分标签
excerpt: "本文讲解搭建Jekyll+GitHub Pages博客，包括配置、部署、个性化全流程。"  # 自定义摘要
---

    这是我的第一篇博客，记录基于Jekyll+GitHub Pages搭建个人博客的全过程。

<!--more-->  <!-- 摘要分隔符，前面内容会作为首页摘要 -->

## 一、为什么选Jekyll+GitHub Pages？
GitHub Pages是GitHub 官方提供的免费静态网站托管服务，让你能直接从 GitHub 仓库创建和发布网站，无需配置复杂服务器或支付托管费用。

Jekyll是一个静态网站生成器，它可以直接在GitHub Pages上构建,让你只需编写上传Markdown文件就能完成博客网站的更新。

- 免费：GitHub Pages提供免费静态托管，无服务器成本；
- 轻量：无数据库，静态页面加载快；
- 易维护：Markdown写文章，Git版本控制，Jekyll生成静态网站。

## 二、核心步骤
1. 创建GitHub仓库（命名：用户名.github.io）；
2. 进入仓库Settings界面的Pages选项中；
3. 将Build and deployment的Source选择为GitHub Actions；
4. 选择使用Jekyll，通过GitHub Actions自动部署；
5. 配置Jekyll核心文件（_config.yml、_posts等）；
[可参考本站源码](https://github.com/tyuecode/tyuecode.github.io)

GitHub Pages默认使用Jekyll，所以当你推送Jekyll网站的文件到仓库时，它会自动构建并更新网站内容
## 三、拓展功能
- 更换换主题：[pages-themes](https://github.com/pages-themes)中收录了可直接使用的主题
- 编辑_config.yml以修改网站配置
- 编辑index.md以修改首页内容
- 编辑about.md以修改关于页面
- 在_posts目录中添加新文章
- 在_layouts目录中更改页面布局