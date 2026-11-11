/* strokeoil core — 分析 + 多风格笔触生成 + 时间轴
 *
 * analyze()      在降采样工作分辨率上算结构场（分层 / 边缘 / 方向 / 显著性）
 * STYLES         风格注册表：每种风格 = 一套工序 + 一套专属笔触语言
 * buildStages()  按 opts.style 分派到对应风格构建器
 * buildTimeline()把工序串成严格不重叠的时间轴
 *
 * 笔触 packed 记录：[d, color, width, start, dur, detail, layer, len, alpha, kind]
 * kind 的语义见 render.js 的 KIND。
 */
(function (root) {
  'use strict';

  const KIND_NORMAL = 0, KIND_GLAZE = 1, KIND_SCUMBLE = 2, KIND_IMPASTO = 3, KIND_FILL = 4;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------------------------------------------------------------- 高斯 */
  function gaussKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return { k, r };
  }
  function blurH(src, dst, w, h, ker) {
    const { k, r } = ker;
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i < 0 ? 0 : (x + i >= w ? w - 1 : x + i);
          s += src[off + xx] * k[i + r];
        }
        dst[off + x] = s;
      }
    }
  }
  function blurV(src, dst, w, h, ker) {
    const { k, r } = ker;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i < 0 ? 0 : (y + i >= h ? h - 1 : y + i);
          s += src[yy * w + x] * k[i + r];
        }
        dst[y * w + x] = s;
      }
    }
  }
  function gaussBlur(src, w, h, sigma) {
    if (sigma < 0.3) return new Float32Array(src);
    const ker = gaussKernel(sigma);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    blurH(src, tmp, w, h, ker);
    blurV(tmp, out, w, h, ker);
    return out;
  }

  /* ---------------------------------------------------------------- 降采样 */
  function downscale(rgba, w, h, tw, th) {
    const out = new Float32Array(tw * th * 3);
    const fx = w / tw, fy = h / th;
    for (let y = 0; y < th; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
      for (let x = 0; x < tw; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * w + xx) * 4;
            r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
          }
        }
        const o = (y * tw + x) * 3;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- Sobel */
  function sobel(gray, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : 0) * w, yp = (y < h - 1 ? y + 1 : h - 1) * w, yc = y * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        const a = gray[ym + xm], b = gray[ym + x], c = gray[ym + xp];
        const d = gray[yc + xm], f = gray[yc + xp];
        const g = gray[yp + xm], hh = gray[yp + x], i = gray[yp + xp];
        gx[yc + x] = (c + 2 * f + i) - (a + 2 * d + g);
        gy[yc + x] = (g + 2 * hh + i) - (a + 2 * b + c);
      }
    }
    return { gx, gy };
  }

  /* ---------------------------------------------------------------- Canny */
  function canny(gray, w, h, sigma, lo, hi) {
    const sm = gaussBlur(gray, w, h, sigma);
    const { gx, gy } = sobel(sm, w, h);
    const mag = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);

    const nms = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const ang = Math.atan2(gy[i], gx[i]);
        const a = (ang * 180 / Math.PI + 180) % 180;
        let d1, d2;
        if (a < 22.5 || a >= 157.5) { d1 = i - 1; d2 = i + 1; }
        else if (a < 67.5) { d1 = i - w - 1; d2 = i + w + 1; }
        else if (a < 112.5) { d1 = i - w; d2 = i + w; }
        else { d1 = i - w + 1; d2 = i + w - 1; }
        const m = mag[i];
        nms[i] = (m >= mag[d1] && m >= mag[d2]) ? m : 0;
      }
    }

    const out = new Float32Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    for (let i = 0; i < w * h; i++) if (nms[i] >= hi) { out[i] = 1; stack[sp++] = i; }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (out[j] === 0 && nms[j] >= lo) { out[j] = 1; stack[sp++] = j; }
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- k-means */
  function kmeans2(f1, f2, n, k, iters, seed) {
    let st = seed || 123456789;
    const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
    const sampleN = Math.min(n, 24000);
    const idx = new Int32Array(sampleN);
    for (let i = 0; i < sampleN; i++) idx[i] = Math.floor(rnd() * n);
    const cx = new Float32Array(k), cy = new Float32Array(k);
    cx[0] = f1[idx[0]]; cy[0] = f2[idx[0]];
    for (let c = 1; c < k; c++) {
      let best = -1, bestD = -1;
      for (let t = 0; t < 2000; t++) {
        const p = idx[Math.floor(rnd() * sampleN)];
        let dmin = 1e9;
        for (let j = 0; j < c; j++) {
          const dx = f1[p] - cx[j], dy = f2[p] - cy[j];
          const d = dx * dx + dy * dy;
          if (d < dmin) dmin = d;
        }
        if (dmin > bestD) { bestD = dmin; best = p; }
      }
      cx[c] = f1[best]; cy[c] = f2[best];
    }
    const lab = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const sx = new Float64Array(k), sy = new Float64Array(k), cnt = new Float64Array(k);
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = 1e18;
        for (let c = 0; c < k; c++) {
          const dx = f1[i] - cx[c], dy = f2[i] - cy[c];
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; bi = c; }
        }
        lab[i] = bi; sx[bi] += f1[i]; sy[bi] += f2[i]; cnt[bi]++;
      }
      for (let c = 0; c < k; c++) {
        if (cnt[c] > 0) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; }
      }
    }
    return { lab, cx, cy };
  }

  /* ---------------------------------------------------------------- 分析 */
  function analyze(rgba, W, H, opts) {
    const want = opts.workRes === 0 ? Math.max(W, H) : (opts.workRes || 1400);
    const maxSide = clamp(want, 320, Math.max(W, H));
    const sc = Math.min(1, maxSide / Math.max(W, H));
    const AW = Math.max(8, Math.round(W * sc)), AH = Math.max(8, Math.round(H * sc));
    const rgb = downscale(rgba, W, H, AW, AH);
    const n = AW * AH;

    const L = new Float32Array(n), S = new Float32Array(n), gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      L[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 100;
      S[i] = mx > 0 ? ((mx - mn) / mx) * 100 : 0;
      gray[i] = L[i] / 100;
    }
    const Lb = gaussBlur(L, AW, AH, 2.4), Sb = gaussBlur(S, AW, AH, 2.4);
    const k = clamp(opts.layers || 5, 2, 8);
    const km = kmeans2(Lb, Sb, n, k, 12, opts.seed || 20261109);

    const order = Array.from({ length: k }, (_, i) => i)
      .sort((a, b) => (km.cx[a] + 0.15 * km.cy[a]) - (km.cx[b] + 0.15 * km.cy[b]));
    const remap = new Int32Array(k);
    order.forEach((c, i) => { remap[c] = i; });
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) labels[i] = remap[km.lab[i]];

    const { gx, gy } = sobel(gray, AW, AH);
    const Jxx = gaussBlur((() => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = gx[i] * gx[i]; return a; })(), AW, AH, 3.0);
    const Jxy = gaussBlur((() => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = gx[i] * gy[i]; return a; })(), AW, AH, 3.0);
    const Jyy = gaussBlur((() => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = gy[i] * gy[i]; return a; })(), AW, AH, 3.0);

    const coh = new Float32Array(n), thHi = new Float32Array(n), mag = new Float32Array(n);
    const c2 = new Float32Array(n), s2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Jxx[i], b = Jxy[i], c = Jyy[i];
      const tr = a + c;
      const t = Math.sqrt(Math.max(0, 0.25 * tr * tr - (a * c - b * b)));
      const l1 = 0.5 * tr + t, l2 = 0.5 * tr - t;
      coh[i] = (l1 - l2) / (l1 + l2 + 1e-6);
      thHi[i] = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2;
      mag[i] = Math.sqrt(tr);
      c2[i] = Math.cos(2 * thHi[i]) * (tr + 1e-6);
      s2[i] = Math.sin(2 * thHi[i]) * (tr + 1e-6);
    }
    const Cb = gaussBlur(c2, AW, AH, 14.0), Sb2 = gaussBlur(s2, AW, AH, 14.0);
    const thLo = new Float32Array(n);
    for (let i = 0; i < n; i++) thLo[i] = 0.5 * Math.atan2(Sb2[i], Cb[i]);

    const eMajor = canny(gray, AW, AH, 3.0, 0.12, 0.30);
    const eFine = canny(gray, AW, AH, 1.2, 0.08, 0.22);
    const eFineS = gaussBlur(eFine, AW, AH, 1.3);

    let mx = 1e-6; for (let i = 0; i < n; i++) if (mag[i] > mx) mx = mag[i];
    const sal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const gm = Math.min(1, mag[i] / mx);
      sal[i] = 0.30 * gm + 0.26 * coh[i] + 0.24 * eFineS[i] + 0.20 * gm;
    }
    const salS = gaussBlur(sal, AW, AH, 2.2);
    let smax = 1e-6; for (let i = 0; i < n; i++) if (salS[i] > smax) smax = salS[i];
    for (let i = 0; i < n; i++) salS[i] = Math.min(1, salS[i] / smax);

    const DX = new Float32Array(n), DY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const th = (coh[i] < 0.28 && salS[i] < 0.18) ? thLo[i] : thHi[i];
      DX[i] = Math.cos(th); DY[i] = Math.sin(th);
    }

    return {
      AW, AH, sxa: W / AW, sya: H / AH, rgb, labels, L, S, gray,
      coh, sal: salS, DX, DY, eMajor, eFine,
      layers: order.map((c, i) => ({ id: i, L: km.cx[c], S: km.cy[c] })),
    };
  }

  /* ---------------------------------------------------------------- 轮廓提取（marching squares）
   * 输出每个连通区域的闭合轮廓（图像坐标），供「色块」风格平涂。
   * 轮廓方向不规范化，渲染端统一用 evenodd 填充，孔洞自然正确。
   */
  function layerContours(A, layer, minArea) {
    const { labels, AW, AH, sxa, sya } = A;
    const at = (x, y) => (x < 0 || y < 0 || x >= AW || y >= AH) ? 0 : (labels[y * AW + x] === layer ? 1 : 0);
    const AX = [], AY = [], BX = [], BY = [];
    const seg = (ax, ay, bx, by) => { AX.push(ax); AY.push(ay); BX.push(bx); BY.push(by); };
    for (let y = -1; y < AH; y++) {
      for (let x = -1; x < AW; x++) {
        const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
        const bits = tl | (tr << 1) | (br << 2) | (bl << 3);
        if (bits === 0 || bits === 15) continue;
        // 用 2 倍整数坐标表示边中点，保证相邻格子端点精确相接
        const tx = 2 * x + 1, ty = 2 * y;
        const rx = 2 * x + 2, ry = 2 * y + 1;
        const bx = 2 * x + 1, by = 2 * y + 2;
        const lx = 2 * x, ly = 2 * y + 1;
        switch (bits) {
          case 1: seg(lx, ly, tx, ty); break;
          case 2: seg(tx, ty, rx, ry); break;
          case 3: seg(lx, ly, rx, ry); break;
          case 4: seg(rx, ry, bx, by); break;
          case 5: seg(lx, ly, tx, ty); seg(rx, ry, bx, by); break;
          case 6: seg(tx, ty, bx, by); break;
          case 7: seg(lx, ly, bx, by); break;
          case 8: seg(bx, by, lx, ly); break;
          case 9: seg(bx, by, tx, ty); break;
          case 10: seg(tx, ty, rx, ry); seg(bx, by, lx, ly); break;
          case 11: seg(bx, by, rx, ry); break;
          case 12: seg(rx, ry, lx, ly); break;
          case 13: seg(rx, ry, tx, ty); break;
          case 14: seg(tx, ty, lx, ly); break;
        }
      }
    }
    const M = AX.length;
    if (!M) return [];
    const keyOf = (x, y) => x * 65536 + y;
    const map = new Map();
    for (let i = 0; i < M; i++) {
      const ka = keyOf(AX[i], AY[i]), kb = keyOf(BX[i], BY[i]);
      let la = map.get(ka); if (!la) { la = []; map.set(ka, la); } la.push(i);
      if (kb !== ka) { let lb = map.get(kb); if (!lb) { lb = []; map.set(kb, lb); } lb.push(i); }
    }
    const used = new Uint8Array(M);
    const loops = [];
    for (let i = 0; i < M; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const px = [AX[i]], py = [AY[i]];
      let cx = BX[i], cy = BY[i];
      const sx0 = AX[i], sy0 = AY[i];
      let guard = M + 8;
      while (guard-- > 0) {
        px.push(cx); py.push(cy);
        if (cx === sx0 && cy === sy0) break;
        const list = map.get(keyOf(cx, cy));
        if (!list) break;
        let nxt = -1;
        for (let t = 0; t < list.length; t++) if (!used[list[t]]) { nxt = list[t]; break; }
        if (nxt < 0) break;
        used[nxt] = 1;
        if (AX[nxt] === cx && AY[nxt] === cy) { cx = BX[nxt]; cy = BY[nxt]; }
        else { cx = AX[nxt]; cy = AY[nxt]; }
      }
      if (px.length < 4) continue;
      let area = 0;
      for (let q = 0; q < px.length; q++) {
        const r = (q + 1) % px.length;
        area += px[q] * py[r] - px[r] * py[q];
      }
      area = Math.abs(area) / 2 / 4;   // 2 倍坐标 → /4
      if (area < minArea) continue;
      const pts = new Float64Array(px.length * 2);
      for (let q = 0; q < px.length; q++) {
        pts[q * 2] = (px[q] / 2) * sxa;
        pts[q * 2 + 1] = (py[q] / 2) * sya;
      }
      loops.push({ pts, area, len: perim(pts) });
    }
    return loops;
  }

  function perim(pts) {
    let s = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      s += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    }
    return s;
  }

  /* Ramer–Douglas–Peucker（开链） */
  function rdp(pts, a0, b0, eps) {
    const keep = new Uint8Array(b0 - a0 + 1);
    keep[0] = 1; keep[b0 - a0] = 1;
    const stack = [[a0, b0]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = pts[a * 2], ay = pts[a * 2 + 1];
      const bx = pts[b * 2], by = pts[b * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const dd = Math.hypot(dx, dy) || 1e-9;
      let best = -1, bestD = -1;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
        const d = Math.abs(px * dy - py * dx) / dd;
        if (d > bestD) { bestD = d; best = i; }
      }
      if (bestD > eps) { keep[best - a0] = 1; stack.push([a, best]); stack.push([best, b]); }
    }
    const out = [];
    for (let i = a0; i <= b0; i++) if (keep[i - a0]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out;
  }

  /* 闭合轮廓简化：首尾重合会让 RDP 退化（所有点到弦的距离都是 0），
   * 所以先在离起点最远处切成两条开链，分别简化后再接起来。 */
  function simplify(pts, eps) {
    const n = pts.length / 2;
    if (n <= 3) return Array.from(pts);
    const closed = (Math.abs(pts[0] - pts[(n - 1) * 2]) < 1e-6 &&
                    Math.abs(pts[1] - pts[(n - 1) * 2 + 1]) < 1e-6);
    const m = closed ? n - 1 : n;
    if (m <= 3) return Array.from(pts.slice(0, m * 2));
    if (!closed) return rdp(pts, 0, m - 1, eps);
    const x0 = pts[0], y0 = pts[1];
    let far = 1, farD = -1;
    for (let i = 1; i < m; i++) {
      const d = (pts[i * 2] - x0) * (pts[i * 2] - x0) + (pts[i * 2 + 1] - y0) * (pts[i * 2 + 1] - y0);
      if (d > farD) { farD = d; far = i; }
    }
    if (far <= 0 || far >= m - 1) return Array.from(pts.slice(0, m * 2));
    const A1 = rdp(pts, 0, far, eps);
    const B1 = rdp(pts, far, m - 1, eps);
    const out = A1.slice();
    for (let i = 2; i < B1.length; i += 2) out.push(B1[i], B1[i + 1]);
    return out;
  }

  /* ---------------------------------------------------------------- 采样 / 取色 */
  function resample(P, K, out) {
    const m = P.length / 2 | 0;
    if (m < 2) {
      // 只有一个点（或没有）：退化成重复该点
      out.length = 0;
      const x0 = m ? P[0] : 0, y0 = m ? P[1] : 0;
      for (let q = 0; q < K; q++) out.push(x0, y0);
      return 0;
    }
    const seg = new Float32Array(m);
    let total = 0;
    for (let i = 0; i < m; i++) {
      const j = Math.min(i + 1, m - 1);
      const dx = P[j * 2] - P[i * 2], dy = P[j * 2 + 1] - P[i * 2 + 1];
      const d = Math.hypot(dx, dy);
      seg[i] = d; total += d;
    }
    if (total < 1e-6) { out.length = 0; for (let q = 0; q < K; q++) out.push(P[0], P[1]); return total; }
    const cum = new Float32Array(m);
    let acc = 0;
    for (let i = 0; i < m; i++) { cum[i] = acc; acc += seg[i]; }
    out.length = 0;
    let j = 0;
    for (let q = 0; q < K; q++) {
      const target = (q / (K - 1)) * total;
      while (j < m - 2 && cum[j + 1] < target) j++;
      const t0 = cum[j], t1 = (j + 1 < m) ? cum[j + 1] : total;
      const f = Math.max(0, Math.min(1, (target - t0) / Math.max(t1 - t0, 1e-9)));
      out.push(P[j * 2] + (P[(j + 1) * 2] - P[j * 2]) * f,
               P[j * 2 + 1] + (P[(j + 1) * 2 + 1] - P[j * 2 + 1]) * f);
    }
    return total;
  }

  function makePainter(A, rgba, W, H, seed) {
    let st = seed || 1;
    const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };

    function sampleA(field, x, y) {
      const ax = clamp(Math.round(x / A.sxa), 0, A.AW - 1);
      const ay = clamp(Math.round(y / A.sya), 0, A.AH - 1);
      return field[ay * A.AW + ax];
    }
    function sampleRGB(x, y) {
      const xi = clamp(Math.round(x), 0, W - 1), yi = clamp(Math.round(y), 0, H - 1);
      const i = (yi * W + xi) * 4;
      return [rgba[i], rgba[i + 1], rgba[i + 2]];
    }
    function lum(x, y) {
      const c = sampleRGB(x, y);
      return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    }
    const hex = (r, g, b) => '#' +
      Math.round(clamp(r, 0, 255)).toString(16).padStart(2, '0') +
      Math.round(clamp(g, 0, 255)).toString(16).padStart(2, '0') +
      Math.round(clamp(b, 0, 255)).toString(16).padStart(2, '0');

    /* 沿方向场行走，返回扁平折线。
     * opt:
     *   breakLayer  是否在跨分层时止笔（默认 true）
     *   colorTol    跨色容差，999 = 不限制
     *   rot90       方向场旋转 90°（交叉排线）
     *   requireEdge + edgeField  只在边缘上走，走偏了向法线方向重新吸附
     *   maxTurn     每步最大转角，压住「打卷」
     *   angle/jitter 锁定方向（排线）
     */
    function trace(x0, y0, len, layer, steps, opt) {
      opt = opt || {};
      const breakLayer = opt.breakLayer !== false;
      const colorTol = opt.colorTol === undefined ? 120 : opt.colorTol;
      const rot = opt.rot90 ? Math.PI / 2 : 0;
      const reqEdge = opt.requireEdge;
      const edgeF = opt.edgeField || A.eFine;
      const maxTurn = opt.maxTurn;
      const lockAng = opt.angle;
      const jerk = opt.jitter || 0;

      const P = [x0, y0];
      let px = x0, py = y0;
      const base = sampleRGB(px, py);
      let hx, hy;
      {
        const a0 = (lockAng !== undefined)
          ? lockAng + (rnd() * 2 - 1) * jerk
          : Math.atan2(sampleA(A.DY, px, py), sampleA(A.DX, px, py)) + rot;
        hx = Math.cos(a0); hy = Math.sin(a0);
      }
      const step = Math.max(1.2, len / Math.max(2, steps));
      for (let s = 0; s < steps; s++) {
        let fx, fy;
        if (lockAng !== undefined) {
          fx = Math.cos(lockAng); fy = Math.sin(lockAng);
        } else {
          const th = Math.atan2(sampleA(A.DY, px, py), sampleA(A.DX, px, py)) + rot;
          fx = Math.cos(th); fy = Math.sin(th);
        }
        if (fx * hx + fy * hy < 0) { fx = -fx; fy = -fy; }

        // 方向场与惯性混合，避免方向场抖动直接传到笔迹上
        let vx = 0.58 * hx + 0.42 * fx, vy = 0.58 * hy + 0.42 * fy;
        let mg = Math.hypot(vx, vy) + 1e-9;
        vx /= mg; vy /= mg;

        // 限制转角：把新方向朝上一方向拉回来
        if (maxTurn !== undefined) {
          const prev = Math.atan2(hy, hx);
          let da = Math.atan2(vy, vx) - prev;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          if (da > maxTurn) da = maxTurn;
          else if (da < -maxTurn) da = -maxTurn;
          vx = Math.cos(prev + da); vy = Math.sin(prev + da);
        }

        let nx = px + vx * step, ny = py + vy * step;
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) break;

        // 走偏边缘时，沿法线方向吸附回脊线
        if (reqEdge && sampleA(edgeF, nx, ny) < reqEdge) {
          const pxp = -vy, pyp = vx;
          let bestX = 0, bestY = 0, bestV = -1;
          for (const d of [1, -1, 2, -2, 0.6, -0.6, 1.4, -1.4]) {
            const tx = px + pxp * d, ty = py + pyp * d;
            const v = sampleA(edgeF, tx, ty);
            if (v > bestV) { bestV = v; bestX = tx; bestY = ty; }
          }
          if (bestV < reqEdge) break;
          nx = bestX; ny = bestY;
        }

        if (breakLayer && sampleA(A.labels, nx, ny) !== layer) break;
        if (colorTol < 999) {
          const c2 = sampleRGB(nx, ny);
          if (Math.abs(c2[0] - base[0]) + Math.abs(c2[1] - base[1]) + Math.abs(c2[2] - base[2]) > colorTol) break;
        }
        px = nx; py = ny;
        P.push(px, py);
        const nvx = px - P[P.length - 4], nvy = py - P[P.length - 3];
        const nd = Math.hypot(nvx, nvy) + 1e-9;
        hx = nvx / nd; hy = nvy / nd;
      }
      return P;
    }

    const Q = [];
    function pickColor(Qpts, K, desat, tint, tintAmt) {
      const idxs = [0, Math.max(1, K >> 2), K >> 1, Math.max(1, (3 * K) >> 2), K - 1];
      const acc = [[], [], []];
      for (const q of idxs) {
        const c = sampleRGB(Qpts[q * 2], Qpts[q * 2 + 1]);
        acc[0].push(c[0]); acc[1].push(c[1]); acc[2].push(c[2]);
      }
      const med = acc.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
      let r = med[0], g = med[1], b = med[2];
      if (desat > 0) {
        const gy = 0.299 * r + 0.587 * g + 0.114 * b;
        r = r * (1 - desat) + gy * desat; g = g * (1 - desat) + gy * desat; b = b * (1 - desat) + gy * desat;
      }
      if (tint && tintAmt > 0) {
        r = r * (1 - tintAmt) + tint[0] * tintAmt;
        g = g * (1 - tintAmt) + tint[1] * tintAmt;
        b = b * (1 - tintAmt) + tint[2] * tintAmt;
      }
      const j = 1 + (rnd() * 2 - 1) * 0.03;
      return hex(r * j, g * j, b * j);
    }

    /* 沿方向场取色生成笔触（油画主力） */
    function make(sx, sy, len, wid, lay, steps, detail, kind, alpha, desat, tint, tintAmt, tag, opt) {
      const out = [];
      for (let i = 0; i < sx.length; i++) {
        const P = trace(sx[i], sy[i], len[i], lay[i], steps, opt);
        const np = P.length / 2;
        if (np < 2) continue;
        let arcLen = 0;
        for (let q = 1; q < np; q++) arcLen += Math.hypot(P[q * 2] - P[(q - 1) * 2], P[q * 2 + 1] - P[(q - 1) * 2 + 1]);
        const K = clamp(Math.ceil(arcLen / 7), 3, 12);
        const arc = resample(P, K, Q);
        if (Q.length < 4) continue;
        const c = pickColor(Q, Q.length / 2, desat || 0, tint, tintAmt || 0);
        let d = 'M' + Q[0].toFixed(1) + ' ' + Q[1].toFixed(1);
        for (let q = 1; q < Q.length / 2; q++) d += 'L' + Q[q * 2].toFixed(1) + ' ' + Q[q * 2 + 1].toFixed(1);
        out.push({
          d, c, w: +wid[i].toFixed(2), a: +alpha.toFixed(3), kind,
          len: +arc.toFixed(2), layer: lay[i] | 0, detail: detail ? 1 : 0, tag: tag || '',
        });
      }
      return out;
    }

    /* 颜色由回调直接给定（线描 / 素描） */
    function makeRaw(sx, sy, len, wid, lay, steps, detail, kind, alpha, colorFn, tag, opt) {
      const out = [];
      for (let i = 0; i < sx.length; i++) {
        const P = trace(sx[i], sy[i], len[i], lay[i], steps, opt);
        if (P.length < 4) continue;
        const K = clamp(Math.ceil(len[i] / 6), 3, 10);
        const Q2 = [];
        const arc = resample(P, K, Q2);
        if (Q2.length < 4) continue;
        const c = colorFn(Q2, i);
        if (!c) continue;
        let d = 'M' + Q2[0].toFixed(1) + ' ' + Q2[1].toFixed(1);
        for (let q = 1; q < Q2.length / 2; q++) d += 'L' + Q2[q * 2].toFixed(1) + ' ' + Q2[q * 2 + 1].toFixed(1);
        out.push({
          d, c, w: +wid[i].toFixed(2), a: +alpha.toFixed(3), kind,
          len: +arc.toFixed(2), layer: lay[i] | 0, detail: detail ? 1 : 0, tag: tag || '',
        });
      }
      return out;
    }

    function grid(sp, jit, rect) {
      const [x0, y0, x1, y1] = rect || [0, 0, W, H];
      const X = [], Y = [];
      for (let y = y0 + sp * 0.5; y < y1; y += sp) {
        for (let x = x0 + sp * 0.5; x < x1; x += sp) {
          const px = x + (rnd() * 2 - 1) * jit * sp;
          const py = y + (rnd() * 2 - 1) * jit * sp;
          if (px > 1 && px < W - 2 && py > 1 && py < H - 2) { X.push(px); Y.push(py); }
        }
      }
      return { X, Y };
    }

    function edgeSeeds(rect, thr, sp, field) {
      const [x0, y0, x1, y1] = rect || [0, 0, W, H];
      const f = field || A.eFine;
      const X = [], Y = [];
      const seen = new Set();
      const spx = Math.max(1, sp);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (sampleA(f, x, y) < 0.5) continue;
          const key = ((x / spx) | 0) * 200003 + ((y / spx) | 0);
          if (seen.has(key)) continue;
          seen.add(key);
          const px = x + (rnd() * 2 - 1) * 0.6, py = y + (rnd() * 2 - 1) * 0.6;
          if (px > 1 && px < W - 2 && py > 1 && py < H - 2) { X.push(px); Y.push(py); }
        }
      }
      return { X, Y };
    }

    return { make, makeRaw, grid, edgeSeeds, sampleA, sampleRGB, lum, hex, rnd, trace };
  }

  /* ---------------------------------------------------------------- 底色推导 */
  function groundColor(P, W, H, opts) {
    opts = opts || {};
    const mode = opts.mode || 'dark';
    const darkFrac = opts.darkFrac === undefined ? 0.28 : opts.darkFrac;
    const hist = new Uint32Array(256);
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        hist[clamp(P.lum(x, y) | 0, 0, 255)]++;
      }
    }
    let tot = 0; for (let i = 0; i < 256; i++) tot += hist[i];
    let need = tot * darkFrac, th = 255;
    for (let i = 0; i < 256; i++) { need -= hist[i]; if (need <= 0) { th = i; break; } }
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const c = P.sampleRGB(x, y);
        if (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 > th) continue;
        r += c[0]; g += c[1]; b += c[2]; n++;
      }
    }
    if (!n) return [40, 34, 28];
    r /= n; g /= n; b /= n;
    if (mode === 'warm') { r *= 0.86; g *= 0.98; b = Math.min(255, b * 1.04); }
    if (mode === 'dim') { r *= 0.55; g *= 0.55; b *= 0.58; }
    return [r, g, b];
  }

  /* ================================================================ 风格一：油画
   * 十道古典工序，笔触带起收锋、厚涂、罩染、干扫。
   */
  const OIL_STAGE = [
    ['imprimatura', '刷底色', 3.5],
    ['underdrawing', '起稿', 5.0],
    ['grisaille', '单色底层', 8.0],
    ['block-in', '铺大色', 7.0],
    ['massing', '塑造', 12.0],
    ['modelling', '塑形', 16.0],
    ['glazing', '罩染', 5.0],
    ['scumbling', '干扫', 4.0],
    ['detail', '细部', 26.0],
    ['impasto', '提白', 3.5],
  ];

  function buildOil(A, rgba, W, H, opts, onStage) {
    const P = makePainter(A, rgba, W, H, opts.seed || 20261109);
    const base = Math.max(W, H) / 1527;
    const s = (opts.scale || 1) * Math.max(0.45, base);
    const stages = [];
    const WT = {}, LB = {};
    OIL_STAGE.forEach(([n, l, w]) => { WT[n] = w; LB[n] = l; });
    const push = (name, ss) => {
      stages.push({ name, label: LB[name] || name, weight: WT[name] || 5, strokes: ss });
      if (onStage) onStage(name, ss.length, LB[name] || name);
    };

    const GB = groundColor(P, W, H, { mode: 'warm', darkFrac: 0.28 });

    // 1 刷底色
    {
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      const rowH = 20 * s;
      for (let y = 9 * s; y < H - 8; y += rowH) {
        let x = 3;
        while (x < W - 40 * s) {
          const x1 = Math.min(x + (140 + P.rnd() * 80) * s, W - 4);
          if (x1 - x < 20 * s) break;
          const n = Math.max(3, Math.ceil((x1 - x) / (40 * s)) + 1);
          for (let k = 0; k < n; k++) {
            const xx = x + (x1 - x) * k / (n - 1);
            X.push(xx); Y.push(y + (P.rnd() * 2 - 1) * 3 * s);
            L.push(x1 - x); Wd.push((21 + P.rnd() * 9) * s);
            Lay.push(P.sampleA(A.labels, xx, y));
          }
          x = x1 - 12 * s;
          if (x1 >= W - 4) break;
        }
      }
      push('imprimatura', P.make(X, Y, L, Wd, Lay, 4, 0, KIND_NORMAL, 1.0, 0, GB, 0.55, 'base'));
    }

    // 2 起稿
    {
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      const sp = 8 * s, seen = new Set();
      for (let y = 1; y < A.AH - 1; y += 1) {
        for (let x = 1; x < A.AW - 1; x += 1) {
          if (A.eMajor[y * A.AW + x] < 1) continue;
          if (P.rnd() > 0.5) continue;
          const fx = x * A.sxa, fy = y * A.sya;
          const key = ((fx / sp) | 0) * 200000 + ((fy / sp) | 0);
          if (seen.has(key)) continue;
          seen.add(key);
          X.push(fx); Y.push(fy);
          L.push((10 + P.rnd() * 16) * s); Wd.push((0.9 + P.rnd() * 0.8) * s);
          Lay.push(P.sampleA(A.labels, fx, fy));
        }
      }
      push('underdrawing', P.make(X, Y, L, Wd, Lay, 4, 0, KIND_NORMAL, 0.55, 0, [58, 44, 34], 0.72, 'under'));
    }

    // 3 单色底层
    {
      const all = [];
      for (const [sp, w0, w1, l0, l1] of [[42, 20, 30, 50, 92], [25, 12, 20, 28, 56]]) {
        const g = P.grid(sp * s, 0.5);
        const L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          L.push((l0 + P.rnd() * (l1 - l0)) * (0.6 + 0.7 * c) * s);
          Wd.push((w0 + P.rnd() * (w1 - w0)) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.make(g.X, g.Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 0.8, 0.72, [70, 58, 46], 0.34, 'gris'));
      }
      push('grisaille', all);
    }

    // 4 铺大色
    {
      const all = [];
      for (const [sp, w0, w1] of [[40, 15, 28], [24, 10, 19]]) {
        const g = P.grid(sp * s, 0.5);
        const L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          L.push((46 + P.rnd() * 40) * (0.6 + 0.7 * c) * s);
          Wd.push((w0 + P.rnd() * (w1 - w0)) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.make(g.X, g.Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 1.0, 0.04, null, 0, 'block'));
      }
      push('block-in', all);
    }

    // 5 塑造
    {
      const all = [];
      for (const [sp, w0, w1, l0, l1, smin] of [[24, 14, 19, 26, 50, 0.03], [18, 8, 13, 20, 40, 0.05], [14, 6, 9, 16, 34, 0.07]]) {
        const g = P.grid(sp * s, 0.5);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          if (P.sampleA(A.sal, g.X[i], g.Y[i]) < smin) continue;
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((l0 + P.rnd() * (l1 - l0)) * (0.6 + 0.7 * c) * s);
          Wd.push((w0 + P.rnd() * (w1 - w0)) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.make(X, Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 1.0, 0, null, 0, 'mass'));
      }
      push('massing', all);
    }

    // 6 塑形
    {
      const all = [];
      for (const [sp, w0, w1, l0, l1, amin] of [[13.5, 4.5, 7, 12, 26, 0.10], [10, 3.2, 5, 9, 20, 0.14], [8, 2.6, 4, 7, 16, 0.18]]) {
        const g = P.grid(sp * s, 0.5);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          if (P.sampleA(A.sal, g.X[i], g.Y[i]) < amin) continue;
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((l0 + P.rnd() * (l1 - l0)) * (0.6 + 0.7 * c) * s);
          Wd.push((w0 + P.rnd() * (w1 - w0)) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.make(X, Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 0.94, 0, null, 0, 'mod'));
      }
      push('modelling', all);
    }

    // 7 罩染：只罩最暗 30%
    {
      const lum = [];
      for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) lum.push(P.lum(x, y));
      lum.sort((a, b) => a - b);
      const thr = lum[Math.floor(lum.length * 0.30)];
      const g = P.grid(30 * s, 0.6);
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      for (let i = 0; i < g.X.length; i++) {
        if (P.lum(g.X[i], g.Y[i]) > thr) continue;
        if (P.sampleA(A.sal, g.X[i], g.Y[i]) < 0.04) continue;
        const cc = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((40 + P.rnd() * 42) * (0.6 + 0.7 * cc) * s);
        Wd.push((14 + P.rnd() * 12) * s);
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('glazing', P.make(X, Y, L, Wd, Lay, 5, 0, KIND_GLAZE, 0.22, 0.05, null, 0, 'glaze'));
    }

    // 8 干扫：亮部 + 低饱和 + 低结构
    {
      const lum = [];
      for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) lum.push(P.lum(x, y));
      lum.sort((a, b) => a - b);
      const thr = lum[Math.floor(lum.length * 0.68)];
      const g = P.grid(28 * s, 0.5);
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      for (let i = 0; i < g.X.length; i++) {
        const c = P.sampleRGB(g.X[i], g.Y[i]);
        const gv = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
        if (gv < thr) continue;
        const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
        if (mx > 0 && ((mx - mn) / mx) * 100 > 32) continue;
        // 干扫只用于结构弱的区域；脸部虽有亮度但结构明确，必须排除，否则糊一层白线
        if (P.sampleA(A.sal, g.X[i], g.Y[i]) > 0.30) continue;
        if (P.sampleA(A.coh, g.X[i], g.Y[i]) > 0.45) continue;
        const cc = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((34 + P.rnd() * 38) * (0.6 + 0.7 * cc) * s);
        Wd.push((9 + P.rnd() * 9) * s);
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('scumbling', P.make(X, Y, L, Wd, Lay, 5, 0, KIND_SCUMBLE, 0.20, 0, null, 0, 'scum'));
    }

    // 9 细部：自动 ROI + 三遍
    {
      const rois = opts.rois && opts.rois.length ? opts.rois : autoROIs(A, opts.autoRois === undefined ? 6 : opts.autoRois);
      const det = [];
      for (const r of rois) {
        const g = P.grid(3.4 * s, 0.55, r);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          if (P.sampleA(A.sal, g.X[i], g.Y[i]) < 0.06) continue;
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((0.45 + P.rnd() * 0.55) * 9.5 * (0.7 + 0.45 * c) * s);
          Wd.push((0.85 + P.rnd() * 0.85) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        det.push(...P.make(X, Y, L, Wd, Lay, 4, 1, KIND_NORMAL, 1.0, 0, null, 0, 'det'));
      }
      for (const r of rois) {
        const g = P.grid(5.6 * s, 0.5, [r[0] + 1.7 * s, r[1] + 1.7 * s, r[2], r[3]]);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          if (P.sampleA(A.sal, g.X[i], g.Y[i]) < 0.10) continue;
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((0.5 + P.rnd() * 0.5) * 6.0 * (0.7 + 0.45 * c) * s);
          Wd.push((0.9 + P.rnd() * 0.9) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        det.push(...P.make(X, Y, L, Wd, Lay, 4, 1, KIND_NORMAL, 1.0, 0, null, 0, 'det2'));
      }
      for (const r of rois.slice(0, 5)) {
        const e = P.edgeSeeds(r, 0.5, 2.6 * s);
        const L = [], Wd = [], Lay = [];
        for (let i = 0; i < e.X.length; i++) {
          const c = P.sampleA(A.coh, e.X[i], e.Y[i]);
          L.push((0.5 + P.rnd() * 0.5) * 6.0 * (0.75 + 0.4 * c) * s);
          Wd.push((0.8 + P.rnd() * 0.6) * s);
          Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
        }
        det.push(...P.make(e.X, e.Y, L, Wd, Lay, 3, 1, KIND_NORMAL, 1.0, 0, null, 0, 'micro'));
      }
      push('detail', det);
    }

    // 10 提白
    {
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      const seen = new Set();
      const step = Math.max(4, Math.floor(Math.max(W, H) / 240));
      for (let y = 6; y < H - 6; y += step) {
        for (let x = 6; x < W - 6; x += step) {
          const g = P.lum(x, y);
          if (g < 235) continue;
          let isMax = true;
          for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) {
            if (P.lum(x + dx, y + dy) > g + 2) { isMax = false; break; }
          }
          if (!isMax) continue;
          const key = ((x / (9 * s)) | 0) * 200000 + ((y / (9 * s)) | 0);
          if (seen.has(key)) continue;
          if (seen.size > 1200) break;
          seen.add(key);
          X.push(x); Y.push(y);
          L.push((4 + P.rnd() * 7) * s); Wd.push((2 + P.rnd() * 2.6) * s);
          Lay.push(P.sampleA(A.labels, x, y));
        }
      }
      push('impasto', P.make(X, Y, L, Wd, Lay, 3, 1, KIND_IMPASTO, 0.98, 0, [255, 253, 246], 0.30, 'imp'));
    }

    return stages;
  }

  /* ================================================================ 风格二：线描
   * 参照 astronaut_edges.png：近黑底 + 细白线，只勾结构，不铺色。
   */
  const LINE_STAGE = [
    ['guide', '定形', 6.0],
    ['contour', '勾主线', 26.0],
    ['structure', '结构线', 24.0],
    ['filigree', '细描', 34.0],
    ['sparks', '点睛', 6.0],
  ];

  function buildLineart(A, rgba, W, H, opts, onStage) {
    const P = makePainter(A, rgba, W, H, opts.seed || 20261109);
    const base = Math.max(W, H) / 1527;
    const s = (opts.scale || 1) * Math.max(0.45, base);
    const stages = [];
    const WT = {}, LB = {};
    LINE_STAGE.forEach(([n, l, w]) => { WT[n] = w; LB[n] = l; });
    const push = (name, ss) => {
      stages.push({ name, label: LB[name] || name, weight: WT[name] || 5, strokes: ss });
      if (onStage) onStage(name, ss.length, LB[name] || name);
    };

    /* 线色：冷白。原图越暗线越亮，越亮线越柔 */
    const inkHex = (lumV) => {
      const t = clamp(lumV / 255, 0, 1);
      const b = 232 - 44 * t * t;
      const j = 0.955 + P.rnd() * 0.09;
      return P.hex(b * j, b * j, Math.min(255, b * j * 1.045));
    };
    /* 线宽都压在 1px 附近，不做粗笔 */
    const lw = (mul) => (0.72 * mul + P.rnd() * 0.34) * Math.max(0.85, s);
    const EDGE_OPT = { requireEdge: 0.5, colorTol: 999, maxTurn: 0.30 };

    // 1 定形：极淡的引导线，只铺骨架
    {
      const e = P.edgeSeeds(null, 0.5, 11 * s, A.eMajor);
      const L = [], Wd = [], Lay = [];
      for (let i = 0; i < e.X.length; i++) {
        L.push((30 + P.rnd() * 34) * s);
        Wd.push(lw(1.5));
        Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
      }
      push('guide', P.makeRaw(e.X, e.Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 0.13,
        Q => inkHex(P.lum(Q[0], Q[1]) * 0.35), 'line-guide',
        Object.assign({}, EDGE_OPT, { edgeField: A.eMajor })));
    }

    // 2 勾主线：主要轮廓，长且连贯
    {
      const e = P.edgeSeeds(null, 0.5, 3.0 * s, A.eMajor);
      const L = [], Wd = [], Lay = [];
      for (let i = 0; i < e.X.length; i++) {
        const coh = P.sampleA(A.coh, e.X[i], e.Y[i]);
        L.push((20 + P.rnd() * 26) * (0.75 + 0.55 * coh) * s);
        Wd.push(lw(1.2));
        Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
      }
      push('contour', P.makeRaw(e.X, e.Y, L, Wd, Lay, 8, 0, KIND_NORMAL, 0.97,
        Q => inkHex(P.lum(Q[0], Q[1])), 'line-main',
        Object.assign({}, EDGE_OPT, { edgeField: A.eMajor })));
    }

    // 3 结构线：内部细节边缘，比主线细
    {
      const e = P.edgeSeeds(null, 0.5, 2.4 * s, A.eFine);
      const L = [], Wd = [], Lay = [];
      for (let i = 0; i < e.X.length; i++) {
        if (P.sampleA(A.sal, e.X[i], e.Y[i]) < 0.12) continue;
        const coh = P.sampleA(A.coh, e.X[i], e.Y[i]);
        L.push((13 + P.rnd() * 18) * (0.75 + 0.55 * coh) * s);
        Wd.push(lw(0.94));
        Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
      }
      push('structure', P.makeRaw(e.X, e.Y, L, Wd, Lay, 7, 0, KIND_NORMAL, 0.84,
        Q => inkHex(P.lum(Q[0], Q[1])), 'line-struct',
        Object.assign({}, EDGE_OPT, { edgeField: A.eFine })));
    }

    // 4 细描：只在细节 ROI 里加密
    {
      const rois = opts.rois && opts.rois.length ? opts.rois : autoROIs(A, opts.autoRois === undefined ? 6 : opts.autoRois);
      const all = [];
      for (const r of rois) {
        const e = P.edgeSeeds(r, 0.5, 1.8 * s, A.eFine);
        const L = [], Wd = [], Lay = [];
        for (let i = 0; i < e.X.length; i++) {
          if (P.sampleA(A.sal, e.X[i], e.Y[i]) < 0.07) continue;
          const coh = P.sampleA(A.coh, e.X[i], e.Y[i]);
          L.push((10 + P.rnd() * 13) * (0.78 + 0.5 * coh) * s);
          Wd.push(lw(0.78));
          Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
        }
        all.push(...P.makeRaw(e.X, e.Y, L, Wd, Lay, 5, 1, KIND_NORMAL, 0.78,
          Q => inkHex(P.lum(Q[0], Q[1])), 'line-fine',
          Object.assign({}, EDGE_OPT, { edgeField: A.eFine })));
      }
      push('filigree', all);
    }

    // 5 点睛：最亮的高光点
    {
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      const step = Math.max(5, Math.floor(Math.max(W, H) / 260));
      for (let y = 4; y < H - 4; y += step) {
        for (let x = 4; x < W - 4; x += step) {
          if (P.lum(x, y) < 226) continue;
          if (P.sampleA(A.sal, x, y) < 0.05) continue;
          X.push(x); Y.push(y);
          L.push((2.5 + P.rnd() * 3.5) * s);
          Wd.push(lw(1.1));
          Lay.push(P.sampleA(A.labels, x, y));
        }
      }
      push('sparks', P.makeRaw(X, Y, L, Wd, Lay, 3, 1, KIND_NORMAL, 0.95,
        () => { const j = 0.97 + P.rnd() * 0.05; return P.hex(252 * j, 253 * j, 255 * j); }, 'line-spark'));
    }

    return stages;
  }

  /* ================================================================ 风格三：色块
   * 参照 astronaut_layers.png：k-means 分层 → 每层一个平涂色 → 硬边填色。
   */
  const POSTER_STAGE = [
    ['base', '铺底色', 14.0],
    ['shade', '暗部色块', 26.0],
    ['midtone', '中间调', 28.0],
    ['light', '亮部', 24.0],
    ['accent', '点缀', 12.0],
  ];

  function buildPosterize(A, rgba, W, H, opts, onStage) {
    const P = makePainter(A, rgba, W, H, opts.seed || 20261109);
    const base = Math.max(W, H) / 1527;
    const stages = [];
    const WT = {}, LB = {};
    POSTER_STAGE.forEach(([n, l, w]) => { WT[n] = w; LB[n] = l; });
    const push = (name, ss) => {
      stages.push({ name, label: LB[name] || name, weight: WT[name] || 5, strokes: ss });
      if (onStage) onStage(name, ss.length, LB[name] || name);
    };

    const k = clamp(opts.layers || 5, 2, 8);
    // 每层均值色在原图分辨率上取，避免降采样偏色
    const sum = new Float64Array(k * 3), cnt = new Float64Array(k);
    const stepPx = Math.max(1, Math.floor(Math.sqrt(W * H / 240000)));
    for (let y = 0; y < H; y += stepPx) {
      for (let x = 0; x < W; x += stepPx) {
        const l = P.sampleA(A.labels, x, y) | 0;
        if (l < 0 || l >= k) continue;
        const c = P.sampleRGB(x, y);
        sum[l * 3] += c[0]; sum[l * 3 + 1] += c[1]; sum[l * 3 + 2] += c[2]; cnt[l]++;
      }
    }
    const palette = [];
    // 先算原图整体饱和度，用它自适应决定「海报化」要提多少饱和：
    // 本来就是低饱和的图（灰暗照片）提太少会一片死灰，提太多又会脏
    let satSum = 0, satN = 0;
    for (let y = 0; y < H; y += Math.max(1, stepPx * 4)) {
      for (let x = 0; x < W; x += Math.max(1, stepPx * 4)) {
        const c = P.sampleRGB(x, y);
        const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
        if (mx > 8) { satSum += (mx - mn) / mx; satN++; }
      }
    }
    const avgSat = satN ? satSum / satN : 0.2;      // 0(灰) … 1(纯色)
    // 灰图多提一点，彩色图少提一点，控制在 1.15–1.9 之间
    const satGain = clamp(1.15 + (0.35 - Math.min(0.35, avgSat)) * 2.2, 1.15, 1.9);
    const conGain = 1.10;

    /* 层内「代表色」：均值会被大量背景像素冲淡成灰，
     * 所以按亮度加权取该层里最饱和的那批像素的中位色，色块才不至于发灰。 */
    const hist = [];
    for (let i = 0; i < k; i++) hist.push([]);
    const hStep = Math.max(1, Math.floor(Math.sqrt(W * H / 90000)));
    for (let y = 0; y < H; y += hStep) {
      for (let x = 0; x < W; x += hStep) {
        const l = P.sampleA(A.labels, x, y) | 0;
        if (l < 0 || l >= k) continue;
        const c = P.sampleRGB(x, y);
        const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
        const s = mx > 8 ? (mx - mn) / mx : 0;
        hist[l].push(c[0], c[1], c[2], s);
      }
    }

    for (let i = 0; i < k; i++) {
      const n = Math.max(1, cnt[i]);
      let r = sum[i * 3] / n, g = sum[i * 3 + 1] / n, b = sum[i * 3 + 2] / n;

      // 取该层饱和度前 35% 的样本，求它们的中位色作为代表色
      const arr = hist[i];
      const cntS = arr.length / 4;
      if (cntS >= 12) {
        const order = [];
        for (let q = 0; q < cntS; q++) order.push(q);
        order.sort((a, b2) => arr[b2 * 4 + 3] - arr[a * 4 + 3]);
        const take = Math.max(6, Math.floor(cntS * 0.35));
        const rs = [], gs = [], bs = [];
        for (let q = 0; q < take; q++) {
          const o = order[q] * 4;
          rs.push(arr[o]); gs.push(arr[o + 1]); bs.push(arr[o + 2]);
        }
        rs.sort((x, y) => x - y); gs.sort((x, y) => x - y); bs.sort((x, y) => x - y);
        const mid = take >> 1;
        // 代表色与均值做混合，既保留层的整体明度，又不被灰冲淡
        r = r * 0.35 + rs[mid] * 0.65;
        g = g * 0.35 + gs[mid] * 0.65;
        b = b * 0.35 + bs[mid] * 0.65;
      }

      // 海报化：提饱和 + 轻微提对比，让色块更明确
      const gv = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gv + (r - gv) * satGain; g = gv + (g - gv) * satGain; b = gv + (b - gv) * satGain;
      r = 128 + (r - 128) * conGain; g = 128 + (g - 128) * conGain; b = 128 + (b - 128) * conGain;
      palette.push([clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)]);
    }

    const minArea = Math.max(6, (A.AW * A.AH) * 0.000004);
    const byLayer = [];
    for (let i = 0; i < k; i++) {
      const loops = layerContours(A, i, minArea);
      loops.sort((a, b) => b.area - a.area);
      byLayer.push(loops);
    }

    const mkFill = (loop, colorHex, alpha, tag) => {
      const pts = simplify(loop.pts, Math.max(0.9, 1.1 * base));
      if (pts.length < 6) return null;
      let d = 'M' + pts[0].toFixed(1) + ' ' + pts[1].toFixed(1);
      for (let q = 1; q < pts.length / 2; q++) d += 'L' + pts[q * 2].toFixed(1) + ' ' + pts[q * 2 + 1].toFixed(1);
      d += 'Z';
      return {
        d, c: colorHex, w: 0, a: alpha, kind: KIND_FILL,
        len: +loop.len.toFixed(1), layer: 0, detail: 0, tag, area: loop.area,
      };
    };

    /* 按明暗把 k 层分 5 组，暗 → 亮依次铺，后画的压在前面 */
    const buckets = [[], [], [], [], []];
    for (let i = 0; i < k; i++) {
      let bi;
      if (i === 0) bi = 0;
      else if (i === k - 1) bi = 4;
      else if (k <= 3) bi = 3;
      else {
        const f = i / (k - 1);
        bi = f < 0.34 ? 1 : f < 0.67 ? 2 : 3;
      }
      buckets[bi].push(i);
    }

    const names = ['base', 'shade', 'midtone', 'light', 'accent'];
    for (let bi = 0; bi < 5; bi++) {
      const out = [];
      for (const li of buckets[bi]) {
        const col = P.hex(palette[li][0], palette[li][1], palette[li][2]);
        for (const loop of byLayer[li]) {
          const f = mkFill(loop, col, 1.0, 'fill');
          if (f) { f.layer = li; out.push(f); }
        }
      }
      push(names[bi], out);
    }

    return stages;
  }

  /* ================================================================ 风格四：素描
   * 纸底 + 石墨排线，暗部交叉线压深。
   */
  const PENCIL_STAGE = [
    ['sketch', '起形', 8.0],
    ['tone', '铺调子', 24.0],
    ['hatch', '排线', 28.0],
    ['cross', '交叉线', 24.0],
    ['lift', '提亮', 8.0],
  ];

  function buildPencil(A, rgba, W, H, opts, onStage) {
    const P = makePainter(A, rgba, W, H, opts.seed || 20261109);
    const base = Math.max(W, H) / 1527;
    const s = (opts.scale || 1) * Math.max(0.45, base);
    const stages = [];
    const WT = {}, LB = {};
    PENCIL_STAGE.forEach(([n, l, w]) => { WT[n] = w; LB[n] = l; });
    const push = (name, ss) => {
      stages.push({ name, label: LB[name] || name, weight: WT[name] || 5, strokes: ss });
      if (onStage) onStage(name, ss.length, LB[name] || name);
    };

    /* 石墨色：原图越暗越黑。纸张很亮，调子从 ~208 往下压 */
    const graphite = (lumV, depth) => {
      const t = clamp(lumV / 255, 0, 1);
      const v = 20 + 190 * Math.pow(t, 0.72);
      const k = depth === undefined ? 1 : depth;
      const out = 255 - (255 - v) * k;
      const j = 0.93 + P.rnd() * 0.12;
      return P.hex(out * j, out * j * 0.995, out * j * 0.965);
    };

    // 1 起形：轻淡的轮廓线
    {
      const e = P.edgeSeeds(null, 0.5, 6.5 * s, A.eMajor);
      const L = [], Wd = [], Lay = [];
      for (let i = 0; i < e.X.length; i++) {
        L.push((18 + P.rnd() * 24) * s);
        Wd.push((0.9 + P.rnd() * 0.6) * Math.max(0.85, s));
        Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
      }
      push('sketch', P.makeRaw(e.X, e.Y, L, Wd, Lay, 5, 0, KIND_NORMAL, 0.42,
        Q => graphite(P.lum(Q[0], Q[1]) * 0.5, 0.55), 'pc-sketch',
        { maxTurn: 0.34 }));
    }

    // 2 铺调子：大而淡的软笔触，像纸擦笔
    {
      const all = [];
      for (const [sp, w0, w1, a, dep] of [[34, 22, 34, 0.15, 0.55], [24, 14, 22, 0.20, 0.75]]) {
        const g = P.grid(sp * s, 0.55);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((28 + P.rnd() * 36) * (0.7 + 0.6 * c) * s);
          Wd.push((w0 + P.rnd() * (w1 - w0)) * s);
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.makeRaw(X, Y, L, Wd, Lay, 6, 0, KIND_NORMAL, a,
          Q => graphite(P.lum(Q[0], Q[1]), dep), 'pc-tone', { maxTurn: 0.22 }));
      }
      push('tone', all);
    }

    // 3 排线：顺结构方向的细线
    {
      const all = [];
      for (const [sp, wd, thr, a] of [[8.5, 0.95, 178, 0.30], [6.4, 0.85, 138, 0.34]]) {
        const g = P.grid(sp * s, 0.65);
        const X = [], Y = [], L = [], Wd = [], Lay = [];
        for (let i = 0; i < g.X.length; i++) {
          const lv = P.lum(g.X[i], g.Y[i]);
          if (lv > thr) continue;
          const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
          X.push(g.X[i]); Y.push(g.Y[i]);
          L.push((12 + P.rnd() * 16) * (0.75 + 0.5 * c) * s);
          Wd.push((wd + P.rnd() * 0.45) * Math.max(0.85, s));
          Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
        }
        all.push(...P.makeRaw(X, Y, L, Wd, Lay, 4, 0, KIND_NORMAL, a,
          Q => graphite(P.lum(Q[0], Q[1]), 0.9), 'pc-hatch', { maxTurn: 0.16 }));
      }
      push('hatch', all);
    }

    // 4 交叉线：最暗处反向排线，把暗部压下去
    {
      const g = P.grid(7.0 * s, 0.7);
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      for (let i = 0; i < g.X.length; i++) {
        const lv = P.lum(g.X[i], g.Y[i]);
        if (lv > 112) continue;
        const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((10 + P.rnd() * 13) * (0.8 + 0.5 * c) * s);
        Wd.push((0.85 + P.rnd() * 0.5) * Math.max(0.85, s));
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('cross', P.makeRaw(X, Y, L, Wd, Lay, 4, 1, KIND_NORMAL, 0.36,
        Q => graphite(P.lum(Q[0], Q[1]), 1.0), 'pc-cross', { rot90: true, maxTurn: 0.16 }));
    }

    // 5 提亮：亮部用高亮笔擦回纸白
    {
      const g = P.grid(10 * s, 0.75);
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      for (let i = 0; i < g.X.length; i++) {
        const lv = P.lum(g.X[i], g.Y[i]);
        if (lv < 192) continue;
        const c = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((14 + P.rnd() * 18) * (0.75 + 0.5 * c) * s);
        Wd.push((4 + P.rnd() * 4.5) * s);
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('lift', P.makeRaw(X, Y, L, Wd, Lay, 4, 1, KIND_NORMAL, 0.34,
        () => P.hex(251, 249, 242), 'pc-lift', { maxTurn: 0.24 }));
    }

    return stages;
  }

  /* ---------------------------------------------------------------- 风格注册表 */
  const STYLES = {
    oil: {
      key: 'oil', label: '油画', nStages: OIL_STAGE.length,
      desc: '十道古典油画工序，起收锋、厚涂、罩染、干扫',
      ground: { type: 'oil', color: '#181613' },
      build: buildOil,
      steps: OIL_STAGE.map(x => x[1]),
    },
    lineart: {
      key: 'lineart', label: '线描', nStages: LINE_STAGE.length,
      desc: '近黑底上的细白线，只勾结构，像版画稿',
      ground: { type: 'lineart', color: '#07080a' },
      build: buildLineart,
      steps: LINE_STAGE.map(x => x[1]),
    },
    posterize: {
      key: 'posterize', label: '色块', nStages: POSTER_STAGE.length,
      desc: '分层平涂的硬边色块，限量配色的海报感',
      ground: { type: 'posterize', color: '#0e1320' },
      build: buildPosterize,
      steps: POSTER_STAGE.map(x => x[1]),
    },
    pencil: {
      key: 'pencil', label: '素描', nStages: PENCIL_STAGE.length,
      desc: '纸底石墨排线，暗部交叉线压深',
      ground: { type: 'pencil', color: '#efe9dc' },
      build: buildPencil,
      steps: PENCIL_STAGE.map(x => x[1]),
    },
  };
  const STYLE_ORDER = ['oil', 'lineart', 'posterize', 'pencil'];

  function buildStages(A, rgba, W, H, opts, onStage) {
    const st = STYLES[opts.style] || STYLES.oil;
    return st.build(A, rgba, W, H, opts, onStage);
  }

  /* ---------------------------------------------------------------- ROI 自动检测 */
  function autoROIs(A, maxN) {
    if (!maxN) return [];
    const tile = 64;
    const gw = Math.ceil(A.AW / tile), gh = Math.ceil(A.AH / tile);
    const score = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let e = 0, g = 0, n = 0;
        const y0 = gy * tile, y1 = Math.min(A.AH, y0 + tile);
        const x0 = gx * tile, x1 = Math.min(A.AW, x0 + tile);
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            e += A.eFine[y * A.AW + x];
            g += A.sal[y * A.AW + x];
            n++;
          }
        }
        score[gy * gw + gx] = (e / n) * 0.65 + (g / n) * 0.35;
      }
    }
    const flat = Array.from(score).map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const chosen = [];
    for (const [, i] of flat) {
      const gx = i % gw, gy = (i / gw) | 0;
      const x0 = gx * tile * A.sxa, y0 = gy * tile * A.sya;
      const x1 = Math.min(A.AW, (gx + 2) * tile) * A.sxa, y1 = Math.min(A.AH, (gy + 2) * tile) * A.sya;
      let ok = true;
      for (const r of chosen) {
        if (x0 < r[2] && r[0] < x1 && y0 < r[3] && r[1] < y1) { ok = false; break; }
      }
      if (ok) chosen.push([x0, y0, x1, y1]);
      if (chosen.length >= maxN) break;
    }
    return chosen;
  }

  /* ---------------------------------------------------------------- 时间轴 */
  /* 兼容旧接口：STAGE_W / STAGE_CN 仍导出（油画） */
  const STAGE_W = {}; OIL_STAGE.forEach(([n, , w]) => { STAGE_W[n] = w; });
  const STAGE_CN = {}; OIL_STAGE.forEach(([n, l]) => { STAGE_CN[n] = l; });

  function buildTimeline(stages, totalSeconds) {
    let wsum = 0;
    for (const st of stages) if (st.strokes.length) wsum += (st.weight || 5);
    const strokes = [], marks = [];
    let t = 0;
    for (const st of stages) {
      if (!st.strokes.length) continue;
      const sec = totalSeconds * (st.weight || 5) / wsum;
      // 色块按面积额外计一点时间，让它「铺开」得不那么突兀
      const unitOf = (s) => 0.0035 + 0.0010 * s.len + 0.0006 * s.w +
        (s.kind === KIND_FILL ? 0.0010 * Math.sqrt(Math.max(1, s.area || 1)) : 0);
      let unit = 0;
      for (const s of st.strokes) unit += unitOf(s);
      const k = sec / Math.max(unit, 1e-9);
      marks.push({ name: st.name, label: st.label, t, n: st.strokes.length, sec });
      for (const s of st.strokes) {
        const dur = unitOf(s) * k;
        s.start = t; s.dur = dur; t += dur;
        delete s.area;
        strokes.push(s);
      }
    }
    return { strokes, marks, total: t };
  }

  root.OILCore = {
    analyze, buildStages, buildTimeline, autoROIs, layerContours, simplify,
    STYLES, STYLE_ORDER, STAGE_CN, STAGE_W,
    K_NORMAL: KIND_NORMAL, K_GLAZE: KIND_GLAZE, K_SCUMBLE: KIND_SCUMBLE,
    K_IMPASTO: KIND_IMPASTO, K_FILL: KIND_FILL,
  };
})(typeof self !== 'undefined' ? self : this);
