---
title: 主页
---

# 欢迎来到我的网站

## 最新文章

<ul class="post-list">
  {% for post in site.posts %}
    <li>
      <a class="post-title" href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <span class="post-date">{{ post.date | date: "%Y年%m月%d日" }}</span>
      <p class="post-excerpt">{{ post.excerpt }}</p>
    </li>
  {% endfor %}
</ul>

#### 导航
- [关于我](/about/)
- [标签归档](/tags/)
- [RSS 订阅](/feed.xml)
