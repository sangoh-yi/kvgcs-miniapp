/* radiocam_worker.js — 전파 카메라 모의의 계산을 웹 워커에서(화면이 멈추지 않게, 2026-10-05).
 *   받는 것: { cmd:'inspect', sc, em, set } → 자세마다 { type:'cap' } 를 보내고 끝에 { type:'done' }
 *            { cmd:'check', scenes, em, set } → 장소마다 { type:'chk' }
 */
'use strict';
importScripts('radiocam_core.js');
const R = self.RCCore;

function slimCap(c) {                                 // 화면에 필요한 것만(영상은 Float32 그대로 넘긴다)
  return {
    ci: c.ci, pose: c.pose,
    bands: c.bands.map((b) => ({ band: b.band, lam: b.lam, lstep: b.lstep, disp: b.disp, sig: b.sig,
      classes: b.classes.map((k) => ({ cls: k.cls, sig: k.sig, M: k.M, dets: k.dets.map((t) => ({ l: t.l, m: t.m, dbm: t.dbm, snr: t.snr, hand: t.hand, dir: t.dir })) })) })),
  };
}
self.onmessage = (ev) => {
  const q = ev.data;
  try {
    if (q.cmd === 'inspect') {
      const t0 = Date.now();
      const res = R.inspect(q.sc, q.em, q.set, (c) => {
        const s = slimCap(c), tr = [];
        for (const b of s.bands) if (b.disp) tr.push(b.disp.buffer);
        self.postMessage({ type: 'cap', id: q.id, cap: s }, tr);
      });
      self.postMessage({ type: 'done', id: q.id, ms: Date.now() - t0,
        pts: res.pts.map((p) => ({ p: p.p, ncap: p.ncap, rms: p.rms, dbm: p.dbm, hand: p.hand, band: p.band, cls: p.cls, kind: p.kind, ko: p.ko, what: p.what || '',
          hit: p.hit, expect: p.expect, polflip: p.polflip, rays: p.rays.map((r) => ({ o: r.o, d: r.d, cap: r.cap })) })),
        truth: res.truth, falseAlarms: res.falseAlarms, dropped: res.dropped, nrays: res.rays.length });
    } else if (q.cmd === 'check') {
      for (const sc of q.scenes) {
        const t0 = Date.now(), res = R.inspect(sc, q.em, q.set);
        self.postMessage({ type: 'chk', id: q.id, sc: sc.id, name: sc.short, ms: Date.now() - t0, truth: res.truth, falseAlarms: res.falseAlarms,
          npts: res.pts.length, ghosts: res.pts.filter((p) => p.kind === 'ghost').length, flips: res.pts.filter((p) => p.polflip).length });
      }
      self.postMessage({ type: 'chkdone', id: q.id });
    }
  } catch (e) {
    self.postMessage({ type: 'err', id: q.id, error: String(e && e.stack || e) });
  }
};
