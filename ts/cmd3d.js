/* cmd3d.js — 명령 칸 효과 층(three.js, 2026-10-04 센터장님 "완전히 첨단적이고 자동적인 느낌 … 마우스만 가져다 대도 인터렉티브하게 이펙트").
 *   명령 칸 전체 뒤에 캔버스 하나를 깔고 두 장면을 그린다.
 *   ① 칸 전체(픽셀 좌표 정사영): 회로선 위를 늘 흐르는 빛 신호 · 떠오르는 알갱이(마우스 곁에서 비켜나며 밝아짐) · 마우스 빛 ·
 *      단추에 마우스를 대면 코어에서 그 단추로 뻗는 에너지 선과 단추 둘레 빛 테 · 누르면 충격파 · 몇 초마다 위에서 아래로 지나가는 점검 훑기선
 *   ② 상태 코어(원근, 코어 칸 자리만): 레이더 홀로그램 — 도는 훑기 빛 · 겹 고리(서로 다른 빠르기) · 반구 선틀 · 안테나 지향 바늘(방위·고도) ·
 *      가운데 20면체 핵(상태 색: 대기 파랑 · 세션 초록 · 작업 호박 · 정지 빨강 · 꺼짐 회색). 코어에 마우스를 대면 그쪽으로 기울고 훑기가 빨라진다.
 *   글은 캔버스에 쓰지 않는다(판독은 옆 HTML) — 10-03 '글자상자가 3D 에 겹쳐'.
 * 쓰기: const fx = CmdFx.create(deck, canvas, coreEl); fx.set({state, az, el}); fx.pulse(색, x, y); fx.resize();
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const COL = { idle: 0x58a6ff, run: 0x3fb950, busy: 0xe3b341, halt: 0xf85149, off: 0x6e7f94 };
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function glowTex(T, soft) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(soft ? 0.15 : 0.3, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }
  // 둥근 네모 빛 테(단추 둘레) — 가운데는 비우고 테두리만 번지게
  function haloTex(T) {
    const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    for (let i = 0; i < 6; i++) { g.strokeStyle = `rgba(255,255,255,${0.05 + i * 0.05})`; g.lineWidth = 14 - i * 2.2; rr(16, 16, W - 32, H - 32, 18); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1.6; rr(16, 16, W - 32, H - 32, 18); g.stroke();
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }

  function create(deck, canvas, coreEl, opts) {
    opts = opts || {};                                  // core: false — 코어 칸에 레이더 홀로그램을 그리지 않는다(실물 모형이 대신, 10-04)
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0);
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    rn.setPixelRatio(DPR);
    rn.autoClear = false;
    const GLOW = glowTex(T), GLOW2 = glowTex(T, true), HALO = haloTex(T);
    let W = 10, H = 10, color = new T.Color(COL.idle), st = 'idle';

    // ───── ① 칸 전체 — 픽셀 좌표(왼쪽 위 0,0 · y 아래로 → 장면 y = −y) ─────
    const sc = new T.Scene();
    const oc = new T.OrthographicCamera(0, 10, 0, -10, -10, 10);
    const traceMat = new T.LineBasicMaterial({ color: 0x3d7fd1, transparent: true, opacity: 0.32, depthWrite: false });
    let traces = [];                                   // [{pts:[Vector2…], len, segLen[]}]
    const traceG = new T.Group(); sc.add(traceG);
    // 흐르는 신호
    const NP = 26, pulseG = new T.BufferGeometry(), pulsePos = new Float32Array(NP * 3), pulseCol = new Float32Array(NP * 3);
    pulseG.setAttribute('position', new T.BufferAttribute(pulsePos, 3)); pulseG.setAttribute('color', new T.BufferAttribute(pulseCol, 3));
    const pulsePts = new T.Points(pulseG, new T.PointsMaterial({ size: 9 * DPR, map: GLOW, vertexColors: true, transparent: true, depthWrite: false,
      blending: T.AdditiveBlending, sizeAttenuation: false }));
    sc.add(pulsePts);
    const pulses = Array.from({ length: NP }, (_, i) => ({ tr: i, s: Math.random(), v: 0.08 + Math.random() * 0.14 }));
    // 알갱이
    const NQ = 240, dustG = new T.BufferGeometry(), dustPos = new Float32Array(NQ * 3), dustCol = new Float32Array(NQ * 3);
    dustG.setAttribute('position', new T.BufferAttribute(dustPos, 3)); dustG.setAttribute('color', new T.BufferAttribute(dustCol, 3));
    sc.add(new T.Points(dustG, new T.PointsMaterial({ size: 2.6 * DPR, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
      blending: T.AdditiveBlending, sizeAttenuation: false })));
    const dust = Array.from({ length: NQ }, () => ({ x: Math.random(), y: Math.random(), vx: 0, vy: 0, b: 0.25 + Math.random() * 0.5, sp: 6 + Math.random() * 14 }));
    // 마우스 빛
    const mGlow = new T.Sprite(new T.SpriteMaterial({ map: GLOW2, color: COL.idle, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    mGlow.scale.set(220, 220, 1); sc.add(mGlow);
    // 단추 빛 테 + 에너지 선(코어 → 단추) 3가닥
    const halo = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: HALO, color: COL.idle, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    sc.add(halo);
    const arcs = [0, 1, 2].map(() => {
      const g = new T.BufferGeometry().setFromPoints(Array.from({ length: 40 }, () => new T.Vector3()));
      const m = new T.LineDashedMaterial({ color: COL.idle, dashSize: 7, gapSize: 9, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending });
      const l = new T.Line(g, m); sc.add(l); return l;
    });
    // 에너지 선을 따라 흐르는 빛 알갱이(코어 → 단추) — 선만으로는 옅어서(10-04 첫 시험)
    const NE = 45, enG = new T.BufferGeometry(), enPos = new Float32Array(NE * 3), enCol = new Float32Array(NE * 3);
    enG.setAttribute('position', new T.BufferAttribute(enPos, 3)); enG.setAttribute('color', new T.BufferAttribute(enCol, 3));
    sc.add(new T.Points(enG, new T.PointsMaterial({ size: 8 * DPR, map: GLOW, vertexColors: true, transparent: true, depthWrite: false,
      blending: T.AdditiveBlending, sizeAttenuation: false })));
    const flare = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color: COL.idle, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    flare.scale.set(46, 46, 1); sc.add(flare);
    // 점검 훑기선
    const scan = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: GLOW2, color: COL.idle, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    sc.add(scan);
    const waves = [];

    // ───── ② 상태 코어 — 원근(코어 칸 자리만) ─────
    const cs = new T.Scene(), cc = new T.PerspectiveCamera(30, 1.3, 0.1, 40);
    const croot = new T.Group(); cs.add(croot);
    const lm = (c, o) => new T.LineBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false });
    const dir = (az, el, r) => new T.Vector3(r * Math.sin(az * D2R) * Math.cos(el * D2R), r * Math.sin(el * D2R), -r * Math.cos(az * D2R) * Math.cos(el * D2R));
    const ringPts = (r, el, step) => { const p = []; for (let a = 0; a <= 360; a += step || 3) p.push(dir(a, el || 0, r)); return p; };
    const floor = new T.Mesh(new T.CircleGeometry(1.0, 96), new T.MeshBasicMaterial({ color: 0x050f22, transparent: true, opacity: 0.8, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; croot.add(floor);
    const rimMat = new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.8, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending });
    const rim = new T.Mesh(new T.RingGeometry(0.985, 1.035, 160), rimMat); rim.rotation.x = -Math.PI / 2; croot.add(rim);
    for (const r of [0.33, 0.66]) croot.add(new T.Line(new T.BufferGeometry().setFromPoints(ringPts(r)), lm(0x24497a, 0.8)));
    const ticks = []; for (let a = 0; a < 360; a += 10) { const L = a % 30 ? 0.05 : 0.11; ticks.push(dir(a, 0, 0.98), dir(a, 0, 0.98 - L)); }
    croot.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(ticks), lm(0x8cbcf2, 0.85)));
    const nMark = new T.Mesh(new T.ConeGeometry(0.045, 0.12, 3), new T.MeshBasicMaterial({ color: 0xff7b72 }));
    nMark.position.copy(dir(0, 0, 1.11)); nMark.rotation.x = -Math.PI / 2; croot.add(nMark);
    // 반구 선틀(옅게)
    for (const el of [30, 60]) croot.add(new T.Line(new T.BufferGeometry().setFromPoints(ringPts(Math.cos(el * D2R), 0).map((v) => v.setY(Math.sin(el * D2R)))), lm(0x2f5f9a, 0.35)));
    for (let az = 0; az < 360; az += 45) { const p = []; for (let e = 0; e <= 90; e += 5) p.push(dir(az, e, 1)); croot.add(new T.Line(new T.BufferGeometry().setFromPoints(p), lm(0x2f5f9a, 0.25))); }
    // 도는 겹 고리(점선) — 서로 다른 빠르기
    const spin = [];
    for (const [r, y, sp, op] of [[1.16, 0.0, 0.25, 0.55], [0.86, 0.02, -0.5, 0.45], [0.5, 0.03, 0.9, 0.5]]) {
      const g = new T.BufferGeometry().setFromPoints(ringPts(r, 0, 2).map((v) => v.setY(y)));
      const l = new T.Line(g, new T.LineDashedMaterial({ color: COL.idle, dashSize: 0.06, gapSize: 0.08, transparent: true, opacity: op, depthWrite: false }));
      l.computeLineDistances(); croot.add(l); spin.push({ l, sp });
    }
    // 훑기 빛(꼬리 달린 부채꼴 8장)
    const sweep = new T.Group(); croot.add(sweep);
    for (let i = 0; i < 8; i++) {
      const m = new T.Mesh(new T.CircleGeometry(0.98, 16, 0, 6 * D2R), new T.MeshBasicMaterial({ color: COL.idle, transparent: true,
        opacity: 0.42 * (1 - i / 8) ** 1.6, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
      m.rotation.x = -Math.PI / 2; m.rotation.z = -i * 6 * D2R; m.position.y = 0.004; sweep.add(m);
    }
    // 핵
    const coreMat = new T.LineBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.95 });
    const core = new T.LineSegments(new T.EdgesGeometry(new T.IcosahedronGeometry(0.15, 1)), coreMat); core.position.y = 0.22; croot.add(core);
    const core2 = new T.LineSegments(new T.EdgesGeometry(new T.OctahedronGeometry(0.08, 0)), coreMat); core2.position.y = 0.22; croot.add(core2);
    const cGlow = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color: COL.idle, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    cGlow.position.y = 0.22; cGlow.scale.set(0.8, 0.8, 1); croot.add(cGlow);
    // 안테나 지향 바늘
    const beamL = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0.22, 0), new T.Vector3(0, 1, 0)]), new T.LineBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.95 }));
    croot.add(beamL);
    const beamC = new T.Mesh(new T.ConeGeometry(0.06, 1, 24, 1, true), new T.MeshBasicMaterial({ color: 0x8cc8ff, transparent: true, opacity: 0.16, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
    beamC.geometry.translate(0, -0.5, 0); beamC.geometry.rotateX(-Math.PI / 2); croot.add(beamC);
    const tip = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color: 0xbfe0ff, transparent: true, depthWrite: false, blending: T.AdditiveBlending })); tip.scale.set(0.26, 0.26, 1); croot.add(tip);
    const azM = new T.Mesh(new T.ConeGeometry(0.05, 0.13, 3), new T.MeshBasicMaterial({ color: 0xbfe0ff })); croot.add(azM);
    const shadow = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), lm(0x58a6ff, 0.55)); croot.add(shadow);

    // ───── 마우스 ─────
    const M = { x: -999, y: -999, in: false, sx: -999, sy: -999, overCore: false };
    let hoverEl = null, hoverK = 0, hoverR = null;
    const rel = (e) => { const r = deck.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    deck.addEventListener('pointermove', (e) => {
      [M.x, M.y] = rel(e); M.in = true;
      const cr = coreEl.getBoundingClientRect(); M.overCore = e.clientX >= cr.left && e.clientX <= cr.right && e.clientY >= cr.top && e.clientY <= cr.bottom;
      M.cx = (e.clientX - cr.left) / cr.width - 0.5; M.cy = (e.clientY - cr.top) / cr.height - 0.5;
      const b = e.target.closest && e.target.closest('.dk, .deck-sel, .dk-phb, .seg button');
      if (b !== hoverEl) { hoverEl = b && !b.disabled ? b : null; }
    });
    deck.addEventListener('pointerleave', () => { M.in = false; hoverEl = null; M.overCore = false; });
    deck.addEventListener('pointerdown', (e) => { const [x, y] = rel(e); pulse(null, x, y); });

    function pulse(c, x, y) {
      const m = new T.Mesh(new T.RingGeometry(0.8, 1.0, 64), new T.MeshBasicMaterial({ color: c != null ? c : color.getHex(), transparent: true, opacity: 0.9,
        side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
      if (x == null) { const r = coreRect(); x = r.x + r.w / 2; y = r.y + r.h / 2; }
      m.position.set(x, -y, 0); m.scale.setScalar(4); sc.add(m); waves.push({ m, t0: performance.now(), big: x == null });
      cWave = performance.now();
    }
    let cWave = -1e9;
    function coreRect() {
      const d = deck.getBoundingClientRect(), r = coreEl.getBoundingClientRect();
      return { x: r.left - d.left, y: r.top - d.top, w: r.width, h: r.height };
    }
    // 회로선 — 칸 모양(무리 머리·단추 줄)을 따라 다시 만든다
    function buildTraces() {
      while (traceG.children.length) { const o = traceG.children.pop(); o.geometry.dispose(); }
      traces = [];
      const d = deck.getBoundingClientRect(), L = 6, R = W - 6;
      const add = (pts) => {
        const v = pts.map(([x, y]) => new T.Vector3(x, -y, 0));
        traceG.add(new T.Line(new T.BufferGeometry().setFromPoints(v), traceMat));
        const seg = []; let len = 0;
        for (let i = 1; i < v.length; i++) { const s = v[i].distanceTo(v[i - 1]); seg.push(s); len += s; }
        traces.push({ v, seg, len });
      };
      add([[L, 12], [L, H - 12]]); add([[R, 12], [R, H - 12]]);
      deck.querySelectorAll('.deck-gh').forEach((h, i) => {
        const r = h.getBoundingClientRect(), y = r.top - d.top + r.height / 2, x = r.left - d.left - 4;
        if (i % 2) add([[R, y - 18], [R - 14, y - 4], [W * 0.55, y - 4]]); else add([[L, y - 18], [L + 14, y], [x, y]]);
      });
      const c = coreRect();
      add([[c.x - 2, c.y + c.h + 3], [c.x + c.w * 0.7, c.y + c.h + 3], [c.x + c.w * 0.7 + 10, c.y + c.h + 13]]);
      add([[L, c.y + 8], [c.x - 3, c.y + 8]]);
      pulses.forEach((p, i) => { p.tr = i % traces.length; });
    }
    function along(tr, s) {
      let d = s * tr.len;
      for (let i = 0; i < tr.seg.length; i++) {
        if (d <= tr.seg[i]) return tr.v[i].clone().lerp(tr.v[i + 1], tr.seg[i] ? d / tr.seg[i] : 0);
        d -= tr.seg[i];
      }
      return tr.v[tr.v.length - 1].clone();
    }

    let az = 0, el = 85, azN = 0, elN = 85, last = 0, visible = true, raf = 0, t0 = performance.now(), layoutSig = '';
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(deck);

    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !visible || t - last < (reduce ? 120 : 33)) return;
      const dt = Math.min(4, (t - last) / 33); last = t;
      const sig = deck.clientWidth + 'x' + deck.clientHeight + ':' + coreEl.offsetTop;
      if (sig !== layoutSig) { layoutSig = sig; resize(); }
      const col = color, ch = col.getHex();
      // ① 칸 전체
      for (const p of pulses) {
        const tr = traces[p.tr]; if (!tr) continue;
        p.s += (p.v * dt * 33 / 1000) * (hoverEl ? 1.8 : 1) * (60 / Math.max(60, tr.len)) * 6;
        if (p.s > 1) { p.s = 0; p.tr = Math.floor(Math.random() * traces.length); }
      }
      pulses.forEach((p, i) => {
        const tr = traces[p.tr]; const v = tr ? along(tr, p.s) : new T.Vector3(-99, 99, 0);
        pulsePos.set([v.x, v.y, 0], i * 3);
        const k = Math.sin(Math.PI * p.s);
        pulseCol.set([col.r * k + 0.2 * k, col.g * k + 0.2 * k, col.b * k + 0.2 * k], i * 3);
      });
      pulseG.attributes.position.needsUpdate = true; pulseG.attributes.color.needsUpdate = true;
      // 알갱이 — 위로 떠오르고, 마우스 곁에서 비켜나며 밝아진다
      M.sx += (M.x - M.sx) * Math.min(1, 0.25 * dt); M.sy += (M.y - M.sy) * Math.min(1, 0.25 * dt);
      dust.forEach((q, i) => {
        let px = q.x * W, py = q.y * H;
        const dx = px - M.sx, dy = py - M.sy, d2 = dx * dx + dy * dy, near = M.in && d2 < 9000;
        if (near) { const f = (1 - d2 / 9000) * 1.6; q.vx += (dx / Math.sqrt(d2 + 1)) * f; q.vy += (dy / Math.sqrt(d2 + 1)) * f; }
        q.vx *= 0.9; q.vy *= 0.9;
        px += q.vx * dt; py += q.vy * dt - q.sp * dt * 0.033;
        if (py < -4) { py = H + 4; px = Math.random() * W; }
        if (px < -4) px = W + 4; if (px > W + 4) px = -4;
        q.x = px / W; q.y = py / H;
        dustPos.set([px, -py, 0], i * 3);
        const b = q.b * (near ? 2.4 : 1) * (0.7 + 0.3 * Math.sin(t / 700 + i));
        dustCol.set([col.r * b, col.g * b, col.b * b], i * 3);
      });
      dustG.attributes.position.needsUpdate = true; dustG.attributes.color.needsUpdate = true;
      mGlow.position.set(M.sx, -M.sy, 0); mGlow.material.opacity += ((M.in ? 0.34 : 0) - mGlow.material.opacity) * 0.15; mGlow.material.color.setHex(ch);
      // 단추 빛 테 · 에너지 선
      hoverK += ((hoverEl ? 1 : 0) - hoverK) * Math.min(1, 0.22 * dt);
      if (hoverEl) { const d = deck.getBoundingClientRect(), r = hoverEl.getBoundingClientRect(); hoverR = { x: r.left - d.left, y: r.top - d.top, w: r.width, h: r.height }; }
      if (hoverR) {
        const r = hoverR, pad = 12, k = 0.5 + 0.5 * Math.sin(t / 220);
        halo.position.set(r.x + r.w / 2, -(r.y + r.h / 2), 0); halo.scale.set(r.w + pad * 2 + 6, r.h + pad * 2 + 6, 1);
        halo.material.opacity = hoverK * (0.55 + 0.35 * k);
        const hc = hoverEl && hoverEl.classList.contains('dk-halt') || hoverEl && hoverEl.classList.contains('dk-estop') ? 0xf85149 : hoverEl && hoverEl.classList.contains('dk-go') ? 0x3fb950 : ch;
        halo.material.color.setHex(hc);
        const c = coreRect(), sx = c.x + c.w * 0.36, sy = c.y + c.h * 0.5, ex = r.x + 10, ey = r.y + r.h / 2;
        const hcc = new T.Color(hc);
        const bez = (j, u) => {
          const bend = 40 + j * 26, mx = Math.min(sx, ex) - bend * 0.55 + 6 * Math.sin(t / 400 + j), my = (sy + ey) / 2;
          return [(1 - u) * (1 - u) * sx + 2 * (1 - u) * u * mx + u * u * ex, (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * my + u * u * ey];
        };
        arcs.forEach((a, j) => {
          const pos = a.geometry.attributes.position;
          for (let i = 0; i < 40; i++) { const [x, y] = bez(j, i / 39); pos.setXYZ(i, x, -y, 0); }
          pos.needsUpdate = true; a.computeLineDistances();
          a.material.dashOffset = -(t / 18) - j * 5;
          a.material.opacity = hoverK * (0.85 - j * 0.2); a.material.color.setHex(hc);
        });
        for (let i = 0; i < NE; i++) {                                 // 가닥마다 15 알갱이가 코어에서 단추로 흐른다
          const j = i % 3, u = ((t / (900 + j * 260)) + Math.floor(i / 3) / 15) % 1, [x, y] = bez(j, u);
          enPos.set([x, -y, 0], i * 3);
          const k = hoverK * Math.sin(Math.PI * u) * (1 - j * 0.22);
          enCol.set([hcc.r * k * 1.3, hcc.g * k * 1.3, hcc.b * k * 1.3], i * 3);
        }
        enG.attributes.position.needsUpdate = true; enG.attributes.color.needsUpdate = true;
        flare.position.set(ex - 2, -ey, 0); flare.material.color.setHex(hc); flare.material.opacity = hoverK * (0.55 + 0.35 * k);
      }
      if (hoverK < 0.01) {
        hoverR = null; halo.material.opacity = 0; flare.material.opacity = 0; arcs.forEach((a) => { a.material.opacity = 0; });
        enCol.fill(0); enG.attributes.color.needsUpdate = true;
      }
      // 점검 훑기선 — 6.5 s 마다 위에서 아래로
      const cyc = ((t - t0) % 6500) / 6500;
      if (cyc < 0.42) { const y = (cyc / 0.42) * (H + 40) - 20; scan.position.set(W / 2, -y, 0); scan.scale.set(W * 1.5, 26, 1); scan.material.opacity = 0.32 * Math.sin(Math.PI * cyc / 0.42); scan.material.color.setHex(ch); }
      else scan.material.opacity = 0;
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i], f = (t - w.t0) / 900;
        if (f >= 1) { sc.remove(w.m); w.m.geometry.dispose(); w.m.material.dispose(); waves.splice(i, 1); continue; }
        w.m.scale.setScalar(4 + 70 * f); w.m.material.opacity = 0.9 * (1 - f);
      }
      // ② 코어
      const da = ((((az - azN) % 360) + 540) % 360) - 180;
      azN += da * Math.min(1, 0.12 * dt); elN += (el - elN) * Math.min(1, 0.12 * dt);
      const d = dir(azN, Math.max(0, elN), 1.0), o = new T.Vector3(0, 0.22, 0);
      beamL.geometry.setFromPoints([o, d]); tip.position.copy(d);
      beamC.position.copy(o); beamC.lookAt(d); beamC.scale.set(1, 1, d.distanceTo(o));
      azM.position.copy(dir(azN, 0, 1.12)); azM.lookAt(0, 0, 0); azM.rotateX(Math.PI / 2);
      shadow.geometry.setFromPoints([new T.Vector3(0, 0.002, 0), dir(azN, 0, 1.0)]);
      const fast = M.overCore ? 2.6 : 1, burst = Math.max(0, 1 - (t - cWave) / 900);
      sweep.rotation.y -= (st === 'run' ? 0.05 : st === 'halt' ? 0 : 0.032) * dt * fast;
      spin.forEach((s) => { s.l.rotation.y += s.sp * 0.01 * dt * fast; });
      core.rotation.y += 0.014 * dt * fast; core.rotation.x += 0.005 * dt; core2.rotation.y -= 0.025 * dt * fast;
      const k = 0.5 + 0.5 * Math.sin(t / (st === 'run' ? 400 : st === 'halt' ? 170 : 900));
      cGlow.material.opacity = 0.45 + 0.35 * k + 0.5 * burst; cGlow.scale.setScalar(0.8 + 0.5 * burst);
      rimMat.opacity = 0.5 + 0.3 * k;
      // 기울기 — 코어에 마우스를 대면 그쪽으로
      const tx = M.overCore ? M.cx : 0, ty = M.overCore ? M.cy : 0;
      croot.rotation.y += ((tx * 0.9 + 0.15 * Math.sin(t / 7000)) - croot.rotation.y) * 0.08;
      const cr0 = coreRect(), asp = cr0.w / Math.max(1, cr0.h);
      const th = 1.0 + ty * 0.5, R = 3.75 * Math.max(1, 1.3 / asp);   // 좁은 칸(미니앱)에도 고리(지름 2.3)가 다 들어오게 멀리서
      cc.position.set(0, R * Math.cos(th) + 0.1, R * Math.sin(th)); cc.lookAt(0, 0.22, 0);
      // 그리기 — ① 전체, ② 코어 자리
      rn.setViewport(0, 0, W, H); rn.setScissor(0, 0, W, H); rn.setScissorTest(false);
      rn.clear();
      rn.render(sc, oc);
      const r = coreRect();
      if (opts.core !== false && r.w > 4 && r.h > 4) {
        const vy = H - r.y - r.h;
        rn.setScissorTest(true); rn.setViewport(r.x, vy, r.w, r.h); rn.setScissor(r.x, vy, r.w, r.h);
        cc.aspect = r.w / r.h; cc.updateProjectionMatrix();
        rn.clearDepth(); rn.render(cs, cc);
        rn.setScissorTest(false);
      }
    }
    function resize() {
      W = Math.max(10, deck.clientWidth); H = Math.max(10, deck.clientHeight);
      rn.setSize(W, H, false);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      oc.left = 0; oc.right = W; oc.top = 0; oc.bottom = -H; oc.updateProjectionMatrix();
      buildTraces();
      return true;
    }
    raf = requestAnimationFrame(frame);
    return {
      set(o) {
        if (o.az != null && isFinite(o.az)) az = ((+o.az % 360) + 360) % 360;
        if (o.el != null && isFinite(o.el)) el = +o.el;
        if (o.state && o.state !== st) {
          st = o.state; color = new T.Color(COL[st] || COL.idle);
          const h = color.getHex();
          coreMat.color.setHex(h); cGlow.material.color.setHex(h); rimMat.color.setHex(h); traceMat.color.setHex(h);
          sweep.children.forEach((m) => m.material.color.setHex(h)); spin.forEach((s) => s.l.material.color.setHex(h));
        }
      },
      pulse,
      resize,
      dispose() { cancelAnimationFrame(raf); rn.dispose(); },
    };
  }
  window.CmdFx = { create, COL };
})();
