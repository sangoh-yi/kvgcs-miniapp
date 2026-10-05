/* vlbisim_core.js — VLBI 관측 → 기록 → 상관(FX) → 프린지 탐색 → 기선 해석 계산(2026-10-05 센터장님
 *   "VLBI 관측부터 기선 해석까지 전 과정을 실제 VLBI 가 하고 있는 이론과 과학적 방법을 동원해서 시뮬레이션").
 *   화면(DOM·three.js) 없음 — 브라우저(window.VSCore)와 Node(module.exports) 둘 다에서 돈다.
 *
 *   모형(참값과 선험 계산값이 같은 식을 쓴다 — 매개변수만 다르다):
 *     τ = τg + τtrop + τclk + τion(f)          τ = t₂ − t₁ (국 2 도착 시각 − 국 1)
 *     τg  = −(B·ŝ)/c ÷ (1 + ŝ·v₂/c)            B = x₂ − x₁ (ITRF), ŝ = 전파원 방향(J2000 → ERA 로 지구 고정), v₂ = ω × x₂ (역행 기선)
 *     τtrop = Σ ±[ZHDᵢ·mₕ(Eᵢ) + ZWDᵢ·m_w(Eᵢ)]/c   Herring 연분수형(Niell 1996 위도 30° 평균 계수)
 *     τion(f) = ±40.308·STEC/(c f²) — 군지연 +, 위상지연 −(얇은 껍질 450 km 사상)
 *     τclk = c₀ + c₁t + c₂t² (+ 수소메이저 백색 FM 잡음 σy(τ)=3·10⁻¹⁴ τ^-½ → 1000 s 에서 1·10⁻¹⁵)
 *   빼먹은 것(참값·모형 모두에서 같이 빠져 모의 안에서는 자기 일관): 세차·장동·극운동·UT1−UTC, 연주 광행차, 중력 지연,
 *     고체 조석·해양 하중, 안테나 축 오프셋·열변형. 실제 해석(IERS 2010 합의 모형)은 이것들을 모두 넣는다.
 */
(function (G) {
  'use strict';
  const C = 299792458, OMEGA = 7.2921151467e-5, KION = 40.308, TECU = 1e16, D2R = Math.PI / 180;

  // ── 벡터 ──
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const nrm = (a) => Math.hypot(a[0], a[1], a[2]);

  // ── 난수(씨앗 고정 — 같은 설정이면 같은 결과) ──
  function rng(seed) {
    let s = (seed >>> 0) || 1, spare = null;
    const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = () => {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let a, b, r; do { a = 2 * u() - 1; b = 2 * u() - 1; r = a * a + b * b; } while (r >= 1 || r === 0);
      const f = Math.sqrt(-2 * Math.log(r) / r); spare = b * f; return a * f;
    };
    return { u, g };
  }

  // ── 시간·지구 자전 — 지구 자전각 ERA(IERS 2010 식 5.15), UT1 ≈ UTC ──
  function era(unix, dut) {
    // 정밀도: Tᵤ 를 날수(정수)와 그날 초로 나눠 더한다 — unix/86400 + 2440587.5 로 한 번에 하면 배정밀도에서 약 40 μs 씩 끊긴다(0.13.1 UT1 모의에서 찾음)
    const s0 = unix - 946728000, days = Math.floor(s0 / 86400), sec = (s0 - days * 86400) + (dut || 0);
    const Tu = days + sec / 86400;
    let f = 0.7790572732640 + 0.00273781191135448 * Tu; f -= Math.floor(f); f += sec / 86400; f -= Math.floor(f);
    return 2 * Math.PI * f;
  }
  const s_crs = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  function crs2trs(v, unix, dut) { const th = era(unix, dut), c = Math.cos(th), s = Math.sin(th); return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]]; }

  // ── 측지(GRS80) ──
  const A_E = 6378137, F_E = 1 / 298.257222101, E2 = F_E * (2 - F_E);
  function geod(x) {
    const p = Math.hypot(x[0], x[1]), lon = Math.atan2(x[1], x[0]);
    let lat = Math.atan2(x[2], p * (1 - E2)), h = 0;
    for (let i = 0; i < 8; i++) { const N = A_E / Math.sqrt(1 - E2 * Math.sin(lat) ** 2); h = p / Math.cos(lat) - N; lat = Math.atan2(x[2], p * (1 - E2 * N / (N + h))); }
    return { lat, lon, h };
  }
  function enuMat(x) {
    const g = geod(x), sl = Math.sin(g.lat), cl = Math.cos(g.lat), so = Math.sin(g.lon), co = Math.cos(g.lon);
    return [[-so, co, 0], [-sl * co, -sl * so, cl], [cl * co, cl * so, sl]];
  }
  function azel(x, s) {
    const R = enuMat(x), e = dot(R[0], s), n = dot(R[1], s), u = dot(R[2], s);
    return { az: (Math.atan2(e, n) + 2 * Math.PI) % (2 * Math.PI), el: Math.asin(Math.max(-1, Math.min(1, u))) };
  }

  // ── 대기 ──
  const MH = [1.2683230e-3, 2.9152299e-3, 62.837393e-3], MW = [5.6794847e-4, 1.5138625e-3, 4.6729510e-2];
  const herring = (sE, a, b, c) => (1 + a / (1 + b / (1 + c))) / (sE + a / (sE + b / (sE + c)));
  const mapH = (el) => herring(Math.sin(el), MH[0], MH[1], MH[2]);
  const mapW = (el) => herring(Math.sin(el), MW[0], MW[1], MW[2]);
  function zhd(x) {                                      // Saastamoinen — 표준 대기압을 높이로 줄인 값(m)
    const g = geod(x), P = 1013.25 * Math.pow(1 - 2.2557e-5 * g.h, 5.2568);
    return 0.0022768 * P / (1 - 0.00266 * Math.cos(2 * g.lat) - 2.8e-7 * g.h);
  }
  function mapIon(el) { const R = 6371e3, H = 450e3, q = R * Math.cos(el) / (R + H); return 1 / Math.sqrt(1 - q * q); }

  // ── 지연 모형 — P: {x1, x2, clk(t), zhd1, zhd2, zwd1(t), zwd2(t), vtec1(t), vtec2(t)} · t 는 세션 기준 시각에서 s ──
  const val = (v, t) => (typeof v === 'function' ? v(t) : (v || 0));
  function delay(P, src, unix, t) {
    const s = crs2trs(s_crs(src.ra, src.dec), unix, P.dut1 || 0);   // P.dut1 = UT1−UTC 가 모형에 든 값(s) — 지구 자전각이 그만큼 앞선다
    const x1 = P.x1, x2 = P.x2, B = sub(x2, x1);
    const v2 = [-OMEGA * x2[1], OMEGA * x2[0], 0];
    const tg0 = -dot(B, s) / C, tg = tg0 / (1 + dot(v2, s) / C);
    const a1 = azel(x1, s), a2 = azel(x2, s);
    const trop = (val(P.zhd2, t) * mapH(a2.el) + val(P.zwd2, t) * mapW(a2.el) - val(P.zhd1, t) * mapH(a1.el) - val(P.zwd1, t) * mapW(a1.el)) / C;
    const dstec = val(P.vtec2, t) * mapIon(a2.el) - val(P.vtec1, t) * mapIon(a1.el);     // TECU
    const A = KION * dstec * TECU / C;                                                      // s·Hz² — τion(f) = A/f²
    const clk = val(P.clk, t);
    return { tg, tg0, ret: tg - tg0, trop, clk, A, nd: tg + trop + clk, s, B, el1: a1.el, el2: a2.el, az1: a1.az, az2: a2.az };
  }
  // 군지연(그 주파수의) — 군 = 비분산 + A/f², 위상 = 비분산 − A/f²
  const groupAt = (d, f) => d.nd + d.A / (f * f);

  // ── FFT(기수 2, 제자리) ──
  function fft(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // ── 주파수 구성(VEX chan_def) — 모의는 위측파대(U) 채널만(아래측파대 CH02·CH10 은 같은 BBC 의 거울이라 뺐다) ──
  function bands(freq) {
    const out = {};
    for (const c of freq.chan) {
      if (c.sb !== 'U') continue;
      (out[c.band] = out[c.band] || { name: c.band, ch: [], bw: c.bw * 1e6, sr: freq.sample_rate }).ch.push({ f: c.f * 1e6, id: c.ch, bbc: c.bbc });
    }
    for (const b of Object.values(out)) {
      const fc = b.ch.map((c) => c.f + b.bw / 2), m = fc.reduce((a, v) => a + v, 0) / fc.length;
      b.fmean = m;
      b.frms = Math.sqrt(fc.reduce((a, v) => a + (v - m) ** 2, 0) / fc.length + b.bw * b.bw / 12);   // 대역 합성 유효 폭
      // 전리층 유효 주파수 — 순수 분산 지연 A/f² 를 채널 위상 기울기로 맞추면 나오는 값(A/τ = f_eff²)
      let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = fc.length;
      for (const f of fc) { const y = 1 / f; sx += f; sy += y; sxx += f * f; sxy += f * y; }   // 위상 φ = 2πA/f → 군지연 = −(1/2π)dφ/df = A·(−d(1/f)/df)
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);                                  // d(1/f)/df 의 최소제곱
      b.feff = Math.sqrt(-1 / slope);
    }
    return out;
  }

  // ── 감도 — SNR = η·S/√(SEFD₁SEFD₂)·√(2·B·T·N), σ_τ = 1/(2π·SNR·Δf_rms) ──
  const ETA2BIT = 0.8825;
  function snr(S, sefd1, sefd2, bw, T, nch) { return ETA2BIT * S / Math.sqrt(sefd1 * sefd2) * Math.sqrt(2 * bw * T * nch); }
  const sigTau = (SNR, b) => 1 / (2 * Math.PI * SNR * b.frms);

  // ── 2비트 표본화(최적 문턱 ±0.9816σ, 값 ±1·±3.3359) ──
  const Q2 = (x) => (x > 0.9816 ? 3.3359 : x > 0 ? 1 : x > -0.9816 ? -1 : -3.3359);

  /* ── 신호부터 상관까지(한 스캔·한 대역) ──
   *  시간 압축: 실제 스캔 T 초를 AP K 개로 나누고, AP 마다 그 시각의 표본 N 개(수 ms)만 실제로 만든다.
   *  상관 계수는 √(2BT/(K·N)) 배로 키워 '스캔 전체 SNR' 을 맞춘다(같은 SNR · 같은 지연·지연률 · 같은 위상 변화).
   *  국 2 자료는 상관기가 모형 정수 지연 n_int 만큼 늦춰 읽은 것 — 기저대 위상 −2π(f_edge+f)τph + 2π f n_int/fs 와
   *  지연률(도플러) e^{−i2π f_c τ̇ t} 를 넣는다. 상관기: 표본마다 프린지 회전 e^{+i2π f_edge τm(t)} → FFT → 분수 지연 e^{+i2π f frac}
   *  → X₁·X₂* 누적 → 자기상관으로 정규화.  */
  function* simCorr(o) {
    // o: {band, truthAt(t)→delay obj, modelAt(t)→delay obj, rho1, rho2 (스캔 실제 값), T, K, N, Nfft, noise(bool), seed}
    const b = o.band, fs = b.sr, K = o.K || 32, N = o.N || 4096, NF = o.Nfft || 128, NB = NF / 2, R = rng(o.seed || 1);
    const comp = Math.sqrt(2 * b.bw * o.T / (K * N));
    // 키운 상관 성분은 두 국에 똑같이(기하 평균) 나눈다 — 곱 r₁r₂(= SNR²)는 같고, 한 국(예: 코키 S SEFD 750 Jy)만 0.9 가까이 커져
    //   2비트 비선형으로 지연이 치우치는 것을 막는다(10-05 검산에서 S −1.5σ 치우침을 찾음)
    const gm = Math.sqrt(o.rho1 * o.rho2) * comp;
    let r1 = Math.min(0.9, gm), r2 = r1;
    if (!o.noise) { r1 = 0.999; r2 = 0.999; }
    const V = [], A1 = [], A2 = [], tap = [], fb = new Float64Array(NB); let snap = null;
    for (let j = 0; j < NB; j++) fb[j] = j * fs / NF;
    const nh = N / 2;
    for (let k = 0; k < K; k++) {
      const tk = -o.T / 2 + (k + 0.5) * o.T / K; tap.push(tk);
      const tr = o.truthAt(tk), tr2 = o.truthAt(tk + 1), md = o.modelAt(tk), md2 = o.modelAt(tk + 1);
      const rateT = tr2.nd - tr.nd, rateM = md2.nd - md.nd;                       // s/s(1 s 차분)
      const nint = Math.round(md.nd * fs);
      const Vk = [], A1k = [], A2k = [];
      for (const ch of b.ch) {
        // 공통 하늘 신호(해석 신호 — 양의 주파수만) — 국 1 · 국 2(지연·분산·지연률)
        const z1r = new Float64Array(N), z1i = new Float64Array(N), z2r = new Float64Array(N), z2i = new Float64Array(N);
        for (let j = 1; j < nh; j++) {
          const ar = R.g(), ai = R.g(), f = j * fs / N, fsky = ch.f + f;
          const ph = -2 * Math.PI * fsky * (tr.nd - tr.A / (fsky * fsky)) + 2 * Math.PI * f * nint / fs;
          const c = Math.cos(ph), s = Math.sin(ph);
          z1r[j] = ar; z1i[j] = ai; z2r[j] = ar * c - ai * s; z2i[j] = ar * s + ai * c;
        }
        fft(z1r, z1i, true); fft(z2r, z2i, true);
        const fc = ch.f + b.bw / 2; let s1 = 0, s2 = 0;
        const x1 = new Float64Array(N), x2 = new Float64Array(N);
        for (let n = 0; n < N; n++) {
          const tt = n / fs - N / (2 * fs), dop = -2 * Math.PI * fc * rateT * tt, c = Math.cos(dop), s = Math.sin(dop);
          x1[n] = z1r[n]; x2[n] = z2r[n] * c - z2i[n] * s; s1 += x1[n] * x1[n]; s2 += x2[n] * x2[n];
        }
        const n1 = Math.sqrt(s1 / N), n2 = Math.sqrt(s2 / N);
        const q1 = new Float64Array(N), q2 = new Float64Array(N);
        for (let n = 0; n < N; n++) {
          q1[n] = Q2(Math.sqrt(r1) * x1[n] / n1 + Math.sqrt(1 - r1) * R.g());
          q2[n] = Q2(Math.sqrt(r2) * x2[n] / n2 + Math.sqrt(1 - r2) * R.g());
        }
        // 상관(FX)
        const vr = new Float64Array(NB), vi = new Float64Array(NB), a1 = new Float64Array(NB), a2 = new Float64Array(NB);
        const br = new Float64Array(NF), bi = new Float64Array(NF), cr = new Float64Array(NF), ci = new Float64Array(NF);
        for (let blk = 0; blk < N / NF; blk++) {
          const tb = tk + ((blk + 0.5) * NF - N / 2) / fs, taum = md.nd + rateM * (tb - tk), frac = taum - nint / fs;
          for (let n = 0; n < NF; n++) {
            const tn = tk + ((blk * NF + n) - N / 2) / fs, th = 2 * Math.PI * ch.f * (md.nd + rateM * (tn - tk));
            br[n] = q1[blk * NF + n]; bi[n] = 0;
            cr[n] = q2[blk * NF + n] * Math.cos(th); ci[n] = q2[blk * NF + n] * Math.sin(th);
          }
          fft(br, bi, false); fft(cr, ci, false);
          for (let j = 0; j < NB; j++) {
            const p = 2 * Math.PI * fb[j] * frac, c = Math.cos(p), s = Math.sin(p);
            const x2r = cr[j] * c - ci[j] * s, x2i = cr[j] * s + ci[j] * c;
            vr[j] += br[j] * x2r + bi[j] * x2i; vi[j] += bi[j] * x2r - br[j] * x2i;   // X₁·X₂*
            a1[j] += br[j] * br[j] + bi[j] * bi[j]; a2[j] += x2r * x2r + x2i * x2i;
          }
        }
        const v = new Float64Array(2 * NB);
        for (let j = 0; j < NB; j++) { const nn = Math.sqrt(a1[j] * a2[j]) || 1; v[2 * j] = vr[j] / nn; v[2 * j + 1] = vi[j] / nn; }
        Vk.push(v); A1k.push(a1); A2k.push(a2);
        if (k === 0 && ch === b.ch[0]) snap = { x: Array.from(x1.slice(0, 1024), (v) => v / n1), q: Array.from(q1.slice(0, 1024)), r1, r2 };
      }
      V.push(Vk); A1.push(A1k); A2.push(A2k);
      yield { k, K };
    }
    return { V, A1, A2, tap, fb, band: b, K, N, NF, nsamp: K * N * b.ch.length, rho: [r1, r2], comp, snap };
  }

  /* ── 프린지 탐색(HOPS fourfit 과 같은 순서) ──
   *  ① 채널마다 지연 스펙트럼(lag) — 단일 대역 지연(SBD, 창 ±NF/(2·fs)·…) ② SBD 로 채널 안 기울기를 지운 채널 위상
   *  ③ 다중 대역 지연(MBD) × 지연률 2D 탐색(AP 축은 FFT) ④ 봉우리 보간 · 진폭 · SNR · 채널 잔여 위상  */
  function fringe(cr, opt) {
    opt = opt || {};
    const b = cr.band, K = cr.K, NB = cr.fb.length, NCH = b.ch.length, fs = b.sr, NF = cr.NF, PAD = 8 * NB;
    // ① SBD — 비간섭 합
    const lag = new Float64Array(PAD);
    const pr = new Float64Array(PAD), pi = new Float64Array(PAD);
    for (let k = 0; k < K; k++) for (let c = 0; c < NCH; c++) {
      pr.fill(0); pi.fill(0); const v = cr.V[k][c];
      for (let j = 0; j < NB; j++) { pr[j] = v[2 * j]; pi[j] = v[2 * j + 1]; }
      fft(pr, pi, false);                                   // Σ V e^{−i2π f τ} — τ = m/(PAD·Δf)
      for (let m = 0; m < PAD; m++) lag[m] += pr[m] * pr[m] + pi[m] * pi[m];
    }
    let m0 = 0; for (let m = 1; m < PAD; m++) if (lag[m] > lag[m0]) m0 = m;
    const dF = fs / NF, lagT = (m) => ((m >= PAD / 2 ? m - PAD : m) / (PAD * dF));
    const yl = lag[(m0 - 1 + PAD) % PAD], y0 = lag[m0], yr = lag[(m0 + 1) % PAD], dm = 0.5 * (yl - yr) / (yl - 2 * y0 + yr || 1);
    const sbd = lagT(m0) + dm / (PAD * dF);
    // ② 채널 위상(SBD 기울기 지움)
    const W = [];
    for (let k = 0; k < K; k++) {
      const row = [];
      for (let c = 0; c < NCH; c++) {
        let sr = 0, si = 0; const v = cr.V[k][c];
        for (let j = 0; j < NB; j++) { const p = -2 * Math.PI * cr.fb[j] * sbd, cs = Math.cos(p), sn = Math.sin(p); sr += v[2 * j] * cs - v[2 * j + 1] * sn; si += v[2 * j] * sn + v[2 * j + 1] * cs; }
        row.push([sr, si]);
      }
      W.push(row);
    }
    // ③ MBD × 지연률
    const fref = b.ch[0].f, df = b.ch.map((c) => c.f - fref);
    const amb = 1 / (gcd0(df.map((d) => Math.round(d / 1e6))) * 1e6);                 // 모호도 간격(s)
    const span = opt.span || Math.min(amb, 60e-9), step = opt.step || 0.04e-9, NT = Math.round(span / step);
    const RP = 256, dt = (cr.tap[1] - cr.tap[0]) || 1;
    let best = { a: -1 }; const map = [];
    const gr = new Float64Array(RP), gi = new Float64Array(RP);
    for (let it = 0; it <= NT; it++) {
      const tau = sbd - span / 2 + it * step;
      gr.fill(0); gi.fill(0);
      for (let k = 0; k < K; k++) {
        let sr = 0, si = 0;
        for (let c = 0; c < NCH; c++) { const p = -2 * Math.PI * df[c] * tau, cs = Math.cos(p), sn = Math.sin(p); sr += W[k][c][0] * cs - W[k][c][1] * sn; si += W[k][c][0] * sn + W[k][c][1] * cs; }
        gr[k] = sr; gi[k] = si;
      }
      fft(gr, gi, false);                                 // Σ_k e^{−i2π ν t_k} — ν = 프린지 진동수
      const rowA = new Float64Array(RP);
      for (let q = 0; q < RP; q++) { const a = Math.hypot(gr[q], gi[q]); rowA[q] = a; if (a > best.a) best = { a, it, q, re: gr[q], im: gi[q] }; }
      if (it % Math.max(1, Math.round(NT / 120)) === 0) map.push({ tau, row: rowA });
    }
    const nu = (q) => ((q >= RP / 2 ? q - RP : q) / (RP * dt));
    // ④ 보간 — 지연 축은 이웃 지연을 다시 계산, 지연률 축은 이웃 칸
    const ampAt = (tau, q) => { let sr = 0, si = 0; for (let k = 0; k < K; k++) { let ar = 0, ai = 0; for (let c = 0; c < NCH; c++) { const p = -2 * Math.PI * df[c] * tau, cs = Math.cos(p), sn = Math.sin(p); ar += W[k][c][0] * cs - W[k][c][1] * sn; ai += W[k][c][0] * sn + W[k][c][1] * cs; } const p2 = -2 * Math.PI * nu(q) * (cr.tap[k] - cr.tap[0]), c2 = Math.cos(p2), s2 = Math.sin(p2); sr += ar * c2 - ai * s2; si += ar * s2 + ai * c2; } return Math.hypot(sr, si); };
    const tau0 = sbd - span / 2 + best.it * step;
    const fa = ampAt(tau0 - step, best.q), fb0 = best.a, fc = ampAt(tau0 + step, best.q);
    const mbd = NCH === 1 ? sbd : tau0 + step * 0.5 * (fa - fc) / (fa - 2 * fb0 + fc || 1);   // 채널 하나면 대역 합성이 없다 — fourfit 처럼 MBD = SBD
    const qa = ampAt(tau0, (best.q - 1 + RP) % RP), qc = ampAt(tau0, (best.q + 1) % RP);
    const nuB = nu(best.q) + (1 / (RP * dt)) * 0.5 * (qa - qc) / (qa - 2 * fb0 + qc || 1);
    const rate = nuB / b.fmean;                          // 채널마다 f·τ̇ 로 도는 위상을 한 ν 로 모았으니 대역 평균 주파수로 나눈다
    const amp = fb0 / (K * NCH * NB);                     // 정규화 상관 진폭
    const SNR = amp * Math.sqrt(cr.nsamp);
    // 채널 잔여 위상(맞춘 MBD·지연률을 빼고)
    const resid = [];
    for (let c = 0; c < NCH; c++) {
      let sr = 0, si = 0;
      for (let k = 0; k < K; k++) { const p = -2 * Math.PI * (df[c] * mbd + nuB * (cr.tap[k] - cr.tap[0])), cs = Math.cos(p), sn = Math.sin(p); sr += W[k][c][0] * cs - W[k][c][1] * sn; si += W[k][c][0] * sn + W[k][c][1] * cs; }
      resid.push({ f: b.ch[c].f, re: sr, im: si, a: Math.hypot(sr, si) / (K * NB) });
    }
    // 전체 프린지 위상을 빼고 채널마다 남는 위상(0 둘레면 맞춤이 좋다)
    let gr0 = 0, gi0 = 0; for (const r of resid) { gr0 += r.re; gi0 += r.im; }
    const ph0 = Math.atan2(gi0, gr0);
    for (const r of resid) { let p = Math.atan2(r.im, r.re) - ph0; while (p > Math.PI) p -= 2 * Math.PI; while (p < -Math.PI) p += 2 * Math.PI; r.ph = p; delete r.re; delete r.im; }
    const tmid = (cr.tap[0] + cr.tap[K - 1]) / 2, phaseMid = ph0 + 2 * Math.PI * nuB * (tmid - cr.tap[0]);
    return { sbd, mbd, rate, amp, SNR, sigma: sigTau(SNR, b), amb, fref, map, span, step, phaseMid: Math.atan2(Math.sin(phaseMid), Math.cos(phaseMid)), nuRes: 1 / (RP * dt), RP, dt, lag: Array.from(lag), dF, PAD, resid, phase: ph0, q: best.q, nu: nuB, tau0 };
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }   // gcd(0, x) = x
  function gcd0(arr) { let g = 0; for (const v of arr) g = gcd(g, v); return g || 1; }

  // 전리층 없는 결합(S/X) — τ = (fX²τX − fS²τS)/(fX² − fS²)
  function ionFree(tX, tS, bX, bS, sX, sS) {
    const x2 = bX.feff ** 2, s2 = bS.feff ** 2, d = x2 - s2;
    return { tau: (x2 * tX - s2 * tS) / d, sig: Math.sqrt((x2 * sX) ** 2 + (s2 * sS) ** 2) / d, A: (tS - tX) / (1 / s2 - 1 / x2) };
  }

  /* ── 세션 모의(관측량 수준) + 기선 해석(가중 최소제곱, 가우스-뉴턴) ──
   *  스캔마다 참 지연(X·S 군지연)에 SNR 이론 σ 만큼 잡음을 더해 '관측 지연' 을 만든다(신호 수준 모의는 한 스캔에서 이 σ 를 검산).
   *  미지수: 국 2 위치 보정 3 · 시계 c₀ c₁ c₂ · 국별 천정 습윤 지연(세션 상수 또는 꺾은선 + 느슨한 제약). 국 1(세종)은 고정 — 기준점. */
  // ── 세션 참값(씨앗 고정) — 메인 화면과 웹 워커가 같은 씨앗으로 같은 참값을 만든다(0.13.1) ──
  function sessionPrep(cfg) {
    const R = rng(cfg.seed || 7), st1 = cfg.st1, st2 = cfg.st2, tref = cfg.tref;
    const dxTrue = cfg.dx2 || [0.02, -0.03, 0.015];
    const x2T = add(st2.xyz, dxTrue);
    const clk = cfg.clk || [3.2e-7, 1.5e-14, 0];       // s, s/s, s/s²
    const maserSig = cfg.maser === false ? 0 : 3e-14;  // 백색 FM — 1 s 에서 σy
    const zwdWalk = (sd0, zero) => { const pts = []; let z = zero, tt = cfg.t0 - 3600; while (tt < cfg.t1 + 3600) { pts.push([tt, z]); tt += 600; z = Math.max(0.01, z + (cfg.tropoVar === false ? 0 : sd0 * Math.sqrt(600 / 3600) * R.g())); } return pts; };
    const lin = (pts) => (t) => { const u = t; if (u <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (u <= pts[i][0]) { const a = pts[i - 1], b = pts[i], w = (u - a[0]) / (b[0] - a[0]); return a[1] + w * (b[1] - a[1]); } return pts[pts.length - 1][1]; };
    const z1T = lin(zwdWalk(cfg.zwdWalk ?? 0.006, cfg.zwd1 ?? 0.15)), z2T = lin(zwdWalk(cfg.zwdWalk ?? 0.006, cfg.zwd2 ?? 0.12));
    const vt = (v0) => (t) => v0 * (0.55 + 0.45 * Math.cos(2 * Math.PI * (t / 86400 - 0.6)));
    // 메이저 잡음 — 백색 FM → 시각 오차는 걸음(10 s 걸음)
    const mpts = []; { let x = 0, tt = cfg.t0 - 120; while (tt < cfg.t1 + 120) { mpts.push([tt, x]); x += maserSig * Math.sqrt(10) * R.g(); tt += 10; } }
    const maserAt = (t) => (maserSig ? lin(mpts)(t) : 0);
    const PT = { x1: st1.xyz, x2: x2T, clk: (t) => clk[0] + clk[1] * (t - tref) + clk[2] * (t - tref) ** 2 + maserAt(t),
      zhd1: zhd(st1.xyz), zhd2: zhd(x2T), zwd1: z1T, zwd2: z2T, vtec1: vt(cfg.vtec1 ?? 18), vtec2: vt(cfg.vtec2 ?? 25) };
    const PM = { x1: st1.xyz, x2: st2.xyz, clk: 0, zhd1: zhd(st1.xyz), zhd2: zhd(st2.xyz), zwd1: 0, zwd2: 0, vtec1: 0, vtec2: 0 };   // 상관기 선험 모형
    return { R, PT, PM, x2T, dxTrue, clk, z1T, z2T };
  }
  const fluxOf = (sc, band, cfg) => (sc['flux' + band] ?? sc.flux) * (cfg.fluxScale || 1);
  // 관측량 수준 — 지연에 σ = 1/(2π·SNR·Δf_rms) 만큼 잡음(기본, 빠르다)
  function obsTheory(cfg, prep, sc) {
    const st1 = cfg.st1, st2 = cfg.st2, bX = cfg.bands.X, bS = cfg.bands.S, R = prep.R, t = sc.t, d = delay(prep.PT, sc.src, t, t);
    if (d.el1 < 5 * D2R || d.el2 < 5 * D2R) return null;
    const sX = snr(fluxOf(sc, 'X', cfg), st1.sefd.X, st2.sefd.X, bX.bw, sc.T, bX.ch.length);
    const sS = snr(fluxOf(sc, 'S', cfg), st1.sefd.S, st2.sefd.S, bS.bw, sc.T, bS.ch.length);
    const sigX = Math.hypot(sigTau(sX, bX), cfg.floor ?? 4e-12), sigS = Math.hypot(sigTau(sS, bS), cfg.floor ?? 4e-12);
    const nz = cfg.noise === false ? 0 : 1;
    const tX = groupAt(d, bX.feff) + nz * sigX * R.g(), tS = groupAt(d, bS.feff) + nz * sigS * R.g();
    const fr = ionFree(tX, tS, bX, bS, sigX, sigS);
    return { t, src: sc.src, name: sc.name, T: sc.T, tX, tS, tau: fr.tau, sig: fr.sig, snrX: sX, snrS: sS, sigX, sigS, truth: d, ionA: fr.A, level: 'obs' };
  }
  // 신호 수준 — 그 스캔을 신호부터 만들어 2비트 · 상관(FX) · 프린지 탐색까지 돌린 지연(느리다 — 웹 워커에서)
  function obsSignal(cfg, prep, sc, o) {
    o = o || {};
    const st1 = cfg.st1, st2 = cfg.st2, t = sc.t, d = delay(prep.PT, sc.src, t, t);
    if (d.el1 < 5 * D2R || d.el2 < 5 * D2R) return null;
    const truthAt = (dt) => delay(prep.PT, sc.src, t + dt, t + dt), modelAt = (dt) => delay(prep.PM, sc.src, t + dt, t + dt);
    const m0 = modelAt(0).nd, out = {};
    for (const band of ['X', 'S']) {
      const b = cfg.bands[band], S = fluxOf(sc, band, cfg);
      const g = simCorr({ band: b, truthAt, modelAt, rho1: S / st1.sefd[band], rho2: S / st2.sefd[band], T: sc.T, K: o.K || 16, N: o.N || 2048, Nfft: 128, noise: cfg.noise !== false, seed: (((o.seed || 1) * 7919 + Math.round(t)) * 2 + (band === 'X' ? 0 : 1)) >>> 0 });   // 스캔마다 다른 잡음(시각으로 씨앗)
      let r; do { r = g.next(); } while (!r.done);
      const fr = fringe(r.value);
      out[band] = { tau: m0 + fr.mbd, sig: Math.hypot(fr.sigma, cfg.floor ?? 4e-12), snr: fr.SNR, sbd: fr.sbd, rate: fr.rate,
        snrT: snr(S, st1.sefd[band], st2.sefd[band], b.bw, sc.T, b.ch.length), err: fr.mbd - (groupAt(truthAt(0), b.feff) - m0) };
    }
    if (out.X.snr < (o.minSnr ?? 7) || out.S.snr < (o.minSnr ?? 7)) return { drop: true, name: sc.name, t, snrX: out.X.snr, snrS: out.S.snr };
    const fr = ionFree(out.X.tau, out.S.tau, cfg.bands.X, cfg.bands.S, out.X.sig, out.S.sig);
    return { t, src: sc.src, name: sc.name, T: sc.T, tX: out.X.tau, tS: out.S.tau, tau: fr.tau, sig: fr.sig, snrX: out.X.snr, snrS: out.S.snr, sigX: out.X.sig, sigS: out.S.sig,
      snrXT: out.X.snrT, snrST: out.S.snrT, errX: out.X.err, errS: out.S.err, truth: d, ionA: fr.A, level: 'signal' };
  }
  /* ── 세션 모의 + 기선 해석(가중 최소제곱, 가우스-뉴턴) ──
   *  기본은 관측량 수준(obsTheory). cfg.obs 를 주면(웹 워커가 신호 수준으로 만든 것) 그것으로 푼다 — 같은 씨앗이라 참값이 같다.
   *  미지수: 국 2 위치 보정 3 · 시계 c₀ c₁ c₂ · 국별 천정 습윤 지연(세션 상수 또는 꺾은선 + 느슨한 제약). 국 1(세종)은 고정 — 기준점. */
  function session(cfg) {
    const st1 = cfg.st1, st2 = cfg.st2, tref = cfg.tref, H = 3600;
    const prep = sessionPrep(cfg);
    const obs = cfg.obs ? cfg.obs.filter((o) => o && !o.drop) : cfg.scans.map((sc) => obsTheory(cfg, prep, sc)).filter(Boolean);
    const est = lsq(obs, { st1, st2, tref, zwdMode: cfg.zwdMode || 'pwl', zwdStep: cfg.zwdStep || 2 * H, zwdCon: cfg.zwdCon ?? 0.015, reweight: cfg.reweight, t0: cfg.t0, t1: cfg.t1 });
    const Btrue = sub(prep.x2T, st1.xyz), Bap = sub(st2.xyz, st1.xyz), Best = sub(add(st2.xyz, est.dx), st1.xyz);
    return { obs, est, truth: { dx: prep.dxTrue, clk: prep.clk, B: Btrue, L: nrm(Btrue), zwd1: prep.z1T, zwd2: prep.z2T }, Bap, Lap: nrm(Bap), Best, Lest: nrm(Best), PT: prep.PT,
      level: cfg.obs ? 'signal' : 'obs', dropped: cfg.obs ? cfg.obs.filter((o) => o && o.drop).length : 0 };
  }

  // 재가중 — χ²/자유도가 1 이 되게 잡음 바닥 σₐ 를 제곱합으로 더해 다시 푼다(nuSolve·Calc/Solve 의 기선 재가중과 같은 생각)
  function lsq(obs, o) {
    const r0 = solve(obs, o, 0);
    if (o.reweight === false || !(r0.chi2r > 1.05)) { r0.sigAdd = 0; return r0; }
    let r = r0, sa = 0;
    for (let pass = 0; pass < 4; pass++) {                // 잔차가 매개변수와 함께 바뀌니 몇 번 되풀이
      const f = (x) => r.res.reduce((a, q) => a + q.v * q.v / (q.sig0 * q.sig0 + x * x), 0) - r.dof;
      let lo = 0, hi = 2e-9; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
      sa = (lo + hi) / 2; r = solve(obs, o, sa);
      if (Math.abs(r.chi2r - 1) < 0.02) break;
    }
    r.sigAdd = sa; r.chi2r0 = r0.chi2r; return r;
  }
  function solve(obs, o, sa) {
    const st1 = o.st1, st2 = o.st2, H = 3600, tref = o.tref;
    // 미지수 배치
    let nodes = [];
    if (o.zwdMode === 'pwl') { for (let t = o.t0; t <= o.t1 + 1; t += o.zwdStep) nodes.push(t); if (nodes[nodes.length - 1] < o.t1) nodes.push(o.t1); }
    else nodes = [o.t0];
    const nz = nodes.length, np = 3 + 3 + 2 * nz;
    const names = ['Δx₂ X', 'Δx₂ Y', 'Δx₂ Z', '시계 c₀', '시계 c₁', '시계 c₂'].concat(nodes.map((t, i) => `ZWD₁ #${i + 1}`), nodes.map((t, i) => `ZWD₂ #${i + 1}`));
    const zw = (t) => {                                       // 꺾은선 무게
      const w = new Float64Array(nz);
      if (nz === 1) { w[0] = 1; return w; }
      if (t <= nodes[0]) { w[0] = 1; return w; }
      for (let i = 1; i < nz; i++) if (t <= nodes[i]) { const f = (t - nodes[i - 1]) / (nodes[i] - nodes[i - 1]); w[i - 1] = 1 - f; w[i] = f; return w; }
      w[nz - 1] = 1; return w;
    };
    let p = new Float64Array(np); const hist = [];
    let N, rhs, res = [], chi2 = 0, dof = 0;
    for (let iter = 0; iter < 6; iter++) {
      const dx = [p[0], p[1], p[2]];
      const P = { x1: st1.xyz, x2: add(st2.xyz, dx), clk: (t) => (p[3] * 1e-9 + p[4] * 1e-9 * (t - tref) / H + p[5] * 1e-9 * ((t - tref) / H) ** 2),
        zhd1: zhd(st1.xyz), zhd2: zhd(add(st2.xyz, dx)), zwd1: (t) => { const w = zw(t); let s = 0; for (let i = 0; i < nz; i++) s += w[i] * p[6 + i]; return s; },
        zwd2: (t) => { const w = zw(t); let s = 0; for (let i = 0; i < nz; i++) s += w[i] * p[6 + nz + i]; return s; }, vtec1: 0, vtec2: 0 };
      N = Array.from({ length: np }, () => new Float64Array(np)); rhs = new Float64Array(np); res = []; chi2 = 0;
      for (const ob of obs) {
        const d = delay(P, ob.src, ob.t, ob.t), y = ob.tau - d.nd, w = 1 / (ob.sig * ob.sig + sa * sa);
        const a = new Float64Array(np), v2 = [-OMEGA * P.x2[1], OMEGA * P.x2[0], 0], k = 1 / (C * (1 + dot(v2, d.s) / C));
        a[0] = -d.s[0] * k; a[1] = -d.s[1] * k; a[2] = -d.s[2] * k;
        const u = (ob.t - tref) / H; a[3] = 1e-9; a[4] = 1e-9 * u; a[5] = 1e-9 * u * u;
        const wz = zw(ob.t), m1 = mapW(d.el1) / C, m2 = mapW(d.el2) / C;
        for (let i = 0; i < nz; i++) { a[6 + i] = -m1 * wz[i]; a[6 + nz + i] = m2 * wz[i]; }
        for (let i = 0; i < np; i++) { if (!a[i]) continue; rhs[i] += a[i] * w * y; for (let j = 0; j < np; j++) N[i][j] += a[i] * w * a[j]; }
        res.push({ t: ob.t, v: y, sig: Math.sqrt(ob.sig * ob.sig + sa * sa), sig0: ob.sig, el1: d.el1, el2: d.el2 }); chi2 += y * y * w;
      }
      // 꺾은선 제약(이웃 매듭 차 0 ± zwdCon) · 선험 느슨 제약(ZWD 0.1 ± 0.5 m 쯤 — 특이 막음)
      for (const off of [6, 6 + nz]) {
        for (let i = 0; i + 1 < nz; i++) { const w = 1 / (o.zwdCon * o.zwdCon), ii = off + i, jj = off + i + 1, y = -(p[jj] - p[ii]); N[ii][ii] += w; N[jj][jj] += w; N[ii][jj] -= w; N[jj][ii] -= w; rhs[ii] -= w * y; rhs[jj] += w * y; }
        for (let i = 0; i < nz; i++) { const w = 1 / 0.25; N[off + i][off + i] += w; rhs[off + i] += w * (0.1 - p[off + i]); }   // 선험 0.1 ± 0.5 m
      }
      const Q = inv(N); if (!Q) break;
      const dp = new Float64Array(np); for (let i = 0; i < np; i++) { let s = 0; for (let j = 0; j < np; j++) s += Q[i][j] * rhs[j]; dp[i] = s; }
      for (let i = 0; i < np; i++) p[i] += dp[i];
      hist.push({ iter: iter + 1, dxmm: [dp[0] * 1e3, dp[1] * 1e3, dp[2] * 1e3], wrms: wrms(res) });
      if (Math.abs(dp[0]) + Math.abs(dp[1]) + Math.abs(dp[2]) < 1e-6 && iter > 0) break;
    }
    // 마지막 잔차·형식 오차
    const Q = inv(N); dof = Math.max(1, obs.length - np);
    // 최종 잔차를 마지막 매개변수로 다시
    const dx = [p[0], p[1], p[2]];
    const P = { x1: st1.xyz, x2: add(st2.xyz, dx), clk: (t) => (p[3] * 1e-9 + p[4] * 1e-9 * (t - tref) / H + p[5] * 1e-9 * ((t - tref) / H) ** 2), zhd1: zhd(st1.xyz), zhd2: zhd(add(st2.xyz, dx)),
      zwd1: (t) => { const w = zw(t); let s = 0; for (let i = 0; i < nz; i++) s += w[i] * p[6 + i]; return s; }, zwd2: (t) => { const w = zw(t); let s = 0; for (let i = 0; i < nz; i++) s += w[i] * p[6 + nz + i]; return s; }, vtec1: 0, vtec2: 0 };
    res = []; chi2 = 0;
    for (const ob of obs) { const d = delay(P, ob.src, ob.t, ob.t), y = ob.tau - d.nd, sg = Math.sqrt(ob.sig * ob.sig + sa * sa); res.push({ t: ob.t, v: y, sig: sg, sig0: ob.sig, el1: d.el1, el2: d.el2, src: ob.name }); chi2 += (y / sg) ** 2; }
    const chi2r = chi2 / dof, sc = Math.sqrt(Math.max(1, chi2r));
    const sig = Q ? Array.from({ length: np }, (_, i) => Math.sqrt(Math.max(0, Q[i][i])) * sc) : null;
    // 국 2 위치 보정을 ENU 로 · 공분산
    const Rm = enuMat(st2.xyz), Cxyz = Q ? [[Q[0][0], Q[0][1], Q[0][2]], [Q[1][0], Q[1][1], Q[1][2]], [Q[2][0], Q[2][1], Q[2][2]]].map((r) => r.map((v) => v * sc * sc)) : null;
    const enu = [dot(Rm[0], dx), dot(Rm[1], dx), dot(Rm[2], dx)];
    let Cenu = null; if (Cxyz) { Cenu = [0, 1, 2].map((i) => [0, 1, 2].map((j) => { let s = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += Rm[i][a] * Cxyz[a][b] * Rm[j][b]; return s; })); }
    return { p: Array.from(p), names, sig, dx, enu, Cxyz, Cenu, res, chi2r, dof, n: obs.length, np, nodes, hist, wrms: wrms(res) };
  }
  function wrms(res) { let a = 0, b = 0; for (const r of res) { const w = 1 / (r.sig * r.sig); a += w * r.v * r.v; b += w; } return Math.sqrt(a / (b || 1)); }
  function inv(M) {                                      // 가우스-조르단(부분 피벗)
    const n = M.length, A = M.map((r) => Array.from(r)), I = Array.from({ length: n }, (_, i) => { const r = new Array(n).fill(0); r[i] = 1; return r; });
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-300) return null;
      [A[c], A[piv]] = [A[piv], A[c]]; [I[c], I[piv]] = [I[piv], I[c]];
      const d = A[c][c]; for (let j = 0; j < n; j++) { A[c][j] /= d; I[c][j] /= d; }
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (!f) continue; for (let j = 0; j < n; j++) { A[r][j] -= f * A[c][j]; I[r][j] -= f * I[c][j]; } }
    }
    return I;
  }

  // ── 스케줄 — VEX 스캔 중 두 국이 함께 든 것(기록 길이는 둘 중 짧은 것) ──
  // 전파원 세기(Jy) — sked $FLUX 모형: B = [b₀, S₀, b₁, S₁, …, bₙ](기선 길이 km 구간마다 세기) · M = 가우스 성분 [S, 장축 mas, 축비, …]
  //   M 은 기선 길이 그대로(투영 없이 — 근사) 가시도 exp(−(πθρ)²/(4 ln2)), ρ = L/λ. 모형이 없으면 대략값 flux
  function fluxAt(src, band, Lkm) {
    const ms = src.fm && src.fm[band]; if (!ms) return src.flux;
    const lam = C / (band === 'X' ? 8.6e9 : 2.3e9); let S = 0;
    for (const m of ms) {
      if (m[0] === 'B') { const v = m.slice(1); let f = v[1]; for (let i = 0; i + 2 < v.length; i += 2) if (Lkm >= v[i] && Lkm < v[i + 2]) { f = v[i + 1]; break; } S += f; }
      else if (m[0] === 'M') { const th = m[2] * 4.8481368e-9, rho = Lkm * 1e3 / lam; S += m[1] * Math.exp(-((Math.PI * th * rho) ** 2) / (4 * Math.LN2)); }
    }
    return S;
  }
  function commonScans(data, sess, id1, id2, Lkm) {
    const S = data.sessions[sess], out = [];
    for (const [t, src, st] of S.scans) {
      const m = {}; for (const x of st.matchAll(/([A-Z][a-z])(\d+)/g)) m[x[1]] = +x[2];
      const so = data.sources[src];
      if (m[id1] && m[id2] && so) {
        const fx = Lkm ? fluxAt(so, 'X', Lkm) : so.flux, fs = Lkm ? fluxAt(so, 'S', Lkm) : so.flux;
        out.push({ t: S.t0 + t + Math.min(m[id1], m[id2]) / 2, t_start: S.t0 + t, T: Math.min(m[id1], m[id2]), name: src, src: so, flux: fx, fluxX: fx, fluxS: fs });
      }
    }
    return out;
  }
  // 세션의 관측국 — 선험 위치는 그 세션 시각의 ITRF2020-u2024(자료에 있으면), 스케줄 파일 위치는 xyzSched 로 남긴다
  function stationFor(data, sess, name) {
    const st = data.stations[name], S = data.sessions[sess], p = S && S.pos && S.pos[name];
    if (!p && st.itrf && S) {                          // 그 세션에 없던 국 — ITRF2020-u2024 를 세션 시각으로
      const dt = S.epoch - st.itrf.epoch, x = st.itrf.X0.map((v, k) => v + st.itrf.V[k] * dt);
      return Object.assign({}, st, { name, xyz: x, xyzSched: st.xyz, posSrc: 'ITRF2020-u2024' });
    }
    return Object.assign({}, st, { name, xyz: p ? p.xyz : st.xyz, xyzSched: p ? p.sched : st.xyz, posSrc: p ? p.src : '카탈로그' });
  }
  // 측지 위경도(°)·높이(m) → ITRF XYZ(GRS80)
  function geo2xyz(latd, lond, h) {
    const la = latd * D2R, lo = lond * D2R, N = A_E / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
    return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)];
  }

  /* ── UT1 Intensive(0.13.1, 10-05 센터장님) — 1시간 · 기선 하나 · UT1−UTC 추정 ──
   *  일정: 두 국이 다 10° 위로 보는 전파원 가운데 하늘을 고르게(지금까지 고른 방향과 가장 먼 것 + 세기) 고른다. 선회는 방위 2°/s·고도 1°/s + 정착 10 s,
   *        기록 길이는 X SNR 25·S SNR 12 가 되게(30~180 s). 실제 IVS Intensive(INT1 Kk–Wz · 18:30 UT) 처럼 1시간에 20~30 스캔.
   *  미지수: dUT1(μs) · 시계 c₀(ns)·c₁(ns/h) · 국별 천정 습윤 지연(상수, 약한 선험 0.1 ± 0.5 m). 관측국 위치·극운동·장동은 고정(모의에서 참값과 같다).
   *  ∂τ/∂UT1 = 수치 미분(1 μs). 감도 상한 = ω·B_eq/c(B_eq = 기선 적도면 성분, ω = 7.2921·10⁻⁵ rad/s) — 1 μs 마다 ps. */
  function intSchedule(cfg) {
    const st1 = cfg.st1, st2 = cfg.st2, L = nrm(sub(st2.xyz, st1.xyz)) / 1e3, out = [];
    const cand = Object.entries(cfg.sources).map(([name, so]) => ({ name, src: so, fx: fluxAt(so, 'X', L), fs: fluxAt(so, 'S', L) })).filter((c) => c.fx >= (cfg.minFlux ?? 0.25) && c.fs >= 0.1);
    let t = cfg.t0, prev = null; const used = [];
    const P0 = { x1: st1.xyz, x2: st2.xyz, clk: 0, zhd1: 0, zhd2: 0, zwd1: 0, zwd2: 0 };
    while (t < cfg.t0 + (cfg.dur || 3600)) {
      let best = null;
      for (const c of cand) {
        const d = delay(P0, c.src, t, t); if (d.el1 < 10 * D2R || d.el2 < 10 * D2R) continue;
        const v = [Math.cos(d.el1) * Math.sin(d.az1), Math.cos(d.el1) * Math.cos(d.az1), Math.sin(d.el1)];
        let md = 2; for (const u of used.slice(-8)) md = Math.min(md, Math.acos(Math.max(-1, Math.min(1, dot(u.v, v)))));   // 최근 8 스캔 방향과 가장 먼 것
        const again = prev && prev.name === c.name;
        const slew = prev ? Math.max(Math.abs(shortAz(d.az1 - prev.az1)) / D2R / 2 + Math.abs(d.el1 - prev.el1) / D2R / 1, Math.abs(shortAz(d.az2 - prev.az2)) / D2R / 2 + Math.abs(d.el2 - prev.el2) / D2R / 1) + 10 : 0;
        const score = md + 0.08 * Math.log(c.fx) - slew / 400 - (again ? 9 : 0);
        if (!best || score > best.score) best = { c, d, v, score, slew };
      }
      if (!best) { t += 60; continue; }
      const c = best.c, ts = t + best.slew;
      const need = (snr0, tgt) => (tgt / snr0) ** 2;    // SNR ∝ √T
      const sX1 = snr(c.fx * (cfg.fluxScale || 1), st1.sefd.X, st2.sefd.X, cfg.bands.X.bw, 1, cfg.bands.X.ch.length), sS1 = snr(c.fs * (cfg.fluxScale || 1), st1.sefd.S, st2.sefd.S, cfg.bands.S.bw, 1, cfg.bands.S.ch.length);
      const T = Math.round(Math.max(30, Math.min(180, Math.max(need(sX1, 25), need(sS1, 12)))));
      if (ts + T > cfg.t0 + (cfg.dur || 3600)) break;
      const d = delay(P0, c.src, ts + T / 2, ts + T / 2);
      out.push({ t: ts + T / 2, t_start: ts, T, name: c.name, src: c.src, flux: c.fx, fluxX: c.fx, fluxS: c.fs, az1: d.az1, el1: d.el1, az2: d.az2, el2: d.el2 });
      used.push({ v: best.v }); prev = { name: c.name, az1: d.az1, el1: d.el1, az2: d.az2, el2: d.el2 }; t = ts + T;
    }
    return out;
  }
  const shortAz = (a) => { let x = a % (2 * Math.PI); if (x > Math.PI) x -= 2 * Math.PI; if (x < -Math.PI) x += 2 * Math.PI; return x; };
  function intensive(cfg) {
    const R = rng(cfg.seed || 11), st1 = cfg.st1, st2 = cfg.st2, bX = cfg.bands.X, bS = cfg.bands.S;
    const scans = cfg.scans || intSchedule(cfg), tref = scans.length ? (scans[0].t + scans[scans.length - 1].t) / 2 : cfg.t0;
    const dutT = (cfg.dut1 ?? 30) * 1e-6, clk = cfg.clk || [2.3e-7, 1.2e-14];
    const PT = { x1: st1.xyz, x2: st2.xyz, dut1: dutT, clk: (t) => clk[0] + clk[1] * (t - tref), zhd1: zhd(st1.xyz), zhd2: zhd(st2.xyz),
      zwd1: (t) => (cfg.zwd1 ?? 0.15) + (cfg.tropoVar === false ? 0 : 0.01 * Math.sin((t - tref) / 2400)), zwd2: (t) => (cfg.zwd2 ?? 0.12) + (cfg.tropoVar === false ? 0 : 0.008 * Math.cos((t - tref) / 3000)),
      vtec1: cfg.vtec1 ?? 18, vtec2: cfg.vtec2 ?? 25 };
    const obs = [];
    for (const sc of scans) {
      const d = delay(PT, sc.src, sc.t, sc.t);
      const sX = snr(sc.fluxX * (cfg.fluxScale || 1), st1.sefd.X, st2.sefd.X, bX.bw, sc.T, bX.ch.length), sS = snr(sc.fluxS * (cfg.fluxScale || 1), st1.sefd.S, st2.sefd.S, bS.bw, sc.T, bS.ch.length);
      const sigX = Math.hypot(sigTau(sX, bX), cfg.floor ?? 4e-12), sigS = Math.hypot(sigTau(sS, bS), cfg.floor ?? 4e-12), nz = cfg.noise === false ? 0 : 1;
      const fr = ionFree(groupAt(d, bX.feff) + nz * sigX * R.g(), groupAt(d, bS.feff) + nz * sigS * R.g(), bX, bS, sigX, sigS);
      obs.push({ t: sc.t, src: sc.src, name: sc.name, T: sc.T, tau: fr.tau, sig: fr.sig, snrX: sX, snrS: sS, el1: d.el1, el2: d.el2 });
    }
    const est = intSolve(obs, { st1, st2, tref, dut1Ap: (cfg.dut1Ap ?? 0) * 1e-6, zwd: cfg.zwdEst !== false, reweight: cfg.reweight });
    const B = sub(st2.xyz, st1.xyz), Beq = Math.hypot(B[0], B[1]);
    return { scans, obs, est, truth: { dut1_us: dutT * 1e6, clk }, B, L: nrm(B), Beq, sensMax: OMEGA * Beq / C * 1e-6, tref };   // sensMax: s/μs
  }
  function intSolve(obs, o) {
    const H = 3600, np = o.zwd ? 5 : 3, names = ['dUT1 μs', '시계 c₀ ns', '시계 c₁ ns/h', 'ZWD₁ m', 'ZWD₂ m'].slice(0, np);
    let p = new Float64Array(np); p[0] = o.dut1Ap * 1e6; let res = [], Q = null, chi2 = 0, sa = 0, part = [];
    const model = (pp, ob) => {
      const P = { x1: o.st1.xyz, x2: o.st2.xyz, dut1: pp[0] * 1e-6, clk: (t) => pp[1] * 1e-9 + pp[2] * 1e-9 * (t - o.tref) / H, zhd1: zhd(o.st1.xyz), zhd2: zhd(o.st2.xyz), zwd1: np > 3 ? pp[3] : 0, zwd2: np > 3 ? pp[4] : 0, vtec1: 0, vtec2: 0 };
      return delay(P, ob.src, ob.t, ob.t);
    };
    const pass = (sa2) => {
      for (let it = 0; it < 6; it++) {
        const N = Array.from({ length: np }, () => new Float64Array(np)), rhs = new Float64Array(np); res = []; chi2 = 0; part = [];
        for (const ob of obs) {
          const d = model(p, ob), y = ob.tau - d.nd, w = 1 / (ob.sig * ob.sig + sa2), pu = Array.from(p); pu[0] += 1;
          const a = new Float64Array(np); a[0] = model(pu, ob).nd - d.nd; a[1] = 1e-9; a[2] = 1e-9 * (ob.t - o.tref) / H;
          if (np > 3) { a[3] = -mapW(d.el1) / C; a[4] = mapW(d.el2) / C; }
          for (let i = 0; i < np; i++) { rhs[i] += a[i] * w * y; for (let j = 0; j < np; j++) N[i][j] += a[i] * w * a[j]; }
          res.push({ t: ob.t, v: y, sig: Math.sqrt(ob.sig * ob.sig + sa2), sig0: ob.sig, name: ob.name }); chi2 += y * y * w; part.push(a[0]);
        }
        if (np > 3) for (const i of [3, 4]) { N[i][i] += 1 / 0.25; rhs[i] += (0.1 - p[i]) / 0.25; }
        Q = inv(N); if (!Q) return;
        let mx = 0; for (let i = 0; i < np; i++) { let s2 = 0; for (let j = 0; j < np; j++) s2 += Q[i][j] * rhs[j]; p[i] += s2; mx = Math.max(mx, Math.abs(s2)); }
        if (mx < 1e-6) break;
      }
    };
    pass(0);
    const dof = Math.max(1, obs.length - np); let chi2r = chi2 / dof; const chi2r0 = chi2r;
    if (o.reweight !== false && chi2r > 1.05) {
      for (let k = 0; k < 4; k++) { const f = (x) => res.reduce((a2, q) => a2 + q.v * q.v / (q.sig0 * q.sig0 + x * x), 0) - dof; let lo = 0, hi = 2e-9; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; } sa = (lo + hi) / 2; pass(sa * sa); chi2r = chi2 / dof; if (Math.abs(chi2r - 1) < 0.02) break; }
    }
    const sc = Math.sqrt(Math.max(1, chi2r)), sig = Q ? Array.from({ length: np }, (_, i) => Math.sqrt(Math.max(0, Q[i][i])) * sc) : null;
    const corr = Q ? Q[0].map((v, j) => v / Math.sqrt(Q[0][0] * Q[j][j])) : null;
    return { p: Array.from(p), sig, names, res, chi2r, chi2r0, dof, sigAdd: sa, n: obs.length, np, wrms: wrms(res), part, corr };
  }


  // 실자료(DiFX 가 상관한 가시도 — realdata.json 의 한 묶음)를 fringe() 가 읽는 모양으로
  function realCorr(set) {
    const NB = set.nb, bw = set.bw, K = set.nap, ch = set.ch.map((c) => ({ f: c.f, id: c.id }));
    const fc = set.ch.map((c) => c.f + bw / 2), fm = fc.reduce((a, b) => a + b, 0) / fc.length;
    const band = { name: set.band, ch, bw, sr: 2 * bw, fmean: fm, frms: Math.sqrt(fc.reduce((a, v) => a + (v - fm) ** 2, 0) / fc.length + bw * bw / 12) };
    const fb = new Float64Array(NB); for (let j = 0; j < NB; j++) fb[j] = j * bw / NB;
    const tap = set.tap || Array.from({ length: K }, (_, k) => k * set.ap), wsum = set.w.reduce((a, b) => a + b, 0);
    return { V: set.V.map((row) => row.map((a) => Float64Array.from(a))), tap, fb, band, K, NF: 2 * NB, nsamp: 2 * bw * set.ap * wsum * ch.length, real: true };
  }

  const API = { C, OMEGA, D2R, KION, era, s_crs, crs2trs, geod, enuMat, azel, mapH, mapW, mapIon, zhd, delay, groupAt, fft, bands, snr, sigTau, Q2, ETA2BIT,
    simCorr, fringe, ionFree, session, sessionPrep, obsTheory, obsSignal, lsq, commonScans, fluxAt, realCorr, stationFor, geo2xyz, intSchedule, intensive, intSolve, rng, dot, sub, add, scl, nrm };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  G.VSCore = API;
})(typeof self !== 'undefined' ? self : this);
