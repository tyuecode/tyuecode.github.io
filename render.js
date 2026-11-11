/* strokeoil render — 共用的笔触绘制器
 *
 * 网页实时预览、下载的单文件播放器，都从这里取绘制逻辑，
 * 保证「页面里看到的」和「下载后播放的」完全一致。
 *
 * 笔触 packed 格式：[d, color, width, start, dur, detail, layer, len, alpha, kind]
 */
(function (root) {
  'use strict';

  const KIND = { NORMAL: 0, GLAZE: 1, SCUMBLE: 2, IMPASTO: 3, FILL: 4 };
  const RE_TOK = /[MLZ]|-?\d+(?:\.\d+)?/g;

  /* ---------------------------------------------------------------- 颜色工具 */
  function h2r(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgb(r, g, b) {
    const c = v => Math.max(0, Math.min(255, Math.round(v)));
    return 'rgb(' + c(r) + ',' + c(g) + ',' + c(b) + ')';
  }
  function hex(r, g, b) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  /* 提亮/压暗：f 为倍率，add 为加数 */
  function tone(h, f, add) {
    const c = h2r(h);
    return rgb(c[0] * f + add, c[1] * f + add, c[2] * f + add);
  }
  /* 亮脊色：底色越亮提亮越少，接近纯白时几乎不提亮 —— 避免浅色区域被顶成纯白线 */
  function ridge(h) {
    const c = h2r(h);
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const k = Math.max(0, Math.min(1, (235 - lum) / 235));
    const f = 1 + 0.22 * k;
    const add = 22 * k * k;
    return rgb(
      Math.max(0, Math.min(255, Math.round(Math.min(c[0] * f + add, 244, c[0] + 34)))),
      Math.max(0, Math.min(255, Math.round(Math.min(c[1] * f + add, 244, c[1] + 34)))),
      Math.max(0, Math.min(255, Math.round(Math.min(c[2] * f + add, 244, c[2] + 34)))));
  }

  /* ---------------------------------------------------------------- 路径解析
   * 同时支持线（M…L…）和闭合填充（M…L…Z）
   */
  function parsePath(d) {
    const tok = d.match(RE_TOK);
    if (!tok) return { pts: new Float32Array(0), closed: false };
    const closed = /Z/i.test(d);
    const n = Math.floor(tok.length / 3);
    const pts = new Float32Array(n * 2);
    for (let k = 0, j = 0; k < n; k++, j += 2) {
      pts[j] = +tok[k * 3 + 1];
      pts[j + 1] = +tok[k * 3 + 2];
    }
    return { pts, closed };
  }

  /* ---------------------------------------------------------------- 底纹
   * 油画布 / 线描黑底 / 素描纸，画一次即可，之后所有笔触叠在上面
   */
  function paintGround(c, w, h, spec) {
    spec = spec || {};
    const type = spec.type || 'oil';
    const color = spec.color || '#181613';
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.fillRect(0, 0, w, h);
    if (type === 'lineart') {
      // 近黑底，四角压暗，中间略提 —— 让白线有「浮起来」的感觉
      const g = c.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.1,
                                       w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
      g.addColorStop(0, 'rgba(255,255,255,0.030)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.008)');
      g.addColorStop(1, 'rgba(0,0,0,0.34)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      return;
    }
    if (type === 'pencil') {
      // 纸张纤维：细密划痕 + 轻微暖色斑
      const img = c.getImageData(0, 0, w, h), d = img.data;
      let seed = 20261109;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i < d.length; i += 4) {
        const v = (rnd() - 0.5) * 8;
        d[i] += v; d[i + 1] += v * 0.97; d[i + 2] += v * 0.85;
      }
      c.putImageData(img, 0, 0);
      // 纸张纤维纹理
      c.save();
      c.globalAlpha = 0.055;
      c.strokeStyle = '#8a7a60';
      c.lineWidth = 1;
      for (let i = 0; i < Math.round(w * h / 7000); i++) {
        const x = rnd() * w, y = rnd() * h;
        const a = (rnd() - 0.5) * 0.5, L = 6 + rnd() * 24;
        c.beginPath(); c.moveTo(x, y);
        c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke();
      }
      c.restore();
      return;
    }
    if (type === 'posterize') {
      // 极淡的中心渐亮，避免大面积平涂死板
      const g = c.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
      g.addColorStop(0, 'rgba(255,255,255,0.045)');
      g.addColorStop(1, 'rgba(0,0,0,0.10)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      return;
    }
    // oil：画布颗粒
    const img = c.getImageData(0, 0, w, h), d = img.data;
    let seed = 20261109;
    for (let i = 0; i < d.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = (((seed >> 16) & 255) / 255 - 0.5) * 4.5;
      d[i] += v; d[i + 1] += v; d[i + 2] += v * 0.9;
    }
    c.putImageData(img, 0, 0);
  }

  /* ---------------------------------------------------------------- 笔画局部路径
   * prog < 1 时只画到整条路径的一部分，实现「逐笔生长」
   */
  function tracePartial(c, pts, prog, SC) {
    const npt = pts.length >> 1;
    const lim = Math.max(2, Math.ceil(npt * prog));
    c.beginPath();
    c.moveTo(pts[0] * SC, pts[1] * SC);
    for (let j = 1; j < lim && j < npt; j++) c.lineTo(pts[j * 2] * SC, pts[j * 2 + 1] * SC);
    return { npt, lim };
  }

  /* ---------------------------------------------------------------- 单笔绘制
   * S: stroke packed 记录；i: 索引；SC: 画布/原图比例
   * pre: { pts, color, lite, alpha, kind } —— 预处理缓存（可选，省去重复解析）
   */
  function drawStroke(c, S, SC, i, prog, pre) {
    const st = S[i];
    const pts = pre ? pre.pts : null;
    const color = pre ? pre.color : st[1];
    const kind = pre ? pre.kind : (st[9] | 0);
    const alpha = pre ? pre.alpha : (st[8] === undefined ? 1 : st[8]);
    const w = st[2] * SC;

    /* ---- 色块填充：一次铺满一块区域 ---- */
    if (kind === KIND.FILL) {
      if (!pts) return;
      const n = pts.length >> 1;
      // 用已画比例做「擦入」：从中心向外扩张，视觉上是色块被刷开
      c.save();
      if (prog >= 0.999) {
        c.globalAlpha = alpha;
        c.beginPath();
        c.moveTo(pts[0] * SC, pts[1] * SC);
        for (let j = 1; j < n; j++) c.lineTo(pts[j * 2] * SC, pts[j * 2 + 1] * SC);
        c.closePath();
        c.fillStyle = color;
        c.fill('evenodd');
      } else {
        // 生长中：按质心缩放，像颜料从中心摊开
        let cx = 0, cy = 0;
        for (let j = 0; j < n; j++) { cx += pts[j * 2]; cy += pts[j * 2 + 1]; }
        cx /= n; cy /= n;
        const k = 0.28 + 0.72 * prog;
        c.globalAlpha = alpha * Math.min(1, prog * 2.4);
        c.beginPath();
        c.moveTo((cx + (pts[0] - cx) * k) * SC, (cy + (pts[1] - cy) * k) * SC);
        for (let j = 1; j < n; j++) {
          c.lineTo((cx + (pts[j * 2] - cx) * k) * SC, (cy + (pts[j * 2 + 1] - cy) * k) * SC);
        }
        c.closePath();
        c.fillStyle = color;
        c.fill('evenodd');
      }
      c.restore();
      return;
    }

    if (!pts) return;
    const r = tracePartial(c, pts, prog, SC);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    /* ---- 干扫：三道平行细线 ---- */
    if (kind === KIND.SCUMBLE) {
      c.globalAlpha = alpha;
      for (let b = 0; b < 3; b++) {
        const off = (b - 1) * w * 0.34;
        c.save(); c.translate(0, off);
        c.strokeStyle = b === 1 ? color : (pre ? pre.lite : ridge(color));
        c.lineWidth = w * (b === 1 ? 0.5 : 0.26);
        c.stroke(); c.restore();
      }
      c.globalAlpha = 1;
      return;
    }

    /* ---- 厚涂：暗边 + 主体 + 高光偏移 ---- */
    if (kind === KIND.IMPASTO) {
      c.globalAlpha = alpha * 0.55;
      c.strokeStyle = tone(color, 0.55, 0);
      c.lineWidth = w * 1.16; c.stroke();
      c.globalAlpha = alpha;
      c.strokeStyle = color; c.lineWidth = w; c.stroke();
      c.save(); c.translate(-w * 0.14, -w * 0.14);
      c.strokeStyle = pre ? pre.lite : ridge(color);
      c.lineWidth = w * 0.36; c.stroke();
      c.restore();
      c.globalAlpha = 1;
      return;
    }

    if (kind === KIND.GLAZE) {
      c.globalAlpha = alpha * 0.62;
      c.strokeStyle = color;
      c.lineWidth = w * 1.34;
      c.stroke();
      c.globalAlpha = alpha;
      c.lineWidth = w;
      c.stroke();
      c.globalAlpha = 1;
      return;
    }

    /* ---- 普通笔触 ---- */
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.lineWidth = w;
    c.stroke();

    // 起锋收锋：首尾各补一小段更细的笔道
    if (w > 4.5 && r.lim >= 4) {
      c.strokeStyle = color;
      c.beginPath(); c.moveTo(pts[0] * SC, pts[1] * SC);
      for (let j = 1; j < Math.min(3, r.npt); j++) c.lineTo(pts[j * 2] * SC, pts[j * 2 + 1] * SC);
      c.lineWidth = w * 0.45; c.stroke();
      const e = Math.min(r.lim, r.npt) - 1;
      c.beginPath(); c.moveTo(pts[e * 2] * SC, pts[e * 2 + 1] * SC);
      for (let j = e - 1; j >= Math.max(0, e - 2); j--) c.lineTo(pts[j * 2] * SC, pts[j * 2 + 1] * SC);
      c.lineWidth = w * 0.4; c.stroke();
    }

    // 颜料渐枯：只在深色粗笔上做，浅色笔上叠亮色会形成白拖尾
    if (w > 7.5) {
      const c0 = h2r(color);
      const lum = 0.299 * c0[0] + 0.587 * c0[1] + 0.114 * c0[2];
      const dryK = Math.max(0, Math.min(1, (180 - lum) / 180));
      if (dryK > 0.08) {
        c.globalAlpha = alpha * 0.30 * dryK;
        c.strokeStyle = pre ? pre.lite : ridge(color);
        const s0 = Math.floor(r.npt * 0.62), e0 = r.lim;
        if (e0 > s0 + 1) {
          c.beginPath(); c.moveTo(pts[s0 * 2] * SC, pts[s0 * 2 + 1] * SC);
          for (let j = s0 + 1; j < e0 && j < r.npt; j++) c.lineTo(pts[j * 2] * SC, pts[j * 2 + 1] * SC);
          c.lineWidth = w * 0.44; c.stroke();
        }
      }
    }
    c.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- 预处理
   * 把 packed 笔触解析成绘制期要用的结构，避免每帧重复解析路径
   */
  function preprocess(S) {
    const out = new Array(S.length);
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      const p = parsePath(s[0]);
      const kind = s[9] | 0;
      out[i] = {
        pts: p.pts,
        color: s[1],
        lite: (kind === KIND.SCUMBLE || kind === KIND.IMPASTO) ? ridge(s[1]) : null,
        alpha: s[8] === undefined ? 1 : s[8],
        kind,
        closed: p.closed,
      };
    }
    return out;
  }

  root.OILRender = {
    KIND, h2r, rgb, hex, tone, ridge,
    parsePath, paintGround, tracePartial, drawStroke, preprocess,
  };
})(typeof self !== 'undefined' ? self : this);
