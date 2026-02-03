---
layout: home  # 使用minima主题的home布局
title: 首页
---
# 欢迎来到TY的博客 📝
分享编程技巧与生活感悟，专注于Jekyll、GitHub、前端相关内容。

## 最新文章
{% for post in site.posts limit:5 %}  <!-- 遍历文章，只显示5篇 -->
  <div class="post-item">
    <h3><a href="{{ post.url | relative_url }}">{{ post.title }}</a></h3>
    <p class="post-meta">{{ post.date | date: "%Y-%m-%d" }} | {{ post.categories | join: " / " }}</p>
    <p class="post-excerpt">{{ post.excerpt | strip_html | truncate: 150 }}</p>  <!-- 摘要（去HTML+截断） -->
  </div>
{% endfor %}