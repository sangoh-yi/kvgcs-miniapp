/* wxtomo_core.js — '동네 단위 10분 뒤 소나기 예보' 모의의 계산 핵심(2026-10-05 센터장님 "1·2·5번 시뮬레이션 만들어 봐 …").
 *   VLBI 가 대류권 지연을 추정하는 방식(사상함수 × 천정 지연 + 경도)을 GNSS 위성기준점·조밀망에 넓혀, 경사 습윤 지연(SWD)으로
 *   대기 수증기를 3차원 단층 영상으로 되살리고, 가강수량(PWV)의 늘어남·이동으로 10·20·30분 뒤 소나기를 읍면동마다 알린다.
 *   브라우저(웹 워커)와 Node(wxtomo_check.js) 양쪽에서 돈다. 화면은 wxtomo3d.js · wxtomo.html.
 *
 *   좌표: 세종 중심(36.54°N 127.27°E)의 국지 평면 — x 동 · y 북 · z 높이(km, 해발). GPS 위성은 IGS 최종궤도(ECEF km).
 *   참 대기(모의): 배경 수증기 e = e0·exp(−z/Hw) + 대류 세포(가우스, 생성 → 성장 → 비 → 소멸, 바람 따라 이동) · 기온 T = T0 − 6.5 z
 *   굴절률 N_wet = k2'·e/T + k3·e/T²  (k2' 22.1 K/hPa · k3 3.739e5 K²/hPa, e hPa) — SWD(mm) = ∫ N_wet ds(km)
 */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180;
  const K2P = 22.1, K3 = 3.739e5;                 // K/hPa · K²/hPa (Bevis 1994)
  const A_WGS = 6378137.0, F_WGS = 1 / 298.257223563, E2 = F_WGS * (2 - F_WGS);
  const ZTOP = 10.0;                              // 대기 위 끝(km) — 그 위 수증기는 무시(전체의 0.1 % 안)

  // ── 기하 ──────────────────────────────────────────────────────────────
  function geo(meta) {
    const lat0 = meta.center.lat, lon0 = meta.center.lon, KX = meta.km_per_deg[0], KY = meta.km_per_deg[1];
    const xy2ll = (x, y) => [lat0 + y / KY, lon0 + x / KX];
    const ll2xy = (la, lo) => [(lo - lon0) * KX, (la - lat0) * KY];
    function ecef(la, lo, h) {
      const s = Math.sin(la * D2R), c = Math.cos(la * D2R), n = A_WGS / Math.sqrt(1 - E2 * s * s);
      return [(n + h) * c * Math.cos(lo * D2R) / 1000, (n + h) * c * Math.sin(lo * D2R) / 1000, (n * (1 - E2) + h) * s / 1000];
    }
    return { lat0, lon0, xy2ll, ll2xy, ecef };
  }

  // 위성 방향(국지 동·북·위 단위 벡터) · 고도각 — 위성 ECEF km, 국 위경도
  function look(sat, sta) {
    const dx = sat[0] - sta.X[0], dy = sat[1] - sta.X[1], dz = sat[2] - sta.X[2], r = Math.hypot(dx, dy, dz);
    const sl = Math.sin(sta.lat * D2R), cl = Math.cos(sta.lat * D2R), so = Math.sin(sta.lon * D2R), co = Math.cos(sta.lon * D2R);
    const e = (-so * dx + co * dy) / r, n = (-sl * co * dx - sl * so * dy + cl * dz) / r, u = (cl * co * dx + cl * so * dy + sl * dz) / r;
    return { e, n, u, el: Math.asin(u), az: Math.atan2(e, n) };
  }

  function satAt(sats, prn, t_utc_s) {      // 1분 표 선형 보간(위성은 1분에 약 230 km — 보간 오차는 방향으로 0.0005° 안)
    const S = sats.sats[prn]; if (!S) return null;
    const f = (t_utc_s - sats.t0_utc_s) / sats.step_s, i = Math.max(0, Math.min(sats.n - 2, Math.floor(f))), a = f - i;
    const p = i * 3, q = p + 3;
    return [S[p] + (S[q] - S[p]) * a, S[p + 1] + (S[q + 1] - S[p + 1]) * a, S[p + 2] + (S[q + 2] - S[p + 2]) * a];
  }

  // ── 지형 ──────────────────────────────────────────────────────────────
  function demSampler(dem) {
    const n = dem.n, half = dem.half_km, H = dem.h;
    return function (x, y) {
      const j = (x + half) / (2 * half) * (n - 1), i = (half - y) / (2 * half) * (n - 1);
      const i0 = Math.max(0, Math.min(n - 2, Math.floor(i))), j0 = Math.max(0, Math.min(n - 2, Math.floor(j)));
      const a = Math.min(1, Math.max(0, i - i0)), b = Math.min(1, Math.max(0, j - j0));
      const f = (ii, jj) => H[ii * n + jj] / 10000;      // dm → km
      return (1 - a) * ((1 - b) * f(i0, j0) + b * f(i0, j0 + 1)) + a * ((1 - b) * f(i0 + 1, j0) + b * f(i0 + 1, j0 + 1));
    };
  }

  // ── 시나리오(참 대기) ─────────────────────────────────────────────────
  //   세포: x·y(0분 자리, km) · t0 생김(분) · tg 자람(분, 가강수량이 쌓이는 시간 — 문헌상 소나기 30~60분 전 PWV 5~10 mm 상승) ·
  //         tr 비(분) · td 사그라듦(분) · amp 핵 수증기 더함(hPa, 높이 zc — 3 hPa 면 PWV 약 +8 mm) · sig 가로 크기(km) · rr 비 세기 최댓값(mm/h)
  function scenarios(G) {
    const at = (la, lo) => G.ll2xy(la, lo);
    const P = (name, la, lo, kind, real) => { const [x, y] = at(la, lo); return { name, x, y, kind, real }; };
    const ADM = (nm, dx, dy) => ({ ref: nm, dx: dx || 0, dy: dy || 0 });  // 읍면동 가운데 기준 자리(만들 때 풀어 넣음)
    return [
      { id: 's1', name: '여름 오후 국지 소나기', desc: '바람이 약한 한여름 오후, 아파트 단지 위에서 소나기 세포가 갑자기 생겼다 사라진다(도시 열섬·지형 상승).',
        t0_utc_s: 5 * 3600, dur: 120, T0: 304.2, e0: 31, Hw: 2.0, grad: [-0.06, 0.03], wind: [0.13, 0.05],
        cells: [
          { at: ADM('고운동', 0.3, 0.2), t0: 8, tg: 34, tr: 24, td: 16, amp: 3.2, sig: 2.6, zc: 2.2, rr: 48 },
          { at: ADM('나성동', -0.4, 0.4), t0: 28, tg: 30, tr: 22, td: 14, amp: 3.0, sig: 2.2, zc: 2.0, rr: 42 },
          { at: ADM('조치원읍', -0.6, -1.0), t0: 52, tg: 32, tr: 20, td: 14, amp: 2.9, sig: 3.0, zc: 2.3, rr: 36 },
          { at: ADM('금남면', 0.8, 1.2), t0: 66, tg: 28, tr: 20, td: 12, amp: 2.7, sig: 2.0, zc: 1.9, rr: 32 },
        ], band: null, pois: [] },
      { id: 's2', name: '장마 띠 통과', desc: '정체전선의 비구름 띠가 남쪽에서 올라와 세종을 지난다. 띠 안에 세포가 줄지어 생기고 사라진다.',
        t0_utc_s: 6 * 3600, dur: 120, T0: 299.5, e0: 29, Hw: 2.0, grad: [0.0, -0.05], wind: [0.08, 0.36],   // 지표 26.4°C · 습도 약 85 %(포화를 넘지 않게)
        band: { y0: -30, ang: 14, sw: 4.2, sl: 45, amp: 2.6, zc: 2.6 },
        cells: [-16, -9, -2, 5, 12, 19].map((xx, k) => ({ x: xx, y: -30 + 0.0 * k, t0: 6 + 9 * (k % 3), tg: 26, tr: 26, td: 14, amp: 2.4, sig: 2.4, zc: 2.4, rr: 30, band: true }))
          .concat([-12, -4, 4, 13].map((xx, k) => ({ x: xx, y: -46, t0: 44 + 8 * k, tg: 26, tr: 24, td: 12, amp: 2.3, sig: 2.3, zc: 2.4, rr: 28, band: true }))),
        pois: [] },
      { id: 's3', name: '금강 둔치·지하차도 침수 경보', desc: '거의 멈춘 비구름이 금강 둔치 위에서 잇달아 생긴다(뒤쪽 세움). 둔치 산책로·지하차도·학교에 30분 앞서 알린다.',
        t0_utc_s: 7 * 3600, dur: 120, T0: 302.0, e0: 32, Hw: 2.1, grad: [0.02, 0.0], wind: [0.06, 0.03],
        cells: [0, 1, 2, 3, 4, 5].map((k) => ({ at: ADM('대평동', -1.6 + 0.15 * k, -0.6), t0: 6 + 14 * k, tg: 24, tr: 26, td: 14, amp: 3.4, sig: 2.1, zc: 2.1, rr: 55 }))
          .concat([{ at: ADM('금남면', -1.5, 2.4), t0: 40, tg: 26, tr: 24, td: 12, amp: 3.0, sig: 2.0, zc: 2.0, rr: 40 }]),
        band: null,
        pois: [P('금강 둔치 산책로', 36.4795, 127.2652, 'park', true), P('세종호수공원', 36.4986, 127.2710, 'park', true),
               P('○○ 지하차도(가정)', 36.4705, 127.2900, 'underpass', false), P('○○ 초등학교(가정)', 36.4850, 127.2560, 'school', false),
               P('둔치 주차장(가정)', 36.4770, 127.2795, 'parking', false)] },
    ];
  }

  function resolveScen(sc, adm) {
    for (const c of sc.cells) {
      if (c.at) {
        const a = adm.find((u) => u.name === c.at.ref);
        c.x = (a ? a.c[0] : 0) + c.at.dx; c.y = (a ? a.c[1] : 0) + c.at.dy;
      }
    }
    return sc;
  }

  const sstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  function lifeA(c, t) {                       // 세포 세기(0~1): 자람 → 비(빗물로 줄어 0.55) → 사그라듦
    const s = t - c.t0;
    if (s <= 0) return 0;
    if (s < c.tg) return sstep(s / c.tg);
    if (s < c.tg + c.tr) return 1 - 0.45 * (s - c.tg) / c.tr;
    const d = s - c.tg - c.tr;
    return d > 3 * c.td ? 0 : 0.55 * Math.exp(-d / c.td);
  }
  function lifeR(c, t) {                       // 비 세기(0~1): 자람 끝 4분 앞부터 비 시간 끝까지
    const s = t - c.t0 - c.tg + 4, L = c.tr + 4;
    if (s <= 0 || s >= L) return 0;
    return Math.sin(Math.PI * s / L) ** 0.8;
  }
  function cellPos(sc, c, t) { return [c.x + sc.wind[0] * t, c.y + sc.wind[1] * t]; }

  function esat(T) { const tc = T - 273.15; return 6.112 * Math.exp(17.62 * tc / (243.12 + tc)); }   // Magnus(hPa)

  function makeField(sc) {
    const cells = sc.cells, w = sc.wind;
    function eAt(x, y, z, t, cellOn) {
      const T = sc.T0 - 6.5 * z;
      let e = sc.e0 * (1 + sc.grad[0] * x / 10 + sc.grad[1] * y / 10) * Math.exp(-z / sc.Hw);
      if (cellOn !== false) {
        if (sc.band) {
          const b = sc.band, by = b.y0 + w[1] * t, bx = w[0] * t, ca = Math.cos(b.ang * D2R), sa = Math.sin(b.ang * D2R);
          const u = (x - bx) * ca + (y - by) * sa, v = -(x - bx) * sa + (y - by) * ca;
          e += b.amp * Math.exp(-0.5 * (v / b.sw) ** 2 - 0.5 * (u / b.sl) ** 2) * Math.exp(-(((z - b.zc) / 2.4) ** 2));
        }
        for (let k = 0; k < cells.length; k++) {
          const c = cells[k], A = lifeA(c, t);
          if (A <= 0) continue;
          const cx = c.x + w[0] * t, cy = c.y + w[1] * t, sg = c.sig * (0.85 + 0.25 * A);
          const r2 = (x - cx) ** 2 + (y - cy) ** 2;
          if (r2 > 25 * sg * sg) continue;
          e += c.amp * A * Math.exp(-0.5 * r2 / (sg * sg)) * Math.exp(-(((z - c.zc) / 2.1) ** 2));
        }
      }
      return Math.min(e, 0.98 * esat(T));
    }
    function nAt(x, y, z, t, cellOn) { const T = sc.T0 - 6.5 * z, e = eAt(x, y, z, t, cellOn); return K2P * e / T + K3 * e / (T * T); }
    function rainAt(x, y, t) {
      let r = 0;
      for (const c of cells) {
        const R = lifeR(c, t); if (R <= 0) continue;
        const cx = c.x + w[0] * t, cy = c.y + w[1] * t, sg = 0.72 * c.sig;
        r += c.rr * R * Math.exp(-0.5 * ((x - cx) ** 2 + (y - cy) ** 2) / (sg * sg));
      }
      return r;
    }
    return { eAt, nAt, rainAt };
  }

  // ── 격자 ──────────────────────────────────────────────────────────────
  const TG = { half: 30, dx: 1.0, dz: 0.25 };                       // 참 대기 표본 격자(광선 적분용)
  const VX = { half: 30, dx: 2.0, ze: [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 3.6, 4.3, 5.2, 6.4, 8.0, 10.0] };   // 단층 영상 복셀
  VX.nx = Math.round(2 * VX.half / VX.dx); VX.nz = VX.ze.length - 1; VX.n = VX.nx * VX.nx * VX.nz;
  const MG = { half: 30, dx: 1.0 }; MG.n = Math.round(2 * MG.half / MG.dx) + 1;                // 지도 격자(61×61, 1 km)

  function truthGrid(F, t) {
    const nx = Math.round(2 * TG.half / TG.dx) + 1, nz = Math.round(ZTOP / TG.dz) + 1, g = new Float32Array(nx * nx * nz);
    for (let k = 0; k < nz; k++) {
      const z = k * TG.dz;
      for (let i = 0; i < nx; i++) {
        const y = -TG.half + i * TG.dx;
        for (let j = 0; j < nx; j++) g[(k * nx + i) * nx + j] = F.nAt(-TG.half + j * TG.dx, y, z, t);
      }
    }
    return { g, nx, nz };
  }
  function sampleTG(TGd, F, x, y, z, t) {
    const fx = (x + TG.half) / TG.dx, fy = (y + TG.half) / TG.dx, fz = z / TG.dz, nx = TGd.nx;
    if (fx < 0 || fy < 0 || fx > nx - 1.001 || fy > nx - 1.001) return F.nAt(x, y, z, t, false);   // 영역 밖 = 배경
    const j = Math.floor(fx), i = Math.floor(fy), k = Math.min(TGd.nz - 2, Math.max(0, Math.floor(fz)));
    const a = fx - j, b = fy - i, c = Math.min(1, Math.max(0, fz - k)), g = TGd.g;
    const o = (k * nx + i) * nx + j, s = nx * nx;
    const v00 = g[o] * (1 - a) + g[o + 1] * a, v01 = g[o + nx] * (1 - a) + g[o + nx + 1] * a;
    const v10 = g[o + s] * (1 - a) + g[o + s + 1] * a, v11 = g[o + s + nx] * (1 - a) + g[o + s + nx + 1] * a;
    return ((v00 * (1 - b) + v01 * b) * (1 - c) + (v10 * (1 - b) + v11 * b) * c);
  }

  // 사상함수 — Niell(1996) 습윤, 위도 36.5° 보간(계수: 30° · 45°) · 경도 사상(Chen & Herring 1997)
  const NW = (() => { const f = (36.5 - 30) / 15, A = [5.6794e-4, 5.8118e-4], B = [1.5138e-3, 1.4572e-3], C = [4.6729e-2, 4.3908e-2];
    return [A[0] + (A[1] - A[0]) * f, B[0] + (B[1] - B[0]) * f, C[0] + (C[1] - C[0]) * f]; })();
  function mfWet(el) { const s = Math.sin(el), [a, b, c] = NW; return (1 + a / (1 + b / (1 + c))) / (s + a / (s + b / (s + c))); }
  function mfGrad(el) { return 1 / (Math.sin(el) * Math.tan(el) + 0.0032); }

  // 가랑비 PWV 환산(Bevis 1992 · 1994): Π = 10⁶ / (ρw·Rv·(k3/Tm + k2'))  · Tm = 70.2 + 0.72·Ts
  function piFactor(Ts) { const Tm = 70.2 + 0.72 * Ts; return 1e6 / (1000 * 461.5 * (K3 / 100 / Tm + K2P / 100)); }

  // ── 관측: 경사 습윤 지연 ──────────────────────────────────────────────
  //   한 국·한 위성: 국에서 위성 쪽으로 위 끝(10 km)까지 0.1 km 걸음으로 N_wet 를 더한다(직선 — 굽음은 고도 15° 위에서 무시할 만함)
  function rays(stations, sats, t_utc_s, cfg) {
    const out = [], cut = (cfg.elcut || 15) * D2R, prns = Object.keys(sats.sats);
    for (let s = 0; s < stations.length; s++) {
      const st = stations[s];
      for (const prn of prns) {
        const sp = satAt(sats, prn, t_utc_s); if (!sp) continue;
        const L = look(sp, st); if (L.el < cut) continue;
        out.push({ s, prn, el: L.el, az: L.az, d: [L.e, L.n, L.u] });
      }
    }
    return out;
  }
  function integrate(TGd, F, st, d, t, ds) {
    const z0 = st.z, L = (ZTOP - z0) / d[2]; let sum = 0;
    for (let s = ds / 2; s < L; s += ds) {
      const x = st.x + d[0] * s, y = st.y + d[1] * s, z = z0 + d[2] * s;
      sum += sampleTG(TGd, F, x, y, z, t);
    }
    return sum * ds;                              // mm(N ppm × km)
  }

  // 국별 천정 습윤 지연·경도(VLBI·GNSS 해석과 같은 식): SWD = m_w(e)·ZWD + m_g(e)·(G_N·cos A + G_E·sin A)
  function zwdFit(obs) {
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const o of obs) {
      const r = [mfWet(o.el), mfGrad(o.el) * Math.cos(o.az), mfGrad(o.el) * Math.sin(o.az)], w = 1 / (o.sig * o.sig);
      for (let i = 0; i < 3; i++) { b[i] += w * r[i] * o.y; for (let j = 0; j < 3; j++) N[i][j] += w * r[i] * r[j]; }
    }
    const x = solve3(N, b); if (!x) return null;
    let chi = 0; for (const o of obs) { const p = mfWet(o.el) * x[0] + mfGrad(o.el) * (Math.cos(o.az) * x[1] + Math.sin(o.az) * x[2]); chi += ((o.y - p) / o.sig) ** 2; }
    const inv = inv3(N);
    return { zwd: x[0], gn: x[1], ge: x[2], s_zwd: Math.sqrt(inv[0][0]), wrms: Math.sqrt(chi / Math.max(1, obs.length - 3)), n: obs.length };
  }
  function solve3(A, b) { const I = inv3(A); if (!I) return null; return [0, 1, 2].map((i) => I[i][0] * b[0] + I[i][1] * b[1] + I[i][2] * b[2]); }
  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2], A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (!det) return null;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }

  // ── 단층 영상 ─────────────────────────────────────────────────────────
  //   미지수 δ = N_wet − N_사전(복셀) · 관측식 y' = y − A·x_사전 − (영역 밖 길) = A·δ + 잡음
  //   최소 Σ w(A·δ − y')² + λh‖가로 라플라스 δ‖² + λv‖세로 차 δ‖² + λ0‖δ‖² → 켤레기울기(CG) · 또는 ART(Kaczmarz)
  function vIdx(x, y, z) {
    const j = Math.floor((x + VX.half) / VX.dx), i = Math.floor((y + VX.half) / VX.dx);
    if (j < 0 || i < 0 || j >= VX.nx || i >= VX.nx || z < 0 || z >= ZTOP) return -1;
    let k = 0; while (k < VX.nz - 1 && z >= VX.ze[k + 1]) k++;
    return (k * VX.nx + i) * VX.nx + j;
  }
  function priorModel(sc, cfg) {                     // 사전(수치예보 배경 꼴): e0·Hw 를 일부러 조금 틀리게 — 자료가 고친다
    const e0 = sc.e0 * (cfg.prior_e0 || 0.93), Hw = sc.Hw * (cfg.prior_hw || 1.08);
    return (z) => { const T = sc.T0 - 6.5 * z, e = e0 * Math.exp(-z / Hw); return K2P * e / T + K3 * e / (T * T); };
  }
  function buildRows(obsList, stations, priorN, ds) {
    const ptr = [0], idx = [], len = [], y = [], w = [];
    for (const o of obsList) {
      const st = stations[o.s], d = o.d, L = (ZTOP - st.z) / d[2];
      let outside = 0, prev = -2, acc = 0, prior = 0;
      const row = new Map();
      for (let s = ds / 2; s < L; s += ds) {
        const x = st.x + d[0] * s, yy = st.y + d[1] * s, z = st.z + d[2] * s, v = vIdx(x, yy, z), pn = priorN(z);
        if (v < 0) { outside += pn * ds; continue; }
        prior += pn * ds;
        row.set(v, (row.get(v) || 0) + ds);
      }
      for (const [k, l] of row) { idx.push(k); len.push(l); }
      ptr.push(idx.length);
      y.push(o.y - prior - outside); w.push(1 / (o.sig * o.sig));
    }
    return { ptr: Int32Array.from(ptr), idx: Int32Array.from(idx), len: Float32Array.from(len), y: Float64Array.from(y), w: Float64Array.from(w), m: obsList.length };
  }
  function Ax(R, x, out) { for (let r = 0; r < R.m; r++) { let s = 0; for (let q = R.ptr[r]; q < R.ptr[r + 1]; q++) s += R.len[q] * x[R.idx[q]]; out[r] = s; } return out; }
  function ATx(R, v, out) { out.fill(0); for (let r = 0; r < R.m; r++) { const a = v[r]; if (!a) continue; for (let q = R.ptr[r]; q < R.ptr[r + 1]; q++) out[R.idx[q]] += R.len[q] * a; } return out; }
  function regOp(x, out, lam) {                      // λh·LhᵀLh + λv·LvᵀLv + λ0·I (층마다 위로 갈수록 λ0 크게)
    const nx = VX.nx, nz = VX.nz;
    out.fill(0);
    for (let k = 0; k < nz; k++) {
      const l0 = lam.l0 * (1 + 2 * k / nz);
      for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++) {
        const o = (k * nx + i) * nx + j;
        out[o] += l0 * x[o];
        if (j + 1 < nx) { const d = x[o] - x[o + 1]; out[o] += lam.lh * d; out[o + 1] -= lam.lh * d; }
        if (i + 1 < nx) { const d = x[o] - x[o + nx]; out[o] += lam.lh * d; out[o + nx] -= lam.lh * d; }
        if (k + 1 < nz) { const d = x[o] - x[o + nx * nx]; out[o] += lam.lv * d; out[o + nx * nx] -= lam.lv * d; }
      }
    }
    return out;
  }
  function tomoCG(R, lam, iters) {
    const n = VX.n, x = new Float64Array(n), b = new Float64Array(n), r = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
    const tm = new Float64Array(R.m), tn = new Float64Array(n), wy = new Float64Array(R.m);
    for (let i = 0; i < R.m; i++) wy[i] = R.w[i] * R.y[i];
    ATx(R, wy, b); r.set(b); p.set(r);
    let rr = 0; for (let i = 0; i < n; i++) rr += r[i] * r[i];
    const rr0 = rr;
    let it = 0;
    for (; it < iters && rr > 1e-10 * rr0; it++) {
      Ax(R, p, tm); for (let i = 0; i < R.m; i++) tm[i] *= R.w[i];
      ATx(R, tm, q); regOp(p, tn, lam); for (let i = 0; i < n; i++) q[i] += tn[i];
      let pq = 0; for (let i = 0; i < n; i++) pq += p[i] * q[i];
      const a = rr / pq; let rn = 0;
      for (let i = 0; i < n; i++) { x[i] += a * p[i]; r[i] -= a * q[i]; rn += r[i] * r[i]; }
      const bt = rn / rr; rr = rn;
      for (let i = 0; i < n; i++) p[i] = r[i] + bt * p[i];
    }
    return { x, it, rel: Math.sqrt(rr / rr0) };
  }
  function tomoART(R, lam, sweeps) {                 // ART(곱셈 없는 Kaczmarz) + 걸음마다 가로 평활
    const n = VX.n, x = new Float64Array(n), nrm = new Float64Array(R.m), tn = new Float64Array(n);
    for (let r = 0; r < R.m; r++) { let s = 0; for (let q = R.ptr[r]; q < R.ptr[r + 1]; q++) s += R.len[q] * R.len[q]; nrm[r] = s; }
    for (let sw = 0; sw < sweeps; sw++) {
      for (let r = 0; r < R.m; r++) {
        if (!nrm[r]) continue;
        let s = 0; for (let q = R.ptr[r]; q < R.ptr[r + 1]; q++) s += R.len[q] * x[R.idx[q]];
        const f = 0.25 * (R.y[r] - s) / nrm[r];
        for (let q = R.ptr[r]; q < R.ptr[r + 1]; q++) x[R.idx[q]] += f * R.len[q];
      }
      regOp(x, tn, { lh: 0.08, lv: 0.02, l0: 0.0 });
      for (let i = 0; i < n; i++) x[i] -= 0.5 * tn[i] * (lam.art_smooth || 1);
    }
    return { x, it: sweeps, rel: NaN };
  }

  // ── 지도 ──────────────────────────────────────────────────────────────
  function truthPWV(F, dem, sc, t) {                 // 참 PWV(mm) — 땅 높이부터 위 끝까지 N_wet 적분 × Π
    const n = MG.n, out = new Float32Array(n * n), dz = 0.1, pi = piFactor(sc.T0);
    for (let i = 0; i < n; i++) { const y = MG.half - i * MG.dx;
      for (let j = 0; j < n; j++) { const x = -MG.half + j * MG.dx, z0 = dem(x, y); let s = 0;
        for (let z = z0 + dz / 2; z < ZTOP; z += dz) s += F.nAt(x, y, z, t);
        out[i * n + j] = s * dz * pi; } }
    return out;
  }
  function reconPWV(xd, priorN, dem, sc) {           // 복원 PWV — 복셀 N(사전 + δ)를 쌍선형으로 지도 격자에
    const n = MG.n, out = new Float32Array(n * n), pi = piFactor(sc.T0), nx = VX.nx;
    const col = (ii, jj, z0) => { let s = 0;
      for (let k = 0; k < VX.nz; k++) { const za = Math.max(VX.ze[k], z0), zb = VX.ze[k + 1]; if (zb <= za) continue;
        const zm = 0.5 * (za + zb); s += (priorN(zm) + xd[(k * nx + ii) * nx + jj]) * (zb - za); }
      return s; };
    for (let i = 0; i < n; i++) { const y = MG.half - i * MG.dx;
      for (let j = 0; j < n; j++) { const x = -MG.half + j * MG.dx, z0 = dem(x, y);
        const fj = (x + VX.half) / VX.dx - 0.5, fi = (y + VX.half) / VX.dx - 0.5;
        const j0 = Math.max(0, Math.min(nx - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(nx - 2, Math.floor(fi)));
        const a = Math.min(1, Math.max(0, fj - j0)), b = Math.min(1, Math.max(0, fi - i0));
        const v = (1 - b) * ((1 - a) * col(i0, j0, z0) + a * col(i0, j0 + 1, z0)) + b * ((1 - a) * col(i0 + 1, j0, z0) + a * col(i0 + 1, j0 + 1, z0));
        out[i * n + j] = v * pi; } }
    return out;
  }
  function priorPWV(priorN, dem, sc) {              // 사전(배경) PWV — 땅 높이부터 적분해 지형 효과(산 위는 작다)를 담는다
    const n = MG.n, out = new Float32Array(n * n), dz = 0.1, pi = piFactor(sc.T0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const x = -MG.half + j * MG.dx, y = MG.half - i * MG.dx, z0 = dem(x, y); let s = 0;
      for (let z = z0 + dz / 2; z < ZTOP; z += dz) s += priorN(z); out[i * n + j] = s * dz * pi; }
    return out;
  }
  function rainMap(F, t) { const n = MG.n, out = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = F.rainAt(-MG.half + j * MG.dx, MG.half - i * MG.dx, t);
    return out; }
    function blur(m, sg) {                            // 가르기 가능 가우스 평활(km) — 가장자리는 있는 점만 평균
    const n = MG.n, r = Math.ceil(3 * sg), w = []; for (let d = -r; d <= r; d++) w.push(Math.exp(-0.5 * (d / sg) ** 2));
    const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = 0, ws = 0; for (let d = -r; d <= r; d++) { const jj = j + d; if (jj < 0 || jj >= n) continue; s += w[d + r] * m[i * n + jj]; ws += w[d + r]; } tmp[i * n + j] = s / ws; }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = 0, ws = 0; for (let d = -r; d <= r; d++) { const ii = i + d; if (ii < 0 || ii >= n) continue; s += w[d + r] * tmp[ii * n + j]; ws += w[d + r]; } out[i * n + j] = s / ws; }
    return out;
  }
  // PWV 이상 = PWV − 큰 규모(가우스 7 km 평활) — 배경 수증기 경도(동서 수 mm)는 빼고 대류 세포(2~4 km)만 남긴다
  //   먼저 사전 PWV(지형 반영)를 빼야 산·골짜기 무늬가 세포로 잡히지 않는다
  function anomaly(m, ref) { const d = new Float32Array(m.length); for (let k = 0; k < m.length; k++) d[k] = m[k] - (ref ? ref[k] : 0);
    const b = blur(d, 7.0), out = new Float32Array(m.length); for (let k = 0; k < m.length; k++) out[k] = d[k] - b[k]; return out; }
  function shiftMap(m, sx, sy) {                    // 지도를 (sx, sy) km 만큼 옮긴다(쌍선형, 밖은 0)
    const n = MG.n, out = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const fj = j - sx / MG.dx, fi = i + sy / MG.dx, j0 = Math.floor(fj), i0 = Math.floor(fi), a = fj - j0, b = fi - i0;
      if (j0 < 0 || i0 < 0 || j0 >= n - 1 || i0 >= n - 1) continue;
      out[i * n + j] = (1 - b) * ((1 - a) * m[i0 * n + j0] + a * m[i0 * n + j0 + 1]) + b * ((1 - a) * m[(i0 + 1) * n + j0] + a * m[(i0 + 1) * n + j0 + 1]);
    }
    return out;
  }
  // 이동(km/분) — 전역 루카스–카나데(밝기 보존 ∂P/∂t + v·∇P = 0)를 되풀이 와핑으로 푼다. 띠처럼 길쭉한 구름은 길이 방향 이동이
  //   정해지지 않으므로(구경 문제) 약한 정규화 μ 로 그 방향을 0 쪽에 붙잡는다. 이상이 양(+)인 곳(세포)에 무게를 둔다.
  function motion(a, b, dt) {
    const n = MG.n; let v = [0, 0];
    for (let it = 0; it < 5; it++) {
      const w = shiftMap(a, v[0] * dt, v[1] * dt);
      let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0;
      for (let i = 6; i < n - 6; i++) for (let j = 6; j < n - 6; j++) {
        const k = i * n + j, wt = b[k] > 0.8 ? 1 : 0; if (!wt) continue;
        const ix = (b[k + 1] - b[k - 1]) / (2 * MG.dx), iy = (b[k - n] - b[k + n]) / (2 * MG.dx), itt = (b[k] - w[k]) / dt;
        sxx += ix * ix; sxy += ix * iy; syy += iy * iy; sxt += ix * itt; syt += iy * itt;
      }
      const mu = 0.03 * (sxx + syy) + 1e-9, a11 = sxx + mu, a22 = syy + mu, det = a11 * a22 - sxy * sxy;
      if (!(det > 0)) break;
      const dvx = -(a22 * sxt - sxy * syt) / det, dvy = -(a11 * syt - sxy * sxt) / det;
      v = [v[0] + dvx, v[1] + dvy];
      if (Math.hypot(dvx, dvy) < 0.005) break;
    }
    const s = Math.hypot(v[0], v[1]); if (s > 1.5) v = [v[0] * 1.5 / s, v[1] * 1.5 / s];     // 25 m/s 넘으면 자른다
    return v;
  }
  const sig = (u) => 1 / (1 + Math.exp(-u));
  function nowcast(an, anPrev, v, cfg) {             // 10·20·30분 예보 확률 지도
    const tend = new Float32Array(an.length), adv = shiftMap(anPrev, v[0] * 5, v[1] * 5);
    for (let k = 0; k < an.length; k++) tend[k] = (an[k] - adv[k]) / 5;        // 라그랑주 경향(mm/분)
    const out = {};
    for (const L of [10, 20, 30]) {
      const f = new Float32Array(an.length), te = Math.min(L, cfg.trend_cap || 14);
      for (let k = 0; k < an.length; k++) f[k] = an[k] + Math.max(-4, Math.min(6, tend[k] * te));
      const sh = shiftMap(f, v[0] * L, v[1] * L), p = new Float32Array(an.length);
      for (let k = 0; k < an.length; k++) p[k] = sig((sh[k] - cfg.p_th) / cfg.p_s);
      out[L] = p;
    }
    return { tend, p: out };
  }

  // ── 읍면동 ────────────────────────────────────────────────────────────
  function unitCells(adm) {
    const n = MG.n;
    const inside = (px, py, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j]; if ((y1 > py) !== (y2 > py) && px < (x2 - x1) * (py - y1) / (y2 - y1) + x1) c = !c; } return c; };
    return adm.map((u) => {
      const cs = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const x = -MG.half + j, y = MG.half - i; if (u.rings.some((r) => inside(x, y, r))) cs.push(i * n + j); }
      if (!cs.length) { const j = Math.round(u.c[0] + MG.half), i = Math.round(MG.half - u.c[1]); cs.push(i * n + j); }
      return cs;
    });
  }
  function level(p, cfg) { return p >= cfg.warn ? 2 : p >= cfg.watch ? 1 : 0; }

  const DEF = { elcut: 15, sig_real: 3.0, sig_dense: 5.0, epochs: [-4, -2, 0], ds: 0.1, lam: { lh: 0.6, lv: 0.25, l0: 0.04, art_smooth: 1 }, iters: 70,
    method: 'cg', p_th: 3.8, p_s: 0.8, trend_cap: 14, watch: 0.3, warn: 0.6, rain_th: 1.0, step: 5, prior_e0: 0.93, prior_hw: 1.08, seed: 7 };

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; }; }
  function gauss(R) { let u = 0, v = 0; while (u === 0) u = R(); v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ── 한 판(시나리오 하나) ──────────────────────────────────────────────
  //   data = {meta, dem, admin, sta, sats} · opt.progress(f, frame) · 돌려줌: frames(5분마다) · 검증 · 국별 ZWD
  function run(data, scenId, cfgIn, opt) {
    opt = opt || {};
    const cfg = Object.assign({}, DEF, cfgIn || {}); cfg.lam = Object.assign({}, DEF.lam, (cfgIn || {}).lam || {});
    const G = geo(data.meta), dem = demSampler(data.dem);
    const sc = resolveScen(JSON.parse(JSON.stringify(scenarios(G).find((s) => s.id === scenId))), data.admin);
    const F = makeField(sc), priorN = priorModel(sc, cfg), R = rng(cfg.seed);
    const st = data.sta.filter((s) => Math.abs(s.x) <= 30 && Math.abs(s.y) <= 30).map((s) => {
      const [la, lo] = G.xy2ll(s.x, s.y);
      return Object.assign({}, s, { z: s.h / 1000, lat: la, lon: lo, X: G.ecef(la, lo, s.h) });
    });
    const realIdx = st.map((s, i) => (s.real ? i : -1)).filter((i) => i >= 0);
    const cells = unitCells(data.admin), pRef = priorPWV(priorN, dem, sc);
    const frames = [], hist = { dense: [], real: [] };
    const ver = { dense: {}, real: {} }; for (const k of ['dense', 'real']) for (const L of [10, 20, 30]) ver[k][L] = { h: 0, m: 0, f: 0, c: 0 };
    const recErr = { dense: [], real: [] }, zwdErr = [];
    const T0 = 10, T1 = sc.dur - 30;                 // 앞 10분은 이동 추정에 쓸 역사, 끝 30분은 검증 남김
    const truthFut = {};
    for (let t = 0; t <= sc.dur; t += cfg.step) truthFut[t] = rainMap(F, t);
    for (let t = 0; t <= T1 + 0.01; t += cfg.step) {
      const tsec = sc.t0_utc_s + t * 60;
      const TGd = truthGrid(F, t);
      // 관측 — 세 때(−4·−2·0분)의 모든 국·위성
      const obs = [];
      for (const ep of cfg.epochs) {
        const tt = Math.max(0, t + ep), list = rays(st, data.sats, sc.t0_utc_s + tt * 60, cfg);
        const TGe = ep === 0 ? TGd : truthGrid(F, tt);
        for (const o of list) {
          const s = st[o.s], swd = integrate(TGe, F, s, o.d, tt, cfg.ds), sz = (s.real ? cfg.sig_real : cfg.sig_dense) / Math.sin(o.el);
          o.y = swd + sz * gauss(R); o.sig = sz; o.truth = swd; o.ep = ep; obs.push(o);
        }
      }
      // 국별 ZWD(실제 기준점) — VLBI·GNSS 식
      const zw = realIdx.map((i) => {
        const fit = zwdFit(obs.filter((o) => o.s === i)), s = st[i];
        let tz = 0; for (let z = s.z + 0.05; z < ZTOP; z += 0.1) tz += F.nAt(s.x, s.y, z, t) * 0.1;
        if (fit) zwdErr.push(fit.zwd - tz);
        return { id: s.id, est: fit && fit.zwd, s: fit && fit.s_zwd, truth: tz, gn: fit && fit.gn, ge: fit && fit.ge, wrms: fit && fit.wrms, n: fit ? fit.n : 0 };
      });
      // 단층 영상 — 조밀망(+실제) · 실제 기준점만
      const out = { t, t_kst: tsec + 9 * 3600, zwd: zw, nobs: { dense: obs.length, real: obs.filter((o) => st[o.s].real).length } };
      const truthP = truthPWV(F, dem, sc, t), rain = truthFut[t];
      out.truth = truthP; out.rain = rain;
      for (const key of ['dense', 'real']) {
        const use = key === 'dense' ? obs : obs.filter((o) => st[o.s].real);
        const Rw = buildRows(use, st, priorN, cfg.ds);
        const sol = cfg.method === 'art' ? tomoART(Rw, cfg.lam, 8) : tomoCG(Rw, cfg.lam, cfg.iters);
        const pw = reconPWV(sol.x, priorN, dem, sc), an = anomaly(pw, pRef);
        hist[key].push({ t, an });
        let e2 = 0, nn = 0; const ta = anomaly(truthP, pRef);
        for (let i = 15; i < MG.n - 15; i++) for (let j = 15; j < MG.n - 15; j++) { const k = i * MG.n + j; e2 += (an[k] - ta[k]) ** 2; nn++; }
        recErr[key].push(Math.sqrt(e2 / nn));
        if (key === 'dense') out.truthAn = ta;
        const prev = hist[key].find((h) => h.t === t - 5), prev10 = hist[key].find((h) => h.t === t - 10);
        let v = [0, 0], nc = null;
        if (prev && prev10) { v = motion(prev10.an, an, 10); nc = nowcast(an, prev.an, v, cfg); }
        out[key] = { pwv: pw, an, v, it: sol.it, rel: sol.rel, p: nc ? nc.p : null, tend: nc ? nc.tend : null };
        if (key === 'dense') out.vox = Float32Array.from(sol.x);
        // 검증 — 읍면동 × 앞때(10·20·30분): 비(≥ rain_th mm/h)가 오나 · 예보가 '주의' 이상인가
        if (nc && t >= T0) for (const L of [10, 20, 30]) {
          const tr = truthFut[t + L]; if (!tr) continue;
          const A = ver[key][L];
          for (const cs of cells) {
            let pm = 0, rm = 0; for (const k of cs) { if (nc.p[L][k] > pm) pm = nc.p[L][k]; if (tr[k] > rm) rm = tr[k]; }
            const fc = pm >= cfg.watch, ob = rm >= cfg.rain_th;
            if (fc && ob) A.h++; else if (!fc && ob) A.m++; else if (fc && !ob) A.f++; else A.c++;
          }
        }
      }
      // 읍면동 경보(조밀망 10·20·30분) · 지점(POI)
      if (out.dense.p) {
        out.units = cells.map((cs, u) => { const r = {}; for (const L of [10, 20, 30]) { let pm = 0; for (const k of cs) pm = Math.max(pm, out.dense.p[L][k]); r[L] = pm; }
          let rnow = 0; for (const k of cs) rnow = Math.max(rnow, rain[k]); return { name: data.admin[u].name, p: r, lv: level(Math.max(r[10], r[20], r[30]), cfg), rain: rnow }; });
        out.pois = sc.pois.map((q) => { const j = Math.round(q.x + MG.half), i = Math.round(MG.half - q.y), k = i * MG.n + j;
          let pm = 0, when = null; for (const L of [10, 20, 30]) if (out.dense.p[L][k] > pm) { pm = out.dense.p[L][k]; when = L; }
          let acc = 0; for (let tt = t + 5; tt <= t + 30; tt += 5) if (truthFut[tt]) acc += truthFut[tt][k] * 5 / 60;
          return { name: q.name, kind: q.kind, real: q.real, p: pm, when, lv: level(pm, cfg), acc30: acc, rain: rain[k] }; });
      }
      // 화면용 광선 몇 가닥(SEJN + 가까운 조밀망 6곳, 지금 때)
      const pick = new Set([st.findIndex((s) => s.id === 'SEJN')].concat(st.map((s, i) => [Math.hypot(s.x - 1, s.y + 4), i]).filter((a) => !st[a[1]].real).sort((a, b) => a[0] - b[0]).slice(0, 6).map((a) => a[1])));
      out.rays = obs.filter((o) => o.ep === 0 && pick.has(o.s)).map((o) => ({ s: o.s, prn: o.prn, el: o.el, az: o.az, d: o.d, swd: o.y, truth: o.truth }));
      frames.push(out);
      if (opt.progress) opt.progress((t + 5) / (T1 + 5), out);
    }
    const score = (A) => ({ pod: A.h / Math.max(1, A.h + A.m), far: A.f / Math.max(1, A.h + A.f), csi: A.h / Math.max(1, A.h + A.m + A.f), n: A.h + A.m + A.f + A.c, ...A });
    const verOut = {}; for (const k of ['dense', 'real']) { verOut[k] = {}; for (const L of [10, 20, 30]) verOut[k][L] = score(ver[k][L]); }
    const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
    return { scen: { id: sc.id, name: sc.name, desc: sc.desc, t0_utc_s: sc.t0_utc_s, dur: sc.dur, wind: sc.wind, cells: sc.cells, band: sc.band, pois: sc.pois },
      st: st.map((s) => ({ id: s.id, name: s.name, kind: s.kind, real: s.real, x: s.x, y: s.y, z: s.z })),
      frames, ver: verOut, rec: { dense: rms(recErr.dense), real: rms(recErr.real), dense_all: recErr.dense, real_all: recErr.real }, zwd: { rms: rms(zwdErr), n: zwdErr.length },
      cfg, grid: { MG, VX: { half: VX.half, dx: VX.dx, ze: VX.ze, nx: VX.nx, nz: VX.nz } } };
  }

  // 화면이 참 대기를 그릴 때 쓰는 가벼운 도움(세포 자리·세기·비)
  function scenState(data, scenId, t) {
    const G = geo(data.meta), sc = resolveScen(JSON.parse(JSON.stringify(scenarios(G).find((s) => s.id === scenId))), data.admin);
    return { sc, cells: sc.cells.map((c) => ({ x: c.x + sc.wind[0] * t, y: c.y + sc.wind[1] * t, A: lifeA(c, t), R: lifeR(c, t), sig: c.sig, zc: c.zc, rr: c.rr })),
      band: sc.band ? { x: sc.wind[0] * t, y: sc.band.y0 + sc.wind[1] * t, ang: sc.band.ang, sw: sc.band.sw, sl: sc.band.sl } : null };
  }

  // 화면이 복셀 격자에서 참 대기·사전을 그릴 때(가볍다: 11,700점)
  function truthVox(data, scenId, t, cfgIn) {
    const cfg = Object.assign({}, DEF, cfgIn || {}), G = geo(data.meta);
    const sc = resolveScen(JSON.parse(JSON.stringify(scenarios(G).find((s) => s.id === scenId))), data.admin), F = makeField(sc), pr = priorModel(sc, cfg);
    const out = new Float32Array(VX.n), nx = VX.nx;
    for (let k = 0; k < VX.nz; k++) { const zm = 0.5 * (VX.ze[k] + VX.ze[k + 1]), p0 = pr(zm);
      for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++) out[(k * nx + i) * nx + j] = F.nAt(-VX.half + (j + 0.5) * VX.dx, -VX.half + (i + 0.5) * VX.dx, zm, t) - p0; }
    return out;
  }

  const API = { geo, look, satAt, demSampler, scenarios, run, scenState, truthVox, mfWet, mfGrad, piFactor, zwdFit, MG, VX, TG, DEF, K2P, K3, ZTOP };
  root.WXCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
