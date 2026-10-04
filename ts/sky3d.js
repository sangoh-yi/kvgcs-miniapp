/* sky3d.js — 지향 측정 3D 하늘 반구(2026-10-03 센터장님 "지금 스캔 박스 — 3js 로 시각적으로 잘 보이게, 첨단스럽게").
 *   남쪽 조금 높은 데서 북쪽을 비스듬히 본다 — 뒤쪽 하늘(북)이 벽처럼 서고, 앞쪽 격자는 옅게 비친다.
 *   가운데 안테나 접시가 지금 방위·고도를 실제로 가리키고 빔 빛줄기가 하늘에 닿는다(훑는 중이면 파랗게 맥동).
 *   측정점은 빛 구슬(초록 = 굴절 보정 뒤 · 회색 = 보정 전 · 빨강 = 실패, 마지막 점은 고리가 퍼진다),
 *   전파원 하루 길(고도 20° 위만 진하게)과 지금 자리 이름, 다음 목표(호박색 마름모 맥동).
 *   글 상자는 캔버스 위에 띄우지 않는다(10-03 '글자상자가 3d 그래프에 겹쳐') — 장면 안 글은 방위 글자·고도 눈금·소스 이름뿐.
 *   레이더 쪽 하늘(방위 236.35° 에서 각거리 110° 안 — X 는 BBC 방식) 경계 점선 · 태양 회피 고리(4° · 15°) · 해 자리(10-04).
 *   천천히 좌우로 흔들린다(끌면 멈추고 5 s 뒤 다시) · 휠 확대 · 두 번 누르면 처음 시점 · 화면에 보일 때만 그린다.
 *   가운데 안테나는 세종 22m 실물 모형(lib/sejong22m.js · models/sejong22m.glb, 10-04) — 그 스크립트가 먼저 있어야 한다.
 * 쓰기: const s = Sky3D.create(canvas); s.set({points, ant, next, running, tracks, scale}); s.resize(); s.dispose();
 *   points: [{az, el, ok, refrac, dx, de}] (dx·de = X 대역 오프셋 ″, X1·X2) · ant: {az, el} · next: {az, el} ·
 *   tracks: Sky3D.tracks(['CASA','TAUA','CYGA'], t0, 24) · scale: ″ 하나당 길이(반구 반지름 1, 기본 0.005 = 40″ → 0.2)
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  // 실물 모형 경로 — 이 파일 옆 models/(운용 화면 /web/models/ · 미니앱 ts/models/). 불러올 때 한 번 정한다
  const GLB = (document.currentScript && document.currentScript.src) ? new URL('models/sejong22m.glb', document.currentScript.src).href : 'models/sejong22m.glb';
  const dir = (T, az, el, r) => {                         // 방위(북→동)·고도 → 북 = −z · 동 = +x · 위 = +y
    const a = az * D2R, e = el * D2R, R = r || 1;
    return new T.Vector3(R * Math.sin(a) * Math.cos(e), R * Math.sin(e), -R * Math.cos(a) * Math.cos(e));
  };
  function textSprite(T, txt, color, h, weight) {
    const fs = 56, cv = document.createElement('canvas');
    let g = cv.getContext('2d');
    const font = `${weight || 700} ${fs}px "Malgun Gothic", "Segoe UI", sans-serif`;
    g.font = font;
    cv.width = Math.ceil(g.measureText(txt).width) + 24; cv.height = Math.ceil(fs * 1.35);
    g = cv.getContext('2d'); g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 10;                 // 어두운 테두리 — 격자 위에서도 읽힌다
    g.fillStyle = color; g.fillText(txt, cv.width / 2, cv.height / 2 + 2);
    const tex = new T.CanvasTexture(cv); tex.minFilter = T.LinearFilter;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    sp.scale.set((h * cv.width) / cv.height, h, 1);
    sp.renderOrder = 10;
    return sp;
  }
  function glowTex(T, inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.3, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }
  // 반구 선 — 카메라 쪽(앞) 방위의 선은 옅게, 건너편(뒤)은 진하게. 수평 성분만 본다(천정은 중간)
  function fadeLineMat(T, color, op) {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uColor: { value: new T.Color(color) }, uOp: { value: op }, uCam: { value: new T.Vector3(0, 0, 1) } },
      vertexShader: 'uniform vec3 uCam; varying float vF;' +
        'void main(){ vec2 c = normalize(uCam.xz + vec2(1e-6)); float f = dot(position.xz, c);' +
        ' vF = 1.0 - 0.72 * smoothstep(0.0, 0.75, f);' +
        ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uOp; varying float vF; void main(){ gl_FragColor = vec4(uColor, uOp * vF); }',
    });
  }

  function create(canvas, opts) {
    opts = opts || {};
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0);
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new T.Scene(), cam = new T.PerspectiveCamera(30, 2, 0.05, 60);
    scene.add(new T.HemisphereLight(0xdfe8ff, 0x101828, 0.9));
    const key = new T.DirectionalLight(0xffffff, 0.8); key.position.set(-1.5, 3, 2.5); scene.add(key);
    const base = new T.Group(), data = new T.Group(), fx = new T.Group();
    scene.add(base, data, fx);
    // 시점 — 안테나(없으면 다음 목표·마지막 점) 방위에서 50° 비켜선 바깥, 고도 약 27° 에서 본다.
    //   그쪽 하늘이 앞으로 와서 측정점·오프셋 화살이 고도 따라 펼쳐지고, 접시와 빔은 옆모습으로 보인다(10-03 시점 비교).
    //   방위가 바뀌면 천천히 따라 돈다. 끌어 돌리면 30 s 동안은 그 시점을 지킨다
    const TH0 = opts.th || 1.1, RAD0 = opts.rad || 3.7, SIDE = 50;
    let kfit = 1, lw = 0, lh = 0;                         // 상자가 좁으면 멀리서 본다(반구 가로 ≈ 세로 × 1.5)
    let th = TH0, ph = opts.ph || 0, rad = RAD0, phBase = ph, sway = 0, focusPh = null;
    const tgt = new T.Vector3(0, opts.ty != null ? opts.ty : 0.28, 0);
    const fades = [];
    const upd = () => {
      const r = rad * kfit;
      cam.position.set(tgt.x + r * Math.sin(th) * Math.sin(ph), tgt.y + r * Math.cos(th), tgt.z + r * Math.sin(th) * Math.cos(ph));
      cam.lookAt(tgt);
      for (const m of fades) m.uniforms.uCam.value.copy(cam.position);
    };
    const fline = (pts, color, op) => { const m = fadeLineMat(T, color, op); fades.push(m); return new T.Line(new T.BufferGeometry().setFromPoints(pts), m); };
    const line = (pts, color, op) => new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }));

    // ── 바닥: 어두운 원판 + 빛나는 지평선 고리 + 방위 눈금(10° 잔 · 30° 긴) + 방위 글자 ──
    const disk = new T.Mesh(new T.CircleGeometry(1.0, 120), new T.MeshBasicMaterial({ color: 0x07142a, transparent: true, opacity: 0.92, depthWrite: false }));
    disk.rotation.x = -Math.PI / 2; disk.position.y = -0.002; base.add(disk);
    const glowRing = new T.Mesh(new T.RingGeometry(0.985, 1.03, 160), new T.MeshBasicMaterial({ color: 0x3d7fd1, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending }));
    glowRing.rotation.x = -Math.PI / 2; base.add(glowRing);
    const tick = [];
    for (let a = 0; a < 360; a += 10) { const L = a % 30 ? 0.035 : 0.075; tick.push(dir(T, a, 0, 1.0), dir(T, a, 0, 1.0 - L)); }
    base.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(tick), new T.LineBasicMaterial({ color: 0x7fb2ee, transparent: true, opacity: 0.7 })));
    for (const r of [0.33, 0.66]) { const p = []; for (let a = 0; a <= 360; a += 4) p.push(dir(T, a, 0, r)); base.add(line(p, 0x1d3a60, 0.6)); }
    for (const [az, t, c] of [[0, 'N', '#ff8a80'], [90, 'E', '#b8c7da'], [180, 'S', '#b8c7da'], [270, 'W', '#b8c7da']]) {
      const sp = textSprite(T, t, c, 0.12, 800); sp.position.copy(dir(T, az, 0, 1.15)); base.add(sp);
    }
    // ── 반구: 고도 고리(30·60) · 방위 경선(30° 마다) · 측정 하한 20° — 앞쪽은 옅게 ──
    for (const el of [30, 60]) { const p = []; for (let a = 0; a <= 360; a += 2) p.push(dir(T, a, el)); base.add(fline(p, 0x4f7fb8, 0.75)); }
    for (let az = 0; az < 360; az += 30) { const p = []; for (let e = 0; e <= 90; e += 2) p.push(dir(T, az, e)); base.add(fline(p, 0x3a6597, az % 90 ? 0.4 : 0.75)); }
    const lim = []; for (let a = 0; a <= 360; a += 2) lim.push(dir(T, a, 20));
    base.add(fline(lim, 0x36c2b0, 0.55));
    for (const el of [30, 60]) { const sp = textSprite(T, el + '°', '#8fb0d6', 0.075, 600); sp.position.copy(dir(T, 300, el, 1.06)); base.add(sp); }
    const dome = new T.Mesh(new T.SphereGeometry(0.997, 72, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      new T.MeshBasicMaterial({ color: 0x2a5da0, transparent: true, opacity: 0.07, side: T.BackSide, depthWrite: false }));
    base.add(dome);

    // ── 레이더 쪽 하늘(10-04) — 드론 레이더(방위 236.35°, 지평선)에서 각거리 110° 안은 X 대역 십자 스캔을 BBC 방식으로 한다.
    //    그 경계(작은 원)를 점선으로, 안쪽 하늘을 아주 옅은 붉은 기로, 지평선에 레이더 자리를 둔다. 은은하게(측정점이 주인공)
    const RAD = { az: 236.35, el: 0.3, sep: 110 }, RD = dir(T, RAD.az, RAD.el, 1).normalize();
    {
      const U = new T.Vector3().crossVectors(RD, new T.Vector3(0, 1, 0)).normalize(), Wv = new T.Vector3().crossVectors(RD, U).normalize();
      const cs = Math.cos(RAD.sep * D2R), sn = Math.sin(RAD.sep * D2R), runs = [];
      let cur = [];
      for (let k = 0; k <= 360; k += 2) {
        const f = k * D2R, p = RD.clone().multiplyScalar(cs).add(U.clone().multiplyScalar(sn * Math.cos(f))).add(Wv.clone().multiplyScalar(sn * Math.sin(f)));
        if (p.y >= 0) cur.push(p.multiplyScalar(0.992)); else if (cur.length) { runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      for (const r of runs) {
        if (r.length < 2) continue;
        const ln = new T.Line(new T.BufferGeometry().setFromPoints(r), new T.LineDashedMaterial({ color: 0xff8a65, dashSize: 0.035, gapSize: 0.025, transparent: true, opacity: 0.5, depthWrite: false }));
        ln.computeLineDistances(); base.add(ln);
      }
      const tint = new T.Mesh(new T.SphereGeometry(0.994, 72, 24, 0, Math.PI * 2, 0, Math.PI / 2), new T.ShaderMaterial({
        uniforms: { uD: { value: RD }, uC: { value: Math.cos(RAD.sep * D2R) } }, transparent: true, depthWrite: false, side: T.BackSide,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uD; uniform float uC; varying vec3 vP; void main(){ float c = dot(vP, uD); float k = smoothstep(uC - 0.02, uC + 0.25, c); gl_FragColor = vec4(1.0, 0.36, 0.24, 0.045 * k); }',
      }));
      base.add(tint);
      const rm = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,160,130,1)', 'rgba(255,90,60,.45)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      rm.scale.set(0.11, 0.11, 1); rm.position.copy(dir(T, RAD.az, 1.2, 1.0)); base.add(rm);
      const rl = textSprite(T, '레이더', '#ff9f85', 0.06, 700); rl.position.copy(dir(T, RAD.az, 7, 1.08)); base.add(rl);
    }
    // ── 태양 회피(10-04) — 해 둘레 4°(빨강, 경고 기준) · 15°(호박) 고리와 해 자리. 1분마다 옮긴다(세종 위경도·지금 시각) ──
    const sunG = new T.Group(); base.add(sunG);
    const ringPts = (c, rdeg) => {
      const U = new T.Vector3().crossVectors(c, new T.Vector3(0, 1, 0)); if (U.lengthSq() < 1e-6) U.set(1, 0, 0); U.normalize();
      const Wv = new T.Vector3().crossVectors(c, U).normalize(), cs = Math.cos(rdeg * D2R), sn = Math.sin(rdeg * D2R), pts = [];
      for (let k = 0; k <= 360; k += 4) { const f = k * D2R; pts.push(c.clone().multiplyScalar(cs).add(U.clone().multiplyScalar(sn * Math.cos(f))).add(Wv.clone().multiplyScalar(sn * Math.sin(f))).multiplyScalar(0.99)); }
      return pts;
    };
    const sunR4 = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0.85, depthWrite: false }));
    const sunR15 = new T.Line(new T.BufferGeometry(), new T.LineDashedMaterial({ color: 0xf0b43c, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.6, depthWrite: false }));
    const sunM = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,240,200,1)', 'rgba(255,190,80,.55)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    sunM.scale.set(0.12, 0.12, 1);
    const sunL = textSprite(T, '태양', '#ffd27a', 0.06, 700);
    sunG.add(sunR4, sunR15, sunM, sunL);
    let sunT = -1e9;
    function sunUpd(t) {
      if (t - sunT < 60000) return;
      sunT = t;
      const s = window.Sejong22m ? Sejong22m.sun(opts.now ? opts.now() : Date.now()) : null;
      sunG.visible = !!(s && s.el > -4);
      if (!sunG.visible) return;
      const c = dir(T, s.az, s.el, 1).normalize();
      const keep = (pts) => pts.filter((p) => p.y >= -0.005);
      sunR4.geometry.setFromPoints(keep(ringPts(c, 4))); sunR15.geometry.setFromPoints(keep(ringPts(c, 15))); sunR15.computeLineDistances();
      sunM.position.copy(dir(T, s.az, Math.max(s.el, 0.5), 1.0)); sunL.position.copy(dir(T, s.az, Math.max(s.el, 0.5) + 7, 1.06));
      dirty = true;
    }

    // ── 안테나: 세종 22m 실물 모형(공용 lib/sejong22m.js — 10-04 센터장님 "기존 안테나 구동 모형을 실물 모형으로 전면 대체") ──
    //   반구 반지름 1 에 높이 약 0.29(m 실척 × AS). 빔은 고도축(16.2 m)에서 나간다. 이 장면은 sRGB 출력이 아니라 무늬는 선형으로(linear)
    const AS = 0.0105, AO = new T.Vector3(0, 16.2 * AS, 0);
    const ANT = window.Sejong22m ? Sejong22m.add(scene, { url: opts.glb || GLB, scale: AS, shadow: false, linear: true, onload: () => { dirty = true; } }) : null;
    // 빔 — 접시에서 하늘까지 빛줄기(가산 혼합 원뿔) + 하늘에 닿은 자리 빛
    const beamMat = new T.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.2, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending });
    const beamG = new T.ConeGeometry(0.055, 1, 28, 1, true); beamG.translate(0, -0.5, 0); beamG.rotateX(-Math.PI / 2);   // 꼭지 = 원점, 넓은 쪽 = +z 1
    const beam = new T.Mesh(beamG, beamMat); scene.add(beam);
    const core = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3(0, 1, 0)]), new T.LineBasicMaterial({ color: 0xa8d4ff, transparent: true, opacity: 0.9 }));
    scene.add(core);
    const hit = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(220,240,255,1)', 'rgba(88,166,255,.55)'), transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending }));
    hit.scale.set(0.2, 0.2, 1); scene.add(hit);
    // 다음 목표 — 호박색 마름모(하늘 면에 붙인 고리)
    const nextM = new T.Mesh(new T.RingGeometry(0.045, 0.06, 4), new T.MeshBasicMaterial({ color: 0xe3b341, side: T.DoubleSide, transparent: true, depthTest: false }));
    nextM.renderOrder = 5; scene.add(nextM);

    let model = null, raf = 0, dirty = true, visible = true, drag = false, px = 0, py = 0, lastUser = -1e9, lastT = 0, latest = null;
    const touch = () => { lastUser = performance.now(); };
    canvas.addEventListener('pointerdown', (e) => { drag = true; px = e.clientX; py = e.clientY; touch(); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = false; touch(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      ph -= (e.clientX - px) * 0.008; th = Math.max(0.12, Math.min(1.42, th - (e.clientY - py) * 0.008));
      phBase = ph; sway = 0; px = e.clientX; py = e.clientY; touch(); dirty = true;
    });
    canvas.addEventListener('wheel', (e) => { rad = Math.max(2.4, Math.min(7, rad + e.deltaY * 0.004)); touch(); dirty = true; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { th = TH0; rad = RAD0; sway = 0; if (focusPh != null) ph = phBase = focusPh; lastUser = -1e9; dirty = true; });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) dirty = true; }).observe(canvas);

    function clearData() {
      for (const g of [data, fx]) while (g.children.length) {
        const o = g.children.pop();
        o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (c.material.map && !c.material.map.keep) c.material.map.dispose(); c.material.dispose(); } });
      }
      latest = null;
    }
    const TEX = {
      ok: glowTex(T, 'rgba(225,255,230,1)', 'rgba(63,185,80,.75)'),
      old: glowTex(T, 'rgba(235,240,245,1)', 'rgba(139,148,158,.6)'),
      bad: glowTex(T, 'rgba(255,215,210,1)', 'rgba(248,81,73,.7)'),
    };
    for (const t of Object.values(TEX)) t.keep = true;        // 다시 그릴 때 버리지 않는다(같이 쓰는 무늬)
    function build() {
      clearData();
      if (!model) return;
      const k = model.scale || 0.005;
      // 전파원 하루 길 — 고도 20° 위는 진하게, 지금 자리에 빛점과 이름
      for (const tr of model.tracks || []) {
        let seg = [], hi = null;
        const flush = () => { if (seg.length > 1) data.add(line(seg, tr.color, hi ? 0.8 : 0.22)); seg = []; };
        for (const [az, el] of tr.pts) {
          if (el < 0) { flush(); hi = null; continue; }
          const h = el >= 20;
          if (hi !== null && h !== hi) { const last = seg[seg.length - 1]; flush(); if (last) seg.push(last); }
          hi = h; seg.push(dir(T, az, el, 1.003));
        }
        flush();
        if (tr.now && tr.now[1] > 0) {
          const c = '#' + tr.color.toString(16).padStart(6, '0');
          const sp = textSprite(T, tr.src, c, 0.085, 700);
          sp.position.copy(dir(T, tr.now[0], tr.now[1] + 9, 1.06)); data.add(sp);
          const g = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,255,255,1)', c + 'aa'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
          g.position.copy(dir(T, tr.now[0], tr.now[1], 1.004)); g.scale.set(0.09, 0.09, 1); data.add(g);
        }
      }
      // 측정점(빛 구슬) + X 대역 오프셋 화살(크게 늘림)
      const arrows = [];
      const pts = (model.points || []).filter((p) => p.az != null && p.el != null);
      pts.forEach((p, i) => {
        const d = dir(T, p.az, p.el, 1.0);
        const sp = new T.Sprite(new T.SpriteMaterial({ map: p.ok ? (p.refrac ? TEX.ok : TEX.old) : TEX.bad, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
        const s = p.ok ? 0.11 : 0.085; sp.scale.set(s, s, 1); sp.position.copy(d); data.add(sp);
        if (p.ok && p.dx != null && p.de != null) {
          const a = p.az * D2R, e = p.el * D2R;
          const eA = new T.Vector3(Math.cos(a), 0, Math.sin(a)), eE = new T.Vector3(-Math.sin(a) * Math.sin(e), Math.cos(e), Math.cos(a) * Math.sin(e));
          arrows.push(d, d.clone().add(eA.multiplyScalar(p.dx * k)).add(eE.multiplyScalar(p.de * k)));
        }
        if (i === pts.length - 1) latest = { d, color: p.ok ? (p.refrac ? 0x3fb950 : 0x8b949e) : 0xf85149 };
      });
      if (arrows.length) data.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(arrows), new T.LineBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.95, depthWrite: false })));
      if (latest) {                                   // 마지막 점 — 하늘 면에 붙어 퍼지는 고리
        const r = new T.Mesh(new T.RingGeometry(0.03, 0.038, 40), new T.MeshBasicMaterial({ color: latest.color, transparent: true, side: T.DoubleSide, depthWrite: false, depthTest: false }));
        r.position.copy(latest.d); r.lookAt(latest.d.clone().multiplyScalar(2)); fx.add(r); latest.ring = r;
      }
      dirty = true;
    }
    function placeAnt() {
      const a = model && model.ant, ok = !!(a && a.az != null && a.el != null);
      beam.visible = core.visible = hit.visible = ok;         // 모형은 늘 보인다(자료가 없으면 마지막 자세 · 처음은 고도 90°)
      if (ok) {
        if (ANT) ANT.place(a.az, a.el);
        const o = AO.clone(), d = dir(T, a.az, a.el, 1.0);
        beam.position.copy(o); beam.lookAt(d); beam.scale.set(1, 1, d.distanceTo(o));   // lookAt 은 +z 를 d 로 돌린다
        core.geometry.setFromPoints([o, d]);
        hit.position.copy(d);
        beamMat.color.setHex(model.running ? 0x58a6ff : 0x7d8ea3); core.material.color.setHex(model.running ? 0xa8d4ff : 0x9aa8b8);
      }
      const n = model && model.next, pts = (model && model.points) || [], lp = pts[pts.length - 1];
      const f = ok && a.el > 3 ? a.az : n && n.az != null && n.el > 0 ? n.az : lp && lp.az != null ? lp.az : null;
      if (f != null && opts.ph == null) {
        const want = Math.PI - (((f + SIDE) % 360) * D2R);            // 카메라 방위 = f + 50° (ph = π − 방위)
        if (focusPh == null) ph = phBase = want;
        focusPh = want;
      }
      nextM.visible = !!(n && n.az != null && n.el != null && n.el > 0);
      if (nextM.visible) { const d = dir(T, n.az, n.el, 1.004); nextM.position.copy(d); nextM.lookAt(d.clone().multiplyScalar(2)); }
      dirty = true;
    }
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !visible || !canvas.clientWidth || !model) return;
      if (t - lastT < 40 && !dirty) return;                  // 움직임은 25 fps 면 넉넉하다
      const dt = Math.min(3, (t - lastT) / 40); lastT = t;
      if (!drag && focusPh != null && t - lastUser > 30000) {      // 안테나 방위를 천천히 따라 돈다(짧은 쪽으로)
        const d = ((((focusPh - phBase + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        phBase += d * Math.min(1, 0.02 * dt);
      }
      if (!drag && t - lastUser > 5000) { sway += 0.004 * dt; ph = phBase + 0.3 * Math.sin(sway); }
      const pulse = 0.5 + 0.5 * Math.sin(t / 300);
      beamMat.opacity = model.running ? 0.16 + 0.18 * pulse : 0.12;
      hit.scale.setScalar(model.running ? 0.16 + 0.1 * pulse : 0.13);
      if (nextM.visible) { const s = 1 + 0.25 * pulse; nextM.scale.set(s, s, 1); }
      if (latest && latest.ring) { const f = (t % 2200) / 2200; latest.ring.scale.setScalar(1 + 2.6 * f); latest.ring.material.opacity = 0.9 * (1 - f); }
      sunUpd(t); dirty = false; upd(); rn.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);
    let sig = '';
    return {
      set(m) {
        const s = JSON.stringify([m.points, m.tracks && m.tracks.map((t) => [t.src, t.pts.length, t.now && t.now.map((v) => Math.round(v))]), m.scale]);
        model = m;
        if (s !== sig) { sig = s; build(); }
        placeAnt();
      },
      resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return false;
        if (w === lw && h === lh) return true;                // 같은 크기면 건드리지 않는다(캔버스 크기를 다시 넣으면 지워져 깜박인다)
        lw = w; lh = h;
        rn.setSize(w, h, false); cam.aspect = w / h; kfit = Math.max(1, 1.35 / cam.aspect);
        cam.updateProjectionMatrix(); dirty = true; return true;
      },
      dispose() { cancelAnimationFrame(raf); clearData(); rn.dispose(); },
    };
  }

  // 전파원 하루 길(방위·고도) — 세종 좌표, 지금부터 hours 시간을 step 분마다(화면이 스스로 계산, 서버에 묻지 않음)
  function track(raH, decD, t0, hours, stepMin) {
    const lat = 36.5219 * D2R, lon = 127.3025, out = [];
    for (let m = 0; m <= hours * 60; m += stepMin || 10) {
      const t = t0 + m * 60, jd = t / 86400 + 2440587.5;
      const gmst = (18.697374558 + 24.06570982441908 * (jd - 2451545.0)) % 24;
      const ha = ((((gmst + lon / 15 - raH) % 24) + 24) % 24) * 15 * D2R, de = decD * D2R;
      const el = Math.asin(Math.sin(lat) * Math.sin(de) + Math.cos(lat) * Math.cos(de) * Math.cos(ha));
      const az = Math.atan2(-Math.cos(de) * Math.sin(ha), Math.sin(de) * Math.cos(lat) - Math.cos(de) * Math.sin(lat) * Math.cos(ha));
      out.push([((az / D2R) % 360 + 360) % 360, el / D2R]);
    }
    return out;
  }
  const SOURCES = { CASA: [23.39, 58.815, 0xe3b341], TAUA: [5.5755, 22.0145, 0xbc8cff], CYGA: [19.9912, 40.7339, 0x58a6ff],
    ORIA: [5.5881, -5.3911, 0xf778ba], W51: [19.3955, 14.5094, 0x56d4dd] };            // 10-04 Orion A · W51 추가
  const NAME = { CASA: 'Cas A', TAUA: 'Tau A', CYGA: 'Cyg A', ORIA: 'Ori A', W51: 'W51' };
  function tracks(names, t0, hours) {
    return (names || Object.keys(SOURCES)).filter((n) => SOURCES[n]).map((n) => {
      const [ra, dec, color] = SOURCES[n];
      return { key: n, src: NAME[n], color, pts: track(ra, dec, t0, hours || 24, 10), now: track(ra, dec, t0, 0, 10)[0] };
    });
  }
  window.Sky3D = { create, tracks, NAME };
})();
