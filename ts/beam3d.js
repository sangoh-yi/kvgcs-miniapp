/* beam3d.js — 십자 스캔 3D 빔(가상): 두 축 맞춤으로 2차원 가우시안 곡면을 three.js 로 그린다.
 *   z = amp · exp(−4 ln2 ((x − x0_az)² / fwhm_az² + (y − x0_el)² / fwhm_el²)), 범위 ±1.8 × HPBW(명목).
 *   대시보드(pointing_check.make_plot) 그림을 따른다: plasma 곡면 + 바닥 투영, Az 단면 #61B4F0 · El 단면 #37E8CF,
 *   측정 점(단면 위), 봉우리 #FF8078 + 드롭선, 원점(조준) ×. 바탕은 투명 — 화면 테마를 따른다.
 * 쓰기: const b = Beam3D.create(canvas); b.draw(model); b.resize(); b.theme(); b.dispose();   (window.THREE 가 있어야 한다)
 * 2026-10-02 업그레이드(센터장님 "3js 같은 걸로 입체적으로 · 회전 · 입체적 효과"): 광택 곡면 + 와이어 격자 + 등고 고리(10·25·50·75·90 %),
 *   빛나는 봉우리(맥동 빛·퍼지는 고리), 측정 점은 빛 구슬, 단면 위를 달리는 훑기 빛점(방위·고도), 처음부터 천천히 회전(끌면 멈추고 4 s 뒤 다시),
 *   두 번 누르면 처음 시점, 화면에 보일 때만 그린다.
 * model = {az:{amp,x0,fwhm,base,slope}, el:{…}, ptsAz:[[x″, 상대전력]…], ptsEl:[…], hp: 명목 빔폭″}
 */
'use strict';
(function () {
  const K4LN2 = 4 * Math.LN2;
  // plasma 색표(matplotlib) — 9 점 사이 직선 보간
  const PLASMA = [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104],
    [244, 136, 73], [254, 188, 43], [240, 249, 33], [240, 249, 33]];
  function plasma(t) {
    t = Math.max(0, Math.min(1, t)) * (PLASMA.length - 2);
    const i = Math.floor(t), f = t - i, a = PLASMA[i], b = PLASMA[i + 1];
    return [(a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255];
  }
  const cssv = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d);

  // 글 스프라이트 — 캔버스를 글 폭에 맞추고, 세상 높이 hw 로 크기를 정한다(글 길이와 상관없이 같은 글자 크기)
  function textSprite(T, txt, color, hw, box) {
    const fs = 64, pad = box ? 22 : 10;
    const font = `700 ${fs}px "Cascadia Mono", Consolas, "Malgun Gothic", monospace`;
    const cv = document.createElement('canvas');
    let g = cv.getContext('2d');
    g.font = font;
    const w = Math.ceil(g.measureText(txt).width) + pad * 2, h = Math.ceil(fs * (box ? 1.6 : 1.3));
    cv.width = w; cv.height = h;
    g = cv.getContext('2d');
    if (box) {                                       // 대시보드 봉우리 이름표처럼 둥근 상자
      g.fillStyle = box.bg; g.strokeStyle = color; g.lineWidth = 4;
      const r = 16;
      g.beginPath(); g.moveTo(r, 2); g.lineTo(w - r, 2); g.quadraticCurveTo(w - 2, 2, w - 2, r); g.lineTo(w - 2, h - r);
      g.quadraticCurveTo(w - 2, h - 2, w - r, h - 2); g.lineTo(r, h - 2); g.quadraticCurveTo(2, h - 2, 2, h - r); g.lineTo(2, r);
      g.quadraticCurveTo(2, 2, r, 2); g.closePath(); g.fill(); g.stroke();
    }
    g.font = font; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, w / 2, h / 2 + 2);
    const tex = new T.CanvasTexture(cv);
    tex.minFilter = T.LinearFilter;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    hw = hw || 0.1;
    sp.scale.set((hw * w) / h, hw, 1);
    return sp;
  }

  // 둥근 빛 무늬(가산 혼합 스프라이트·점 재질용)
  function glowTex(T, inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.35, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }

  function create(canvas) {
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0);
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new T.Scene();
    const cam = new T.PerspectiveCamera(34, 1, 0.05, 50);
    scene.add(new T.HemisphereLight(0xdfe8ff, 0x1a1f2a, 0.75));
    const sun = new T.DirectionalLight(0xffffff, 0.85); sun.position.set(-1.6, 3.2, 2.2); scene.add(sun);
    const rim = new T.PointLight(0x58a6ff, 0.9, 9); rim.position.set(2.2, 1.6, -2.4); scene.add(rim);
    const warm = new T.PointLight(0xff9a5c, 0.45, 8); warm.position.set(-2.4, 1.2, 2.0); scene.add(warm);
    const root = new T.Group(); scene.add(root);
    const fx = new T.Group(); scene.add(fx);                // 움직이는 빛(봉우리 맥동·훑기 점) — 매 장면 새로 만든다
    let th = 0.95, ph = -0.62, rad = 4.3;
    const tgt = new T.Vector3(0, 0.3, 0);
    function upd() {
      cam.position.set(tgt.x + rad * Math.sin(th) * Math.sin(ph), tgt.y + rad * Math.cos(th), tgt.z + rad * Math.sin(th) * Math.cos(ph));
      cam.lookAt(tgt);
    }
    let drag = false, px = 0, py = 0, lastUser = -1e9, auto = true, raf = 0, lastT = 0, visible = true;
    const touch = () => { lastUser = performance.now(); };
    canvas.addEventListener('pointerdown', (e) => { drag = true; px = e.clientX; py = e.clientY; touch(); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = false; touch(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      ph -= (e.clientX - px) * 0.008; th = Math.max(0.2, Math.min(1.45, th - (e.clientY - py) * 0.008));
      px = e.clientX; py = e.clientY; touch(); render();
    });
    canvas.addEventListener('wheel', (e) => { rad = Math.max(2.2, Math.min(8, rad + e.deltaY * 0.004)); touch(); render(); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { th = 0.95; ph = -0.62; rad = 4.3; touch(); render(); });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);

    let model = null, anim = null;
    function disposeGroup(g) {
      for (const o of [...g.children]) {
        g.remove(o);
        o.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
        });
      }
    }
    function clear() { disposeGroup(root); disposeGroup(fx); anim = null; }
    function build() {
      clear();
      if (!model) return;
      const hp = model.hp || 1200, R = 1.8 * hp;
      const A = model.az, E = model.el;
      const amp = Math.max(1e-6, (A.amp + E.amp) / 2), H = 0.95;
      const zf = (x, y) => amp * Math.exp(-K4LN2 * ((x - A.x0) ** 2 / (A.fwhm * A.fwhm) + (y - E.x0) ** 2 / (E.fwhm * E.fwhm)));
      const X = (x) => x / R, Z = (y) => -y / R, Y = (v) => (v / amp) * H;
      const ink = cssv('--text-2', '#b1bac4'), mut = cssv('--text-3', '#8b949e'), line = cssv('--line', '#30363d');
      // 광택 곡면(plasma) + 바닥 투영
      const N = 96, geo = new T.PlaneGeometry(2, 2, N, N);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position, cols = new Float32Array(pos.count * 3);
      const fgeo = geo.clone(), fcols = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) * R, y = -pos.getZ(i) * R, z = zf(x, y);
        pos.setY(i, Y(z));
        const c = plasma(z / amp);
        cols.set(c, i * 3); fcols.set(c, i * 3);
      }
      geo.setAttribute('color', new T.BufferAttribute(cols, 3));
      geo.computeVertexNormals();
      root.add(new T.Mesh(geo, new T.MeshPhongMaterial({ vertexColors: true, side: T.DoubleSide, shininess: 85, specular: 0x5a5a6a,
        emissive: 0x0a0618, transparent: true, opacity: 0.97 })));
      fgeo.setAttribute('color', new T.BufferAttribute(fcols, 3));
      const floor = new T.Mesh(fgeo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.26, depthWrite: false }));
      floor.position.y = -0.002; root.add(floor);
      // 와이어 격자(곡면을 따라)
      const W = 30, wg = new T.PlaneGeometry(2, 2, W, W); wg.rotateX(-Math.PI / 2);
      const wp = wg.attributes.position;
      for (let i = 0; i < wp.count; i++) { const x = wp.getX(i) * R, y = -wp.getZ(i) * R; wp.setY(i, Y(zf(x, y)) + 0.004); }
      root.add(new T.LineSegments(new T.WireframeGeometry(wg), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.10, depthWrite: false })));
      wg.dispose();
      // 등고 고리 — 같은 상대 전력(10·25·50·75·90 %)의 타원: 높이에 띄워 plasma 색으로. 50 % 는 반전력(빔폭) — 굵게 보이게 두 겹
      for (const L of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const q = Math.sqrt(-Math.log(L) / K4LN2), p = [];
        for (let k = 0; k <= 128; k++) {
          const a = (k / 128) * Math.PI * 2, x = A.x0 + A.fwhm * q * Math.cos(a), y = E.x0 + E.fwhm * q * Math.sin(a);
          p.push(new T.Vector3(X(x), Y(L * amp) + 0.006, Z(y)));
        }
        const c = plasma(L), col = new T.Color(c[0], c[1], c[2]).lerp(new T.Color(1, 1, 1), 0.35);
        root.add(new T.Line(new T.BufferGeometry().setFromPoints(p), new T.LineBasicMaterial({ color: col, transparent: true, opacity: L === 0.5 ? 1 : 0.75 })));
        if (L === 0.5) {                                   // 반전력 고리를 바닥에도
          const fp = p.map((v) => new T.Vector3(v.x, 0.006, v.z));
          root.add(new T.Line(new T.BufferGeometry().setFromPoints(fp), new T.LineBasicMaterial({ color: 0xffb454 })));
        }
      }
      // 명목 빔(조준점 중심, 점선) — 반전력 고리와 어긋난 만큼이 지향 오차
      const np = [];
      for (let k = 0; k <= 96; k++) { const a = (k / 96) * Math.PI * 2; np.push(new T.Vector3(X((hp / 2) * Math.cos(a)), 0.007, Z((hp / 2) * Math.sin(a)))); }
      const nl = new T.Line(new T.BufferGeometry().setFromPoints(np), new T.LineDashedMaterial({ color: 0x9aa4b2, dashSize: 0.035, gapSize: 0.03 }));
      nl.computeLineDistances(); root.add(nl);
      // 바닥 틀 · 눈금선(1 HPBW 마다)
      const lm = new T.LineBasicMaterial({ color: line, transparent: true, opacity: 0.9 });
      const gpts = [];
      for (let k = -Math.floor(R / hp); k <= Math.floor(R / hp); k++) {
        const v = (k * hp) / R;
        gpts.push(new T.Vector3(v, 0, -1), new T.Vector3(v, 0, 1), new T.Vector3(-1, 0, v), new T.Vector3(1, 0, v));
      }
      gpts.push(new T.Vector3(-1, 0, -1), new T.Vector3(1, 0, -1), new T.Vector3(1, 0, -1), new T.Vector3(1, 0, 1),
        new T.Vector3(1, 0, 1), new T.Vector3(-1, 0, 1), new T.Vector3(-1, 0, 1), new T.Vector3(-1, 0, -1));
      root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(gpts), lm));
      root.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-1, 0, -1), new T.Vector3(-1, H * 1.1, -1)]), lm));
      // 맞춘 단면(Az: 고도 = x0_el · El: 방위 = x0_az) — 훑기 빛점이 이 길을 달린다
      const cutPts = (isAz) => {
        const p = [];
        for (let k = 0; k <= 200; k++) {
          const t = -R + (2 * R * k) / 200, x = isAz ? t : A.x0, y = isAz ? E.x0 : t;
          p.push(new T.Vector3(X(x), Y(zf(x, y)) + 0.008, Z(y)));
        }
        return p;
      };
      const pAz = cutPts(true), pEl = cutPts(false);
      root.add(new T.Line(new T.BufferGeometry().setFromPoints(pAz), new T.LineBasicMaterial({ color: 0x61b4f0 })));
      root.add(new T.Line(new T.BufferGeometry().setFromPoints(pEl), new T.LineBasicMaterial({ color: 0x37e8cf })));
      // 측정 점 — 빛 구슬(가산 혼합)
      const dotTex = glowTex(T, 'rgba(255,255,255,1)', 'rgba(255,255,255,.45)');
      const dots = (pts, fit, isAz, color) => {
        const v = [];
        for (const [x, y] of pts || []) {
          if (Math.abs(x) > R) continue;
          const z = y - (fit.base + fit.slope * x);
          v.push(isAz ? X(x) : X(A.x0), Y(Math.max(0, z)), isAz ? Z(E.x0) : Z(x));
        }
        if (!v.length) return null;
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.Float32BufferAttribute(v, 3));
        return new T.Points(g, new T.PointsMaterial({ color, size: 0.075, map: dotTex, transparent: true, depthWrite: false,
          blending: T.AdditiveBlending, sizeAttenuation: true }));
      };
      for (const d of [dots(model.ptsAz, A, true, 0x61b4f0), dots(model.ptsEl, E, false, 0x37e8cf)]) if (d) root.add(d);
      // 봉우리 — 구슬 + 드롭선 + 빛(맥동) + 퍼지는 고리(바닥) · 조준점 ×
      const pk = new T.Mesh(new T.SphereGeometry(0.04, 20, 14), new T.MeshBasicMaterial({ color: 0xff8078 }));
      pk.position.set(X(A.x0), H, Z(E.x0)); root.add(pk);
      const dl = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(X(A.x0), 0, Z(E.x0)), new T.Vector3(X(A.x0), H, Z(E.x0))]),
        new T.LineDashedMaterial({ color: 0xff8078, dashSize: 0.04, gapSize: 0.03 }));
      dl.computeLineDistances(); root.add(dl);
      const xs = 0.06;
      root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints([new T.Vector3(-xs, 0.003, -xs), new T.Vector3(xs, 0.003, xs),
        new T.Vector3(-xs, 0.003, xs), new T.Vector3(xs, 0.003, -xs)]), new T.LineBasicMaterial({ color: mut })));
      const halo = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,190,170,1)', 'rgba(255,110,90,.35)'), transparent: true,
        depthWrite: false, blending: T.AdditiveBlending }));
      halo.position.set(X(A.x0), H, Z(E.x0)); fx.add(halo);
      const ring = new T.Mesh(new T.RingGeometry(0.9, 1, 64), new T.MeshBasicMaterial({ color: 0xff8078, transparent: true, opacity: 0.6,
        side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(X(A.x0), 0.01, Z(E.x0)); fx.add(ring);
      // 훑기 빛점 — 방위 단면·고도 단면을 번갈아 달린다(십자 스캔이 하는 일)
      const runAz = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(220,240,255,1)', 'rgba(97,180,240,.55)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      const runEl = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(220,255,250,1)', 'rgba(55,232,207,.55)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      runAz.scale.set(0.16, 0.16, 1); runEl.scale.set(0.16, 0.16, 1); fx.add(runAz, runEl);
      anim = { halo, ring, runAz, runEl, pAz, pEl };
      // 글: 축 이름·눈금·봉우리
      const lbl = (txt, color, x, y, z, hw, box) => { const sp = textSprite(T, txt, color, hw, box); sp.position.set(x, y, z); root.add(sp); };
      lbl('방위 Az ″', ink, 0, 0, 1.42, 0.12);
      lbl('고도 El ″', ink, 1.52, 0, 0, 0.12);
      for (const k of [-1, 0, 1]) {
        const v = k * hp, t = k ? (k > 0 ? '+' : '−') + Math.abs(v) + '″' : '0″';
        lbl(t, mut, X(v), 0, 1.14, 0.095);
        lbl(t, mut, 1.2, 0, Z(v), 0.095);
      }
      lbl('상대 전력', mut, -1, H * 1.18, -1, 0.1);
      const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + '″';
      lbl(`봉우리 Az${sgn(A.x0)} El${sgn(E.x0)}`, '#ff8078', X(A.x0), H + 0.24, Z(E.x0), 0.13, { bg: cssv('--panel', '#161b22') });
    }
    // 움직임 — 봉우리 빛 맥동 · 바닥 고리 퍼짐 · 훑기 빛점 · 천천히 회전(손대면 멈추고 4 s 뒤 다시). 보일 때만 30 fps
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (!model || document.hidden || !visible || !canvas.clientWidth || t - lastT < 33) return;
      const dt = Math.min(3, (t - lastT) / 33); lastT = t;
      if (auto && !drag && t - lastUser > 4000) ph += 0.0042 * dt;
      if (anim) {
        const s = (t % 1800) / 1800, pulse = 0.5 + 0.5 * Math.sin(t / 260);
        anim.halo.scale.set(0.34 + 0.12 * pulse, 0.34 + 0.12 * pulse, 1);
        anim.halo.material.opacity = 0.65 + 0.35 * pulse;
        const rr = 0.04 + 0.42 * s; anim.ring.scale.set(rr, rr, rr); anim.ring.material.opacity = 0.75 * (1 - s);
        const k = (t % 6000) / 3000, onAz = k < 1, f = onAz ? k : k - 1, path = onAz ? anim.pAz : anim.pEl;
        const p = path[Math.min(path.length - 1, Math.floor(f * (path.length - 1)))];
        (onAz ? anim.runAz : anim.runEl).position.copy(p);
        (onAz ? anim.runAz : anim.runEl).visible = true; (onAz ? anim.runEl : anim.runAz).visible = false;
      }
      render();
    }
    raf = requestAnimationFrame(frame);
    function render() { upd(); rn.render(scene, cam); }
    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return false;
      rn.setSize(w, h, false);
      cam.aspect = w / h; cam.updateProjectionMatrix();
      render();
      return true;
    }
    return {
      draw(m) { model = m; build(); if (!resize()) render(); },
      resize,
      theme() { build(); render(); },
      clear() { model = null; clear(); render(); },
      setAuto(v) { auto = !!v; touch(); },
      reset() { th = 0.95; ph = -0.62; rad = 4.3; render(); },
      dispose() { cancelAnimationFrame(raf); clear(); rn.dispose(); },
    };
  }
  window.Beam3D = { create, plasma };
})();
