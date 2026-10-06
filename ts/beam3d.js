/* beam3d.js — 십자 스캔 3D 빔(가상): 두 축 맞춤으로 2차원 가우시안 곡면을 three.js 로 그린다.
 *   z = amp · exp(−4 ln2 ((x − x0_az)² / fwhm_az² + (y − x0_el)² / fwhm_el²)), 범위 ±1.8 × HPBW(명목).
 *   대시보드(pointing_check.make_plot) 그림을 따른다: plasma 곡면 + 바닥 투영, Az 단면 #61B4F0 · El 단면 #37E8CF,
 *   측정 점(단면 위), 봉우리 #FF8078 + 드롭선, 원점(조준) ×. 바탕은 투명 — 화면 테마를 따른다.
 * 쓰기: const b = Beam3D.create(canvas[, {metaEl}]); b.draw(model); b.resize(); b.theme(); b.dispose();   (window.THREE 가 있어야 한다)
 *   metaEl 을 주면 측정 정보·색 막대를 캔버스 위 덧판 대신 그 요소(그래프 위 띠)에 쓰고, 봉우리 이름표도 상자 없이 작게 단다.
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
  // 곡면 색 — 바탕(빔 밖)은 어두운 남색으로 가라앉히고 빔만 plasma 로 빛나게(10-02 바닥이 새파랗게 떠 보이던 것)
  const NAVY = [0.02, 0.035, 0.09];
  function ground(t) {
    const c = plasma(t), w = Math.min(1, Math.max(0, (t - 0.01) / 0.22)), k = 0.08 + 0.92 * w * w * (3 - 2 * w);
    return [NAVY[0] + (c[0] - NAVY[0]) * k, NAVY[1] + (c[1] - NAVY[1]) * k, NAVY[2] + (c[2] - NAVY[2]) * k];
  }
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

  function create(canvas, opts) {
    opts = opts || {};
    const metaEl = opts.metaEl || null;              // 덧판을 그래프 밖(이 요소)에 쓴다 — 좁은 화면에서 글 상자가 곡면을 가리지 않게(10-03 미니앱)
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0);
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 1.5 : 2)));   // 휴대폰 1.5(10-06)
    const scene = new T.Scene();
    const cam = new T.PerspectiveCamera(34, 1, 0.05, 50);
    scene.add(new T.HemisphereLight(0xdfe8ff, 0x1a1f2a, 0.75));
    const sun = new T.DirectionalLight(0xffffff, 0.85); sun.position.set(-1.6, 3.2, 2.2); scene.add(sun);
    const rim = new T.PointLight(0x58a6ff, 0.9, 9); rim.position.set(2.2, 1.6, -2.4); scene.add(rim);
    const warm = new T.PointLight(0xff9a5c, 0.45, 8); warm.position.set(-2.4, 1.2, 2.0); scene.add(warm);
    const root = new T.Group(); scene.add(root);
    const fx = new T.Group(); scene.add(fx);                // 움직이는 빛(봉우리 맥동·훑기 점) — 매 장면 새로 만든다
    // 기본 시점 — 오른쪽 앞(+x,+z)에서 본다: 뒷벽(z=-1)·옆벽(x=-1)이 늘 뒤에 있게. 한 바퀴 돌지 않고 좌우로 천천히 흔든다(10-02)
    const TH0 = 1.0, PH0 = 0.8, RAD0 = 4.5;
    let th = TH0, ph = PH0, rad = RAD0, phBase = PH0, sway = 0;
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
      phBase = ph; sway = 0;
      px = e.clientX; py = e.clientY; touch(); render();
    });
    canvas.addEventListener('wheel', (e) => { rad = Math.max(2.2, Math.min(8, rad + e.deltaY * 0.004)); touch(); render(); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { th = TH0; ph = phBase = PH0; rad = RAD0; sway = 0; touch(); render(); });
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
        const c = ground(z / amp);
        cols.set(c, i * 3); fcols.set(c, i * 3);
      }
      geo.setAttribute('color', new T.BufferAttribute(cols, 3));
      geo.computeVertexNormals();
      root.add(new T.Mesh(geo, new T.MeshPhongMaterial({ vertexColors: true, side: T.DoubleSide, shininess: 60, specular: 0x2c2c36,
        emissive: 0x0a0618, transparent: true, opacity: 0.97 })));
      fgeo.setAttribute('color', new T.BufferAttribute(fcols, 3));
      const floor = new T.Mesh(fgeo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, depthWrite: false }));
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
      // ── 3D 차트 상자(10-02): 뒷벽(z=-1, 방위 단면)·옆벽(x=-1, 고도 단면) — 격자·전력 눈금, 단면 그림자(맞춘 곡선+측정 점) ──
      const HW = H * 1.12;
      const wallM = new T.MeshBasicMaterial({ color: 0x0c1a33, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false });
      const back = new T.Mesh(new T.PlaneGeometry(2, HW), wallM); back.position.set(0, HW / 2, -1); root.add(back);
      const side = new T.Mesh(new T.PlaneGeometry(2, HW), wallM.clone()); side.rotation.y = Math.PI / 2; side.position.set(-1, HW / 2, 0); root.add(side);
      const wg2 = [], gm = new T.LineBasicMaterial({ color: 0x4a6a96, transparent: true, opacity: 0.55 });
      for (const L of [0.25, 0.5, 0.75, 1.0]) {                 // 전력 눈금선(두 벽)
        const yy = Y(L * amp);
        wg2.push(new T.Vector3(-1, yy, -0.999), new T.Vector3(1, yy, -0.999), new T.Vector3(-0.999, yy, -1), new T.Vector3(-0.999, yy, 1));
      }
      for (let k = -Math.floor(R / hp); k <= Math.floor(R / hp); k++) {   // 빔폭마다 세로선(두 벽)
        const v = (k * hp) / R;
        wg2.push(new T.Vector3(v, 0, -0.999), new T.Vector3(v, HW, -0.999), new T.Vector3(-0.999, 0, v), new T.Vector3(-0.999, HW, v));
      }
      root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(wg2), gm));
      const projAz = [], projEl = [];
      for (let k = 0; k <= 200; k++) {
        const tt = -R + (2 * R * k) / 200;
        projAz.push(new T.Vector3(X(tt), Y(zf(tt, E.x0)), -0.996));
        projEl.push(new T.Vector3(-0.996, Y(zf(A.x0, tt)), Z(tt)));
      }
      root.add(new T.Line(new T.BufferGeometry().setFromPoints(projAz), new T.LineBasicMaterial({ color: 0x61b4f0 })));
      root.add(new T.Line(new T.BufferGeometry().setFromPoints(projEl), new T.LineBasicMaterial({ color: 0x37e8cf })));
      // 봉우리 자리 표시선(벽 위 x0) — 지향 오차가 벽에서도 보이게
      root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints([new T.Vector3(X(A.x0), 0, -0.995), new T.Vector3(X(A.x0), H, -0.995),
        new T.Vector3(-0.995, 0, Z(E.x0)), new T.Vector3(-0.995, H, Z(E.x0))]), new T.LineDashedMaterial({ color: 0xff8078, dashSize: 0.03, gapSize: 0.025 })).computeLineDistances());
      // 측정 커튼 — 훑은 점마다 바닥에서 측정값까지 세로 빛줄(방위 파랑·고도 청록) + 벽에 비친 측정 점
      const curtain = (pts, fit, isAz, color) => {
        const seg = [], wall = [];
        for (const [x, y] of pts || []) {
          if (Math.abs(x) > R) continue;
          const zm = Math.max(0, y - (fit.base + fit.slope * x)), py = Y(zm);
          const px = isAz ? X(x) : X(A.x0), pz = isAz ? Z(E.x0) : Z(x);
          seg.push(new T.Vector3(px, 0, pz), new T.Vector3(px, py, pz));
          wall.push(isAz ? X(x) : -0.994, py, isAz ? -0.994 : Z(x));
        }
        if (seg.length) root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(seg),
          new T.LineBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, blending: T.AdditiveBlending })));
        if (wall.length) {
          const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(wall, 3));
          root.add(new T.Points(g, new T.PointsMaterial({ color, size: 0.03, sizeAttenuation: true })));
        }
      };
      curtain(model.ptsAz, A, true, 0x61b4f0);
      curtain(model.ptsEl, E, false, 0x37e8cf);
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
      runAz.scale.set(0.16, 0.16, 1); runEl.scale.set(0.16, 0.16, 1); runAz.visible = false; runEl.visible = false; fx.add(runAz, runEl);
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
      lbl('상대 전력', mut, -1, H * 1.24, -1, 0.1);
      for (const L of [0, 0.5, 1]) lbl(`${Math.round(L * 100)}%`, mut, -1.06, Y(L * amp), -1.06, 0.085);
      lbl('방위 단면', '#61b4f0', 0.62, H * 1.05, -0.99, 0.085);
      lbl('고도 단면', '#37e8cf', -0.99, H * 1.05, 0.62, 0.085);
      const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + '″';
      if (metaEl) lbl(`Az${sgn(A.x0)} El${sgn(E.x0)}`, '#ff8078', X(A.x0), H + 0.2, Z(E.x0), 0.1);
      else lbl(`봉우리 Az${sgn(A.x0)} El${sgn(E.x0)}`, '#ff8078', X(A.x0), H + 0.24, Z(E.x0), 0.13, { bg: cssv('--panel', '#161b22') });
    }
    // 움직임 — 봉우리 빛 맥동 · 바닥 고리 퍼짐 · 훑기 빛점 · 천천히 회전(손대면 멈추고 4 s 뒤 다시). 보일 때만 30 fps
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (!model || document.hidden || !visible || !canvas.clientWidth || t - lastT < 33) return;
      const dt = Math.min(3, (t - lastT) / 33); lastT = t;
      if (auto && !drag && t - lastUser > 4000) { sway += 0.006 * dt; ph = phBase + 0.42 * Math.sin(sway); }
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
    // 겉글 덧판 — model.meta = {when, src, band, verdict, note, off}. 캔버스 부모(상대 위치)에 붙는다(10-02 '측정 날짜도 잘 보이게')
    function overlay() {
      if (metaEl) return strip();
      const host = canvas.parentElement;
      if (!host) return;
      let o = host.querySelector(':scope > .b3-meta'), cb = host.querySelector(':scope > .b3-cbar');
      if (!o) {
        o = document.createElement('div'); o.className = 'b3-meta';
        o.style.cssText = 'position:absolute;left:10px;top:9px;z-index:3;pointer-events:none;font:600 12px "Malgun Gothic",sans-serif;color:#dbe7f5;' +
          'background:rgba(6,12,24,.62);border:1px solid rgba(120,190,255,.4);border-radius:9px;padding:7px 10px;backdrop-filter:blur(3px);' +
          'box-shadow:0 0 14px rgba(88,166,255,.25);max-width:72%';
        host.appendChild(o);
      }
      if (!cb) {
        cb = document.createElement('div'); cb.className = 'b3-cbar';
        cb.style.cssText = 'position:absolute;right:10px;top:12px;bottom:34px;width:12px;border-radius:6px;z-index:3;pointer-events:none;' +
          'background:linear-gradient(0deg,#0d0887,#5402a3,#8b0aa5,#b93289,#db5c68,#f48849,#febc2a,#f0f921);box-shadow:0 0 10px rgba(240,249,33,.25)';
        cb.innerHTML = '<span style="position:absolute;right:16px;top:-3px;font:600 10px monospace;color:#cfd8e6">100%</span>' +
          '<span style="position:absolute;right:16px;top:50%;transform:translateY(-50%);font:600 10px monospace;color:#cfd8e6">50%</span>' +
          '<span style="position:absolute;right:16px;bottom:-3px;font:600 10px monospace;color:#cfd8e6">0%</span>';
        host.appendChild(cb);
      }
      const m = (model && model.meta) || {};
      const vcol = m.verdict === 'PASS' ? '#3fdc8a' : m.verdict === 'FAIL' ? '#ff6b6b' : '#f5b041';
      o.style.display = model ? '' : 'none'; cb.style.display = model ? '' : 'none';
      o.innerHTML = `<div style="font-size:10.5px;color:#8fb3e0;letter-spacing:.04em">십자 스캔 측정</div>` +
        `<div style="font:800 15px monospace;color:#fff;text-shadow:0 0 10px rgba(88,166,255,.6)">${m.when || '—'}</div>` +
        `<div>${m.src || ''}${m.band ? ' · ' + m.band : ''}${m.verdict ? ` · <b style="color:${vcol}">${m.verdict}</b>` : ''}</div>` +
        (m.off ? `<div style="color:#ffb0a8;font:600 11.5px monospace">${m.off}</div>` : '') +
        (m.note ? `<div style="color:#9fb0c6;font-size:10.5px;margin-top:2px">${m.note}</div>` : '');
    }
    // 그래프 위 띠(metaEl) — 한두 줄: 측정 시각·소스·판정 / 오프셋·빔폭 + 가로 색 막대
    function strip() {
      const m = (model && model.meta) || {};
      const vcol = m.verdict === 'PASS' ? '#3fdc8a' : m.verdict === 'FAIL' ? '#ff6b6b' : '#f5b041';
      metaEl.style.display = model ? '' : 'none';
      metaEl.innerHTML =
        `<div style="display:flex;align-items:center;gap:8px">` +
          `<b style="font:800 13px monospace;color:#fff">${m.when || '—'}</b>` +
          (m.verdict ? `<b style="color:${vcol};font-size:11.5px">${m.verdict}</b>` : '') +
          `<span style="margin-left:auto;display:flex;align-items:center;gap:4px;font:600 9.5px monospace;color:#9fb0c6;flex:none">0%` +
            `<i style="display:block;width:48px;height:7px;border-radius:4px;background:linear-gradient(90deg,#0d0887,#5402a3,#8b0aa5,#b93289,#db5c68,#f48849,#febc2a,#f0f921)"></i>100%</span></div>` +
        `<div style="color:#b9c8dc;font-size:11px;margin-top:2px">${m.src || ''}${m.band ? ' · ' + m.band : ''}</div>` +
        (m.off ? `<div style="color:#ffb0a8;font:600 10.5px monospace;margin-top:1px">${m.off}</div>` : '') +
        (m.note ? `<div style="color:#8fa3bb;font-size:10px;margin-top:2px">${m.note}</div>` : '');
    }
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
      draw(m) { model = m; build(); overlay(); if (!resize()) render(); },
      resize,
      theme() { build(); render(); },
      clear() { model = null; clear(); render(); },
      setAuto(v) { auto = !!v; touch(); },
      reset() { th = TH0; ph = phBase = PH0; rad = RAD0; sway = 0; render(); },
      dispose() { cancelAnimationFrame(raf); clear(); rn.dispose(); },
    };
  }
  window.Beam3D = { create, plasma };
})();
