/* radiocam_core.js — 전파 카메라(몰래카메라·도청기 찾기) 모의의 물리 계산(2026-10-05). 브라우저·웹 워커·Node 에서 같이 돈다.
 *   VLBI·전파 간섭계의 방법을 손에 드는 위상 배열에 그대로 옮긴다.
 *   ① 전파: 숨긴 기기 → 방 안 전파. 직접파 + 1·2차 반사(영상법, 벽·거울·타일의 진폭 반사 Γ), 칸막이 투과 τ, 자유공간 손실 λ/(4πL)
 *   ② 수신: 배열 소자마다 복소 진폭(정확한 거리 — 근거리 그대로) · 소자 방향성(패치 5 dBi) · 이중 원편파(오른·왼)
 *      같은 기기의 여러 경로는 띠폭 B 안에서 sinc(B·Δτ) 만큼 서로 맞물린다(Wi-Fi OFDM 20 MHz)
 *   ③ 상관: 소자 쌍 교차상관 V_ij = <x_i x_j*>(VLBI 가시도와 같다). 적분 표본 M = B·T 의 추정 잡음 √(R_ii R_jj / M)
 *      간헐 송출(비콘)은 '버스트 동기 적분'으로 켜진 때만 쌓는다(펄서 게이팅) — 신호는 그대로, 표본만 B·T·duty
 *   ④ 영상: 같은 간격(Δ)의 쌍을 모아(중복 기선 합치기) 2차원 FFT → 방향 코사인(l, m) 더티 영상 · 점 퍼짐(PSF) · Högbom CLEAN
 *   ⑤ 위치: 점검원이 돌며 찍은 여러 자세의 방향 광선을 3차원으로 모아(복셀 투표 → 최소제곱) 점으로 맞춘다 — 지구 자전 합성처럼 위치를 바꿔 넓힌다
 *   ⑥ 가르기: 방 밖(벽·거울 뒤)에 맺힌 점 = 반사 허상 · 편파가 뒤집히면 홀수 번 반사 · 등록 기기(공유기 등)와 대조
 *   한계(화면 '물리' 탭에 밝힌다): 가구 산란·회절 없음 · 칸막이는 투과만 · 영상은 원거리 근사(+ 2.5 m 초점 보정) · 녹화만 하는(송출 없는) 카메라는 못 찾는다
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RCCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const C = 299792458, KB = 1.380649e-23, T0 = 290;
  const BANDS = { 2.4: { f: 2.437e9, ch: '2.4 GHz · 6채널' }, 5.8: { f: 5.785e9, ch: '5.8 GHz · 157채널' } };
  const D_EL = C / 5.785e9 / 2;                       // 소자 간격 2.59 cm(5.8 GHz 의 λ/2) — 2.4 GHz 에서는 0.21 λ
  const GEL = Math.pow(10, 5 / 10);                   // 패치 소자 이득 5 dBi
  const NFFT = 128;                                  // 영상 격자(방향 코사인) — 5.8 GHz 한 칸 0.9° · 2.4 GHz 2.1°(빔폭 7~34° 에 비해 충분)
  const DEF = { n: 8, T: 1.0, B: 20e6, nf: 6, gate: true, ptx: 0, order: 2, focus: 2.5, bands: [2.4, 5.8], hfov: 66, vfov: 52, seed: 1,
    dyn: 0.025,                                      // 봉우리 대비 −16 dB 아래는 버린다(소자 교정 오차·근거리 초점 어긋남 수준 — 실제 기기의 동적 범위)
    verify: 0.5 };                                   // 재투영 검증 — 점이 보여야 할 자세 가운데 실제로 검출된 비율

  // ───────── 난수(재현) ─────────
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    u.gauss = () => {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
      const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f;
    };
    return u;
  }

  // ───────── 벡터 ─────────
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const dbm2w = (d) => Math.pow(10, d / 10) / 1000;
  const w2dbm = (w) => 10 * Math.log10(Math.max(w, 1e-30) * 1000);

  // ───────── 방 기하 ─────────
  const AX = { x: 0, y: 1, z: 2 };
  function faces(sc) {
    const { W, H, D } = sc.room, L = [W, H, D], fs = [];
    for (const nm of ['x0', 'x1', 'y0', 'y1', 'z0', 'z1']) {
      const ax = AX[nm[0]], val = nm[1] === '0' ? 0 : L[ax];
      fs.push({ name: nm, ax, val, mat: sc.faces[nm] });
    }
    return fs;
  }
  function inBox(sc, p, m) {
    const { W, H, D } = sc.room; m = m || 0;
    return p[0] > -m && p[0] < W + m && p[1] > -m && p[1] < H + m && p[2] > -m && p[2] < D + m;
  }
  function reflect(p, f) { const q = p.slice(); q[f.ax] = 2 * f.val - q[f.ax]; return q; }
  function planeHit(a, b, ax, val) {                 // 선분 a→b 와 평면(ax = val)
    const den = b[ax] - a[ax]; if (Math.abs(den) < 1e-12) return null;
    const t = (val - a[ax]) / den; if (t <= 1e-9 || t >= 1 - 1e-9) return null;
    return { t, q: add(a, mul(sub(b, a), t)) };
  }
  function onFace(sc, q, f) {
    const { W, H, D } = sc.room, L = [W, H, D], e = 1e-6;
    for (let i = 0; i < 3; i++) if (i !== f.ax && (q[i] < -e || q[i] > L[i] + e)) return false;
    return true;
  }
  function mirrorAt(sc, q, f) {                      // 그 자리에 거울·화이트보드·Low-E 창이 있나
    for (const m of sc.mirrors || []) {
      if (m.face !== f.name) continue;
      const c = m.c;
      if (f.ax === 0) { if (Math.abs(q[1] - c[1]) <= m.h / 2 && Math.abs(q[2] - c[2]) <= m.w / 2) return m; }
      else if (f.ax === 2) { if (Math.abs(q[0] - c[0]) <= m.w / 2 && Math.abs(q[1] - c[1]) <= m.h / 2) return m; }
      else if (Math.abs(q[0] - c[0]) <= m.w / 2 && Math.abs(q[2] - c[2]) <= m.h / 2) return m;
    }
    return null;
  }
  function gammaAt(sc, em, q, f, bi) {
    const mi = mirrorAt(sc, q, f), mat = mi ? mi.mat : f.mat;
    return { g: em[mat].g[bi], mat, mirror: mi ? mi.name : null };
  }
  function tauSeg(sc, em, a, b, bi) {                // 선분이 지나는 칸막이의 투과 곱
    let tau = 1;
    for (const p of sc.partitions || []) {
      const mn = p.min, mx = p.max;
      let ax = -1; for (let i = 0; i < 3; i++) if (Math.abs(mx[i] - mn[i]) < 1e-9) ax = i;
      if (ax < 0) continue;
      const h = planeHit(a, b, ax, mn[ax]); if (!h) continue;
      const q = h.q; let inside = true;
      for (let i = 0; i < 3; i++) if (i !== ax && (q[i] < mn[i] - 1e-9 || q[i] > mx[i] + 1e-9)) inside = false;
      if (!inside) continue;
      if (p.door && ax === 2 && q[0] > p.door[0] && q[0] < p.door[1] && q[1] < 2.1) continue;   // 열린 문틀
      tau *= em[p.mat].t[bi];
    }
    return tau;
  }

  /** 기기 src → 받는 점 rcv 의 경로들(영상법). 각 경로: 영상점 img · 꺾이는 점 pts · 반사 진폭 coef(부호 포함) · 투과 tau · 차수 order */
  function paths(sc, em, src, rcv, band, order) {
    const bi = band > 4 ? 1 : 0, fs = faces(sc), out = [];
    out.push({ order: 0, img: src, pts: [src, rcv], coef: 1, tau: tauSeg(sc, em, src, rcv, bi), via: [] });
    if (order >= 1) for (const f of fs) {
      const img = reflect(src, f), h = planeHit(rcv, img, f.ax, f.val);
      if (!h || !onFace(sc, h.q, f)) continue;
      const g = gammaAt(sc, em, h.q, f, bi);
      out.push({ order: 1, img, pts: [src, h.q, rcv], coef: -g.g, tau: tauSeg(sc, em, src, h.q, bi) * tauSeg(sc, em, h.q, rcv, bi), via: [g.mirror || f.name] });
    }
    if (order >= 2) for (const f1 of fs) for (const f2 of fs) {
      if (f1 === f2) continue;
      const i1 = reflect(src, f1), i2 = reflect(i1, f2);
      const h2 = planeHit(rcv, i2, f2.ax, f2.val); if (!h2 || !onFace(sc, h2.q, f2)) continue;
      const h1 = planeHit(h2.q, i1, f1.ax, f1.val); if (!h1 || !onFace(sc, h1.q, f1)) continue;
      const g1 = gammaAt(sc, em, h1.q, f1, bi), g2 = gammaAt(sc, em, h2.q, f2, bi);
      out.push({ order: 2, img: i2, pts: [src, h1.q, h2.q, rcv], coef: g1.g * g2.g,
        tau: tauSeg(sc, em, src, h1.q, bi) * tauSeg(sc, em, h1.q, h2.q, bi) * tauSeg(sc, em, h2.q, rcv, bi), via: [g1.mirror || f1.name, g2.mirror || f2.name] });
    }
    return out;
  }

  // ───────── 점검 기기 자세 ─────────
  function pose(cap) {
    const f = unit(sub(cap.look, cap.pos));
    let r = cross(f, [0, 1, 0]); if (norm(r) < 1e-6) r = [1, 0, 0]; r = unit(r);
    const u = cross(r, f);
    return { o: cap.pos, f, r, u };                   // 소자 평면 = (r, u) · 앞 = f(카메라와 같은 쪽)
  }
  function elements(n) {
    const out = [];
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++)
      out.push({ ix, iy, x: (ix - (n - 1) / 2) * D_EL, y: (iy - (n - 1) / 2) * D_EL });
    return out;
  }
  const elWorld = (P, e) => add(P.o, add(mul(P.r, e.x), mul(P.u, e.y)));
  function dirWorld(P, l, m) { const nn = Math.sqrt(Math.max(0, 1 - l * l - m * m)); return unit(add(add(mul(P.r, l), mul(P.u, m)), mul(P.f, nn))); }

  // ───────── 공분산(신호 + 잡음) ─────────
  /** 기기 하나의 오른·왼 원편파 공분산 K×K(복소, re/im 따로) */
  function devCov(sc, em, dev, P, els, set, band) {
    const lam = C / BANDS[band].f, k = 2 * Math.PI / lam, K = els.length;
    const ps = paths(sc, em, dev.pos, P.o, band, set.order), NP = ps.length;
    const pt = dbm2w(dev.ptx_dbm + (set.ptx || 0)), sp = Math.sqrt(pt);
    const e = dev.pol || 0, fR = (1 + e) / 2, fL = (1 - e) / 2;
    const Lc = ps.map((p) => norm(sub(P.o, p.img)));
    const rho = new Float64Array(NP * NP);
    for (let p = 0; p < NP; p++) for (let q = 0; q < NP; q++) rho[p * NP + q] = sinc(set.B * (Lc[p] - Lc[q]) / C);
    const out = {};
    for (const ch of ['R', 'L']) {
      const Gr = new Float64Array(K * NP), Gi = new Float64Array(K * NP);
      const ew = els.map((e) => elWorld(P, e));
      for (let pi = 0; pi < NP; pi++) {
        const p = ps[pi], odd = p.order % 2 === 1;
        const pf = Math.sqrt(ch === 'R' ? (odd ? fL : fR) : (odd ? fR : fL));
        const base = sp * p.coef * p.tau * pf;
        if (base === 0) continue;
        for (let kk = 0; kk < K; kk++) {
          const v = sub(p.img, ew[kk]), L = norm(v);
          const ct = dot(v, P.f) / L, ge = Math.sqrt(GEL) * (ct > 0 ? Math.pow(ct, 0.7) : 0.056);   // 뒤쪽 −25 dB(휴대폰 몸체·접지판)
          const a = base * ge * lam / (4 * Math.PI * L), ph = -k * L;
          Gr[kk * NP + pi] = a * Math.cos(ph); Gi[kk * NP + pi] = a * Math.sin(ph);
        }
      }
      // A = G ρ (K×P) → R = A G^H
      const Ar = new Float64Array(K * NP), Ai = new Float64Array(K * NP);
      for (let kk = 0; kk < K; kk++) for (let q = 0; q < NP; q++) {
        let sr = 0, si = 0;
        for (let p = 0; p < NP; p++) { const w = rho[p * NP + q]; sr += Gr[kk * NP + p] * w; si += Gi[kk * NP + p] * w; }
        Ar[kk * NP + q] = sr; Ai[kk * NP + q] = si;
      }
      const Rr = new Float64Array(K * K), Ri = new Float64Array(K * K);
      for (let i = 0; i < K; i++) for (let j = i; j < K; j++) {
        let sr = 0, si = 0;
        for (let q = 0; q < NP; q++) {                   // A_iq · conj(G_jq)
          const ar = Ar[i * NP + q], ai = Ai[i * NP + q], gr = Gr[j * NP + q], gi = Gi[j * NP + q];
          sr += ar * gr + ai * gi; si += ai * gr - ar * gi;
        }
        Rr[i * K + j] = sr; Ri[i * K + j] = si; Rr[j * K + i] = sr; Ri[j * K + i] = -si;
      }
      out[ch] = { Rr, Ri };
    }
    out.paths = ps;
    return out;
  }

  // ───────── FFT(2의 거듭제곱) ─────────
  function fft1(re, im, n, sign) {
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = sign * 2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  function fft2(re, im, n, sign) {
    const rr = new Float64Array(n), ri = new Float64Array(n);
    for (let y = 0; y < n; y++) { for (let x = 0; x < n; x++) { rr[x] = re[y * n + x]; ri[x] = im[y * n + x]; } fft1(rr, ri, n, sign); for (let x = 0; x < n; x++) { re[y * n + x] = rr[x]; im[y * n + x] = ri[x]; } }
    for (let x = 0; x < n; x++) { for (let y = 0; y < n; y++) { rr[y] = re[y * n + x]; ri[y] = im[y * n + x]; } fft1(rr, ri, n, sign); for (let y = 0; y < n; y++) { re[y * n + x] = rr[y]; im[y * n + x] = ri[y]; } }
  }

  /** 가시도(쌍) → 같은 간격끼리 모아 FFT → 실수 영상(N×N, 가운데 = 정면). 단위 = 소자 하나 받은 전력(W) */
  function imageFromVis(Vr, Vi, els, n, lam, focus, pairsOut) {
    const N = NFFT, re = new Float64Array(N * N), im = new Float64Array(N * N), K = els.length, k = 2 * Math.PI / lam;
    let np = 0;
    for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) {
      let vr = Vr[i * K + j], vi = Vi[i * K + j];
      if (focus > 0) {                                   // 프레넬 초점(거리 focus) — e^{+jk(|ρi|²−|ρj|²)/(2R)}
        const ph = k * ((els[i].x * els[i].x + els[i].y * els[i].y) - (els[j].x * els[j].x + els[j].y * els[j].y)) / (2 * focus);
        const c = Math.cos(ph), s = Math.sin(ph), t = vr * c - vi * s; vi = vr * s + vi * c; vr = t;
      }
      const dx = els[j].ix - els[i].ix, dy = els[j].iy - els[i].iy;
      const a = ((dy % N) + N) % N * N + ((dx % N) + N) % N, b = ((-dy % N) + N) % N * N + ((-dx % N) + N) % N;
      re[a] += vr; im[a] += vi; re[b] += vr; im[b] -= vi; np += 2;
    }
    fft2(re, im, N, +1);
    const out = new Float32Array(N * N), h = N / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[((y + h) % N) * N + ((x + h) % N)] = re[y * N + x] / np;
    if (pairsOut) pairsOut.np = np;
    return out;
  }
  const PSF = {};
  function psf(n, lam) {
    const key = n + ':' + lam.toFixed(5); if (PSF[key]) return PSF[key];
    const els = elements(n), K = els.length, Vr = new Float64Array(K * K), Vi = new Float64Array(K * K);
    for (let i = 0; i < K * K; i++) Vr[i] = 1;
    const im = imageFromVis(Vr, Vi, els, n, lam, 0), c = (NFFT / 2) * NFFT + NFFT / 2, pk = im[c];
    for (let i = 0; i < im.length; i++) im[i] /= pk;
    return (PSF[key] = im);
  }
  const lstep = (lam) => lam / (NFFT * D_EL);         // 영상 한 칸의 방향 코사인
  const beamwidth = (n, lam) => lam / (n * D_EL);     // λ/D(라디안 근사)

  /** Högbom CLEAN — 앞쪽 반구(|l,m| < 0.95)에서 봉우리를 PSF 로 빼며 성분을 모은다 */
  function clean(img, P0, lam, opt) {
    const N = NFFT, h = N / 2, ls = lstep(lam), res = Float32Array.from(img), comps = [];
    const mask = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const l = (x - h) * ls, m = (y - h) * ls; if (l * l + m * m < 0.95 * 0.95) mask[y * N + x] = 1; }
    const vals = []; for (let i = 0; i < N * N; i++) if (mask[i]) vals.push(Math.abs(res[i]));
    vals.sort((a, b) => a - b);
    const sig0 = 1.4826 * vals[vals.length >> 1] || 1e-30;
    let peak0 = 0; for (let i = 0; i < N * N; i++) if (mask[i] && res[i] > peak0) peak0 = res[i];
    const thr = Math.max(opt.nsig * sig0, peak0 * opt.dyn);
    for (let it = 0; it < opt.maxit; it++) {
      let bi = -1, bv = -Infinity;
      for (let i = 0; i < N * N; i++) if (mask[i] && res[i] > bv) { bv = res[i]; bi = i; }
      if (bv < thr) break;
      const by = (bi / N) | 0, bx = bi % N, g = opt.gain * bv;
      comps.push({ x: bx, y: by, f: g });
      for (let y = 0; y < N; y++) { const py = ((y - by + h) % N + N) % N; for (let x = 0; x < N; x++) { const px = ((x - bx + h) % N + N) % N; res[y * N + x] -= g * P0[py * N + px]; } }
    }
    return { comps, res, sig0, thr, peak0 };
  }
  /** CLEAN 성분 → 빔 하나 안의 것을 묶어 검출(가중 중심) */
  function detections(cl, lam, n, minFlux) {
    const N = NFFT, h = N / 2, ls = lstep(lam), bw = beamwidth(n, lam), cs = cl.comps.map((c) => ({ l: (c.x - h) * ls, m: (c.y - h) * ls, f: c.f })), used = new Uint8Array(cs.length), out = [];
    const order = cs.map((_, i) => i).sort((a, b) => cs[b].f - cs[a].f);
    for (const i of order) {
      if (used[i]) continue;
      let sf = 0, sl = 0, sm = 0;
      for (let j = 0; j < cs.length; j++) {
        if (used[j]) continue;
        if (Math.hypot(cs[j].l - cs[i].l, cs[j].m - cs[i].m) < 0.6 * bw) { used[j] = 1; sf += cs[j].f; sl += cs[j].f * cs[j].l; sm += cs[j].f * cs[j].m; }
      }
      if (sf >= minFlux) out.push({ l: sl / sf, m: sm / sf, flux: sf });
    }
    return out;
  }
  function restore(cl, lam, n, rw) {                 // 화면용 — CLEAN 성분을 빔(가우스)으로 그린 모형 + 잔차(양수만, rw 배)
    const N = NFFT, h = N / 2, ls = lstep(lam), sb = beamwidth(n, lam) / 2.355 / ls, R = Math.ceil(3 * sb), out = new Float32Array(N * N);
    const w = rw == null ? 1 : rw;
    for (let i = 0; i < N * N; i++) out[i] = w * Math.max(0, cl.res[i]);
    for (const c of cl.comps) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = c.x + dx, y = c.y + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue;
      out[y * N + x] += c.f * Math.exp(-(dx * dx + dy * dy) / (2 * sb * sb));
    }
    return out;
  }
  const sampleImg = (img, lam, l, m) => { const N = NFFT, h = N / 2, ls = lstep(lam); const x = Math.round(l / ls + h), y = Math.round(m / ls + h); return x >= 0 && y >= 0 && x < N && y < N ? img[y * N + x] : 0; };

  /** 자세 하나에서 띠마다 관측 → 상관 → 영상 → CLEAN → 검출. gate 면 기기마다(버스트 시각으로 가른) 따로 */
  function capture(sc, em, cap, setIn, ci) {
    const set = Object.assign({}, DEF, setIn), R = rng((set.seed * 7919 + (ci || 0) * 104729) >>> 0);
    const P = pose(cap), els = elements(set.n), K = els.length, out = { ci, pose: P, bands: [] };
    const devs = sc.devices.filter((d) => d.on !== false);
    const sn = KB * T0 * set.B * Math.pow(10, set.nf / 10);
    for (const band of set.bands) {
      const lam = C / BANDS[band].f, bd = devs.filter((d) => d.band === band);
      if (!bd.length) { out.bands.push({ band, classes: [], disp: null }); continue; }
      const covs = bd.map((d) => ({ d, c: devCov(sc, em, d, P, els, set, band) }));
      const classes = set.gate ? covs.map((x) => [x]) : [covs];
      const P0 = psf(set.n, lam), bandOut = { band, lam, classes: [], disp: null };
      let disp = null;
      for (const cls of classes) {
        const imgs = {};
        let M = set.B * set.T;
        if (set.gate) M *= Math.max(cls[0].d.duty, 1e-4);
        for (const ch of ['R', 'L']) {
          const Rr = new Float64Array(K * K), Ri = new Float64Array(K * K);
          for (const x of cls) { const w = set.gate ? 1 : x.d.duty, c = x.c[ch]; for (let i = 0; i < K * K; i++) { Rr[i] += w * c.Rr[i]; Ri[i] += w * c.Ri[i]; } }
          for (let i = 0; i < K; i++) Rr[i * K + i] += sn;
          for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) {          // 상관 추정 잡음 √(R_ii R_jj / M)
            const s = Math.sqrt(Rr[i * K + i] * Rr[j * K + j] / M / 2);
            Rr[i * K + j] += s * R.gauss(); Ri[i * K + j] += s * R.gauss();
          }
          imgs[ch] = imageFromVis(Rr, Ri, els, set.n, lam, set.focus);
        }
        const S = new Float32Array(imgs.R.length); for (let i = 0; i < S.length; i++) S[i] = imgs.R[i] + imgs.L[i];
        const cl = clean(S, P0, lam, { gain: 0.25, nsig: 5, dyn: set.dyn, maxit: 250 });
        const dets = detections(cl, lam, set.n, 5 * cl.sig0).map((t) => {
          const r = sampleImg(imgs.R, lam, t.l, t.m), l = sampleImg(imgs.L, lam, t.l, t.m);
          return Object.assign(t, { snr: t.flux / cl.sig0, dbm: w2dbm(t.flux), hand: (r + l) !== 0 ? (r - l) / Math.abs(r + l) : 0, dir: dirWorld(P, t.l, t.m) });
        }).filter((t) => t.l * t.l + t.m * t.m < 0.9);
        const rest = restore(cl, lam, set.n, 0.3);
        if (!disp) disp = new Float32Array(rest.length);
        for (let i = 0; i < rest.length; i++) disp[i] += Math.max(0, rest[i]);
        bandOut.classes.push({ cls: set.gate ? cls[0].d.id : 'all', dets, sig: cl.sig0, M, ncomp: cl.comps.length });
      }
      bandOut.sig = sn;
      bandOut.disp = disp; bandOut.lstep = lstep(lam);
      out.bands.push(bandOut);
    }
    return out;
  }

  // ───────── 여러 자세 → 3차원 점(광선 쌍 최근접점 모으기 → 최소제곱) ─────────
  /** 다른 자세에서 나온 두 광선이 가까이 지나는 자리(최근접점 가운데)를 모아, 가장 붐비는 곳부터 점으로 맞춘다.
   *  점 = 그 자리를 지나는 광선들(자세마다 하나)에 대한 수직 거리 제곱합 최소. 자세 셋 이상이 지나야 점으로 친다. */
  function solveRays(sc, rays, opt) {
    opt = Object.assign({ gate: 0.22, minCaps: 3, tmin: 0.2, tmax: 14, rad: 0.3 }, opt || {});
    const W = (r) => 1 + Math.log10(Math.max(r.snr, 1)), mids = [];
    for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
      const r1 = rays[i], r2 = rays[j]; if (r1.cap === r2.cap) continue;
      const b = dot(r1.d, r2.d), den = 1 - b * b; if (den < 1e-3) continue;      // 거의 나란하면 교점이 불안정
      const w0 = sub(r1.o, r2.o), d = dot(r1.d, w0), e = dot(r2.d, w0);
      const t = (b * e - d) / den, u = (e - b * d) / den;
      if (t < opt.tmin || u < opt.tmin || t > opt.tmax || u > opt.tmax) continue;
      const p1 = add(r1.o, mul(r1.d, t)), p2 = add(r2.o, mul(r2.d, u)), dist = norm(sub(p1, p2));
      if (dist < opt.gate + 0.015 * (t + u) / 2) mids.push({ p: mul(add(p1, p2), 0.5), w: W(r1) * W(r2), i, j });
    }
    const pts = [], alive = mids.map(() => true), taken = new Uint8Array(rays.length);   // 광선 하나는 한 점에만(배타 배정 — 강한 점이 먼저)
    const free = (k) => alive[k] && !taken[mids[k].i] && !taken[mids[k].j];
    for (let guard = 0; guard < 40; guard++) {
      let bi = -1, bd = 0;                             // 가장 붐비는 최근접점
      for (let i = 0; i < mids.length; i++) {
        if (!free(i)) continue; let s = 0;
        for (let j = 0; j < mids.length; j++) if (free(j) && norm(sub(mids[i].p, mids[j].p)) < opt.rad) s += mids[j].w;
        if (s > bd) { bd = s; bi = i; }
      }
      if (bi < 0) break;
      let p = mids[bi].p, used = [];
      for (const gate of [0.35, 0.22, 0.15]) {
        const best = {};                               // 자세마다 가장 가까운 광선 하나
        for (let ri = 0; ri < rays.length; ri++) {
          if (taken[ri]) continue;
          const r = rays[ri], v = sub(p, r.o), t = dot(v, r.d); if (t < opt.tmin) continue;
          const dp = norm(sub(v, mul(r.d, t))), tol = gate + 0.01 * t;
          if (dp < tol && (!best[r.cap] || dp < best[r.cap].dp)) best[r.cap] = { r, dp, ri };
        }
        used = Object.values(best).map((x) => x.r); var usedIdx = Object.values(best).map((x) => x.ri);
        if (used.length < 2) break;
        const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], bb = [0, 0, 0];
        for (const r of used) {
          const w = W(r), d = r.d;
          const M = [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2], -d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2], -d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]];
          for (let q = 0; q < 9; q++) A[q] += w * M[q];
          for (let q = 0; q < 3; q++) bb[q] += w * (M[q * 3] * r.o[0] + M[q * 3 + 1] * r.o[1] + M[q * 3 + 2] * r.o[2]);
        }
        const sol = solve3(A, bb); if (sol) p = sol;
      }
      for (let j = 0; j < mids.length; j++) if (alive[j] && norm(sub(mids[j].p, p)) < opt.rad + 0.05) alive[j] = false;
      alive[bi] = false;
      if (used.length < opt.minCaps) continue;
      if (pts.some((q) => norm(sub(q.p, p)) < 0.3)) continue;
      for (const ri of usedIdx) taken[ri] = 1;
      const rms = Math.sqrt(used.reduce((s2, r) => { const v = sub(p, r.o), t = dot(v, r.d); return s2 + Math.pow(norm(sub(v, mul(r.d, t))), 2); }, 0) / used.length);
      pts.push({ p, ncap: used.length, rays: used, rms, dbm: Math.max(...used.map((r) => r.dbm)), hand: used.reduce((s2, r) => s2 + r.hand, 0) / used.length, band: used[0].band, cls: used[0].cls });
    }
    return pts;
  }
  function solve3(A, b) {
    const a = A, det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (Math.abs(det) < 1e-9) return null;
    const inv = [a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4], a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5], a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]];
    return [0, 1, 2].map((r) => (inv[r * 3] * b[0] + inv[r * 3 + 1] * b[1] + inv[r * 3 + 2] * b[2]) / det);
  }

  /** 점 하나 가르기 — 방 안(의심·등록) · 방 밖(거울·벽 뒤 허상) */
  function classify(sc, pt) {
    const { W, H, D } = sc.room, p = pt.p, m = 0.3;   // 벽면 30 cm 안 = 벽에 붙은 기기(벽에 붙으면 거울상이 자기와 겹치고 삼각측량 오차로 벽 너머에 맺힐 수 있다)
    if (inBox(sc, p, m)) {
      let best = null;
      for (const d of sc.devices) if (d.legit) { const dd = norm(sub(d.pos, p)); if (dd < 0.45 && (!best || dd < best.dd)) best = { d, dd }; }
      return best ? { kind: 'legit', ko: '등록 기기', what: best.d.name } : { kind: 'suspect', ko: '의심 기기' };
    }
    const fs = faces(sc);
    for (const f of fs) {
      const outside = f.val === 0 ? p[f.ax] < -m : p[f.ax] > f.val + m;
      if (!outside) continue;
      const q = p.slice(); q[f.ax] = f.val;               // 그 면으로 내린 자리
      for (const mi of sc.mirrors || []) {
        if (mi.face !== f.name) continue;
        const ex = Object.assign({}, mi, { w: mi.w + 0.6, h: mi.h + 0.6 });
        if (mirrorAt({ mirrors: [ex] }, q, f)) return { kind: 'ghost', ko: '반사 허상', what: mi.name + ' 뒤' };
      }
      return { kind: 'ghost', ko: '반사 허상', what: ({ x0: '왼쪽 벽', x1: '오른쪽 벽', y0: '바닥', y1: '천장', z0: '안쪽 벽', z1: '앞쪽 벽' })[f.name] + ' 뒤' };
    }
    return { kind: 'ghost', ko: '반사 허상', what: '방 밖' };
  }

  /** 점검 한 판 — 자세들 → 검출 광선 → 3차원 점 → 가르기 → 정답 대조 */
  function inspect(sc, em, setIn, onCap) {
    const set = Object.assign({}, DEF, setIn), caps = [], rays = [];
    sc.captures.forEach((cap, ci) => {
      const r = capture(sc, em, cap, set, ci); caps.push(r);
      for (const b of r.bands) for (const c of b.classes) for (const t of c.dets) rays.push({ o: r.pose.o, d: t.dir, snr: t.snr, dbm: t.dbm, hand: t.hand, cap: ci, band: b.band, cls: c.cls });
      if (onCap) onCap(r, ci);
    });
    const groups = {};
    for (const r of rays) { const g = set.gate ? r.band + ':' + r.cls : String(r.band); (groups[g] = groups[g] || []).push(r); }
    let pts = [], dropped = 0;
    for (const g in groups) pts = pts.concat(solveRays(sc, groups[g], { minCaps: 3 }));
    // 재투영 검증 — 점이 앞쪽 시야(|l,m| < 0.85)에 드는 자세에서, 같은 띠·갈래의 검출이 그 방향 가까이(빔폭 0.6 배·최소 4°) 있었나
    for (const p of pts) {
      let exp = 0, hit = 0;
      for (const c of caps) {
        const P = c.pose, v = sub(p.p, P.o), L = norm(v); if (L < 0.2 || dot(v, P.f) <= 0) continue;
        const u = mul(v, 1 / L), l = dot(u, P.r), m = dot(u, P.u); if (l * l + m * m > 0.72) continue;
        const b = c.bands.find((x) => x.band === p.band); if (!b || !b.lam) continue;
        exp++;
        const tol = Math.max(0.6 * beamwidth(set.n, b.lam), 4 * Math.PI / 180);
        const ok = b.classes.some((k) => (!set.gate || k.cls === p.cls) && k.dets.some((t) => Math.acos(Math.min(1, dot(t.dir, u))) < tol));
        if (ok) hit++;
      }
      p.expect = exp; p.hit = hit; p.ratio = exp ? hit / exp : 0;
    }
    const keep = pts.filter((p) => p.hit >= 3 && p.ratio >= set.verify); dropped = pts.length - keep.length; pts = keep;
    for (const p of pts) Object.assign(p, classify(sc, p));
    // 버스트 동기면 갈래 하나 = 송신기 하나 — 방 안 점은 가장 잘 받쳐진 하나만 기기, 나머지는 같은 기기의 다중경로(허상)
    if (set.gate) {
      const by = {};
      for (const p of pts) if (p.kind !== 'ghost') (by[p.band + ':' + p.cls] = by[p.band + ':' + p.cls] || []).push(p);
      for (const k in by) {
        const g = by[k].sort((a, b) => (b.ncap * b.ratio - a.ncap * a.ratio) || (b.dbm - a.dbm));
        for (const p of g.slice(1)) Object.assign(p, { kind: 'ghost', ko: '반사 허상', what: '같은 기기의 다중경로' });
      }
    }
    // 같은 기기(버스트 갈래)의 방 안 점 편파를 기준으로 허상의 편파 뒤집힘을 본다
    for (const p of pts) if (p.kind === 'ghost') {
      const ref = pts.find((q) => q.kind !== 'ghost' && q.band === p.band && q.cls === p.cls);
      p.polflip = ref && Math.abs(ref.hand) > 0.15 && Math.abs(p.hand) > 0.15 ? (Math.sign(ref.hand) !== Math.sign(p.hand)) : null;
    }
    const truth = sc.devices.filter((d) => d.on !== false && set.bands.includes(d.band)).map((d) => {
      const near = pts.filter((p) => p.kind !== 'ghost' && p.band === d.band && (!set.gate || p.cls === d.id)).map((p) => ({ p, e: norm(sub(p.p, d.pos)) })).sort((a, b) => a.e - b.e)[0];
      return { id: d.id, name: d.name, legit: !!d.legit, found: !!(near && near.e < 0.5), err: near ? near.e : null };
    });
    const on = sc.devices.filter((d) => d.on !== false && set.bands.includes(d.band));
    const fa = pts.filter((p) => p.kind !== 'ghost' && !on.some((d) => d.band === p.band && norm(sub(d.pos, p.p)) < 0.5));
    return { caps, rays, pts, truth, falseAlarms: fa.length, dropped, set };
  }

  // ───────── 링크 예산 · 감지 거리 · 세기 지도 ─────────
  function link(dev, dist, setIn) {
    const set = Object.assign({}, DEF, setIn), lam = C / BANDS[dev.band].f, K = set.n * set.n, np = K * (K - 1);
    const prx = dbm2w(dev.ptx_dbm + (set.ptx || 0)) * GEL * Math.pow(lam / (4 * Math.PI * dist), 2);
    const sn = KB * T0 * set.B * Math.pow(10, set.nf / 10), sig = set.gate ? prx : prx * dev.duty, M = set.B * set.T * (set.gate ? dev.duty : 1);
    const snrImg = sig * Math.sqrt(M * np / 2) / (sig + sn);
    return { prx_dbm: w2dbm(prx), noise_dbm: w2dbm(sn), snr_el_db: 10 * Math.log10(prx / sn), M, snrImg, gain_corr_db: 10 * Math.log10(Math.sqrt(M)) };
  }
  function detectRange(dev, setIn, need) {
    need = need || 5; let lo = 0.1, hi = 2000;
    for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (link(dev, mid, setIn).snrImg >= need) lo = mid; else hi = mid; }
    return lo;
  }
  function coverage(sc, em, dev, y, step) {
    const { W, D } = sc.room, nx = Math.round(W / step), nz = Math.round(D / step), lam = C / BANDS[dev.band].f, pt = dbm2w(dev.ptx_dbm);
    const map = new Float32Array(nx * nz), ex = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const r = [(i + 0.5) * step, y, (k + 0.5) * step];
      let s = 0;
      for (const p of paths(sc, em, dev.pos, r, dev.band, 2)) { const L = Math.max(norm(sub(r, p.img)), 0.05); s += Math.pow(p.coef * p.tau * lam / (4 * Math.PI * L), 2); }
      const w = pt * s;                                   // 등방 안테나가 받는 전력(W, 여러 경로 전력 합)
      map[k * nx + i] = w2dbm(w);
      ex[k * nx + i] = w * 4 * Math.PI / (lam * lam);   // 전력 밀도 S(W/m²) — 기준 10 W/m²(ICNIRP·전자파 인체보호기준 일반인 2~300 GHz)
    }
    return { nx, nz, step, map, ex };
  }

  return { C, BANDS, D_EL, GEL, NFFT, DEF, rng, faces, paths, pose, elements, elWorld, dirWorld, devCov, imageFromVis, psf, clean, detections, restore,
    lstep, beamwidth, capture, solveRays, classify, inspect, link, detectRange, coverage, w2dbm, dbm2w, norm, sub, add, mul, dot, unit };
});
