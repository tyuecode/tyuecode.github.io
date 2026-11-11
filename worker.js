/* 生成 worker：把分析+笔触+时间轴跑在后台线程，避免界面卡死 */
importScripts('core.js');

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'generate') return;

  const { rgba, w, h, opts } = msg;
  const t0 = performance.now();
  const post = (phase, progress, extra) =>
    self.postMessage(Object.assign({ type: 'progress', phase, progress }, extra || {}));

  try {
    post('分析画面', 5);
    const A = OILCore.analyze(rgba, w, h, opts);

    // 分层统计
    const cnt = new Float64Array(opts.layers || 5);
    for (let i = 0; i < A.labels.length; i++) cnt[A.labels[i]]++;
    const tot = A.labels.length;
    const layers = A.layers.map((l, i) => ({
      id: l.id, L: +l.L.toFixed(1), S: +l.S.toFixed(1), frac: cnt[i] / tot,
    }));
    post('分析画面', 12, { layers });

    const names = ['刷底色','起稿','单色底层','铺大色','塑造','塑形','罩染','干扫','细部','提白'];
    let idx = 0;
    const stages = OILCore.buildStages(A, rgba, w, h, opts, (name, n) => {
      idx++;
      post('笔触 · ' + (OILCore.STAGE_CN[name] || name), 12 + Math.round(64 * idx / 10),
           { stage: name, count: n });
    });

    post('编排时间轴', 80);
    const tl = OILCore.buildTimeline(stages, opts.seconds || 90);

    // 严格串行校验
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
