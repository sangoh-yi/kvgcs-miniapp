/* vlbisim_worker.js — VLBI 모의 '전 세션 신호 수준'(0.13.1, 2026-10-05). 화면이 멈추지 않게 웹 워커에서
 *   스캔마다 신호 생성 → 2비트 → 상관(FX) → 프린지 탐색(X·S) → 전리층 없는 지연을 만든다. 해석(최소제곱)은 화면 쪽이 같은 씨앗으로 푼다.
 *   받는 것: {cfg(VSCore.session 과 같은 설정, 함수 없음), K, N, seed, minSnr} · 보내는 것: {prog, n, last} … {done, obs, ms}
 */
'use strict';
importScripts('vlbisim_core.js');
let stop = false;
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.stop) { stop = true; return; }
  stop = false;
  const V = self.VSCore, cfg = m.cfg, prep = V.sessionPrep(cfg), obs = [], t0 = Date.now(), n = cfg.scans.length;
  for (let i = 0; i < n; i++) {
    if (stop) { self.postMessage({ stopped: true, done: false, i }); return; }
    let o = null;
    try { o = V.obsSignal(cfg, prep, cfg.scans[i], { K: m.K || 16, N: m.N || 2048, seed: m.seed || 1, minSnr: m.minSnr ?? 7 }); }
    catch (err) { o = { drop: true, name: cfg.scans[i].name, t: cfg.scans[i].t, err: String(err) }; }
    if (o) obs.push(o);
    self.postMessage({ prog: i + 1, n, last: o && !o.drop ? { name: o.name, snrX: o.snrX, snrS: o.snrS, errX: o.errX, errS: o.errS } : (o ? { name: o.name, drop: true } : null), ms: Date.now() - t0 });
  }
  self.postMessage({ done: true, obs, ms: Date.now() - t0 });
};
