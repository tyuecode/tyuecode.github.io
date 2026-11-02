---
title: 主页
---

# 欢迎来到我的网站

## 最新文章

<ul class="post-list">
  {% for post in paginator.posts %}
    <li>
      <a class="post-title" href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <span class="post-date">{{ post.date | date: "%Y年%m月%d日" }}</span>
      <p class="post-excerpt">{{ post.excerpt }}</p>
    </li>
  {% endfor %}
</ul>

{% if paginator.total_pages > 1 %}
<nav class="pagination">
  {% if paginator.previous_page %}
    <a href="{{ paginator.previous_page_path | relative_url }}">&laquo; 上一页</a>
  {% endif %}
  <span>第 {{ paginator.page }} / {{ paginator.total_pages }} 页</span>
  {% if paginator.next_page %}
    <a href="{{ paginator.next_page_path | relative_url }}">下一页 &raquo;</a>
  {% endif %}
</nav>
{% endif %}

#### 导航
- [关于我](/about/)
- [标签归档](/tags/)
- [RSS 订阅](/feed.xml)
