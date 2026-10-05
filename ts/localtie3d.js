/* localtie3d.js — 연결측량 디지털 트윈 + 토탈스테이션·타겟 관측 모의(2026-10-05 센터장님
 *   "연결측량 정보도 여기에서 볼 수 있게 해 줘. 타겟과 토탈스테이션으로 관측하고 분석하는 시뮬레이션도 여기서 동작하고 볼 수 있게 해 줘.
 *    지금은 VLBI, 위성기준점, 필라들까지 반영, SLR 하지 말고").
 *
 *   장면: 정사영상 지형(models/terrain) · 관측소 건물·필라(models/site_twin.glb, SLR 건물·필라는 숨김) · 실물 안테나(lib/sejong22m.js)
 *         · 연결측량 점(VLBI IVP · 위성기준점 SEJN · 필라 VP01~05)과 IVP → 점 벡터 · σ 타원체(확대).
 *         틀은 디지털 트윈과 같다 — 원점 = IVP 수평 자리, x = 동 · y = 마당 위 높이 · z = −북, m 실척(1 배).
 *   모의(화면 안에서만 — 실제 장비 명령은 없다):
 *     VIP 사용자매뉴얼(국토지리정보원 2026-02) 3.4·5.3·9~10절의 관측 방식을 따른다.
 *       수평 타겟 PH — 고도 90° 에서 방위를 돌리며 관측(타겟마다 수평 원, 원 중심이 방위축 위)
 *       수직 타겟 PV — 방위를 고정(0°·330°)하고 고도를 돌리며 관측(수직 원, 원 중심이 고도축 위)
 *     필라 위 토탈스테이션(후시로 방향 잡기 — 방향 오차·기계점 오차 포함)이 보이는 타겟만 경사거리·수평각·연직각을 잰다.
 *     분석은 '외접원 중심점 계산법'과 같은 기하: 타겟별 3D 원 맞춤 → 방위축(PH 원 법선·중심) · 고도축(PV 원 중심 둘)
 *     → 두 축의 공통 수선 → IVP(방위축 위 점) · 축 오프셋(두 축 사이, 지향 방향 +). 실제 VIP 는 Universal Cone 모델로
 *     모든 관측을 한꺼번에 조정한다(PMINOLESS → 제약 GMM) — 이 모의는 그 기하를 눈으로 보이는 데 목적이 있다.
 *     몬테카를로(같은 설정으로 여러 번)로 IVP·축 오프셋의 흩어짐(σ)을 낸다.
 *   쓰기: const L = LocalTie.create(canvas, {onStatus, onProgress, onResult, onMc});
 *         L.load(data) · L.sim.start(cfg) · pause() · resume() · reset() · L.view('all'|'ant'|'ivp') · L.show({…}) · L.highlight(id)
 */
'use strict';
(function () {
  const D2R = Math.PI / 180, AS = Math.PI / 180 / 3600;

  // ── 작은 선형대수(배열 [x, y, z]) ──
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const n = nrm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  const mean = (P) => { const s = [0, 0, 0]; for (const p of P) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return scl(s, 1 / Math.max(1, P.length)); };

  function eigSym3(A) {                       // 야코비 — 3×3 대칭행렬 고윳값·고유벡터(열)
    const a = A.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 40; it++) {
      let p = 0, q = 1, m = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > m) { p = 0; q = 2; m = Math.abs(a[0][2]); }
      if (Math.abs(a[1][2]) > m) { p = 1; q = 2; m = Math.abs(a[1][2]); }
      if (m < 1e-15) break;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
    const vals = [a[0][0], a[1][1], a[2][2]];
    const vecs = [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]);
    return { vals, vecs };
  }
  function planeFit(P) {
    const c = mean(P), M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of P) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j]; }
    const { vals, vecs } = eigSym3(M); let k = 0; if (vals[1] < vals[k]) k = 1; if (vals[2] < vals[k]) k = 2;
    return { c, n: unit(vecs[k]) };
  }
  // 3D 원 맞춤 — 평면 맞춤 → 평면 위 대수 맞춤(Kasa) → 기하 맞춤(가우스-뉴턴, 짧은 호에서도 치우치지 않게)
  function circleFit3(P) {
    if (P.length < 4) return null;
    const pl = planeFit(P), n = pl.n;
    const e1 = unit(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(n, e1);
    const Q = P.map((p) => { const d = sub(p, pl.c); return [dot(d, e1), dot(d, e2)]; });
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const [x, y] of Q) { const r = [x, y, 1], z = -(x * x + y * y); for (let i = 0; i < 3; i++) { b[i] += r[i] * z; for (let j = 0; j < 3; j++) S[i][j] += r[i] * r[j]; } }
    const sol = solve3(S, b); if (!sol) return null;
    let cx = -sol[0] / 2, cy = -sol[1] / 2, R = Math.sqrt(Math.max(1e-9, cx * cx + cy * cy - sol[2]));
    for (let it = 0; it < 12; it++) {
      const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Jtr = [0, 0, 0];
      for (const [x, y] of Q) {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1e-9, r = d - R, J = [-dx / d, -dy / d, -1];
        for (let i = 0; i < 3; i++) { Jtr[i] += J[i] * r; for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j]; }
      }
      const dlt = solve3(JtJ, Jtr.map((v) => -v)); if (!dlt) break;
      cx += dlt[0]; cy += dlt[1]; R += dlt[2];
      if (Math.hypot(dlt[0], dlt[1], dlt[2]) < 1e-10) break;
    }
    let ss = 0; for (const [x, y] of Q) { const r = Math.hypot(x - cx, y - cy) - R; ss += r * r; }
    const pd = P.map((p) => dot(sub(p, pl.c), n)); let sp = 0; for (const v of pd) sp += v * v;
    return { c: add(pl.c, add(scl(e1, cx), scl(e2, cy))), n, r: R, e1, e2, rms: Math.sqrt(ss / P.length), rmsPlane: Math.sqrt(sp / P.length), np: P.length };
  }
  function solve3(A, b) {
    const m = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-18) return null;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }
  function closest(p0, d, q0, w) {          // 두 직선의 공통 수선 — 각 직선 위 발
    const r = sub(p0, q0), a = dot(d, d), b = dot(d, w), c = dot(w, w), e = dot(d, r), f = dot(w, r), den = a * c - b * b;
    const t = Math.abs(den) < 1e-12 ? 0 : (b * f - c * e) / den, s = Math.abs(den) < 1e-12 ? f / c : (a * f - b * e) / den;
    return { p: add(p0, scl(d, t)), q: add(q0, scl(w, s)) };
  }
  function rngOf(seed) {                      // mulberry32 + 박스-뮬러
    let s = seed >>> 0;
    const u = () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    const g = () => { if (spare !== null) { const v = spare; spare = null; return v; } let a, b, r; do { a = u() * 2 - 1; b = u() * 2 - 1; r = a * a + b * b; } while (r >= 1 || r === 0); const k = Math.sqrt(-2 * Math.log(r) / r); spare = b * k; return a * k; };
    return { u, g };
  }

  // ── 참값 기하 — 타겟 배치는 VIP 매뉴얼 9.6절(슬랜트 높이)·10절(외접원 중심 높이)에서 ──
  //   PH01~04 r 5.01 m · IVP 위 1.83 m(R 5.34) · PH05~07 r 3.88 m · 위 1.83(R 4.29) · PH08·09 r 4.75 · 고도축 높이(R 4.75, 축 오프셋용 쌍)
  //   PH10·11 r 5.12 · 아래 3.13(R 6.01) · PV06·07 고도축 따라 ±3.72 m(외접원 중심 41.35·33.85 대 IVP 37.63) · 고도축에서 1.6 m(추정)
  const PH = [
    { id: 'PH01', r: 5.01, h: 1.83, phi: 45 }, { id: 'PH02', r: 5.01, h: 1.83, phi: 135 }, { id: 'PH03', r: 5.01, h: 1.83, phi: 225 },
    { id: 'PH04', r: 5.01, h: 1.83, phi: 315 }, { id: 'PH05', r: 3.88, h: 1.83, phi: 0 }, { id: 'PH06', r: 3.88, h: 1.83, phi: 120 },
    { id: 'PH07', r: 3.88, h: 1.83, phi: 240 }, { id: 'PH08', r: 4.75, h: 0.0, phi: 90 }, { id: 'PH09', r: 4.75, h: 0.0, phi: 270 },
    { id: 'PH10', r: 5.12, h: -3.13, phi: 30 }, { id: 'PH11', r: 5.12, h: -3.13, phi: 210 },
  ];
  const PV = [{ id: 'PV06', s: 3.72, rho: 1.6, psi: 180 }, { id: 'PV07', s: -3.72, rho: 1.6, psi: 180 }];
  const PH_COL = [0x6fb0ff, 0x58c7ff, 0x48d7f0, 0x3fe0d0, 0x8fd16a, 0xb7d45a, 0xd8c84e, 0xf0a14a, 0xf5874f, 0xe56a9b, 0xc77bf0];

  function basis(A) { const a = A * D2R; return { p: [Math.sin(a), 0, -Math.cos(a)], u: [Math.cos(a), 0, Math.sin(a)] }; }
  function makeGeom(H, eM) {
    const ivp = [0, H, 0];
    return {
      ivp, e: eM,
      ph(t, A) { const { p, u } = basis(A), f = t.phi * D2R; const n = add(scl(p, Math.cos(f)), scl(u, Math.sin(f))); return { pos: add(add(ivp, [0, t.h, 0]), scl(n, t.r)), n }; },
      pv(t, A, E) { const { p, u } = basis(A), g = (E + t.psi) * D2R; const d = add(scl(p, Math.cos(g)), [0, Math.sin(g), 0]);
        return { pos: add(add(add(ivp, scl(p, eM)), scl(u, t.s)), scl(d, t.rho)), n: scl(u, Math.sign(t.s)) }; },
    };
  }

  // 관측 계획 — 자세(방위·고도)마다 모든 기계점이 보이는 타겟을 잰다
  function plan(cfg) {
    const out = [];
    for (let A = 0; A < 360 - 1e-6; A += cfg.phStep) out.push({ A, E: 90, kind: 'PH' });
    for (const A of cfg.pvAz) for (let E = cfg.elMin; E <= 90 + 1e-6; E += cfg.elStep) out.push({ A, E, kind: 'PV' });
    return out;
  }
  function visible(S, T, n, kind) {
    const v = sub(S, T), d = nrm(v), vu = scl(v, 1 / d);
    if (kind === 'PH') { const h = unit([v[0], 0, v[2]]); return dot(h, unit([n[0], 0, n[2]])) > Math.cos(65 * D2R) && Math.abs(vu[1]) < Math.sin(70 * D2R); }
    return dot(vu, n) > Math.cos(70 * D2R);
  }
  // 한 관측: 참 기계점(알려진 자리 + 오차)에서 재고, 알려진 자리로 되돌려 점을 만든다
  function observe(Sk, setup, T, sig, rng) {
    const St = add(Sk, setup.dpos), v = sub(T, St), d = nrm(v);
    const hz = Math.atan2(v[0], -v[2]), z = Math.acos(v[1] / d);
    const dm = d + rng.g() * (sig.d + sig.ppm * 1e-6 * d) + sig.pc;
    const hm = hz + rng.g() * sig.h + setup.orient, zm = z + rng.g() * sig.v;
    const pt = add(Sk, [dm * Math.sin(zm) * Math.sin(hm), dm * Math.cos(zm), -dm * Math.sin(zm) * Math.cos(hm)]);
    return { d: dm, hz: hm, z: zm, pt };
  }
  function makeSetups(stations, sig, rng) {
    const out = {};
    for (const s of stations) out[s.id] = { orient: rng.g() * sig.h, dpos: [rng.g() * sig.st, rng.g() * sig.st, rng.g() * sig.st] };
    return out;
  }
  function runAll(cfg, geom, stations, seed) {   // 애니메이션 없이 한 판 — 몬테카를로용
    const rng = rngOf(seed), setups = makeSetups(stations, cfg.sig, rng), obs = [];
    for (const ps of plan(cfg)) {
      const tg = ps.kind === 'PH' ? PH : PV;
      for (const s of stations) for (const t of tg) {
        const g = ps.kind === 'PH' ? geom.ph(t, ps.A) : geom.pv(t, ps.A, ps.E);
        if (!visible(s.pos, g.pos, g.n, ps.kind)) continue;
        const o = observe(s.pos, setups[s.id], g.pos, cfg.sig, rng);
        obs.push({ kind: ps.kind, id: t.id, A: ps.A, E: ps.E, st: s.id, pt: o.pt });
      }
    }
    return obs;
  }
  // 분석 — 원 맞춤 → 두 축 → IVP·축 오프셋
  function analyze(obs, geom) {
    const byPH = {}, byPV = {};
    for (const o of obs) {
      if (o.kind === 'PH') (byPH[o.id] = byPH[o.id] || []).push(o.pt);
      else { const k = o.id + '@' + o.A; (byPV[k] = byPV[k] || []).push(o.pt); }
    }
    const ph = {}; let nS = [0, 0, 0], wsum = 0; const cs = [];
    for (const id in byPH) {
      const f = circleFit3(byPH[id]); if (!f) continue; ph[id] = f;
      const n = f.n[1] < 0 ? scl(f.n, -1) : f.n; nS = add(nS, scl(n, f.np)); wsum += f.np; cs.push(f.c);
    }
    if (!cs.length) return null;
    const d = unit(nS), p0 = mean(cs);
    const pv = {}, per = [];
    const azs = [...new Set(obs.filter((o) => o.kind === 'PV').map((o) => o.A))];
    for (const A of azs) {
      const cc = [];
      for (const t of PV) { const pts = byPV[t.id + '@' + A]; if (!pts) continue; const f = circleFit3(pts); if (!f) continue; pv[t.id + '@' + A] = f; cc.push({ t, f }); }
      if (!cc.length) continue;
      let q0, w;
      if (cc.length >= 2) { const a = cc.find((x) => x.t.s > 0) || cc[0], b = cc.find((x) => x.t.s < 0) || cc[1]; q0 = scl(add(a.f.c, b.f.c), 0.5); w = unit(sub(a.f.c, b.f.c)); }
      else { q0 = cc[0].f.c; w = cc[0].f.n; }
      const cl = closest(p0, d, q0, w), { p } = basis(A), off = sub(cl.q, cl.p);
      per.push({ A, ivp: cl.p, elPt: cl.q, w, e: dot(off, p), n: cc.length });
    }
    if (!per.length) return { ph, pv, az: { p0, d }, per, ivp: null };
    const ivp = mean(per.map((x) => x.ivp)), e = per.reduce((s, x) => s + x.e, 0) / per.length;
    const rmsOf = (o) => { const v = Object.values(o).map((f) => f.rms); return v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : 0; };
    const dEnu = (x) => [x[0], -x[2], x[1]];
    return { ph, pv, az: { p0, d }, per, ivp, e, diff_mm: scl(dEnu(sub(ivp, geom.ivp)), 1000), e_mm: e * 1000,
             rmsPH_mm: rmsOf(ph) * 1000, rmsPV_mm: rmsOf(pv) * 1000, tilt_as: Math.acos(Math.min(1, d[1])) / AS };
  }

  // ── 장면 ──
  function textSprite(T, txt, color, h) {
    const fs = 44, cv = document.createElement('canvas'), g = cv.getContext('2d');
    g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`;
    const w = Math.ceil(g.measureText(txt).width) + 16; cv.width = w; cv.height = fs + 16;
    g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 8; g.fillStyle = color; g.fillText(txt, 8, cv.height / 2);
    const tx = new T.CanvasTexture(cv); tx.encoding = T.sRGBEncoding;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tx, transparent: true, depthWrite: false, toneMapped: false }));
    sp.scale.set(h * w / cv.height, h, 1); sp.renderOrder = 6; return sp;
  }
  const KCOL = { vlbi: 0xffcf5a, gnss: 0x4fe3c1, pillar: 0x7cb8ff };

  function create(canvas, opts) {
    opts = opts || {};
    const T = window.THREE; if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); rn.outputEncoding = T.sRGBEncoding;
    rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 0.95; rn.shadowMap.enabled = true; rn.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene(); scene.fog = new T.Fog(new T.Color(0x0a1120).convertSRGBToLinear(), 260, 720);
    const cam = new T.PerspectiveCamera(40, 1, 0.1, 2000);
    scene.add(new T.HemisphereLight(0xd8e6ff, 0x26303e, 0.75));
    const sun = new T.DirectionalLight(0xfff1dc, 2.1); sun.position.set(60, 90, 40); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 300 }); sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004; scene.add(sun);
    const rim = new T.DirectionalLight(0x8fbaff, 0.5); rim.position.set(-50, 30, -60); scene.add(rim);

    const st = { H: (window.Sejong22m && Sejong22m.EL_Z) || 15.7, data: null, pts: {}, ant: null, az: 180, el: 90, dirty: true };
    const G = { base: new T.Group(), pts: new T.Group(), vec: new T.Group(), sig: new T.Group(), sim: new T.Group(), fit: new T.Group(), mag: new T.Group() };
    for (const k in G) scene.add(G[k]);

    // 자료 받기 — 미니앱 잠금판이면 TSX 가 암호문을 풀어 준다
    const get = async (u, t) => {
      if (window.TSX && TSX.fetch && TSX.has && TSX.has(u)) {
        const rel = new URL(u, location.href).href.split('?')[0].slice(TSX.base.length), b = await TSX.fetch(rel);
        return t === 'json' ? JSON.parse(new TextDecoder().decode(b)) : new Blob([b], { type: 'image/jpeg' });
      }
      if (t === 'img') return u;
      const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u + ' ' + r.status); return t === 'json' ? r.json() : r.blob();
    };
    const loadImg = async (src, flip) => {          // 주소 → Image(무늬 flipY 로 뒤집기) · 암호문 blob → ImageBitmap(만들 때 뒤집기)
      if (typeof src === 'string') { const im = new Image(); im.decoding = 'async'; im.src = src; await im.decode(); return im; }
      return await createImageBitmap(src, flip ? { imageOrientation: 'flipY' } : {});
    };

    // 지형(정사영상) · 건물·필라(SLR 숨김) · 안테나
    (async () => {
      try {
        const big = Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio || 1, 2), mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || location.pathname.indexOf('/ts/') >= 0;
        const oname = !mobile && big >= 1400 ? 'site_ortho_4k.jpg' : 'site_ortho.jpg';
        const [dem, imgSrc] = await Promise.all([get('models/terrain/site_dem.json', 'json'), get('models/terrain/' + oname, 'img')]);
        const N = dem.n, S = dem.side_m, geo = new T.PlaneGeometry(S, S, N - 1, N - 1); geo.rotateX(-Math.PI / 2);
        const pos = geo.attributes.position;
        for (let k = 0; k < pos.count; k++) { const i = Math.floor(k / N), j = k % N; pos.setY(k, (dem.h[i * N + j] || 0) - 0.04); }
        geo.computeVertexNormals();
        const isUrl = typeof imgSrc === 'string', img = await loadImg(imgSrc, true), tex = new T.Texture(img);
        tex.flipY = isUrl;                             // 운용 화면 antenna3d 와 같다
        tex.encoding = T.sRGBEncoding; tex.anisotropy = rn.capabilities.getMaxAnisotropy(); tex.needsUpdate = true;
        G.base.add(new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, color: 0xeeeeee, toneMapped: false })));
        const sh = new T.Mesh(geo, new T.ShadowMaterial({ opacity: 0.36 })); sh.receiveShadow = true; sh.position.y = 0.03; G.base.add(sh);
        st.dirty = true;
        if (T.GLTFLoader) {
          const roof = new T.Texture(isUrl ? img : await loadImg(imgSrc, false)); roof.flipY = false;   // glTF 무늬 좌표 — 뒤집지 않은 판 roof.encoding = T.sRGBEncoding; roof.needsUpdate = true;
          const L = new T.GLTFLoader(), url = 'models/site_twin.glb';
          const g = await new Promise((ok, no) => { if (window.TSX && TSX.glb) TSX.glb(url).then((b) => L.parse(b, '', ok, no), no); else L.load(url, ok, undefined, no); });
          g.scene.traverse((o) => {
            if (/slr|sp0|sp1a/i.test(o.name || '')) o.visible = false;               // SLR 건물·돔·필라는 이번에는 넣지 않는다(10-05)
            if (!o.isMesh) return; o.castShadow = o.receiveShadow = true; const m = o.material;
            if (m && m.name === 'Roof_Ortho') { m.map = roof; m.color.setRGB(1, 1, 1); m.roughness = 0.9; m.needsUpdate = true; }
          });
          G.base.add(g.scene); st.dirty = true;
        }
      } catch (e) { console.warn('지형·건물을 불러오지 못함', e); }
    })();
    if (window.Sejong22m) st.ant = Sejong22m.add(scene, { url: 'models/sejong22m.glb', scale: 1, onload: (m) => { st.model = m; st.ant.place(st.az, st.el); if (st.xray) xray(true); st.dirty = true; } });
    // 투시 — IVP·축이 구조물 속에 있어 안테나를 반투명하게(IVP 보기에서 저절로)
    function xray(on) {
      st.xray = !!on; if (!st.model) return;
      st.model.traverse((o) => { if (!o.isMesh) return; const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) { if (!m.userData.lt0) m.userData.lt0 = { t: m.transparent, o: m.opacity, d: m.depthWrite };
          m.transparent = on ? true : m.userData.lt0.t; m.opacity = on ? 0.2 : m.userData.lt0.o; m.depthWrite = on ? false : m.userData.lt0.d; m.needsUpdate = true; }
        o.castShadow = !on; });
      st.dirty = true;
    }

    const w3 = (enu) => new T.Vector3(enu[0], st.H + enu[2], -enu[1]);   // 동·북·높이(IVP 기준) → 장면
    function load(data) {
      st.data = data;
      for (const g of [G.pts, G.vec, G.sig]) while (g.children.length) g.remove(g.children[0]);
      st.pts = {};
      for (const p of data.points) {
        const P = w3(p.enu), col = KCOL[p.kind] || 0xffffff, grp = new T.Group(); grp.position.copy(P);
        const glow = new T.Mesh(new T.SphereGeometry(p.kind === 'vlbi' ? 0.28 : 0.22, 24, 16), new T.MeshBasicMaterial({ color: col, toneMapped: false }));
        grp.add(glow);
        const ring = new T.Mesh(new T.RingGeometry(0.55, 0.7, 48), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, side: T.DoubleSide, depthWrite: false, toneMapped: false }));
        ring.rotation.x = -Math.PI / 2; grp.add(ring);
        if (p.kind === 'vlbi') {                     // IVP — 십자 표지(구조물을 뚫고 보이게)
          glow.material.depthTest = false; glow.renderOrder = 9;
          const m = new T.LineBasicMaterial({ color: col, toneMapped: false, depthTest: false });
          for (const a of [[1.4, 0, 0], [0, 1.4, 0], [0, 0, 1.4]]) grp.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-a[0], -a[1], -a[2]), new T.Vector3(...a)]), m));
        } else {
          grp.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 3.2, 0)]), new T.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6, toneMapped: false })));
        }
        const lb = textSprite(T, p.id === 'IVP' ? 'IVP' : p.id, '#' + col.toString(16).padStart(6, '0'), 1.5); lb.position.set(0, p.kind === 'vlbi' ? 2.4 : 4.0, 0); grp.add(lb);
        G.pts.add(grp); st.pts[p.id] = { grp, P, p, ring };
        if (p.id !== 'IVP') {                         // IVP → 점 벡터(점선)
          const g = new T.BufferGeometry().setFromPoints([w3([0, 0, 0]), P]);
          const ln = new T.Line(g, new T.LineDashedMaterial({ color: 0x7fe9ff, dashSize: 0.9, gapSize: 0.5, transparent: true, opacity: 0.75, toneMapped: false }));
          ln.computeLineDistances(); ln.userData.id = p.id; G.vec.add(ln);
        }
        if (p.a_enu_mm) {                             // σ 타원체(×300 확대)
          const k = 300 / 1000, s = p.a_enu_mm, el = new T.Mesh(new T.SphereGeometry(1, 20, 12), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false }));
          el.scale.set(s[0] * k, s[2] * k, s[1] * k); el.position.copy(P); G.sig.add(el);
        }
      }
      G.sig.visible = false; st.dirty = true;
    }
    function highlight(id) {
      for (const ln of G.vec.children) { const on = !id || ln.userData.id === id; ln.material.opacity = on ? 0.95 : 0.18; ln.material.color.setHex(on && id ? 0xffe28a : 0x7fe9ff); }
      for (const k in st.pts) st.pts[k].ring.scale.setScalar(k === id ? 1.8 : 1);
      st.dirty = true;
    }

    // ── 카메라(끌어 돌리기 · 휠 · 두 손가락) ──
    const cv = { tgt: new T.Vector3(-6, 6, 4), th: 0.95, ph: -2.35, r: 125 };
    let goal = null;
    function view(name) {
      if (name === 'ant') goal = { tgt: new T.Vector3(0, 12, 0), th: 1.15, ph: cv.ph, r: 46 };
      else if (name === 'ivp') { goal = { tgt: new T.Vector3(0, st.H, 0), th: 1.3, ph: cv.ph, r: 16 }; xray(true); if (opts.onXray) opts.onXray(true); }
      else goal = { tgt: new T.Vector3(-6, 6, 4), th: 0.95, ph: -2.35, r: 125 };
    }
    function camApply() {
      const s = Math.sin(cv.th);
      cam.position.set(cv.tgt.x + cv.r * s * Math.cos(cv.ph), cv.tgt.y + cv.r * Math.cos(cv.th), cv.tgt.z + cv.r * s * Math.sin(cv.ph)); cam.lookAt(cv.tgt);
    }
    let drag = 0, px = 0, py = 0, pinch = 0;
    canvas.addEventListener('pointerdown', (e) => { drag = e.button === 2 || e.shiftKey ? 2 : 1; px = e.clientX; py = e.clientY; goal = null; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = 0; });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
      if (drag === 1) { cv.ph += dx * 0.006; cv.th = Math.max(0.12, Math.min(1.5, cv.th - dy * 0.006)); }
      else { const k = cv.r * 0.0016, f = new T.Vector3(Math.cos(cv.ph), 0, Math.sin(cv.ph)), rt = new T.Vector3(-f.z, 0, f.x); cv.tgt.addScaledVector(rt, dx * k).addScaledVector(f, dy * k); }
      st.dirty = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { cv.r = Math.max(4, Math.min(420, cv.r * Math.exp(e.deltaY * 0.0012))); goal = null; st.dirty = true; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { if (e.touches.length === 2) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) cv.r = Math.max(4, Math.min(420, cv.r * pinch / d)); pinch = d; st.dirty = true; e.preventDefault(); } }, { passive: false });
    canvas.addEventListener('touchend', () => { pinch = 0; });
    canvas.addEventListener('dblclick', () => view('all'));

    // ── 모의 관측(애니메이션) ──
    const TS = {};                                    // 기계점 모형(필라 위 토탈스테이션)
    function tsModel(col) {
      const g = new T.Group(), m = new T.MeshStandardMaterial({ color: 0xf2c94c, metalness: 0.2, roughness: 0.5 }), dk = new T.MeshStandardMaterial({ color: 0x1c2533, metalness: 0.4, roughness: 0.5 });
      const body = new T.Mesh(new T.BoxGeometry(0.22, 0.26, 0.18), m); body.position.y = 0.13; g.add(body);
      const yoke = new T.Group(); yoke.position.y = 0.3; g.add(yoke);
      const tel = new T.Mesh(new T.CylinderGeometry(0.045, 0.055, 0.26, 18), dk); tel.rotation.x = Math.PI / 2; yoke.add(tel);
      const halo = new T.Mesh(new T.RingGeometry(0.42, 0.5, 40), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: T.DoubleSide, toneMapped: false }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; g.add(halo);
      g.scale.setScalar(2.2); g.userData = { yoke, halo }; return g;
    }
    const tgtMesh = {};                               // 타겟(프리즘) — 안테나와 함께 돈다
    function ensureTargets() {
      if (Object.keys(tgtMesh).length) return;
      const geo = new T.SphereGeometry(0.11, 14, 10);
      PH.forEach((t, i) => { const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color: PH_COL[i % PH_COL.length], toneMapped: false })); G.sim.add(m); tgtMesh[t.id] = m; });
      for (const t of PV) { const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0xffb454, toneMapped: false })); G.sim.add(m); tgtMesh[t.id] = m; }
    }
    const losMat = new T.LineBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.95, toneMapped: false });
    const los = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), losMat); los.visible = false; scene.add(los);
    const ptsGeo = {}, ptsObj = {};
    function addObsPoint(key, col, p) {
      if (!ptsGeo[key]) { ptsGeo[key] = []; const g = new T.BufferGeometry(); const o = new T.Points(g, new T.PointsMaterial({ color: col, size: 5, sizeAttenuation: false, toneMapped: false, transparent: true, opacity: 0.95 })); G.sim.add(o); ptsObj[key] = o; }
      ptsGeo[key].push(p[0], p[1], p[2]);
      const g = ptsObj[key].geometry; g.setAttribute('position', new T.Float32BufferAttribute(ptsGeo[key], 3)); g.computeBoundingSphere();
    }
    const sim = { cfg: null, geom: null, stations: [], steps: [], si: 0, qi: 0, queue: [], obs: [], rng: null, setups: null, running: false, paused: false, wait: 0, res: null, mc: null, mcToken: 0 };

    function stationsOf(ids) {
      return ids.map((id) => { const p = st.data.points.find((x) => x.id === id); if (!p) return null; const P = w3(p.enu); return { id, pos: [P.x, P.y + 0.25, P.z], top: P }; }).filter(Boolean);
    }
    function clearSim() {
      for (const g of [G.fit, G.mag]) while (g.children.length) g.remove(g.children[0]);
      for (const k in ptsObj) { G.sim.remove(ptsObj[k]); delete ptsObj[k]; delete ptsGeo[k]; }
      for (const k in TS) { scene.remove(TS[k]); delete TS[k]; }
      los.visible = false; sim.res = null; sim.mc = null; sim.mcToken++;
    }
    function start(cfg) {
      if (!st.data) return;
      clearSim(); ensureTargets();
      sim.cfg = cfg; sim.geom = makeGeom(st.H, cfg.e_mm / 1000); sim.stations = stationsOf(cfg.stations);
      sim.steps = plan(cfg); sim.si = 0; sim.queue = []; sim.obs = []; sim.rng = rngOf(cfg.seed || (Date.now() & 0xffffffff)); sim.setups = makeSetups(sim.stations, cfg.sig, sim.rng);
      for (const s of sim.stations) { const m = tsModel(0x37e8cf); m.position.copy(s.top); scene.add(m); TS[s.id] = m; }
      sim.running = true; sim.paused = false; sim.wait = 0;
      tgtPose(st.az, st.el); emit('status', '관측 시작 — 기계점 ' + sim.stations.map((s) => s.id).join('·'));
    }
    function tgtPose(A, E) {                          // 타겟 자리를 지금 안테나 자세로(그리기용 참값)
      if (!sim.geom) return;
      for (const t of PH) { const g = sim.geom.ph(t, A); tgtMesh[t.id].position.set(...g.pos); tgtMesh[t.id].visible = true; }
      for (const t of PV) { const g = sim.geom.pv(t, A, E); tgtMesh[t.id].position.set(...g.pos); tgtMesh[t.id].visible = true; }
    }
    const shortest = (a, b) => { let d = ((b - a) % 360 + 540) % 360 - 180; return d; };
    function simTick(dt) {
      if (!sim.running || sim.paused) return;
      const k = sim.cfg.speed;                        // 배속
      if (sim.si >= sim.steps.length && !sim.queue.length) { finish(); return; }
      if (!sim.queue.length) {                        // 다음 자세로 돌린다(그리기는 3 °/s × 배속)
        const ps = sim.steps[sim.si], rate = 3 * k * (k >= 999 ? 1e6 : 1);
        const dA = shortest(st.az, ps.A), dE = ps.E - st.el, stp = rate * dt;
        if (Math.abs(dA) > 1e-3 || Math.abs(dE) > 1e-3) {
          st.az = (st.az + Math.sign(dA) * Math.min(Math.abs(dA), stp) + 360) % 360; st.el += Math.sign(dE) * Math.min(Math.abs(dE), stp);
          if (st.ant) st.ant.place(st.az, st.el); tgtPose(st.az, st.el); st.dirty = true; return;
        }
        st.az = ps.A; st.el = ps.E; if (st.ant) st.ant.place(st.az, st.el); tgtPose(st.az, st.el);
        const tg = ps.kind === 'PH' ? PH : PV;
        for (const s of sim.stations) for (const t of tg) {
          const g = ps.kind === 'PH' ? sim.geom.ph(t, ps.A) : sim.geom.pv(t, ps.A, ps.E);
          if (visible(s.pos, g.pos, g.n, ps.kind)) sim.queue.push({ ps, s, t, g });
        }
        sim.si++; emit('progress', progress());
        if (!sim.queue.length) return;
      }
      sim.wait -= dt;
      if (sim.wait > 0) return;
      const n = k >= 999 ? sim.queue.length : 1;
      for (let i = 0; i < n && sim.queue.length; i++) {
        const q = sim.queue.shift(), o = observe(q.s.pos, sim.setups[q.s.id], q.g.pos, sim.cfg.sig, sim.rng);
        sim.obs.push({ kind: q.ps.kind, id: q.t.id, A: q.ps.A, E: q.ps.E, st: q.s.id, pt: o.pt, d: o.d, hz: o.hz, z: o.z });
        const idx = PH.findIndex((x) => x.id === q.t.id);
        addObsPoint(q.t.id + (q.ps.kind === 'PV' ? '@' + q.ps.A : ''), q.ps.kind === 'PH' ? PH_COL[idx % PH_COL.length] : 0xffb454, o.pt);
        los.geometry.setFromPoints([new T.Vector3(...q.s.pos), new T.Vector3(...q.g.pos)]); los.visible = true;
        const m = TS[q.s.id]; if (m) { const v = sub(q.g.pos, q.s.pos); m.rotation.y = Math.atan2(v[0], v[2]); m.userData.yoke.rotation.x = -Math.atan2(v[1], Math.hypot(v[0], v[2])); }
        if (n === 1) emit('status', `${q.s.id} → ${q.t.id} · 방위 ${q.ps.A.toFixed(0)}° 고도 ${q.ps.E.toFixed(0)}° · 경사거리 ${o.d.toFixed(4)} m · 수평각 ${dms(((o.hz / D2R) % 360 + 360) % 360)} · 천정각 ${dms(o.z / D2R)}`);
      }
      sim.wait = 0.32 / k; emit('progress', progress()); st.dirty = true;
    }
    function progress() {
      const c = { PH: 0, PV: 0 }; for (const o of sim.obs) c[o.kind]++;
      return { step: sim.si, steps: sim.steps.length, obs: sim.obs.length, ph: c.PH, pv: c.PV, frac: sim.steps.length ? sim.si / sim.steps.length : 0 };
    }
    function finish() {
      sim.running = false; los.visible = false;
      const res = analyze(sim.obs, sim.geom); sim.res = res; drawFit(res);
      emit('result', res ? Object.assign({ n: sim.obs.length, counts: progress(), e_true_mm: sim.cfg.e_mm }, res) : null);
      emit('status', res && res.ivp ? '분석 끝 — 원 맞춤 → 방위축·고도축 → IVP·축 오프셋. 흩어짐(σ)을 몬테카를로로 재는 중…' : '분석할 관측이 모자랍니다');
      if (res && res.ivp) monteCarlo(sim.cfg, sim.cfg.mc || 40);
    }
    function monteCarlo(cfg, N) {
      const token = ++sim.mcToken, geom = sim.geom, stations = sim.stations, D = [], E = [];
      let i = 0;
      const chunk = () => {
        if (token !== sim.mcToken) return;
        const t0 = performance.now();
        while (i < N && performance.now() - t0 < 25) { const r = analyze(runAll(cfg, geom, stations, 7919 * (i + 1) + 13), geom); if (r && r.ivp) { D.push(r.diff_mm); E.push(r.e_mm); } i++; }
        emit('mc', { done: i, N });
        if (i < N) { setTimeout(chunk, 0); return; }
        const m = [0, 1, 2].map((k) => D.reduce((s, d) => s + d[k], 0) / D.length);
        const sd = [0, 1, 2].map((k) => Math.sqrt(D.reduce((s, d) => s + (d[k] - m[k]) ** 2, 0) / Math.max(1, D.length - 1)));
        const em = E.reduce((s, x) => s + x, 0) / E.length, es = Math.sqrt(E.reduce((s, x) => s + (x - em) ** 2, 0) / Math.max(1, E.length - 1));
        sim.mc = { N: D.length, mean_mm: m, sd_mm: sd, e_mean_mm: em, e_sd_mm: es }; drawMag();
        emit('mc', Object.assign({ done: N, N }, sim.mc));
        emit('status', `몬테카를로 ${D.length}판 — IVP σ 동 ${sd[0].toFixed(2)} · 북 ${sd[1].toFixed(2)} · 높이 ${sd[2].toFixed(2)} mm · 축 오프셋 σ ${es.toFixed(2)} mm`);
      };
      setTimeout(chunk, 30);
    }
    function circleLine(f, col, op) {
      const pts = []; for (let i = 0; i <= 128; i++) { const a = i / 128 * Math.PI * 2; pts.push(new T.Vector3(...add(f.c, add(scl(f.e1, f.r * Math.cos(a)), scl(f.e2, f.r * Math.sin(a)))))); }
      return new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: col, transparent: true, opacity: op, toneMapped: false }));
    }
    function drawFit(res) {
      while (G.fit.children.length) G.fit.remove(G.fit.children[0]);
      if (!res) return;
      PH.forEach((t, i) => { const f = res.ph[t.id]; if (f) G.fit.add(circleLine(f, PH_COL[i % PH_COL.length], 0.85)); });
      for (const k in res.pv) G.fit.add(circleLine(res.pv[k], 0xffb454, 0.9));
      const az = res.az, a0 = add(az.p0, scl(az.d, -st.H + 0.5)), a1 = add(az.p0, scl(az.d, 14));
      const thru = (c) => new T.LineBasicMaterial({ color: c, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 });   // 축은 구조물 속 — 뚫고 보이게
      const ln = (a, b, c) => { const l = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]), thru(c)); l.renderOrder = 8; return l; };
      G.fit.add(ln(a0, a1, 0x37e8cf));
      for (const p of res.per) G.fit.add(ln(add(p.elPt, scl(p.w, -7)), add(p.elPt, scl(p.w, 7)), 0xffb454));
      if (res.ivp) { const m = new T.Mesh(new T.SphereGeometry(0.16, 20, 14), new T.MeshBasicMaterial({ color: 0xff6b8a, toneMapped: false, depthTest: false })); m.renderOrder = 10; m.position.set(...res.ivp); G.fit.add(m); }
      st.dirty = true;
    }
    function drawMag() {                               // 추정 − 참값 ×500 화살표 · 몬테카를로 σ 타원체 ×500
      while (G.mag.children.length) G.mag.remove(G.mag.children[0]);
      const r = sim.res; if (!r || !r.ivp) return;
      const K = 500, base = new T.Vector3(...sim.geom.ivp), d = sub(r.ivp, sim.geom.ivp), v = new T.Vector3(d[0] * K, d[1] * K, d[2] * K);
      if (v.length() > 1e-6) { const ar = new T.ArrowHelper(v.clone().normalize(), base, v.length(), 0xff6b8a, Math.min(0.6, v.length() * 0.3), Math.min(0.35, v.length() * 0.2));
        for (const o of [ar.line, ar.cone]) { o.material.depthTest = false; o.material.toneMapped = false; o.renderOrder = 11; } G.mag.add(ar); }
      if (sim.mc) { const s = sim.mc.sd_mm, el = new T.Mesh(new T.SphereGeometry(1, 24, 14), new T.MeshBasicMaterial({ color: 0xff6b8a, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false, toneMapped: false })); el.renderOrder = 10;
        el.scale.set(s[0] * K / 1000, s[2] * K / 1000, s[1] * K / 1000); el.position.copy(base); G.mag.add(el); }
      st.dirty = true;
    }
    const dms = (deg) => { const d = Math.floor(deg), mm = (deg - d) * 60, m = Math.floor(mm), s = (mm - m) * 60; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`; };
    const handlers = opts;
    function emit(k, v) { const f = handlers['on' + k[0].toUpperCase() + k.slice(1)]; if (f) try { f(v); } catch (e) { console.warn(e); } }

    // ── 그리기 ──
    function resize() { const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1; rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); st.dirty = true; }
    addEventListener('resize', resize);
    let last = performance.now(), visibleNow = true;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visibleNow = es[0].isIntersecting; }).observe(canvas);
    function loop(t) {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      if (!visibleNow || document.hidden) return;
      if (goal) { const f = 1 - Math.pow(0.002, dt); cv.tgt.lerp(goal.tgt, f); cv.th += (goal.th - cv.th) * f; cv.ph += (goal.ph - cv.ph) * f; cv.r += (goal.r - cv.r) * f; st.dirty = true; if (Math.abs(goal.r - cv.r) < 0.05) goal = null; }
      simTick(dt);
      if (sim.running) { const s = 1 + 0.25 * Math.sin(t / 160); for (const k in TS) TS[k].userData.halo.scale.setScalar(s); st.dirty = true; }
      if (!st.dirty) return; st.dirty = false; camApply(); rn.render(scene, cam);
    }
    resize(); requestAnimationFrame(loop);

    return {
      load, highlight, view, resize, xray,
      show(o) { if ('sigma' in o) G.sig.visible = !!o.sigma; if ('vectors' in o) G.vec.visible = !!o.vectors; if ('points' in o) G.sim.visible = !!o.points;
        if ('fit' in o) G.fit.visible = !!o.fit; if ('mag' in o) G.mag.visible = !!o.mag; st.dirty = true; },
      sim: { start, pause() { sim.paused = true; }, resume() { sim.paused = false; }, reset() { sim.running = false; clearSim(); for (const k in tgtMesh) tgtMesh[k].visible = false; st.dirty = true; },
             get running() { return sim.running; }, get paused() { return sim.paused; }, get result() { return sim.res; }, get mc() { return sim.mc; },
             setSpeed(k) { if (sim.cfg) sim.cfg.speed = k; } },
      pose(az, el) { st.az = az; st.el = el; if (st.ant) st.ant.place(az, el); st.dirty = true; },
      targets: { PH, PV },
    };
  }
  window.LocalTie = { create, _test: { circleFit3, analyze, runAll, makeGeom, plan, PH, PV } };
})();
