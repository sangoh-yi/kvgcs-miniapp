/* scan3d.js — '지금 스캔' 3D 원판(2026-10-02 센터장님 "지금 스캔 그래픽 — 첨단 분위기 · 아티팩트 · 3js").
 *   스캔 한 주기(앞 스캔 끝 = 선회 시작 → 도착 → 기록 시작 → 끝)를 기울인 빛 고리 한 바퀴에 놓는다(12시에서 시계 방향).
 *   푸른 띠 = 예측 선회 · 붉은 테 = 기록 창 · 붉은→주황 채움 = 기록한 만큼 · 초록 구슬 = 도착 · 흰 빛머리+꼬리 = 지금.
 *   가운데는 남은 시간(크게) · 양옆은 계기판 수치 · 고리 위 시각 글은 화면 좌표로 붙인다. 바탕은 어두운 화면(테마와 상관없이 계기판).
 * 쓰기: const s = Scan3D.create(canvas, { now: () => 초 }); s.set(model); s.resize(); s.dispose();   (window.THREE 가 있어야 한다)
 * model = { t0, predSlew, start, stop, recOn, arrived, stage, rec, paused, tiles: [[이름, 값HTML, 'good'|'warn'|'']…] }
 *   시각은 모두 epoch 초. 화면 글은 KST.
 */
'use strict';
(function () {
  const TAU = Math.PI * 2, GAP = 0.62;                  // 12시 쪽 틈(라디안) — 처음과 끝이 맞붙지 않게
  const PHI = (f) => GAP / 2 + Math.max(0, Math.min(1, f)) * (TAU - GAP);
  const P2 = (n) => String(n).padStart(2, '0');
  const kst = (t) => { const d = new Date((t + 9 * 3600) * 1000); return `${P2(d.getUTCHours())}:${P2(d.getUTCMinutes())}:${P2(d.getUTCSeconds())}`; };
  const mmss = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${P2(m)}:${P2(x)}` : `${P2(m)}:${P2(x)}`;
  };
  const COL = { slew: 0x4fc3ff, wait: 0x2bd4c0, rec: 0xff4d5e, rec2: 0xff9a5c, ok: 0x3fdc8a, pause: 0xf5b041, head: 0xffffff };
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');

  function glowTex(T, inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.32, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }
  // 바닥 원판 무늬 — 동심원·방사 눈금·육각 격자(가산 혼합으로 은은하게)
  function dialTex(T) {
    const n = 1024, c = document.createElement('canvas'); c.width = c.height = n;
    const g = c.getContext('2d'), m = n / 2;
    const rg = g.createRadialGradient(m, m, 0, m, m, m);
    rg.addColorStop(0, 'rgba(40,120,220,.30)'); rg.addColorStop(0.55, 'rgba(20,70,150,.16)'); rg.addColorStop(0.82, 'rgba(10,40,90,.10)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, n, n);
    g.save(); g.beginPath(); g.arc(m, m, m * 0.7, 0, TAU); g.clip();
    g.strokeStyle = 'rgba(110,190,255,.10)'; g.lineWidth = 1.2;
    const s = 26, hh = s * Math.sqrt(3) / 2;
    for (let y = -s, row = 0; y < n + s; y += hh, row++) {
      for (let x = (row % 2 ? s * 0.75 : 0) - s; x < n + s; x += s * 1.5) {
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; g.lineTo(x + (s / 2) * Math.cos(a), y + (s / 2) * Math.sin(a)); }
        g.closePath(); g.stroke();
      }
    }
    g.restore();
    for (const [r, a] of [[0.30, 0.22], [0.48, 0.18], [0.70, 0.30], [0.96, 0.14]]) {
      g.strokeStyle = `rgba(120,200,255,${a})`; g.lineWidth = 2; g.beginPath(); g.arc(m, m, m * r, 0, TAU); g.stroke();
    }
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * TAU, r0 = m * (k % 6 ? 0.66 : 0.6), r1 = m * 0.7;
      g.strokeStyle = `rgba(120,200,255,${k % 6 ? 0.18 : 0.4})`; g.lineWidth = k % 6 ? 1.5 : 2.5;
      g.beginPath(); g.moveTo(m + r0 * Math.cos(a), m + r0 * Math.sin(a)); g.lineTo(m + r1 * Math.cos(a), m + r1 * Math.sin(a)); g.stroke();
    }
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearMipmapLinearFilter; return t;
  }
  // 레이더 쓸기 쐐기 — 앞쪽이 밝고 뒤로 사라진다
  function sweepTex(T) {
    const n = 512, c = document.createElement('canvas'); c.width = c.height = n;
    const g = c.getContext('2d'), m = n / 2;
    for (let k = 0; k < 90; k++) {
      const a0 = -(k + 1) * 0.0105, a1 = -k * 0.0105, al = 0.42 * Math.pow(1 - k / 90, 2.2);
      g.fillStyle = `rgba(90,200,255,${al})`; g.beginPath(); g.moveTo(m, m); g.arc(m, m, m, a0, a1); g.closePath(); g.fill();
    }
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearFilter; return t;
  }

  function create(canvas, opt) {
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const now = (opt && opt.now) || (() => Date.now() / 1000);
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0);
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new T.Scene();
    const cam = new T.PerspectiveCamera(36, 2, 0.05, 40);
    const R0 = 1.0, R1 = 1.13;                          // 주 고리 안·밖 반지름
    const root = new T.Group(); scene.add(root);         // 원판 전체(살짝 흔들린다)
    const stat = new T.Group(); root.add(stat);          // 시각이 바뀔 때만 다시 만드는 것
    const dyn = new T.Group(); root.add(dyn);            // 매 장면 바뀌는 것(채움·꼬리)
    const ADD = { transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide };
    // 바닥 원판 · 레이더 쓸기 · 안쪽 도는 고리 둘 · 가운데 빛
    const dial = new T.Mesh(new T.CircleGeometry(1.55, 96), new T.MeshBasicMaterial(Object.assign({ map: dialTex(T), opacity: 0.95 }, ADD)));
    dial.rotation.x = -Math.PI / 2; dial.position.y = -0.004; root.add(dial);
    const sweep = new T.Mesh(new T.CircleGeometry(0.97, 64), new T.MeshBasicMaterial(Object.assign({ map: sweepTex(T), opacity: 0.55 }, ADD)));
    sweep.rotation.x = -Math.PI / 2; sweep.position.y = 0.002; root.add(sweep);
    const dashRing = (r, w, n, duty, color, op) => {
      const g = new T.Group();
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU, m = new T.Mesh(new T.RingGeometry(r, r + w, 6, 1, a, (TAU / n) * duty),
          new T.MeshBasicMaterial(Object.assign({ color, opacity: op }, ADD)));
        m.rotation.x = -Math.PI / 2; g.add(m);
      }
      root.add(g); return g;
    };
    const ringA = dashRing(0.80, 0.022, 48, 0.55, 0x58b8ff, 0.55);
    const ringB = dashRing(0.64, 0.05, 6, 0.7, 0x2bd4c0, 0.28);
    const coreTex = glowTex(T, 'rgba(255,255,255,1)', 'rgba(120,200,255,.45)');
    const core = new T.Sprite(new T.SpriteMaterial({ map: coreTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, color: 0x88ccff }));
    core.position.set(0, 0.05, 0); core.scale.set(0.7, 0.7, 1); root.add(core);
    // 가운데 빛기둥(기록 중엔 붉게 솟는다)
    const beamGeo = new T.CylinderGeometry(0.03, 0.1, 0.4, 24, 1, true); beamGeo.translate(0, 0.2, 0);
    const beam = new T.Mesh(beamGeo, new T.MeshBasicMaterial(Object.assign({ color: 0x58b8ff, opacity: 0.0 }, ADD)));
    root.add(beam);
    // 떠다니는 빛가루 — 고리 둘레
    const NP = 140, pp = new Float32Array(NP * 3), pv = [];
    for (let k = 0; k < NP; k++) {
      const a = Math.random() * TAU, r = 0.7 + Math.random() * 0.75;
      pp.set([r * Math.cos(a), Math.random() * 0.5, r * Math.sin(a)], k * 3);
      pv.push({ a, r, y: Math.random() * 0.5, s: 0.08 + Math.random() * 0.25, w: (Math.random() - 0.5) * 0.2 });
    }
    const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pp, 3));
    const pmat = new T.PointsMaterial({ size: 0.035, map: glowTex(T, 'rgba(255,255,255,1)', 'rgba(140,210,255,.6)'), color: 0x9fd8ff,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.8 });
    root.add(new T.Points(pg, pmat));
    // 지금 빛머리 · 도착 구슬
    const head = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,255,255,1)', 'rgba(150,215,255,.55)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    head.scale.set(0.34, 0.34, 1); root.add(head);
    const headPin = new T.Mesh(new T.CylinderGeometry(0.006, 0.006, 0.34, 6), new T.MeshBasicMaterial(Object.assign({ color: 0xffffff, opacity: 0.85 }, ADD)));
    root.add(headPin);
    const arrive = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(230,255,240,1)', 'rgba(63,220,138,.6)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    arrive.scale.set(0.2, 0.2, 1); arrive.visible = false; root.add(arrive);
    const dashGeo = new T.RingGeometry(R0 + 0.025, R1 - 0.025, 3, 1, Math.PI / 2 - 0.025, 0.05); dashGeo.rotateX(-Math.PI / 2);
    const dashes = [];
    for (let k = 0; k < 70; k++) {
      const d = new T.Mesh(dashGeo, new T.MeshBasicMaterial(Object.assign({ color: 0x2bd4c0, opacity: 0.7 }, ADD)));
      d.position.y = 0.005; d.visible = false; root.add(d); dashes.push(d);
    }
    const ripple = new T.Mesh(new T.RingGeometry(0.9, 1, 48), new T.MeshBasicMaterial(Object.assign({ color: 0xff4d5e, opacity: 0 }, ADD)));
    ripple.rotation.x = -Math.PI / 2; root.add(ripple);

    // 겉글(화면 좌표) — 가운데 남은 시간 · 양옆 계기 · 고리 시각 글
    const host = canvas.parentElement;
    const ov = document.createElement('div');
    ov.className = 's3-ov';
    ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;font-family:"Malgun Gothic",sans-serif';
    ov.innerHTML =
      '<div class="s3-c" style="position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);text-align:center;white-space:nowrap">' +
      '<div class="s3-l" style="font:700 11.5px \'Malgun Gothic\',sans-serif;letter-spacing:.06em;color:#9fd2ff;text-shadow:0 0 8px rgba(80,180,255,.7)"></div>' +
      '<div class="s3-big" style="font:800 34px/1.05 \'Cascadia Mono\',Consolas,monospace;color:#fff;letter-spacing:.02em;text-shadow:0 0 14px rgba(120,200,255,.9),0 0 30px rgba(80,160,255,.45)"></div>' +
      '<div class="s3-sub" style="font:600 11px \'Cascadia Mono\',Consolas,monospace;color:#b9c9de;margin-top:1px"></div></div>' +
      '<div class="s3-hl" style="position:absolute;left:8px;top:8px;bottom:8px;display:flex;flex-direction:column;justify-content:space-between;width:92px"></div>' +
      '<div class="s3-hr" style="position:absolute;right:8px;top:8px;bottom:8px;display:flex;flex-direction:column;justify-content:space-between;width:92px;text-align:right"></div>' +
      '<div class="s3-tags"></div>';
    host.appendChild(ov);
    const $o = (c) => ov.querySelector(c);
    const tagBox = $o('.s3-tags');

    let model = null, sig = '', raf = 0, lastT = 0, visible = true, fillKey = '', tailKey = '', lastTxt = 0;
    let fillMesh = null, fillGlow = null, tailMesh = null;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);

    const span = () => (model ? Math.max(1, model.stop - model.t0) : 1);
    const fr = (t) => (t - model.t0) / span();
    const pt = (phi, r, y) => new T.Vector3(r * Math.sin(phi), y || 0, -r * Math.cos(phi));
    function arcGeo(r0, r1, phA, phB, seg) {          // φ(12시에서 시계 방향) phA→phB 의 납작한 고리 조각
      const g = new T.RingGeometry(r0, r1, seg || Math.max(4, Math.ceil(((phB - phA) / TAU) * 160)), 1, Math.PI / 2 - phB, Math.max(1e-4, phB - phA));
      g.rotateX(-Math.PI / 2);
      return g;
    }
    function colorArc(g, phA, phB, fn) {               // 각마다 꼭짓점 색(fn(0..1) → [r,g,b])
      const p = g.attributes.position, cols = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        let phi = Math.atan2(p.getX(i), -p.getZ(i)); if (phi < 0) phi += TAU;
        const u = (phi - phA) / Math.max(1e-6, phB - phA);
        cols.set(fn(Math.max(0, Math.min(1, u))), i * 3);
      }
      g.setAttribute('color', new T.BufferAttribute(cols, 3));
      return g;
    }
    const disp = (o) => { if (!o) return; o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); if (o.parent) o.parent.remove(o); };
    function clearGroup(g) { while (g.children.length) disp(g.children[0]); }
    const lbls = [];
    function label(txt, phi, r, color, strong, al) {
      const d = document.createElement('div');
      d.textContent = txt;
      d.style.cssText = `position:absolute;transform:translate(${al === 'l' ? '-100%' : al === 'r' ? '0' : '-50%'},-50%);font:${strong ? 700 : 600} 10.5px 'Cascadia Mono',Consolas,monospace;color:${color};` +
        'background:rgba(4,10,22,.72);border:1px solid rgba(120,190,255,.28);border-radius:5px;padding:1px 5px;white-space:nowrap;text-shadow:0 0 6px rgba(0,0,0,.8)';
      tagBox.appendChild(d); lbls.push({ d, al, p: pt(phi, r, 0.02) });
    }

    // 시각(스캔)이 바뀌면 다시 — 틈 받침·눈금·선회 띠·기록 창·글
    function build() {
      clearGroup(stat); tagBox.innerHTML = ''; lbls.length = 0; fillKey = tailKey = '';
      if (!model) return;
      const m = model, base = new T.MeshBasicMaterial(Object.assign({ color: 0x1d5596, opacity: 0.42 }, ADD));
      const track = new T.Mesh(arcGeo(R0, R1, PHI(0), PHI(1)), base); track.position.y = 0.001; stat.add(track);
      // 바깥 눈금 — 30 초마다(분은 길게)
      const tick = [], step = span() > 1800 ? 300 : span() > 600 ? 60 : 30;
      for (let t = Math.ceil(m.t0 / step) * step; t <= m.stop; t += step) {
        const ph = PHI(fr(t)), big = (Math.round(t) % 60) === 0;
        tick.push(pt(ph, R1 + 0.03), pt(ph, R1 + (big ? 0.11 : 0.06)));
      }
      stat.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(tick), new T.LineBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.6 })));
      // 틈 양 끝 표지
      for (const f of [0, 1]) stat.add(new T.Line(new T.BufferGeometry().setFromPoints([pt(PHI(f), R0 - 0.06), pt(PHI(f), R1 + 0.06)]),
        new T.LineBasicMaterial({ color: 0xa8d8ff, transparent: true, opacity: 0.8 })));
      // 예측 선회(푸른 띠) · 기다림(청록 옅게)
      const ps = Math.max(0, m.predSlew || 0), fS = fr(m.t0 + ps), fA = fr(m.start);
      if (ps > 0) {
        stat.add(new T.Mesh(colorArc(arcGeo(R0, R1, PHI(0), PHI(fS)), PHI(0), PHI(fS), (u) => [0.12 + 0.19 * u, 0.35 + 0.42 * u, 0.6 + 0.4 * u]),
          new T.MeshBasicMaterial(Object.assign({ vertexColors: true, opacity: 0.95 }, ADD))));
        const gl = new T.Mesh(arcGeo(R0 - 0.05, R1 + 0.05, PHI(0), PHI(fS)), new T.MeshBasicMaterial(Object.assign({ color: COL.slew, opacity: 0.12 }, ADD)));
        gl.position.y = 0.002; stat.add(gl);
      }
      if (fA > fS) stat.add(new T.Mesh(arcGeo(R0 + 0.035, R1 - 0.035, PHI(fS), PHI(fA)), new T.MeshBasicMaterial(Object.assign({ color: COL.wait, opacity: 0.38 }, ADD))));
      // 기록 창 — 붉은 빛 테 두 줄 + 옅은 바탕
      const pa = PHI(fA), pb = PHI(1);
      for (const [r0, r1] of [[R0 - 0.035, R0 - 0.012], [R1 + 0.012, R1 + 0.035]]) {
        const e = new T.Mesh(arcGeo(r0, r1, pa, pb), new T.MeshBasicMaterial(Object.assign({ color: COL.rec, opacity: 0.95 }, ADD))); e.position.y = 0.003; stat.add(e);
      }
      stat.add(new T.Mesh(arcGeo(R0, R1, pa, pb), new T.MeshBasicMaterial(Object.assign({ color: COL.rec, opacity: 0.10 }, ADD))));
      // 시각 글
      label(`선회 ${kst(m.t0).slice(0, 5)}`, PHI(0), R1 + 0.16, '#9fd2ff', false, 'r');
      label(`끝 ${kst(m.stop)}`, pb, R1 + 0.16, '#ffd2cc', true, 'l');
      // 계기 수치(양옆)
      const tl = Array.isArray(m.tiles) ? m.tiles : [];
      const tile = ([k, v, cls], right) => `<div style="background:linear-gradient(${right ? 270 : 90}deg,rgba(6,16,34,.82),rgba(6,16,34,.35));` +
        `border-${right ? 'right' : 'left'}:2px solid ${cls === 'warn' ? '#f5b041' : cls === 'good' ? '#3fdc8a' : 'rgba(120,190,255,.6)'};padding:3px 7px;border-radius:4px">` +
        `<div style="font:600 10px 'Malgun Gothic',sans-serif;color:#8fb3e0;letter-spacing:.03em">${k}</div>` +
        `<div style="font:700 13.5px 'Cascadia Mono',Consolas,monospace;color:${cls === 'warn' ? '#ffc861' : cls === 'good' ? '#7dffb8' : '#eaf4ff'};text-shadow:0 0 8px rgba(100,180,255,.45)">${v}</div></div>`;
      $o('.s3-hl').innerHTML = tl.slice(0, 3).map((x) => tile(x, false)).join('');
      $o('.s3-hr').innerHTML = tl.slice(3, 6).map((x) => tile(x, true)).join('');
    }

    function place() {                                  // 글을 화면 좌표로
      const w = canvas.clientWidth, h = canvas.clientHeight;
      root.updateMatrixWorld();
      const side = model && Array.isArray(model.tiles) && model.tiles.length ? 104 : 4;   // 양옆 계기 수치 자리는 비켜 간다
      for (const l of lbls) {
        const v = l.p.clone().applyMatrix4(root.matrixWorld).project(cam);
        const bw = l.d.offsetWidth || 90, x = ((v.x + 1) / 2) * w;
        l.d.style.transform = 'translate(-50%,-50%)';
        l.d.style.left = Math.max(side + bw / 2, Math.min(w - side - bw / 2, x + (l.al === 'l' ? -bw / 2 : l.al === 'r' ? bw / 2 : 0))) + 'px';
        l.d.style.top = ((1 - v.y) / 2) * h + 'px';
      }
    }

    function frame(tms) {
      raf = requestAnimationFrame(frame);
      if (!model || document.hidden || !visible || !canvas.clientWidth || tms - lastT < 33) return;
      const dt = Math.min(3, (tms - lastT) / 33); lastT = tms;
      const m = model, t = now(), paused = !!m.paused;
      const recOn = m.recOn != null ? Math.max(m.recOn, m.start) : null;
      const recNow = !paused && recOn != null && t >= recOn && t < m.stop;
      const phase = paused ? 'pause' : t >= m.stop ? 'done' : recNow ? 'rec' : t >= m.start ? 'rec' : (m.arrived != null ? 'wait' : 'slew');
      const k = paused ? 0.15 : 1, pulse = 0.5 + 0.5 * Math.sin(tms / 240);
      // 움직임 — 쓸기·고리·원판 흔들림
      sweep.rotation.z -= 0.035 * dt * k * (phase === 'slew' ? 2.2 : 1);
      ringA.rotation.y += 0.004 * dt * k * (phase === 'slew' ? 3 : 1);
      ringB.rotation.y -= 0.006 * dt * k;
      root.rotation.x = 0.03 * Math.sin(tms / 2600); root.rotation.z = 0.025 * Math.sin(tms / 3300);
      // 빛가루
      const pa = pg.attributes.position;
      for (let i = 0; i < NP; i++) {
        const q = pv[i]; q.a += 0.0025 * dt * k * (1 + q.w); q.y += 0.002 * dt * q.s * (phase === 'rec' ? 3 : 1);
        if (q.y > 0.6) q.y = 0;
        pa.setXYZ(i, q.r * Math.cos(q.a), q.y, q.r * Math.sin(q.a));
      }
      pa.needsUpdate = true;
      pmat.color.setHex(phase === 'rec' ? 0xffb0a0 : phase === 'pause' ? 0xffd28a : 0x9fd8ff);
      // 기록한 만큼 채움(붉은→주황) — 각이 조금이라도 바뀌면 다시
      const fNow = Math.max(0, Math.min(1, fr(t))), phNow = PHI(fNow);
      const fk = recOn != null && t > recOn ? (PHI(fr(Math.min(t, m.stop))) * 400 | 0) : -1;
      if (String(fk) !== fillKey) {
        fillKey = String(fk); disp(fillMesh); disp(fillGlow); fillMesh = fillGlow = null;
        if (fk >= 0) {
          const a = PHI(fr(recOn)), b = PHI(fr(Math.min(t, m.stop)));
          if (b > a + 1e-3) {
            fillMesh = new T.Mesh(colorArc(arcGeo(R0 + 0.01, R1 - 0.01, a, b), a, b, (u) => [1, 0.22 + 0.38 * u, 0.2 + 0.05 * u]),
              new T.MeshBasicMaterial(Object.assign({ vertexColors: true, opacity: 1 }, ADD)));
            fillMesh.position.y = 0.004; dyn.add(fillMesh);
            fillGlow = new T.Mesh(arcGeo(R0 - 0.07, R1 + 0.07, a, b), new T.MeshBasicMaterial(Object.assign({ color: COL.rec, opacity: 0.16 }, ADD)));
            fillGlow.position.y = 0.003; dyn.add(fillGlow);
          }
        }
      }
      // 꼬리 — 지금 앞 0.55 rad 를 흰빛→어둠으로
      const tk = (phNow * 300 | 0) + phase;
      if (tk !== tailKey) {
        tailKey = tk; disp(tailMesh); tailMesh = null;
        const a = Math.max(PHI(0), phNow - 0.55);
        if (phNow > a + 1e-3) {
          const c = phase === 'rec' ? [1, 0.55, 0.5] : phase === 'pause' ? [1, 0.8, 0.4] : [0.6, 0.85, 1];
          tailMesh = new T.Mesh(colorArc(arcGeo(R0 - 0.02, R1 + 0.02, a, phNow), a, phNow, (u) => [c[0] * u * u, c[1] * u * u, c[2] * u * u]),
            new T.MeshBasicMaterial(Object.assign({ vertexColors: true, opacity: 0.9 }, ADD)));
          tailMesh.position.y = 0.006; dyn.add(tailMesh);
        }
      }
      // 앞길 점선 — 지금 앞에서 끝까지, 0.11 rad 마다 하나씩 시계 방향으로 흐른다
      {
        const a = phNow + 0.07, b = PHI(1), sp = 0.11, off = ((tms / 1000) * 0.09 * k) % sp, pA = PHI(fr(m.start));
        let n = 0;
        for (let ph = a + off; ph < b - 0.02 && n < dashes.length; ph += sp, n++) {
          const d = dashes[n]; d.visible = true; d.rotation.y = -ph;
          d.material.color.setHex(paused ? COL.pause : ph >= pA ? COL.rec : COL.wait);
          d.material.opacity = 0.75 * Math.min(1, (ph - a) / 0.25, (b - ph) / 0.25) * (ph >= pA ? 0.8 : 1);
        }
        for (; n < dashes.length; n++) dashes[n].visible = false;
      }
      // 빛머리·핀·도착
      const hp = pt(phNow, (R0 + R1) / 2, 0.02);
      head.position.copy(hp); headPin.position.set(hp.x, 0.17, hp.z);
      const hc = phase === 'rec' ? 0xffc2b8 : phase === 'pause' ? 0xffd28a : 0xd8f0ff;
      head.material.color.setHex(hc); headPin.material.color.setHex(hc);
      const hs = 0.42 + 0.1 * pulse; head.scale.set(hs, hs, 1);
      if (m.arrived != null) { arrive.visible = true; arrive.position.copy(pt(PHI(fr(m.arrived)), (R0 + R1) / 2, 0.025)); const s = 0.17 + 0.05 * pulse; arrive.scale.set(s, s, 1); }
      else arrive.visible = false;
      // 가운데 빛·빛기둥·퍼지는 고리
      const cc = phase === 'rec' ? 0xff6a6a : phase === 'pause' ? 0xf5b041 : phase === 'done' ? 0x3fdc8a : phase === 'wait' ? 0x2bd4c0 : 0x58b8ff;
      core.material.color.setHex(cc); const cs = 0.55 + (phase === 'rec' ? 0.25 : 0.12) * pulse; core.scale.set(cs, cs, 1);
      beam.material.color.setHex(cc); beam.material.opacity = phase === 'rec' ? 0.07 + 0.05 * pulse : 0.03;
      beam.scale.set(1, phase === 'rec' ? 1 : 0.5, 1);
      if (phase === 'rec') {
        const s = (tms % 1600) / 1600; ripple.scale.set(0.15 + 0.85 * s, 0.15 + 0.85 * s, 1); ripple.material.opacity = 0.5 * (1 - s);
      } else ripple.material.opacity = 0;
      // 가운데 글(4 번에 1 번)
      if (tms - lastTxt > 120) {
        lastTxt = tms;
        let l, b, s;
        const len = Math.round(m.stop - m.start);
        if (paused) { l = '‖ 멈춤'; b = t < m.start ? mmss(m.start - t) : t < m.stop ? mmss(m.stop - t) : '끝'; s = '사람이 멈춤 — [다시]로 이어 간다'; }
        else if (t < m.start) {
          l = m.arrived != null ? '도착 · 기록 시작까지' : '선회 중 · 기록 시작까지';
          b = mmss(m.start - t); s = `시작 ${kst(m.start)} KST · 길이 ${len} s`;
        } else if (t < m.stop) {
          l = recNow ? '● 기록 중 · 끝까지' : '기록 켜는 중 · 끝까지';
          b = mmss(m.stop - t); s = `끝 ${kst(m.stop)} KST · ${Math.round(((t - m.start) / Math.max(1, m.stop - m.start)) * 100)} %`;
        } else { l = '기록 끝'; b = '끝'; s = `길이 ${len} s · 다음 스캔으로`; }
        const L = $o('.s3-l'), B = $o('.s3-big'), S2 = $o('.s3-sub');
        if (L.textContent !== l) L.textContent = l;
        if (B.textContent !== b) B.textContent = b;
        if (S2.textContent !== s) S2.textContent = s;
        const glow = phase === 'rec' ? 'rgba(255,90,90,.95),0 0 30px rgba(255,80,80,.5)' : phase === 'pause' ? 'rgba(245,176,65,.9),0 0 26px rgba(245,176,65,.4)' : 'rgba(120,200,255,.9),0 0 30px rgba(80,160,255,.45)';
        B.style.textShadow = `0 0 14px ${glow}`;
        L.style.color = phase === 'rec' ? '#ffb3ad' : phase === 'pause' ? '#ffd28a' : '#9fd2ff';
        L.style.opacity = phase === 'rec' ? String(0.65 + 0.35 * (Math.floor(tms / 500) % 2)) : '1';
      }
      place();
      rn.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);

    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return false;
      rn.setSize(w, h, false);
      cam.aspect = w / h;
      // 고리 전체(글 자리까지)가 늘 들어오게 거리 조정 — 좁으면 뒤로
      //   고리(글 자리 1.5)가 화면 폭의 60 % 쯤 — 양옆에 계기 수치 자리를 남긴다. 고도 38° 로 비스듬히
      const vf = Math.tan((cam.fov * Math.PI) / 360), fill = opt && opt.fill ? opt.fill : 0.66, dist = Math.max(1.5 / (fill * vf * cam.aspect), 3.6);
      cam.position.set(0, dist * 0.62, dist * 0.79); cam.lookAt(0, -0.06, 0);
      cam.updateProjectionMatrix();
      return true;
    }
    return {
      set(m) {
        model = m;
        const s = m ? JSON.stringify([m.t0, m.predSlew, m.start, m.stop, m.tiles]) : '';
        if (s !== sig) { sig = s; build(); }
        resize();
      },
      resize,
      dispose() { cancelAnimationFrame(raf); clearGroup(stat); clearGroup(dyn); dashGeo.dispose(); rn.dispose(); ov.remove(); },
    };
  }
  window.Scan3D = { create };
})();
