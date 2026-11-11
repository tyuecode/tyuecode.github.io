/* strokeoil core — Python 管线的浏览器移植
 * 分析在降采样工作分辨率上做（结构场本身平滑，缩采样几乎无损），
 * 笔触种子与取色在原始分辨率上做（保证细节与色彩不糊）。
 */
(function (root) {
  'use strict';

  const K_NORMAL = 0, K_GLAZE = 1, K_SCUMBLE = 2, K_IMPASTO = 3;
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

    // 非极大值抑制
    const nms = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const ang = Math.atan2(gy[i], gx[i]);
        let a = (ang * 180 / Math.PI + 180) % 180;
        let d1, d2;
        if (a < 22.5 || a >= 157.5) { d1 = i - 1; d2 = i + 1; }
        else if (a < 67.5) { d1 = i - w - 1; d2 = i + w + 1; }
        else if (a < 112.5) { d1 = i - w; d2 = i + w; }
        else { d1 = i - w + 1; d2 = i + w - 1; }
        const m = mag[i];
        nms[i] = (m >= mag[d1] && m >= mag[d2]) ? m : 0;
      }
    }

    // 双阈值 + 滞后
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
    // 采样做 k-means++ 初始化
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
    const maxSide = opts.workRes || 1400;
    const sc = Math.min(1, maxSide / Math.max(W, H));
    const AW = Math.max(8, Math.round(W * sc)), AH = Math.max(8, Math.round(H * sc));
    const rgb = downscale(rgba, W, H, AW, AH);
    const n = AW * AH;

    // L* / S 近似（RGB→亮度 + 饱和度）
    const L = new Float32Array(n), S = new Float32Array(n), gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      L[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 100;
      S[i] = mx > 0 ? ((mx - mn) / mx) * 100 : 0;
      gray[i] = L[i] / 100;
    }
    // 先平滑再聚类，天然抑制层内碎屑（替代 Python 的 medianBlur）
    const Lb = gaussBlur(L, AW, AH, 2.4), Sb = gaussBlur(S, AW, AH, 2.4);
    const k = opts.layers || 5;
    const km = kmeans2(Lb, Sb, n, k, 12, opts.seed || 20261109);

    // 按 L + 0.15S 排序编号（0 = 最暗）
    const order = Array.from({ length: k }, (_, i) => i)
      .sort((a, b) => (km.cx[a] + 0.15 * km.cy[a]) - (km.cx[b] + 0.15 * km.cy[b]));
    const remap = new Int32Array(k);
    order.forEach((c, i) => { remap[c] = i; });
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) labels[i] = remap[km.lab[i]];

    // 结构张量
    const { gx, gy } = sobel(gray, AW, AH);
    const Jxx = gaussBlur(new Float32Array(gx.map ? gx.map(v => v * v) : (() => {
      const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = gx[i] * gx[i]; return a;
    })()), AW, AH, 3.0);
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
    // 低频方向场（倍角平滑，避免 0/π 跳变）
    const Cb = gaussBlur(c2, AW, AH, 14.0), Sb2 = gaussBlur(s2, AW, AH, 14.0);
    const thLo = new Float32Array(n);
    for (let i = 0; i < n; i++) thLo[i] = 0.5 * Math.atan2(Sb2[i], Cb[i]);

    const eMajor = canny(gray, AW, AH, 3.0, 0.12, 0.30);
    const eFine = canny(gray, AW, AH, 1.2, 0.08, 0.22);
    const eFineS = gaussBlur(eFine, AW, AH, 1.3);

    // 显著性
    let mx = 1e-6; for (let i = 0; i < n; i++) if (mag[i] > mx) mx = mag[i];
    const sal = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const gm = Math.min(1, mag[i] / mx);
      sal[i] = 0.30 * gm + 0.26 * coh[i] + 0.24 * eFineS[i] + 0.20 * gm;
    }
    const salS = gaussBlur(sal, AW, AH, 2.2);
    let smax = 1e-6; for (let i = 0; i < n; i++) if (salS[i] > smax) smax = salS[i];
    for (let i = 0; i < n; i++) salS[i] = Math.min(1, salS[i] / smax);

    // 方向场：平坦且无结构处走低频
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

  /* ---------------------------------------------------------------- 笔触 */
  function resample(P, K, out) {
    const m = P.length / 2 | 0;
    const seg = new Float32Array(m);
    let total = 0;
    for (let i = 0; i < m; i++) {
      const j = Math.min(i + 1, m - 1);
      const dx = P[j * 2] - P[i * 2], dy = P[j * 2 + 1] - P[i * 2 + 1];
      const d = Math.hypot(dx, dy);
      seg[i] = d; total += d;
    }
    if (total < 1e-6) { out.length = 0; for (let q = 0; q < K; q++) { out.push(P[0], P[1]); } return total; }
    const cum = new Float32Array(m);
    let acc = 0;
    for (let i = 0; i < m; i++) { cum[i] = acc; acc += seg[i]; }
    out.length = 0;
    let j = 0;
    for (let q = 0; q < K; q++) {
      const target = (q / (K - 1)) * total;
      while (j < m - 2 && cum[j + 1] < target) j++;
      const t0 = cum[j], t1 = cum[j + 1];
      const f = Math.max(0, Math.min(1, (target - t0) / Math.max(t1 - t0, 1e-9)));
      out.push(P[j * 2] + (P[(j + 1) * 2] - P[j * 2]) * f,
               P[j * 2 + 1] + (P[(j + 1) * 2 + 1] - P[j * 2 + 1]) * f);
    }
    return total;
  }

  function makePainter(A, rgba, W, H, seed) {
    let st = seed || 1;
    const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
    const unif = (a, b) => a + (b - a) * rnd();

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
    const hex = (r, g, b) => '#' +
      Math.round(clamp(r, 0, 255)).toString(16).padStart(2, '0') +
      Math.round(clamp(g, 0, 255)).toString(16).padStart(2, '0') +
      Math.round(clamp(b, 0, 255)).toString(16).padStart(2, '0');

    /* 沿方向场行走，返回折线（扁平数组）与弧长 */
    const Ptmp = new Float64Array(64);
    function trace(x0, y0, len, layer, steps) {
      let px = x0, py = y0;
      const base = sampleRGB(px, py);
      let hx = sampleA(A.DX, px, py), hy = sampleA(A.DY, px, py);
      const step = Math.max(1.5, len / steps);
      const P = [px, py];
      for (let s = 0; s < steps; s++) {
        let fx = sampleA(A.DX, px, py), fy = sampleA(A.DY, px, py);
        if (fx * hx + fy * hy < 0) { fx = -fx; fy = -fy; }
        let nx0 = 0.58 * hx + 0.42 * fx, ny0 = 0.58 * hy + 0.42 * fy;
        const mg = Math.hypot(nx0, ny0) + 1e-9;
        nx0 /= mg; ny0 /= mg;
        const nx = px + nx0 * step, ny = py + ny0 * step;
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) break;
        if (sampleA(A.labels, nx, ny) !== layer) break;
        const c2 = sampleRGB(nx, ny);
        if (Math.abs(c2[0] - base[0]) + Math.abs(c2[1] - base[1]) + Math.abs(c2[2] - base[2]) > 120) break;
        px = nx; py = ny; hx = nx0; hy = ny0;
        P.push(px, py);
      }
      return P;
    }

    function pickColor(Q, K, desat, tint, tintAmt) {
      const idxs = [0, Math.max(1, K >> 2), K >> 1, Math.max(1, (3 * K) >> 2), K - 1];
      const acc = [[], [], []];
      for (const q of idxs) {
        const c = sampleRGB(Q[q * 2], Q[q * 2 + 1]);
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

    const Q = [];
    function make(sx, sy, len, wid, lay, steps, detail, kind, alpha, desat, tint, tintAmt, tag) {
      const out = [];
      for (let i = 0; i < sx.length; i++) {
        const P = trace(sx[i], sy[i], len[i], lay[i], steps);
        const np = P.length / 2;
        if (np < 2) continue;
        // K 按弧长定，和 Python 的 ceil(len/7) 对齐；短笔用 3 点就够
        let arcLen = 0;
        for (let q = 1; q < np; q++) arcLen += Math.hypot(P[q*2] - P[(q-1)*2], P[q*2+1] - P[(q-1)*2+1]);
        const K = clamp(Math.ceil(arcLen / 7), 3, 12);
        const arc = resample(P, K, Q);
        const c = pickColor(Q, Q.length / 2, desat || 0, tint, tintAmt || 0);
        let d = 'M' + Q[0].toFixed(1) + ' ' + Q[1].toFixed(1);
        for (let q = 1; q < Q.length / 2; q++) d += 'L' + Q[q * 2].toFixed(1) + ' ' + Q[q * 2 + 1].toFixed(1);
        out.push({
          d, c, w: +wid[i].toFixed(2), a: +alpha.toFixed(3), kind,
          len: +arc.toFixed(2), layer: lay[i], detail, tag: tag || '',
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

    function edgeSeeds(rect, thr, sp) {
      const [x0, y0, x1, y1] = rect;
      const X = [], Y = [];
      const seen = new Set();
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (sampleA(A.eFine, x, y) < 0.5) continue;
          const key = ((x / sp) | 0) * 100000 + ((y / sp) | 0);
          if (seen.has(key)) continue;
          seen.add(key);
          const px = x + (rnd() * 2 - 1) * 0.6, py = y + (rnd() * 2 - 1) * 0.6;
          if (px > 1 && px < W - 2 && py > 1 && py < H - 2) { X.push(px); Y.push(py); }
        }
      }
      return { X, Y };
    }

    return { make, grid, edgeSeeds, sampleA, sampleRGB, unif, rnd };
  }

  /* ---------------------------------------------------------------- 十道工序 */
  function buildStages(A, rgba, W, H, opts, onStage) {
    const P = makePainter(A, rgba, W, H, opts.seed || 20261109);
    const base = Math.max(W, H) / 1527;           // 笔触尺度随图幅放大，笔数保持可控
    const s = (opts.scale || 1) * Math.max(0.45, base);
    const stages = [];
    const push = (name, ss) => { stages.push({ name, strokes: ss }); if (onStage) onStage(name, ss.length); };

    const groundFromImg = () => {
      // 取最暗 28% 像素的均值，再向暖褐偏
      const hist = new Uint32Array(256);
      for (let i = 0; i < W * H; i += 17) {
        const g = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
        hist[g]++;
      }
      let tot = 0; for (let i = 0; i < 256; i++) tot += hist[i];
      let need = tot * 0.28, th = 255;
      for (let i = 0; i < 256; i++) { need -= hist[i]; if (need <= 0) { th = i; break; } }
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < W * H; i += 7) {
        const gg = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
        if (gg > th) continue;
        r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n++;
      }
      if (!n) return [40, 34, 28];
      r = (r / n) * 0.86; g = (g / n) * 0.98; b = Math.min(255, (b / n) * 1.04);
      return [r, g, b];
    };
    const GB = groundFromImg();

    // 1 底色
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
      push('imprimatura', P.make(X, Y, L, Wd, Lay, 4, 0, K_NORMAL, 1.0, 0, GB, 0.55, 'base'));
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
      push('underdrawing', P.make(X, Y, L, Wd, Lay, 4, 0, K_NORMAL, 0.55, 0, [58, 44, 34], 0.72, 'under'));
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
        all.push(...P.make(g.X, g.Y, L, Wd, Lay, 5, 0, K_NORMAL, 0.8, 0.72, [70, 58, 46], 0.34, 'gris'));
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
        all.push(...P.make(g.X, g.Y, L, Wd, Lay, 5, 0, K_NORMAL, 1.0, 0.04, null, 0, 'block'));
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
        all.push(...P.make(X, Y, L, Wd, Lay, 5, 0, K_NORMAL, 1.0, 0, null, 0, 'mass'));
      }
      push('massing', all);
    }

    // 6 塑形（三档宽度，和细节层接上）
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
        all.push(...P.make(X, Y, L, Wd, Lay, 5, 0, K_NORMAL, 0.94, 0, null, 0, 'mod'));
      }
      push('modelling', all);
    }

    // 7 罩染（只罩最暗 30%）
    {
      const lum = [];
      for (let i = 0; i < W * H; i += 23) lum.push(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114);
      lum.sort((a, b) => a - b);
      const thr = lum[Math.floor(lum.length * 0.30)];
      const g = P.grid(30 * s, 0.6);
      const X = [], Y = [], L = [], Wd = [], Lay = [];
      for (let i = 0; i < g.X.length; i++) {
        const c = P.sampleRGB(g.X[i], g.Y[i]);
        if (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 > thr) continue;
        if (P.sampleA(A.sal, g.X[i], g.Y[i]) < 0.04) continue;
        const cc = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((40 + P.rnd() * 42) * (0.6 + 0.7 * cc) * s);
        Wd.push((14 + P.rnd() * 12) * s);
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('glazing', P.make(X, Y, L, Wd, Lay, 5, 0, K_GLAZE, 0.22, 0.05, null, 0, 'glaze'));
    }

    // 8 干扫（亮部 + 低饱和 + 低结构）
    {
      const lum = [];
      for (let i = 0; i < W * H; i += 23) lum.push(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114);
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
        // 关键：干扫只用于「结构弱」的区域（天空/雾/反光面）。
        // 脸部虽然够亮够低饱和，但有明确结构，必须在 sal 上排除，否则会糊一层白线。
        if (P.sampleA(A.sal, g.X[i], g.Y[i]) > 0.30) continue;
        if (P.sampleA(A.coh, g.X[i], g.Y[i]) > 0.45) continue;
        const cc = P.sampleA(A.coh, g.X[i], g.Y[i]);
        X.push(g.X[i]); Y.push(g.Y[i]);
        L.push((34 + P.rnd() * 38) * (0.6 + 0.7 * cc) * s);
        Wd.push((9 + P.rnd() * 9) * s);
        Lay.push(P.sampleA(A.labels, g.X[i], g.Y[i]));
      }
      push('scumbling', P.make(X, Y, L, Wd, Lay, 5, 0, K_SCUMBLE, 0.20, 0, null, 0, 'scum'));
    }

    // 9 细部（自动 ROI + 三遍；密度与 Python 版对齐，避免碎屑）
    {
      const rois = opts.rois && opts.rois.length ? opts.rois : autoROIs(A, opts.autoRois || 6);
      const det = [];
      // 第一遍：细笔铺形，只落在有结构的地方（显著性过滤是关键，否则会糊成碎屑）
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
        det.push(...P.make(X, Y, L, Wd, Lay, 4, 1, K_NORMAL, 1.0, 0, null, 0, 'det'));
      }
      // 第二遍：更疏的错位网格补缝
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
        det.push(...P.make(X, Y, L, Wd, Lay, 4, 1, K_NORMAL, 1.0, 0, null, 0, 'det2'));
      }
      // 第三遍：只沿边缘播种（最锐的一层，笔数天然少）
      for (const r of rois.slice(0, 5)) {
        const e = P.edgeSeeds(r, 0.5, 2.6 * s);
        const L = [], Wd = [], Lay = [];
        for (let i = 0; i < e.X.length; i++) {
          const c = P.sampleA(A.coh, e.X[i], e.Y[i]);
          L.push((0.5 + P.rnd() * 0.5) * 6.0 * (0.75 + 0.4 * c) * s);
          Wd.push((0.8 + P.rnd() * 0.6) * s);
          Lay.push(P.sampleA(A.labels, e.X[i], e.Y[i]));
        }
        det.push(...P.make(e.X, e.Y, L, Wd, Lay, 3, 1, K_NORMAL, 1.0, 0, null, 0, 'micro'));
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
          const c = P.sampleRGB(x, y);
          const g = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
          if (g < 235) continue;
          // 局部极大值才算高光
          let isMax = true;
          for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) {
            const c2 = P.sampleRGB(x + dx, y + dy);
            if (c2[0] * 0.299 + c2[1] * 0.587 + c2[2] * 0.114 > g + 2) { isMax = false; break; }
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
      push('impasto', P.make(X, Y, L, Wd, Lay, 3, 1, K_IMPASTO, 0.98, 0, [255, 253, 246], 0.30, 'imp'));
    }

    return stages;
  }

  /* ---------------------------------------------------------------- ROI 自动检测 */
  function autoROIs(A, maxN) {
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
  const STAGE_W = {
    imprimatura: 3.5, underdrawing: 5.0, grisaille: 8.0, 'block-in': 7.0,
    massing: 12.0, modelling: 16.0, glazing: 5.0, scumbling: 4.0,
    detail: 26.0, impasto: 3.5,
  };
  const STAGE_CN = {
    imprimatura: '刷底色', underdrawing: '起稿', grisaille: '单色底层',
    'block-in': '铺大色', massing: '塑造', modelling: '塑形',
    glazing: '罩染', scumbling: '干扫', detail: '细部', impasto: '提白',
  };

  function buildTimeline(stages, totalSeconds) {
    let wsum = 0;
    for (const st of stages) if (st.strokes.length) wsum += STAGE_W[st.name] || 5;
    const strokes = [], marks = [];
    let t = 0;
    for (const st of stages) {
      if (!st.strokes.length) continue;
      const sec = totalSeconds * (STAGE_W[st.name] || 5) / wsum;
      let unit = 0;
      for (const s of st.strokes) unit += 0.0035 + 0.0010 * s.len + 0.0006 * s.w;
      const k = sec / Math.max(unit, 1e-9);
      marks.push({ name: st.name, label: STAGE_CN[st.name] || st.name, t, n: st.strokes.length, sec });
      for (const s of st.strokes) {
        const dur = (0.0035 + 0.0010 * s.len + 0.0006 * s.w) * k;
        s.start = t; s.dur = dur; t += dur;
        strokes.push(s);
      }
    }
    return { strokes, marks, total: t };
  }

  root.OILCore = {
    analyze, buildStages, buildTimeline, autoROIs,
    K_NORMAL, K_GLAZE, K_SCUMBLE, K_IMPASTO, STAGE_CN, STAGE_W,
  };
})(typeof self !== 'undefined' ? self : this);
