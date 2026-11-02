---
title: 标签
layout: default
permalink: /tags/
---

# 标签归档

{% assign sorted_tags = site.tags | sort %}
{% for tag in sorted_tags %}
<h2 id="{{ tag[0] | slugify }}">{{ tag[0] }} <small>({{ tag[1].size }})</small></h2>
<ul>
  {% for post in tag[1] %}
  <li>
    <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
    <span class="post-date">{{ post.date | date: "%Y-%m-%d" }}</span>
  </li>
  {% endfor %}
</ul>
{% endfor %}
