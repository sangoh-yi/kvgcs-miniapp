/* jamsim_core.js — GPS 방해전파 실시간 역추적망 모의의 계산부(2026-10-05 센터장님 "1,2,5번 시뮬레이션 만들어 봐 … 실제 장소도 만들어서").
 *   화면(jamsim.js)과 Node 검산(models/jamsim/jamsim_check.js)이 같은 식을 쓴다. 화면 안 모의뿐 — 실제 장비 명령은 없다.
 *
 *   1 교란원     L1 1575.42 MHz · 잡음형(대역 Bj) 또는 처프형(훑는 폭 Bj) · 등가 방사 전력 EIRP(W) · 안테나 높이
 *   2 전파       자유공간 손실 FSPL = 20·log10(4πd/λ) + 지형 가시선(실제 DEM · 유효 지구 반지름 4/3) 칼날 회절 J(ν)(ITU-R P.526)
 *   3 GNSS 영향  J/S = (수신 교란 전력 · C/A 대역 몫) − (GPS L1 C/A −128.5 dBm) — 20 dB 넘으면 저하 · 30 dB 넘으면 끊김(상용 수신기 범위 24~40 dB)
 *   4 감지·상관  기준점마다 SDR(대역 B · 잡음 kTB·NF). 두 기준점 기록의 교차상관 — VLBI 와 같은 식
 *                ρ = √(s₁s₂ / ((1+s₁)(1+s₂))) · SNR = ρ·√(B·T) · σ_τ = 1 / (2π·B_rms·SNR), B_rms = B/√12 · σ_ν ≈ √3/(π·T·SNR)
 *   5 위치       도착 시각 차(TDOA) · 도플러 차(FDOA, 움직이는 교란원)로 가중 최소제곱(가우스-뉴턴) — 공통 기준점 상관을 넣은 공분산
 *                + 다중경로 · 기준점 시계 오차(교란 중 GNSS 시각을 잃으면 유지 시계: OCXO·루비듐·수소메이저·광섬유 시각)
 *   6 경보       위치·영향 지도로 선박·항공기의 저하·끊김을 판정하고 해경·관제에 알린다
 */
'use strict';
(function (root) {
  const C = 299792458, F_L1 = 1575.42e6, LAM = C / F_L1, KB = 1.380649e-23, T0 = 290, RE = 6371008.8, K43 = 4 / 3;
  const GPS_S_DBM = -128.5, B_CA = 2.046e6;
  const WGS_A = 6378137.0, WGS_E2 = 0.00669438002290;
  const D2R = Math.PI / 180;
  const db = (x) => 10 * Math.log10(x), undb = (x) => Math.pow(10, x / 10);

  // ── 좌표 ──
  function ecef(lat, lon, h) {
    const la = lat * D2R, lo = lon * D2R, s = Math.sin(la), c = Math.cos(la), N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
    return [(N + h) * c * Math.cos(lo), (N + h) * c * Math.sin(lo), (N * (1 - WGS_E2) + h) * s];
  }
  function geod(x, y, z) {
    const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - WGS_E2)), h = 0;
    for (let i = 0; i < 8; i++) { const s = Math.sin(lat), N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + h))); }
    return [lat / D2R, lon / D2R, h];
  }
  function frame(lat0, lon0) {                       // 지역 접평면(동·북·위) — 원점 = 지역 가운데 바닥
    const o = ecef(lat0, lon0, 0), la = lat0 * D2R, lo = lon0 * D2R;
    const E = [-Math.sin(lo), Math.cos(lo), 0], N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const toEnu = (p) => { const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return [dot(d, E), dot(d, N), dot(d, U)]; };
    const fromEnu = (q) => [o[0] + q[0] * E[0] + q[1] * N[0] + q[2] * U[0], o[1] + q[0] * E[1] + q[1] * N[1] + q[2] * U[1], o[2] + q[0] * E[2] + q[1] * N[2] + q[2] * U[2]];
    return { o, E, N, U, toEnu, fromEnu, enu: (lat, lon, h) => toEnu(ecef(lat, lon, h)) };
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  function gcDist(lat1, lon1, lat2, lon2) {          // 대권 거리(m, 구)
    const a = Math.sin((lat2 - lat1) * D2R / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
    return 2 * RE * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ── 지형(위경도 등간격 Int16 격자) ──
  function dem(region, i16) {
    const { lon0, lon1, lat0, lat1, nx, ny } = region;
    const at = (lat, lon) => {                        // 겹선형 · 바다(해저)는 0 으로
      const fx = (lon - lon0) / (lon1 - lon0) * nx - 0.5, fy = (lat1 - lat) / (lat1 - lat0) * ny - 0.5;
      if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return 0;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), u = fx - x0, v = fy - y0;
      const g = (x, y) => Math.max(0, i16[y * nx + x]);
      return g(x0, y0) * (1 - u) * (1 - v) + g(x1, y0) * u * (1 - v) + g(x0, y1) * (1 - u) * v + g(x1, y1) * u * v;
    };
    const sea = (lat, lon) => at(lat, lon) <= 0.5;
    return { at, sea, region };
  }

  // ── 전파: 자유공간 + 지형 가시선 · 칼날 회절(가장 깊이 막는 한 점, ITU-R P.526 식 31) ──
  function knife(nu) { return nu <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1); }
  function path(D, a, b, nSamp) {                     // a, b = {lat, lon, h(타원체고가 아닌 해발 m)}
    const d = Math.max(1, gcDist(a.lat, a.lon, b.lat, b.lon)), n = nSamp || 48;
    let worst = -Infinity, wd = 0;
    for (let k = 1; k < n; k++) {
      const f = k / n, lat = a.lat + (b.lat - a.lat) * f, lon = a.lon + (b.lon - a.lon) * f;
      const d1 = d * f, d2 = d - d1;
      const ground = D.at(lat, lon) + d1 * d2 / (2 * K43 * RE);           // 지형 + 지구 볼록(4/3)
      const line = a.h + (b.h - a.h) * f;
      const nu = (ground - line) * Math.sqrt(2 * d / (LAM * d1 * d2));
      if (nu > worst) { worst = nu; wd = d1; }
    }
    const fspl = 20 * Math.log10(4 * Math.PI * d / LAM), diff = knife(worst);
    return { d, fspl, diff, loss: fspl + diff, nu: worst, at: wd, los: worst < 0 };
  }

  // ── 교란 세기 · GNSS 영향 ──
  function jamAt(D, jam, rx, gRx) {                   // 수신 교란 전력(dBm) · J/S(dB)
    const p = path(D, jam, rx);
    const pr = db(jam.eirpW * 1000) + (gRx || 0) - p.loss;                 // dBm
    const frac = Math.min(1, B_CA / jam.bw);
    const js = pr + db(frac) - GPS_S_DBM;
    return { pr, js, path: p };
  }
  const JS_DEGRADE = 20, JS_LOSS = 30;
  const state = (js) => js >= JS_LOSS ? 'loss' : js >= JS_DEGRADE ? 'degrade' : 'ok';

  // ── 시계(기준점이 GNSS 시각을 잃었을 때 유지) ──
  //   x(t) ≈ √((y₀·t)² + (½·a·t²)² + σ₁²·t) — y₀: 잠금 풀릴 때 남은 주파수 오차 · a: 노화 · σ₁: 1 s 앨런 편차(백색 FM)
  const CLOCKS = {
    gnss: { name: 'GNSS 시각(교란 없음)', fixed: 5e-9 },
    ocxo: { name: 'OCXO(수정 발진기)', y0: 1e-10, aging: 1e-10 / 86400, adev1: 1e-12 },
    rb: { name: '루비듐', y0: 5e-12, aging: 5e-11 / (30 * 86400), adev1: 3e-12 },
    maser: { name: '수소메이저(세종 VLBI)', y0: 1e-14, aging: 1e-15 / 86400, adev1: 1e-13 },
    fiber: { name: '광섬유 시각(세종 메이저 → 기준점)', fixed: 1e-10 },
  };
  function clockSigma(kind, t) {
    const c = CLOCKS[kind] || CLOCKS.ocxo;
    if (c.fixed != null) return c.fixed;
    return Math.sqrt((c.y0 * t) ** 2 + (0.5 * c.aging * t * t) ** 2 + c.adev1 * c.adev1 * t + CLOCKS.gnss.fixed ** 2);   // 잠금 풀릴 때의 GNSS 시각 오차 + 늘어나는 몫
  }
  function clockFreqSigma(kind) { const c = CLOCKS[kind] || CLOCKS.ocxo; return c.fixed != null ? 1e-12 : c.y0; }

  // ── 감지 · 상관(VLBI 식) ──
  function sdrNoiseDbm(bw, nfDb) { return db(KB * T0 * bw * 1000) + (nfDb == null ? 2 : nfDb); }
  function corrStats(s1, s2, beff, T) {
    const rho = Math.sqrt(s1 * s2 / ((1 + s1) * (1 + s2)));
    const snr = rho * Math.sqrt(beff * T);
    const brms = beff / Math.sqrt(12);
    return { rho, snr, sigTau: 1 / (2 * Math.PI * brms * Math.max(snr, 1e-9)), sigNu: Math.sqrt(3) / (Math.PI * T * Math.max(snr, 1e-9)) };
  }

  // ── 작은 선형대수 ──
  function inv(M) {
    const n = M.length, A = M.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-300) return null;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map((r) => r.slice(n));
  }
  const matMul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  const tr = (A) => A[0].map((_, j) => A.map((r) => r[j]));

  // 난수(재현되게)
  function rng(seed) { let s = seed >>> 0 || 1; const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); return { u, n: () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); } }; }

  // ── 한 번 관측 → 위치 결정 ──
  //   opt: {F(지역 틀), D(지형), stations[{id,lat,lon,h(타원체고), clock}], jam{lat,lon,hAsl(해발),eirpW,bw,type,vel[ve,vn] m/s},
  //         T(적분 s), sdrBw, nf, mpNs(다중경로 ns), clock(유지 시계), tHold(교란 지속 s), seed, noise(0/1), mode('2d'|'3d'), useFdoa,
  //         hAssume(2d: 지형 위 교란 안테나 높이 가정 m), geoidN(지오이드고 m — 해발 = 타원체고 − N)}
  //   2d = 땅·바다 위 교란원: 높이를 '그 자리 지형(바다 0) + hAssume' 로 묶고 동·북을 푼다. 3d = 드론: 높이도 푼다.
  function solve(opt) {
    const { F, D, jam } = opt, T = opt.T || 1.0, B = opt.sdrBw || 5e6, noise = opt.noise == null ? 1 : opt.noise;
    const GN = opt.geoidN == null ? 25 : opt.geoidN, R = rng(opt.seed || 7), nfl = sdrNoiseDbm(B, opt.nf);
    const beff = Math.min(B, jam.bw), J = { lat: jam.lat, lon: jam.lon, h: jam.hAsl, eirpW: jam.eirpW, bw: jam.bw };
    const pj = ecef(jam.lat, jam.lon, jam.hAsl + GN);
    const vE = jam.vel ? jam.vel[0] : 0, vN = jam.vel ? jam.vel[1] : 0;
    const vj = [vE * F.E[0] + vN * F.N[0], vE * F.E[1] + vN * F.N[1], vE * F.E[2] + vN * F.N[2]];
    // 기준점마다: 받은 세기(감시 SDR · L 대역 감시 안테나 0 dBi, 지상 2.5 m) · 자기 GNSS(초크링 — 지평 쪽 −5 dBi)가 끊겼나 → 시계
    const st = opt.stations.map((s) => {
      const hAsl = s.h - GN;
      const sdr = jamAt(D, J, { lat: s.lat, lon: s.lon, h: hAsl + 2.5 }, 0);
      const own = jamAt(D, J, { lat: s.lat, lon: s.lon, h: hAsl + 2.0 }, -5);
      const snrDb = sdr.pr + db(Math.min(1, jam.bw / B)) - nfl;          // 감시 대역 안의 교란 몫 / 잡음
      const lost = own.js >= JS_LOSS;
      const ck = lost ? (s.clock || opt.clock || 'ocxo') : 'gnss';
      const sigClk = ck === 'gnss' ? CLOCKS.gnss.fixed : clockSigma(ck, opt.tHold || 0);
      return Object.assign({}, s, { hAsl, p: ecef(s.lat, s.lon, s.h + 2.5), pr: sdr.pr, snrDb, s: undb(snrDb), los: sdr.path.los, nu: sdr.path.nu, d: sdr.path.d,
        ownJs: own.js, lost, clk: ck, sigClk, sigFclk: ck === 'gnss' ? 1e-12 : clockFreqSigma(ck) });
    });
    // 감지 — 표본 하나의 SNR 이 잡음보다 한참 낮아도(−30 dB 등) 가장 센 기준점과 상관을 쌓으면 잡힌다(VLBI 와 같다): 상관 SNR ≥ detSnr
    st.sort((a, b) => b.snrDb - a.snrDb);
    const top = st[0], detSnr = opt.detSnr || 7;
    for (const s of st) s.corrSnr = s === top ? Infinity : corrStats(top.s, s.s, beff, T).snr;
    const det = top && top.snrDb > -20 ? st.filter((s) => s.corrSnr >= detSnr) : [];
    const is3 = opt.mode === '3d', useF = !!opt.useFdoa, nPos = is3 ? 3 : 2, nX = nPos + (useF ? 2 : 0);
    const need = nX + 1 - (useF ? Math.min(2, nX) : 0) + 1;
    const out = { st, det, nfl, beff, T };
    if (det.length < Math.max(4, need)) { out.fail = `감지한 기준점 ${det.length} 곳 — 위치를 풀려면 ${Math.max(4, need)} 곳 넘게`; return out; }
    const ref = det[0], others = det.slice(1);
    const mp = (opt.mpNs == null ? 5 : opt.mpNs) * 1e-9;
    const sig = (s) => Math.sqrt(s.sigClk ** 2 + mp * mp);                 // 기준점마다 독립: 시계 + 다중경로(참 오차의 크기)
    //   clockAware = false: 유지 시계로 넘어간 것을 모른 채 모든 기준점을 GNSS 시각 수준으로 믿고 푼다 → 시계 오차가 그대로 위치 오차가 된다
    const aware = opt.clockAware !== false, sigW = (s) => aware ? sig(s) : Math.sqrt(CLOCKS.gnss.fixed ** 2 + mp * mp);
    const pairs = others.map((s) => Object.assign({ s }, corrStats(ref.s, s.s, beff, T)));
    const rngP = (p, q) => norm(sub(p, q));
    const rate = (p, v, q) => { const d = sub(p, q); return dot(v, d) / norm(d); };   // 거리 변화율(m/s)
    const clkTrue = new Map(det.map((s) => [s.id, noise ? sig(s) * R.n() : 0]));
    const fclkTrue = new Map(det.map((s) => [s.id, noise ? s.sigFclk * F_L1 * R.n() : 0]));
    const tdoa = pairs.map((P) => (rngP(pj, P.s.p) - rngP(pj, ref.p)) / C + (clkTrue.get(P.s.id) - clkTrue.get(ref.id)) + (noise ? P.sigTau * R.n() : 0));
    const fdoa = pairs.map((P) => -(rate(pj, vj, P.s.p) - rate(pj, vj, ref.p)) / LAM + (fclkTrue.get(P.s.id) - fclkTrue.get(ref.id)) + (noise ? P.sigNu * R.n() : 0));
    // 공분산 — 모든 쌍이 같은 기준점을 쓰니 서로 상관(기준점 몫이 모든 칸에)
    const nP = pairs.length;
    const Ct = Array.from({ length: nP }, (_, i) => Array.from({ length: nP }, (_, j) => (i === j ? pairs[i].sigTau ** 2 + sigW(pairs[i].s) ** 2 : 0) + sigW(ref) ** 2));
    const Cf = Array.from({ length: nP }, (_, i) => Array.from({ length: nP }, (_, j) => (i === j ? pairs[i].sigNu ** 2 + (pairs[i].s.sigFclk * F_L1) ** 2 : 0) + (ref.sigFclk * F_L1) ** 2));
    const enuJ = F.toEnu(pj), hA = opt.hAssume == null ? (D.sea(jam.lat, jam.lon) ? 10 : 20) : opt.hAssume;
    const toP = (x) => {
      if (is3) return F.fromEnu([x[0], x[1], x[2]]);
      const g = geod(...F.fromEnu([x[0], x[1], 0]));
      return ecef(g[0], g[1], D.at(g[0], g[1]) + hA + GN);                // 2d: 그 자리 지형 + 가정 높이
    };
    const toV = (x) => useF ? [x[nPos] * F.E[0] + x[nPos + 1] * F.N[0], x[nPos] * F.E[1] + x[nPos + 1] * F.N[1], x[nPos] * F.E[2] + x[nPos + 1] * F.N[2]] : [0, 0, 0];
    const modelT = (p) => pairs.map((P) => (rngP(p, P.s.p) - rngP(p, ref.p)) / C);
    const model = (x) => { const p = toP(x), v = toV(x); return modelT(p).concat(useF ? pairs.map((P) => -(rate(p, v, P.s.p) - rate(p, v, ref.p)) / LAM) : []); };
    const yObs = tdoa.concat(useF ? fdoa : []);
    const W = inv(useF ? blockDiag(Ct, Cf) : Ct), Wt = inv(Ct);
    // 처음 값 — 지역 전체를 3 km 간격으로 훑어(TDOA 만) 가장 맞는 곳 → 가우스-뉴턴
    const reg = D.region, midLat = 0.5 * (reg.lat0 + reg.lat1), midLon = 0.5 * (reg.lon0 + reg.lon1);
    const e0 = F.enu(midLat, reg.lon0, 0)[0], e1 = F.enu(midLat, reg.lon1, 0)[0], n0 = F.enu(reg.lat0, midLon, 0)[1], n1 = F.enu(reg.lat1, midLon, 0)[1];
    let best = null;
    for (let e = e0; e <= e1; e += 3000) for (let n = n0; n <= n1; n += 3000) {
      const x = is3 ? [e, n, 300] : [e, n], p = toP(x), m = modelT(p), r = tdoa.map((v, i) => v - m[i]);
      let c = 0; for (let i = 0; i < nP; i++) for (let j = 0; j < nP; j++) c += r[i] * Wt[i][j] * r[j];
      if (!best || c < best.c) best = { x, c };
    }
    // 가우스-뉴턴에 감쇠(레벤버그-마쿼트) — 시계 오차가 km 급이 되면 맨 가우스-뉴턴은 발산한다. 비용이 늘면 λ 를 키우고, 한 걸음은 50 km 까지
    const costW = (x) => { const m = model(x), r = yObs.map((v, i) => v - m[i]); let c = 0; for (let i = 0; i < r.length; i++) for (let j = 0; j < r.length; j++) c += r[i] * W[i][j] * r[j]; return c; };
    let x = best.x.concat(useF ? [0, 0] : []), it = 0, cov = null, lam = 1e-3, c0 = costW(x);
    for (; it < 60; it++) {
      const m0 = model(x), cols = [];
      for (let k = 0; k < nX; k++) { const h = k < nPos ? 0.5 : 0.01, xp = x.slice(); xp[k] += h; const m1 = model(xp); cols.push(m1.map((v, i) => (v - m0[i]) / h)); }
      const A = tr(cols), r = yObs.map((v, i) => v - m0[i]), AtW = matMul(tr(A), W), N = matMul(AtW, A), g0 = matMul(AtW, r.map((v) => [v])).map((v) => v[0]);
      const Ninv0 = inv(N); if (!Ninv0) break; cov = Ninv0;
      let took = false;
      for (let tries = 0; tries < 8; tries++) {
        const Nd = N.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lam) : v))), Ni = inv(Nd); if (!Ni) { lam *= 10; continue; }
        let dx = matMul(Ni, g0.map((v) => [v])).map((v) => v[0]);
        const st2 = Math.hypot(dx[0], dx[1]); if (st2 > 50000) dx = dx.map((v) => v * 50000 / st2);
        const xn = x.map((v, k) => v + dx[k]), cn = costW(xn);
        if (cn <= c0) { x = xn; c0 = cn; const small = Math.hypot(dx[0], dx[1]) < 1e-4 && (!is3 || Math.abs(dx[2]) < 1e-4); lam = Math.max(1e-7, lam / 10); took = !(small && lam <= 1e-3); break; }   // 감쇠가 작을 때만 수렴으로 본다
        lam *= 10;
      }
      if (!took) break;
    }
    const pHat = toP(x), g = geod(pHat[0], pHat[1], pHat[2]), eHat = F.toEnu(pHat);
    const errE = eHat[0] - enuJ[0], errN = eHat[1] - enuJ[1], errU = eHat[2] - enuJ[2];
    const sEE = cov[0][0], sNN = cov[1][1], sEN = cov[0][1], q = Math.sqrt(0.25 * (sEE - sNN) ** 2 + sEN * sEN);
    Object.assign(out, {
      ok: true, it, ref: ref.id, n: det.length, chi2: c0 / Math.max(1, yObs.length - nX),
      pairs: pairs.map((P, i) => ({ id: P.s.id, snr: P.snr, rho: P.rho, sigTau: P.sigTau, sigNu: P.sigNu, tdoa: tdoa[i], fdoa: fdoa[i] })),
      est: { lat: g[0], lon: g[1], hAsl: g[2] - GN, e: eHat[0], n: eHat[1], u: eHat[2], ve: useF ? x[nPos] : null, vn: useF ? x[nPos + 1] : null },
      truth: { e: enuJ[0], n: enuJ[1], u: enuJ[2], ve: vE, vn: vN },
      err: { e: errE, n: errN, u: errU, h: Math.hypot(errE, errN), ve: useF ? x[nPos] - vE : null, vn: useF ? x[nPos + 1] - vN : null },
      sigma: { e: Math.sqrt(sEE), n: Math.sqrt(sNN), u: is3 ? Math.sqrt(cov[2][2]) : null, ve: useF ? Math.sqrt(cov[nPos][nPos]) : null, vn: useF ? Math.sqrt(cov[nPos + 1][nPos + 1]) : null },
      ellipse: { a: Math.sqrt(0.5 * (sEE + sNN) + q), b: Math.sqrt(Math.max(0, 0.5 * (sEE + sNN) - q)), ang: 0.5 * Math.atan2(2 * sEN, sEE - sNN) },
      gdop: gdop(pairs, ref, toP, x, Math.min(nPos, 2), (xx) => modelT(toP(xx)), nP),
      cov,
    });
    return out;
  }
  function blockDiag(A, B) { const n = A.length, m = B.length; return Array.from({ length: n + m }, (_, i) => Array.from({ length: n + m }, (_, j) => (i < n && j < n ? A[i][j] : i >= n && j >= n ? B[i - n][j - n] : 0))); }
  function gdop(pairs, ref, toP, x, nPos, modelT, nT) {             // 수평 기하 인자 — 모든 쌍 σ 같게(c·σ_τ = 1 m)일 때 수평 위치 σ(m)
    const m0 = modelT(x), Jm = [];
    for (let k = 0; k < nPos; k++) { const xp = x.slice(); xp[k] += 1; const m1 = modelT(xp); Jm.push(m1.map((v, i) => (v - m0[i]) * C)); }
    const A = tr(Jm), n = nT, Cu = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 2 : 1)));   // 같은 σ · 공통 기준
    const N = matMul(matMul(tr(A), inv(Cu)), A), Ni = inv(N);
    return Ni ? Math.sqrt(Ni[0][0] + Ni[1][1]) : null;
  }

  // ── 영향 지도: 높이 hRx(해발 m)에서 J/S 격자 ──
  function footprint(D, jam, region, hRx, nx, ny, gRx) {
    const out = new Float32Array(nx * ny), J = { lat: jam.lat, lon: jam.lon, h: jam.hAsl, eirpW: jam.eirpW, bw: jam.bw };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const lat = region.lat1 - (j + 0.5) / ny * (region.lat1 - region.lat0), lon = region.lon0 + (i + 0.5) / nx * (region.lon1 - region.lon0);
      const ground = D.at(lat, lon);
      out[j * nx + i] = jamAt(D, J, { lat, lon, h: Math.max(hRx, ground + 2) }, gRx == null ? -3 : gRx).js;
    }
    return { nx, ny, js: out };
  }

  // ── 신호 수준 상관 시연(두 기준점 기록 · 복소 기저대역) ──
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr2 = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr2; im[b] = im[a] - ti; re[a] += tr2; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  //   tau(s) · dfHz(도플러 차) · fs(표본률) · snr1·snr2(선형) · N(2의 거듭제곱) · type('noise'|'chirp') · bw
  function corrDemo(o) {
    const N = o.N || 16384, fs = o.fs || 4e6, R = rng(o.seed || 3), seg = o.seg || 8;
    // 교란 신호: 하늘 쪽 공통 성분(주파수 영역에서 만들어 분수 지연·도플러를 정확히 넣는다)
    const sr = new Float64Array(N), si = new Float64Array(N);
    if (o.type === 'chirp') {
      const k = (o.bw || 2e6) / (N / fs); for (let n = 0; n < N; n++) { const t = n / fs, ph = Math.PI * k * (t - N / fs / 2) ** 2; sr[n] = Math.cos(ph); si[n] = Math.sin(ph); }
    } else { for (let n = 0; n < N; n++) { sr[n] = R.n(); si[n] = R.n(); } }
    // 대역 제한(교란 대역 bw) + 2번 기록에 지연 tau
    const ar = Float64Array.from(sr), ai = Float64Array.from(si); fft(ar, ai, false);
    const br = new Float64Array(N), bi = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const f = (k < N / 2 ? k : k - N) * fs / N; if (o.type !== 'chirp' && Math.abs(f) > (o.bw || 2e6) / 2) { ar[k] = 0; ai[k] = 0; }
      const ph = -2 * Math.PI * f * o.tau; br[k] = ar[k] * Math.cos(ph) - ai[k] * Math.sin(ph); bi[k] = ar[k] * Math.sin(ph) + ai[k] * Math.cos(ph);
    }
    fft(ar, ai, true); fft(br, bi, true);
    const pw = (r, i) => { let s = 0; for (let n = 0; n < N; n++) s += r[n] * r[n] + i[n] * i[n]; return s / N; };
    const P = pw(ar, ai);
    const x1r = new Float64Array(N), x1i = new Float64Array(N), x2r = new Float64Array(N), x2i = new Float64Array(N);
    const n1 = Math.sqrt(P / (o.snr1 || 1)), n2 = Math.sqrt(P / (o.snr2 || 1));
    for (let n = 0; n < N; n++) {
      const t = n / fs, rot = 2 * Math.PI * (o.dfHz || 0) * t, c = Math.cos(rot), s = Math.sin(rot);
      x1r[n] = ar[n] + n1 * R.n() * Math.SQRT1_2; x1i[n] = ai[n] + n1 * R.n() * Math.SQRT1_2;
      x2r[n] = br[n] * c - bi[n] * s + n2 * R.n() * Math.SQRT1_2; x2i[n] = br[n] * s + bi[n] * c + n2 * R.n() * Math.SQRT1_2;
    }
    // 교차상관 R(l) = Σ x2[n] x1*[n−l] … FFT 로: X2·conj(X1)
    const Xr = Float64Array.from(x1r), Xi = Float64Array.from(x1i), Yr = Float64Array.from(x2r), Yi = Float64Array.from(x2i);
    fft(Xr, Xi, false); fft(Yr, Yi, false);
    const cr = new Float64Array(N), ci = new Float64Array(N);
    for (let k = 0; k < N; k++) { cr[k] = Yr[k] * Xr[k] + Yi[k] * Xi[k]; ci[k] = Yi[k] * Xr[k] - Yr[k] * Xi[k]; }
    fft(cr, ci, true);
    const amp = new Float64Array(N); let kmax = 0;
    for (let k = 0; k < N; k++) { amp[k] = Math.hypot(cr[k], ci[k]); if (amp[k] > amp[kmax]) kmax = k; }
    const am = (k) => amp[(k + N) % N], y0 = am(kmax - 1), y1 = am(kmax), y2 = am(kmax + 1);
    const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    let lag = kmax + frac; if (lag > N / 2) lag -= N;
    // 바닥 잡음 대비 봉우리(SNR)
    let s1 = 0, s2 = 0, m = 0; for (let k = 0; k < N; k++) if (Math.abs(k - kmax) > 8 && Math.abs(k - kmax) < N - 8) { s1 += amp[k]; s2 += amp[k] * amp[k]; m++; }
    const mu = s1 / m, sd = Math.sqrt(Math.max(1e-30, s2 / m - mu * mu));
    // 지연률(도플러 차) — 4 ms 기록은 주파수 분해능이 약 250 Hz 라 FDOA(몇~몇십 Hz)를 못 잰다. 실제처럼 긴 기록(0.25 s · 1 Ms/s)을
    //   seg 토막으로 나눠, 찾은 지연에서 토막마다 상관 위상을 구하고 그 기울기(= 2π·도플러 차)를 잰다 — VLBI 의 지연률(fringe rate)과 같다
    const fsL = o.fsL || 1e6, NL = o.NL || 262144, segL = o.segL || 32;
    const m1 = Math.sqrt(1 / (o.snr1 || 1)), m2 = Math.sqrt(1 / (o.snr2 || 1)), RL = rng((o.seed || 3) + 17);
    const Ls = NL / segL, phs = [], amps = [];
    //   지연은 앞에서 찾은 값으로 이미 보정(2번 기록을 그만큼 당김)했다고 보고, 두 기록이 같은 하늘 신호 표본을 갖게 한다 — 남는 것은 도플러 차의 위상 회전과 각 국의 잡음
    for (let q = 0; q < segL; q++) {
      let re = 0, im = 0;
      for (let n = q * Ls; n < (q + 1) * Ls; n++) {
        const sr0 = RL.n() * Math.SQRT1_2, si0 = RL.n() * Math.SQRT1_2;
        const ar1 = sr0 + m1 * RL.n() * Math.SQRT1_2, ai1 = si0 + m1 * RL.n() * Math.SQRT1_2;
        const rot = 2 * Math.PI * (o.dfHz || 0) * n / fsL, c = Math.cos(rot), sn = Math.sin(rot);
        const br1 = sr0 * c - si0 * sn + m2 * RL.n() * Math.SQRT1_2, bi1 = sr0 * sn + si0 * c + m2 * RL.n() * Math.SQRT1_2;
        re += br1 * ar1 + bi1 * ai1; im += bi1 * ar1 - br1 * ai1;          // x2 · conj(x1)
      }
      phs.push(Math.atan2(im, re)); amps.push(Math.hypot(re, im));
    }
    for (let q = 1; q < segL; q++) { while (phs[q] - phs[q - 1] > Math.PI) phs[q] -= 2 * Math.PI; while (phs[q] - phs[q - 1] < -Math.PI) phs[q] += 2 * Math.PI; }
    let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let q = 0; q < segL; q++) { const t = (q + 0.5) * Ls / fsL; sx += t; sy += phs[q]; sxx += t * t; sxy += t * phs[q]; }
    const slope = (segL * sxy - sx * sy) / (segL * sxx - sx * sx);
    const half = 256, lagAxis = [], ampOut = [];
    for (let k = -half; k <= half; k++) { lagAxis.push(k / fs); ampOut.push(am(Math.round(lag) + k)); }
    const shift = Math.round(lag);
    return { tauEst: lag / fs, tauTrue: o.tau, dfEst: slope / (2 * Math.PI), dfTrue: o.dfHz || 0, peakSnr: (y1 - mu) / sd, lagAxis: lagAxis.map((v) => v + shift / fs), amp: ampOut, phs, phT: phs.map((_, q) => (q + 0.5) * Ls / fsL), fs, N, fsL, NL };
  }

  // ── 시나리오(가상) — 교란원 · 움직임 ──
  const KN = 0.514444;
  const SCEN = {
    fixed: { name: '고정 지상 교란원', where: '해주 일대(가상 시나리오)', lat: 38.040, lon: 125.715, agl: 40, eirpW: 3000, bw: 2e6, type: 'noise', mode: '2d', fdoa: false, model: 'Jam_Tower',
      note: '공개 보도된 교란 사례에 기댄 가상 시나리오 — 출력·자리는 모의값' },
    ship: { name: '선박 탑재 이동 교란원', where: '연평도 서쪽 바다', path: [[37.700, 125.300], [37.640, 125.560]], speedKn: 10, agl: 12, eirpW: 10, bw: 10e6, type: 'chirp', mode: '2d', fdoa: true, model: 'Ship_Fishing',
      note: '처프형(10 MHz 훑기) · FDOA 로 속도까지' },
    drone: { name: '드론 교란원', where: '인천공항 남쪽 접근로', lat: 37.405, lon: 126.505, agl: 300, eirpW: 1, bw: 2e6, type: 'noise', mode: '3d', fdoa: false, model: 'Drone', orbitM: 400,
      note: '높이까지 푼다(3차원) — 기준점이 모두 땅에 있어 높이 정밀도는 약하다' },
  };
  function jamAtTime(D, key, t) {                    // 시각 t(s, 교란 시작 = 0)의 교란원 자리·속도
    const S = SCEN[key];
    if (S.path) {
      const [a, b] = S.path, d = gcDist(a[0], a[1], b[0], b[1]), v = S.speedKn * KN, f = Math.min(1, (v * t) / d);
      const lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
      const ve = (b[1] - a[1]) * D2R * RE * Math.cos(lat * D2R) / d * v, vn = (b[0] - a[0]) * D2R * RE / d * v;
      return { lat, lon, hAsl: D.at(lat, lon) + S.agl, eirpW: S.eirpW, bw: S.bw, type: S.type, vel: [ve, vn] };
    }
    if (S.orbitM) {
      const w = 12 / S.orbitM, ang = w * t, lat = S.lat + S.orbitM * Math.sin(ang) / RE / D2R, lon = S.lon + S.orbitM * Math.cos(ang) / (RE * Math.cos(S.lat * D2R)) / D2R;
      return { lat, lon, hAsl: D.at(lat, lon) + S.agl, eirpW: S.eirpW, bw: S.bw, type: S.type, vel: [-12 * Math.sin(ang), 12 * Math.cos(ang)] };
    }
    return { lat: S.lat, lon: S.lon, hAsl: D.at(S.lat, S.lon) + S.agl, eirpW: S.eirpW, bw: S.bw, type: S.type, vel: [0, 0] };
  }

  const API = { SCEN, jamAtTime, KN, C, F_L1, LAM, GPS_S_DBM, JS_DEGRADE, JS_LOSS, CLOCKS, ecef, geod, frame, dem, path, knife, jamAt, state, clockSigma, sdrNoiseDbm, corrStats, solve, footprint, corrDemo, gcDist, rng, db, undb };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.JamCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
