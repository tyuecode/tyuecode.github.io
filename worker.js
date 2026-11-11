/* 生成 worker：把分析 + 笔触 + 时间轴跑在后台线程，避免界面卡死 */
/* core.js 同样会被 CDN 强缓存，必须把本 worker 的查询串透传下去，
 * 否则会出现「新 worker + 旧 core」，风格依然失效。 */
importScripts('core.js' + (self.location && self.location.search ? self.location.search : ''));

/* 握手：新版会回自己的 build 与风格数，旧版不会。
 * 页面用它判断浏览器有没有命中缓存里的旧脚本（见 index.html 的 checkWorkerVersion）。 */
const BUILD = '20261111-4style';

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'hello') {
    self.postMessage({
      type: 'hello',
      build: BUILD,
      styles: Object.keys(OILCore.STYLES || {}).length,
      styleKeys: Object.keys(OILCore.STYLES || {}),
    });
    return;
  }

  if (msg.type !== 'generate') return;

  const { rgba, w, h, opts } = msg;
  const t0 = performance.now();
  const post = (phase, progress, extra) =>
    self.postMessage(Object.assign({ type: 'progress', phase, progress }, extra || {}));

  try {
    const styleKey = (opts.style && OILCore.STYLES[opts.style]) ? opts.style : 'oil';
    const styleDef = OILCore.STYLES[styleKey];

    post('分析画面', 4);
    const A = OILCore.analyze(rgba, w, h, opts);

    // 分层统计
    const k = A.layers.length;
    const cnt = new Float64Array(k);
    for (let i = 0; i < A.labels.length; i++) cnt[A.labels[i]]++;
    const tot = A.labels.length;
    const layers = A.layers.map((l, i) => ({
      id: l.id, L: +l.L.toFixed(1), S: +l.S.toFixed(1), frac: cnt[i] / tot,
    }));
    post('分析画面', 11, { layers });

    const nStage = Math.max(1, styleDef.nStages);
    let idx = 0;
    const stages = OILCore.buildStages(A, rgba, w, h, opts, (name, n, label) => {
      idx++;
      post('笔触 · ' + (label || name), 11 + Math.round(72 * idx / nStage),
           { stage: name, stageLabel: label, count: n });
    });

    post('编排时间轴', 86);
    const tl = OILCore.buildTimeline(stages, opts.seconds || 90);

    // 严格串行校验：不允许重叠或断裂
    let breaks = 0;
    for (let i = 1; i < tl.strokes.length; i++) {
      const prevEnd = tl.strokes[i - 1].start + tl.strokes[i - 1].dur;
      if (Math.abs(tl.strokes[i].start - prevEnd) > 1e-6) breaks++;
    }

    const pack = tl.strokes.map(s => [s.d, s.c, s.w, s.start, s.dur, s.detail, s.layer,
                                      +s.len.toFixed(1), s.a, s.kind]);
    post('完成', 100);
    self.postMessage({
      type: 'done',
      payload: {
        w, h, total: tl.total, layers,
        style: styleKey,
        styleLabel: styleDef.label,
        ground: styleDef.ground || { type: 'oil', color: '#181613' },
        steps: styleDef.steps,
        stages: tl.marks.map(m => ({ name: m.name, label: m.label, t: m.t, n: m.n })),
        strokes: pack,
        detail: tl.strokes.filter(s => s.detail).length,
        breaks,
        elapsed: (performance.now() - t0) / 1000,
        perStage: tl.marks.map(m => [m.label, m.n]),
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
