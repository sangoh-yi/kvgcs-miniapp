/* fx3d.js — 페이지 전체 효과(three.js, 2026-10-04 센터장님 "전체 페이지 첨단 3js 이팩트 효과 빵빵하게 · 글자도 시인성 좋게").
 *   두 층 — 둘 다 pointer-events 없음(클릭·스크롤은 그대로 아래로).
 *   ① 뒤 층(canvas, 글 아래): 흐르는 점 격자 · 떠다니는 별빛 알갱이(마우스 곁에서 비켜나며 밝아지고 별자리 선으로 이어짐) · 마우스 빛
 *   ② 앞 층(overlay, 글 위 — 가산 혼합 · 테두리와 틈에만): 카드 테두리를 따라 달리는 네온 빛(늘) · 마우스를 댄 카드 빛 테와 테두리 빛 넷 ·
 *      주요 칸을 잇는 데이터 흐름(빛 알갱이 곡선) · 9 s 마다 화면을 훑는 점검 띠(옅게) · 누르면 충격파 · 커서를 따라 도는 조준 고리
 *   상태 색 — html[data-obs="rec"] 기록 중이면 빨강 기운, 아니면 파랑. 밝은 테마는 옅은 남색·보통 혼합.
 *   글은 캔버스에 쓰지 않는다. 움직임 줄이기(prefers-reduced-motion)면 느리게·옅게.
 * 쓰기: PageFx.create({ canvas, overlay, links: [['#a', '#b'], …], cards: '.card, .rail', count: 560 })
 */
'use strict';
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function glowTex(T, soft) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(soft ? 0.12 : 0.28, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }
  function haloTex(T) {
    const W = 512, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    for (let i = 0; i < 7; i++) { g.strokeStyle = `rgba(255,255,255,${0.03 + i * 0.045})`; g.lineWidth = 22 - i * 3; rr(24, 24, W - 48, H - 48, 22); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1.6; rr(24, 24, W - 48, H - 48, 22); g.stroke();
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }
  function dotTex(T) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(32, 32, 1.15, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(0, 32, 64, 0.6); g.fillRect(32, 0, 0.6, 64);
    const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.minFilter = T.LinearFilter; return t;
  }
  function reticleTex(T) {                          // 조준 고리 — 점선 고리 + 십자 눈금
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 2;
    for (let a = 0; a < 360; a += 30) { g.beginPath(); g.arc(64, 64, 44, (a + 4) * Math.PI / 180, (a + 22) * Math.PI / 180); g.stroke(); }
    g.lineWidth = 1.2; g.globalAlpha = 0.7; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1; g.lineWidth = 2;
    for (const [x0, y0, x1, y1] of [[64, 4, 64, 16], [64, 112, 64, 124], [4, 64, 16, 64], [112, 64, 124, 64]]) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }

  function create(o) {
    const T = window.THREE;
    if (!T || !o || !o.canvas) throw new Error('three.js 없음');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const mkR = (cv) => { const r = new T.WebGLRenderer({ canvas: cv, antialias: false, alpha: true }); r.setClearColor(0x000000, 0); r.setPixelRatio(DPR); return r; };
    const rnB = mkR(o.canvas), rnF = o.overlay ? mkR(o.overlay) : null;
    const bg = new T.Scene(), fg = new T.Scene(), cam = new T.OrthographicCamera(0, 10, 0, -10, -10, 10);
    const GLOW = glowTex(T), GLOW2 = glowTex(T, true), HALO = haloTex(T), DOT = dotTex(T), RET = reticleTex(T);
    let W = 10, H = 10, col = new T.Color(0x58a6ff), light = null;
    const mats = [];
    const mk = (m) => { mats.push(m); return m; };
    const AB = () => (light ? T.NormalBlending : T.AdditiveBlending);

    // ───── ① 뒤 층 ─────
    const grid = new T.Mesh(new T.PlaneGeometry(1, 1), mk(new T.MeshBasicMaterial({ map: DOT, color: 0x6fa8ff, transparent: true, opacity: 0.2, depthWrite: false })));
    bg.add(grid);
    const N = Math.max(80, o.count || 560), pg = new T.BufferGeometry(), pp = new Float32Array(N * 3), pc = new Float32Array(N * 3);
    pg.setAttribute('position', new T.BufferAttribute(pp, 3)); pg.setAttribute('color', new T.BufferAttribute(pc, 3));
    const ptsMat = mk(new T.PointsMaterial({ size: 2.6 * DPR, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false }));
    bg.add(new T.Points(pg, ptsMat));
    const P = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), vx: 0, vy: 0, z: 0.3 + Math.random() * 0.7, b: 0.35 + Math.random() * 0.65, ph: Math.random() * 6.28 }));
    const MAXL = 180, lg = new T.BufferGeometry(), lp = new Float32Array(MAXL * 6), lc = new Float32Array(MAXL * 6);
    lg.setAttribute('position', new T.BufferAttribute(lp, 3)); lg.setAttribute('color', new T.BufferAttribute(lc, 3));
    const lineMat = mk(new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    bg.add(new T.LineSegments(lg, lineMat));
    const mGlow = new T.Sprite(mk(new T.SpriteMaterial({ map: GLOW2, color: 0x58a6ff, transparent: true, opacity: 0, depthWrite: false })));
    mGlow.scale.set(420, 420, 1); bg.add(mGlow);

    // ───── ② 앞 층 ─────
    const F = rnF ? fg : bg;                          // 앞 캔버스가 없으면 뒤 층에 함께
    const halo = new T.Mesh(new T.PlaneGeometry(1, 1), mk(new T.MeshBasicMaterial({ map: HALO, color: 0x58a6ff, transparent: true, opacity: 0, depthWrite: false })));
    F.add(halo);
    const spot = new T.Sprite(mk(new T.SpriteMaterial({ map: GLOW2, color: 0x58a6ff, transparent: true, opacity: 0, depthWrite: false })));
    spot.scale.set(260, 260, 1); F.add(spot);
    const reticle = new T.Sprite(mk(new T.SpriteMaterial({ map: RET, color: 0x8cc8ff, transparent: true, opacity: 0, depthWrite: false })));
    reticle.scale.set(46, 46, 1); F.add(reticle);
    // 테두리 달림 빛 — 카드마다 머리 1 + 꼬리 7
    const RUN = 18, MAXC = 24, rg = new T.BufferGeometry(), rp = new Float32Array(MAXC * RUN * 3), rc = new Float32Array(MAXC * RUN * 3);
    rg.setAttribute('position', new T.BufferAttribute(rp, 3)); rg.setAttribute('color', new T.BufferAttribute(rc, 3));
    F.add(new T.Points(rg, mk(new T.PointsMaterial({ size: 6 * DPR, map: GLOW, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false }))));
    // 마우스를 댄 카드 — 테두리 빛 넷
    const HR = 4 * RUN, hg = new T.BufferGeometry(), hp = new Float32Array(HR * 3), hc = new Float32Array(HR * 3);
    hg.setAttribute('position', new T.BufferAttribute(hp, 3)); hg.setAttribute('color', new T.BufferAttribute(hc, 3));
    F.add(new T.Points(hg, mk(new T.PointsMaterial({ size: 9 * DPR, map: GLOW, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false }))));
    // 데이터 흐름
    const links = (o.links || []).map(([a, b]) => ({ a, b }));
    const NS = Math.max(1, links.length) * 30, sg = new T.BufferGeometry(), sp = new Float32Array(NS * 3), scol = new Float32Array(NS * 3);
    sg.setAttribute('position', new T.BufferAttribute(sp, 3)); sg.setAttribute('color', new T.BufferAttribute(scol, 3));
    F.add(new T.Points(sg, mk(new T.PointsMaterial({ size: 7 * DPR, map: GLOW, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false }))));
    const trailMat = mk(new T.LineBasicMaterial({ color: 0x3d7fd1, transparent: true, opacity: 0.35, depthWrite: false }));
    const trails = links.map(() => { const l = new T.Line(new T.BufferGeometry().setFromPoints(Array.from({ length: 32 }, () => new T.Vector3())), trailMat); F.add(l); return l; });
    const band = new T.Mesh(new T.PlaneGeometry(1, 1), mk(new T.MeshBasicMaterial({ map: GLOW2, color: 0x58a6ff, transparent: true, opacity: 0, depthWrite: false })));
    F.add(band);
    const waves = [];

    // ───── 마우스 ─────
    const M = { x: -9999, y: -9999, sx: -9999, sy: -9999, in: false };
    let hoverCard = null, hk = 0, hr = null;
    const cardSel = o.cards || '.card';
    addEventListener('pointermove', (e) => { M.x = e.clientX; M.y = e.clientY; M.in = true; hoverCard = e.target.closest ? e.target.closest(cardSel) : null; }, { passive: true });
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { M.in = false; hoverCard = null; } });
    addEventListener('blur', () => { M.in = false; });
    addEventListener('pointerdown', (e) => {
      for (const [k, big] of [[0, 1], [1, 0.55]]) {
        const m = new T.Mesh(new T.RingGeometry(0.86, 1.0, 72), new T.MeshBasicMaterial({ color: col.getHex(), transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false, blending: AB() }));
        m.position.set(e.clientX, -e.clientY, 0); m.scale.setScalar(3); F.add(m); waves.push({ m, t0: performance.now() + k * 120, big });
      }
    }, { passive: true });

    const rectOf = (el) => { if (!el || el.hidden || !el.offsetParent) return null; const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < H ? r : null; };
    const rect = (sel) => rectOf(typeof sel === 'string' ? document.querySelector(sel) : sel);
    function perim(r, s) {                            // 네모 둘레 위 점(시계 방향, s ∈ [0,1))
      const w = r.width, h = r.height, L = 2 * (w + h); let d = (((s % 1) + 1) % 1) * L;
      if (d < w) return [r.left + d, r.top]; d -= w;
      if (d < h) return [r.right, r.top + d]; d -= h;
      if (d < w) return [r.right - d, r.bottom]; d -= w;
      return [r.left, r.bottom - d];
    }
    const bez = (p0, p1, p2, u) => [(1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * p1[0] + u * u * p2[0], (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * p1[1] + u * u * p2[1]];
    function linkPath(ra, rb) {
      const ca = [ra.left + ra.width / 2, ra.top + ra.height / 2], cb = [rb.left + rb.width / 2, rb.top + rb.height / 2];
      let p0, p2;
      if (Math.abs(cb[0] - ca[0]) > Math.abs(cb[1] - ca[1])) { const s = cb[0] > ca[0]; p0 = [s ? ra.right : ra.left, ra.top + 24]; p2 = [s ? rb.left : rb.right, rb.top + 24]; }
      else { const s = cb[1] > ca[1]; p0 = [ca[0], s ? ra.bottom : ra.top]; p2 = [cb[0], s ? rb.top : rb.bottom]; return [p0, [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2], p2]; }
      return [p0, [(p0[0] + p2[0]) / 2, Math.min(p0[1], p2[1]) - 26], p2];
    }
    let cards = [], cardsT = 0, lightT = 0, lightV = false;
    // 밝은 바탕인가 — 테마 이름 대신 --bg 밝기로(운용 화면 light/dark · 미니앱 자동·밝음·종이·청사진 … 모두)
    function isLight() {
      if (o.isLight) return !!o.isLight();
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!m) return document.documentElement.getAttribute('data-theme') === 'light';
      let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
    }
    const seed = new WeakMap();

    let last = 0, raf = 0, t0 = performance.now();
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < (reduce ? 120 : 33)) return;
      const dt = Math.min(4, (t - last) / 33); last = t;
      if (o.canvas.clientWidth !== W || o.canvas.clientHeight !== H) resize();
      if (t - lightT > 1000) { lightT = t; lightV = isLight(); }
      const lt = lightV;
      if (lt !== light) {
        light = lt; mats.forEach((m) => { m.blending = AB(); m.needsUpdate = true; });
        grid.material.opacity = light ? 0.22 : 0.2;
        ptsMat.opacity = light ? 0.5 : 1; lineMat.opacity = light ? 0.4 : 1;
      }
      const rec = document.documentElement.getAttribute('data-obs') === 'rec';
      col.lerp(new T.Color(light ? (rec ? 0xb42318 : 0x0969da) : (rec ? 0xff6b5e : 0x58a6ff)), 0.05);
      const ch = col.getHex(), cr = col.r, cg = col.g, cb = col.b, LK = light ? 0.9 : 1;
      if (t - cardsT > 1500) { cardsT = t; cards = [...document.querySelectorAll(cardSel)].slice(0, MAXC); }
      // ① 뒤 층
      grid.material.map.offset.set(((t - t0) / 80000) % 1, ((t - t0) / 120000) % 1); grid.material.color.setHex(ch);
      M.sx += (M.x - M.sx) * Math.min(1, 0.25 * dt); M.sy += (M.y - M.sy) * Math.min(1, 0.25 * dt);
      const near = [];
      for (let i = 0; i < N; i++) {
        const q = P[i];
        let x = q.x * W, y = q.y * H;
        const dx = x - M.sx, dy = y - M.sy, d2 = dx * dx + dy * dy, isN = M.in && d2 < 32000;
        if (isN) { const f = (1 - d2 / 32000) * 1.3 * q.z; q.vx += dx / Math.sqrt(d2 + 1) * f; q.vy += dy / Math.sqrt(d2 + 1) * f; if (near.length < 80) near.push(i); }
        q.vx *= 0.9; q.vy *= 0.9;
        x += q.vx * dt; y += (q.vy - (reduce ? 1.5 : 7) * q.z * 0.033) * dt;
        if (y < -6) { y = H + 6; x = Math.random() * W; }
        if (x < -6) x = W + 6; if (x > W + 6) x = -6;
        q.x = x / W; q.y = y / H;
        const px = M.in ? (M.sx - W / 2) * 0.014 * q.z : 0, py = M.in ? (M.sy - H / 2) * 0.014 * q.z : 0;
        pp[i * 3] = x - px; pp[i * 3 + 1] = -(y - py); pp[i * 3 + 2] = 0;
        const b = q.b * (isN ? 2.8 : 1) * (0.6 + 0.4 * Math.sin(t / 850 + q.ph)) * LK;
        pc[i * 3] = cr * b; pc[i * 3 + 1] = cg * b; pc[i * 3 + 2] = cb * b;
      }
      pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true;
      let nl = 0;
      for (let a = 0; a < near.length && nl < MAXL; a++) for (let b = a + 1; b < near.length && nl < MAXL; b++) {
        const i = near[a] * 3, j = near[b] * 3, dx = pp[i] - pp[j], dy = pp[i + 1] - pp[j + 1], d = dx * dx + dy * dy;
        if (d > 8000) continue;
        const k = (1 - d / 8000) * LK;
        lp.set([pp[i], pp[i + 1], 0, pp[j], pp[j + 1], 0], nl * 6); lc.set([cr * k, cg * k, cb * k, cr * k, cg * k, cb * k], nl * 6); nl++;
      }
      lg.setDrawRange(0, nl * 2); lg.attributes.position.needsUpdate = true; lg.attributes.color.needsUpdate = true;
      mGlow.position.set(M.sx, -M.sy, 0); mGlow.material.color.setHex(ch);
      mGlow.material.opacity += ((M.in ? (light ? 0.12 : 0.3) : 0) - mGlow.material.opacity) * 0.12;
      // ② 앞 층 — 테두리 달림 빛
      rc.fill(0);
      cards.forEach((el, ci) => {
        const r = rectOf(el); if (!r) return;
        let sd = seed.get(el); if (sd == null) { sd = Math.random(); seed.set(el, sd); }
        const speed = 1 / (9000 + (sd * 6000)), head = (t * speed + sd) % 1, L = 2 * (r.width + r.height);
        for (let k = 0; k < RUN; k++) {
          const [x, y] = perim(r, head - k * (7 / L)), idx = (ci * RUN + k) * 3;
          rp[idx] = x; rp[idx + 1] = -y; rp[idx + 2] = 0;
          const kk = (1 - k / RUN) ** 1.3 * (k === 0 ? 1.4 : 1.0) * LK;
          rc[idx] = cr * kk; rc[idx + 1] = cg * kk; rc[idx + 2] = cb * kk;
        }
      });
      rg.attributes.position.needsUpdate = true; rg.attributes.color.needsUpdate = true;
      // 마우스를 댄 카드 — 빛 테 + 테두리 빛 넷(빠르게)
      hk += ((hoverCard ? 1 : 0) - hk) * Math.min(1, 0.2 * dt);
      if (hoverCard) hr = hoverCard.getBoundingClientRect();
      hc.fill(0);
      if (hr) {
        const pad = 16, k = 0.5 + 0.5 * Math.sin(t / 240);
        halo.position.set(hr.left + hr.width / 2, -(hr.top + hr.height / 2), 0); halo.scale.set(hr.width + pad * 2 + 12, hr.height + pad * 2 + 12, 1);
        halo.material.opacity = hk * (light ? 0.35 : 0.55 + 0.3 * k); halo.material.color.setHex(ch);
        const L = 2 * (hr.width + hr.height);
        for (let s4 = 0; s4 < 4; s4++) for (let k2 = 0; k2 < RUN; k2++) {
          const [x, y] = perim(hr, (t / 2600) + s4 / 4 - k2 * (12 / L)), idx = (s4 * RUN + k2) * 3;
          hp[idx] = x; hp[idx + 1] = -y; hp[idx + 2] = 0;
          const kk = hk * (1 - k2 / RUN) ** 1.4 * LK;
          hc[idx] = cr * kk + 0.25 * kk; hc[idx + 1] = cg * kk + 0.25 * kk; hc[idx + 2] = cb * kk + 0.25 * kk;
        }
        if (hk < 0.01) { hr = null; halo.material.opacity = 0; }
      }
      hg.attributes.position.needsUpdate = true; hg.attributes.color.needsUpdate = true;
      spot.position.set(M.sx, -M.sy, 0); spot.material.color.setHex(ch);
      spot.material.opacity += ((M.in ? (light ? 0.05 : 0.09) : 0) - spot.material.opacity) * 0.12;
      reticle.position.set(M.sx, -M.sy, 0); reticle.material.rotation = t / 1400; reticle.material.color.setHex(ch);
      reticle.material.opacity += ((M.in ? (light ? 0.35 : 0.55) : 0) - reticle.material.opacity) * 0.15;
      reticle.scale.setScalar(hoverCard ? 40 + 6 * Math.sin(t / 200) : 46);
      // 데이터 흐름
      let si = 0;
      links.forEach((Lk, j) => {
        const ra = rect(Lk.a), rb = rect(Lk.b), tr = trails[j];
        if (!ra || !rb) { tr.visible = false; for (let k2 = 0; k2 < 30; k2++, si++) scol.set([0, 0, 0], si * 3); return; }
        tr.visible = true;
        const [p0, p1, p2] = linkPath(ra, rb), pos = tr.geometry.attributes.position;
        for (let i = 0; i < 32; i++) { const [x, y] = bez(p0, p1, p2, i / 31); pos.setXYZ(i, x, -y, 0); }
        pos.needsUpdate = true;
        const hot = hoverCard && (hoverCard.matches(Lk.a) || hoverCard.matches(Lk.b)) ? 1 : 0;
        for (let k2 = 0; k2 < 30; k2++, si++) {
          const u = ((t / (2200 - hot * 900)) + k2 / 30 + j * 0.17) % 1, [x, y] = bez(p0, p1, p2, u);
          sp.set([x, -y, 0], si * 3);
          const kk = Math.sin(Math.PI * u) * (0.6 + 0.8 * hot) * LK;
          scol.set([cr * kk, cg * kk, cb * kk], si * 3);
        }
      });
      sg.attributes.position.needsUpdate = true; sg.attributes.color.needsUpdate = true;
      trailMat.color.setHex(ch); trailMat.opacity = light ? 0.22 : 0.38;
      // 점검 띠 — 9 s 마다(글 위로 지나가니 아주 옅게)
      const cyc = ((t - t0) % 9000) / 9000;
      if (cyc < 0.35 && !reduce) { const y = (cyc / 0.35) * (H + 80) - 40; band.position.set(W / 2, -y, 0); band.scale.set(W * 1.4, 44, 1); band.material.opacity = (light ? 0.06 : 0.12) * Math.sin(Math.PI * cyc / 0.35); band.material.color.setHex(ch); }
      else band.material.opacity = 0;
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i], f = (t - w.t0) / 900;
        if (f < 0) continue;
        if (f >= 1) { F.remove(w.m); w.m.geometry.dispose(); w.m.material.dispose(); waves.splice(i, 1); continue; }
        w.m.scale.setScalar(3 + 120 * w.big * f); w.m.material.opacity = 0.9 * (1 - f);
      }
      rnB.render(bg, cam);
      if (rnF) rnF.render(fg, cam);
    }
    function resize() {
      W = Math.max(10, o.canvas.clientWidth); H = Math.max(10, o.canvas.clientHeight);
      rnB.setSize(W, H, false); if (rnF) rnF.setSize(W, H, false);
      cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = -H; cam.updateProjectionMatrix();
      grid.position.set(W / 2, -H / 2, -1); grid.scale.set(W, H, 1); grid.material.map.repeat.set(W / 44, H / 44);
    }
    resize();
    raf = requestAnimationFrame(frame);
    return { resize, dispose() { cancelAnimationFrame(raf); rnB.dispose(); if (rnF) rnF.dispose(); } };
  }
  window.PageFx = { create };
})();
