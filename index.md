---
title: 主页
---

# 欢迎来到我的网站

## 最新文章

<ul>
  {% for post in site.posts limit:5 %}
    <li>
      <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <span class="post-date">{{ post.date | date: "%Y年%m月%d日" }}</span>
    </li>
  {% endfor %}
</ul>

<p><a href="{{ '/archive' | relative_url }}">查看所有文章</a></p>


#### 导航
- [关于我](/about)