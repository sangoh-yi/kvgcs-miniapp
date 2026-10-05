/* vlbisim3d.js — VLBI 전 과정 모의의 3D(three.js r128, 2026-10-05). 계산은 vlbisim_core.js(VSCore), 자산은 블렌더
 *   models/vlbisim/vlbisim_assets.glb(지구·12 m 안테나·신호 사슬 장비) + 공용 lib/sejong22m.js(세종 22 m 실물).
 *   장면 넷 — sky(지구 자전·전파원·파면·기선) · chain(두 국 신호 사슬 → 상관기) · corr(상관기·프린지 곡면) · base(기선 해석 결과)
 *   좌표: three = (X, Z, −Y)(ITRF·천구 모두) · 지구 반지름 10 · 지구는 ERA 만큼 돈다(천구 좌표 장면 — 전파원·파면은 하늘에 고정)
 *   안테나는 지구 위에 크게 과장해 그린다(실제 크기면 보이지 않는다) — 화면 아래 띠에 밝힌다. 글 상자는 띄우지 않는다.
 */
'use strict';
(function () {
  const D2R = Math.PI / 180, RE = 10, M2U = RE / 6371e3, AK = 0.034;   // 안테나 과장 배율(1 m → 0.034) — 지구 위에서 약 1 단위
  function txt(T, s, color, h) {
    const fs = 44, c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`; const w = Math.ceil(g.measureText(s).width) + 16;
    c.width = w; c.height = fs + 16; g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`;
    g.fillStyle = color || '#dbe7f5'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 6; g.fillText(s, 8, c.height / 2);
    const tx = new T.CanvasTexture(c); tx.encoding = T.sRGBEncoding;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tx, transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(h * w / c.height, h, 1); sp.renderOrder = 10; return sp;
  }
  function glowTex(T, inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.35, outer); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  }
  function rodBetween(T, a, b, r, mat) {
    const d = new T.Vector3().subVectors(b, a), L = d.length(), m = new T.Mesh(new T.CylinderGeometry(r, r, 1, 10, 1, true), mat);
    m.scale.set(1, Math.max(L, 1e-6), 1); m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.clone().normalize()); return m;
  }

  function create(cv, o) {
    const T = window.THREE, VS = window.VSCore;
    const rn = new T.WebGLRenderer({ canvas: cv, antialias: true });
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); rn.outputEncoding = T.sRGBEncoding; rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 1.05;
    const scene = new T.Scene(); scene.background = new T.Color(0x040913);
    const cam = new T.PerspectiveCamera(40, 1, 0.01, 5000);
    scene.add(new T.HemisphereLight(0xc4d8ff, 0x0b1222, 0.6));
    const key = new T.DirectionalLight(0xfff4e6, 1.9); key.position.set(80, 50, 60); scene.add(key);
    const rim = new T.DirectionalLight(0x6fa8ff, 0.55); rim.position.set(-60, -10, -80); scene.add(rim);
    // 별(천구에 고정)
    { const n = 2600, p = new Float32Array(n * 3), R = o.seed ? VS.rng(o.seed) : VS.rng(9);
      for (let i = 0; i < n; i++) { const z = 2 * R.u() - 1, a = 2 * Math.PI * R.u(), r = 1500, q = Math.sqrt(1 - z * z); p[3 * i] = r * q * Math.cos(a); p[3 * i + 1] = r * z; p[3 * i + 2] = r * q * Math.sin(a); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(p, 3));
      scene.add(new T.Points(g, new T.PointsMaterial({ color: 0x9fb4d8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.75, depthWrite: false }))); }
    const G = { sky: new T.Group(), chain: new T.Group(), corr: new T.Group() }; for (const k in G) scene.add(G[k]);
    const v3 = (p, k) => new T.Vector3(p[0] * (k || 1), p[2] * (k || 1), -p[1] * (k || 1));
    const ADD = (c, op) => new T.MeshBasicMaterial({ color: c, transparent: true, opacity: op, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false });
    let assets = null, dirty = true, mode = 'sky', S = null, FR = null, SOL = null, t0 = performance.now();
    const ST = [{}, {}];

    // ── 하늘: 지구(자전) · 관측국 · 전파원 · 파면 · 기선 ──
    const earthG = new T.Group(); G.sky.add(earthG);
    const atm = new T.Mesh(new T.SphereGeometry(RE * 1.018, 64, 32), new T.MeshBasicMaterial({ color: 0x3f8cff, transparent: true, opacity: 0.12, side: T.BackSide, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
    G.sky.add(atm);
    const srcG = new T.Group(); G.sky.add(srcG);
    const srcGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,240,200,1)', 'rgba(255,190,90,.45)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
    srcGlow.scale.set(9, 9, 1); srcG.add(srcGlow);
    let srcLbl = null, beamLine = null;
    // 파면 — 평면파답게 격자선 평면(가장자리로 갈수록 사라짐) + 옅은 빛. 묶음(Group)의 +z 가 ŝ 를 본다
    const WF = []; const wfTex = glowTex(T, 'rgba(140,200,255,.55)', 'rgba(80,140,255,.16)');
    const wfGrid = (() => {
      const L = 34, n = 12, pos = [], col = [];
      for (let i = 0; i <= n; i++) {
        const u = -L / 2 + L * i / n;
        for (let k = 0; k < 24; k++) {                       // 선을 잘게 나눠 가장자리로 갈수록 어둡게(정점 색)
          const a = -L / 2 + L * k / 24, b = -L / 2 + L * (k + 1) / 24;
          for (const [x0, y0, x1, y1] of [[u, a, u, b], [a, u, b, u]]) {
            pos.push(x0, y0, 0, x1, y1, 0);
            for (const [x, y] of [[x0, y0], [x1, y1]]) { const r = Math.hypot(x, y) / (L / 2), w = Math.max(0, 1 - r * r) ** 1.6; col.push(0.45 * w, 0.8 * w, 1.0 * w); }
          }
        }
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3)); return g;
    })();
    for (let i = 0; i < 4; i++) {
      const g = new T.Group();
      const gm = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false });
      const pm = new T.MeshBasicMaterial({ map: wfTex, transparent: true, opacity: 0.5, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false });
      g.add(new T.LineSegments(wfGrid, gm)); g.add(new T.Mesh(new T.PlaneGeometry(34, 34), pm));
      g.material = { set opacity(v) { gm.opacity = 0.62 * v / 0.55; pm.opacity = 0.4 * v / 0.55; }, get opacity() { return gm.opacity * 0.55 / 0.62; } };
      G.sky.add(g); WF.push(g);
    }
    const pathMat = new T.MeshBasicMaterial({ color: 0xffc34d, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
    const baseMat = new T.MeshBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false });
    let pathRod = null, baseRod = null, footDot = null;
    const flashes = [0, 0];
    const ringMat = [ADD(0x5fe3ff, 0.0), ADD(0xffc34d, 0.0)];
    // 기선 해석 결과(오차 타원체 · 보정 화살)
    const solG = new T.Group(); earthG.add(solG);

    function placeStation(i, xyz, name, isSejong) {
      const g = new T.Group(), q = frameQ(xyz); g.position.copy(v3(xyz, M2U)); g.quaternion.copy(q); earthG.add(g);
      const ring = new T.Mesh(new T.RingGeometry(0.25, 0.42, 48), ringMat[i]); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);
      const pin = new T.Mesh(new T.CircleGeometry(0.12, 24), ADD(i ? 0xffc34d : 0x5fe3ff, 0.9)); pin.rotation.x = -Math.PI / 2; pin.position.y = 0.03; g.add(pin);
      const lb = txt(T, name, i ? '#ffd27a' : '#8ff0ff', 0.42); lb.position.set(0, 1.55, 0); g.add(lb);
      const st = { g, ring, lb, xyz, name };
      if (isSejong && window.Sejong22m) st.ant = window.Sejong22m.add(scene, { url: o.sejongUrl, scale: AK, parent: g, shadow: false });
      else st.pending = true;
      ST[i] = st; return st;
    }
    function frameQ(xyz) {
      const R = VS.enuMat(xyz), E = v3(R[0]), N = v3(R[1]), U = v3(R[2]), Sd = N.clone().negate();
      return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(E, U, Sd));
    }
    function ant12(st) {
      if (!assets || !st.pending) return;
      const src = assets.getObjectByName('Ant12'); if (!src) return;
      const a = src.clone(true); a.scale.setScalar(AK * (o.dish2 || 12) / 12); st.g.add(a); st.pending = false;   // 12 m 일반형을 상대국 지름으로(코키 파크 20 m)
      const AZ = a.getObjectByName('Ant12_AZ'), EL = a.getObjectByName('Ant12_EL');
      st.ant = { place(az, el) { if (AZ) AZ.rotation.y = (180 - az) * D2R; if (EL) EL.rotation.x = (90 - el) * D2R; } };
      if (st.azel) st.ant.place(st.azel[0], st.azel[1]);
    }

    // ── 신호 사슬(두 국 → 상관기) ──
    const chainParts = {}; const flowPts = []; let flowMesh = null, flowPaths = [];
    function buildChain() {
      if (!assets) return;
      const lay = [['Feed', -6.2], ['LNA', -5.0], ['DownConv', -3.8], ['HMaser', -2.5], ['DBBC3', -1.0], ['FlexBuff', 0.4]];
      for (let s = 0; s < 2; s++) {
        const z = s ? -1.9 : 1.9, path = [];
        for (const [nm, x] of lay) {
          const src = assets.getObjectByName(nm); if (!src) continue;
          const c = src.clone(true); c.position.set(x, 0, nm === 'HMaser' ? z * 0.42 : z); G.chain.add(c); (chainParts[nm] = chainParts[nm] || []).push(c);
          if (nm !== 'HMaser') path.push(new T.Vector3(x, nm === 'Feed' ? 0.5 : nm === 'DBBC3' || nm === 'FlexBuff' ? 1.0 : 0.35, z));
        }
        const fb = assets.getObjectByName('Fiber'); if (fb) { const c = fb.clone(true); c.position.set(1.9, 0, z * 0.55); G.chain.add(c); path.push(new T.Vector3(1.9, 0.3, z * 0.55)); }
        path.push(new T.Vector3(3.6, 1.0, 0));
        flowPaths.push(path);
        // 시각 동기: 수소메이저 → 하향 변환기(LO)·DBBC3(표본 시각)·FlexBuff(VDIF 시각표)
        const hm = new T.Vector3(-2.5, 1.7, z * 0.42);
        for (const tx of [-3.8, -1.0, 0.4]) G.chain.add(rodBetween(T, hm, new T.Vector3(tx, tx === -3.8 ? 0.3 : 1.6, z), 0.012, new T.MeshBasicMaterial({ color: 0xffb44c, transparent: true, opacity: 0.55, toneMapped: false })));
        const lbl = txt(T, s ? (o.names ? o.names[1] : '국 2') : (o.names ? o.names[0] : '국 1'), s ? '#ffd27a' : '#8ff0ff', 0.3); lbl.position.set(-7.6, 1.1, z); G.chain.add(lbl); (chainParts._lbl = chainParts._lbl || []).push(lbl);
      }
      const co = assets.getObjectByName('Correlator'); if (co) { const c = co.clone(true); c.position.set(4.2, 0, 0); G.chain.add(c); chainParts.Correlator = [c]; const c2 = co.clone(true); c2.position.set(0, 0, 0); G.corr.add(c2); }
      const names = [['피드 혼', -6.2], ['LNA', -5.0], ['하향 변환(LO)', -3.8], ['수소메이저', -2.5], ['DBBC3 · 2비트', -1.0], ['FlexBuff · VDIF', 0.4], ['광섬유 전송', 1.9], ['상관기', 4.2]];
      for (const [s, x] of names) { const l = txt(T, s, '#b8c8de', 0.2); l.position.set(x, x === 4.2 ? 2.35 : 2.15, 0); G.chain.add(l); }
      const n = 360; flowMesh = new T.InstancedMesh(new T.SphereGeometry(0.045, 8, 6), new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), n);
      flowMesh.instanceMatrix.setUsage(T.DynamicDrawUsage); const col = new T.Color();
      for (let i = 0; i < n; i++) { flowPts.push({ s: i % 2, u: (i / n) * 1.0 + (i % 7) * 0.013, band: i % 3 === 0 ? 'S' : 'X' }); col.set(i % 3 === 0 ? 0xffb44c : 0x5fe3ff); flowMesh.setColorAt(i, col); }
      G.chain.add(flowMesh);
    }
    const pathAt = (P, u) => { const L = []; let tot = 0; for (let i = 1; i < P.length; i++) { const l = P[i].distanceTo(P[i - 1]); L.push(l); tot += l; } let d = u * tot; for (let i = 1; i < P.length; i++) { if (d <= L[i - 1]) return P[i - 1].clone().lerp(P[i], d / L[i - 1]); d -= L[i - 1]; } return P[P.length - 1].clone(); };

    // ── 상관기·프린지 곡면 ──
    let surf = null, surfPeak = null; const surfG = new T.Group(); surfG.position.set(3.4, 2.6, 0.6); G.corr.add(surfG);
    function setFringe(fr) {
      FR = fr; if (surf) { surfG.remove(surf); surf.geometry.dispose(); }
      if (!fr || !fr.map || !fr.map.length) return;
      const rows = fr.map.length, RP = fr.RP, sub = 2, cols = Math.min(128, RP / sub);
      // 지연률 축은 봉우리 둘레 ±64 칸(zero-pad 된 FFT)만
      const q0 = fr.q, W = 4.6, H = 3.4;
      const geo = new T.PlaneGeometry(W, H, cols - 1, rows - 1); const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
      let amax = 0; for (const r of fr.map) for (let q = 0; q < RP; q++) amax = Math.max(amax, r.row[q]);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const q = (q0 - cols / 2 + j + RP) % RP, a = fr.map[i].row[q] / (amax || 1), k = i * cols + j;
        pos.setZ(k, a * 1.6); const c = ramp(a); col[3 * k] = c[0]; col[3 * k + 1] = c[1]; col[3 * k + 2] = c[2];
      }
      geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.computeVertexNormals();
      surf = new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: T.DoubleSide, emissive: 0x0b1f3a, emissiveIntensity: 0.4 }));
      surf.rotation.x = -Math.PI / 2; surfG.add(surf);
      if (!surfPeak) { surfPeak = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T, 'rgba(255,255,255,1)', 'rgba(255,200,90,.6)'), transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false })); surfPeak.scale.set(0.5, 0.5, 1); surfG.add(surfPeak); }
      // 봉우리 자리
      let bi = 0, bj = 0, bv = -1; for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const q = (q0 - cols / 2 + j + RP) % RP, a = fr.map[i].row[q]; if (a > bv) { bv = a; bi = i; bj = j; } }
      surfPeak.position.set(-W / 2 + W * bj / (cols - 1), 1.6 * bv / (amax || 1) + 0.12, -(H / 2 - H * bi / (rows - 1)));
      if (!surfG.userData.axes) { surfG.userData.axes = 1; const l1 = txt(T, '다중 대역 지연 →', '#8fb0d6', 0.2); l1.position.set(-W / 2 - 0.2, 0, -H / 2 - 0.25); surfG.add(l1); const l2 = txt(T, '지연률 →', '#8fb0d6', 0.2); l2.position.set(W / 2 + 0.6, 0, H / 2 + 0.1); surfG.add(l2); }
      dirty = true;
    }
    function ramp(a) { const s = [[0.02, 0.05, 0.2], [0.05, 0.35, 0.7], [0.15, 0.8, 0.85], [0.95, 0.85, 0.35], [1, 1, 0.95]]; const x = Math.max(0, Math.min(0.999, a)) * (s.length - 1), i = Math.floor(x), f = x - i; return [0, 1, 2].map((k) => s[i][k] + (s[i + 1][k] - s[i][k]) * f); }

    // ── 자산 ──
    // 잠금판이면 GLB 도 암호문 — TSX 로 풀어 parse(10-05)
    const glbLoad = (L, url, ok, _p, no) => (window.TSX && TSX.has && TSX.has(url))
      ? TSX.fetch(new URL(url, location.href).href.split('?')[0].slice(TSX.base.length)).then((b) => L.parse(b, '', ok, no || (() => {})), no || (() => {}))
      : L.load(url, ok, undefined, no);
    if (T.GLTFLoader) glbLoad(new T.GLTFLoader(), o.assetsUrl, (g) => {
      assets = g.scene;
      const e = assets.getObjectByName('Earth');
      if (e) { const ec = e.clone(true); ec.scale.setScalar(RE); ec.traverse((m) => { if (m.isMesh && m.material) { m.material.envMapIntensity = 0; if (m.material.map) m.material.map.encoding = T.sRGBEncoding; m.material.roughness = 0.9; } }); earthG.add(ec); }
      buildChain(); for (const st of ST) if (st && st.pending) ant12(st);
      dirty = true; if (o.onload) o.onload();
    }, undefined, (err) => { if (o.onerror) o.onerror(err); });

    // ── 장면 정하기 ──
    function setScan(s) {
      // s: {unix, sC(천구 단위 벡터), x1, x2, name1, name2, src, azel1:[az,el], azel2, tau_g}
      S = s;
      if (!ST[0].g) { placeStation(0, s.x1, s.name1, true); placeStation(1, s.x2, s.name2, false); if (assets) ant12(ST[1]); }
      ST[0].azel = s.azel1; ST[1].azel = s.azel2;
      if (ST[0].ant) ST[0].ant.place(s.azel1[0], s.azel1[1]); if (ST[1].ant) ST[1].ant.place(s.azel2[0], s.azel2[1]);
      earthG.rotation.y = VS.era(s.unix);
      const sh = v3(s.sC).normalize(); srcG.position.copy(sh.clone().multiplyScalar(140));
      if (srcLbl) srcG.remove(srcLbl); srcLbl = txt(T, s.src, '#ffe2a6', 3.2); srcLbl.position.set(0, 6.5, 0); srcG.add(srcLbl);
      if (beamLine) G.sky.remove(beamLine);
      beamLine = rodBetween(T, sh.clone().multiplyScalar(135), sh.clone().multiplyScalar(RE * 1.05), 0.05, ADD(0xffd27a, 0.22)); G.sky.add(beamLine);
      dirty = true;
    }
    function stationWorld(i) { const p = new T.Vector3(); if (!ST[i].g) return p; earthG.updateMatrixWorld(true); return ST[i].g.getWorldPosition(p); }
    function updGeom() {
      if (!S || !ST[0].g) return;
      const p1 = stationWorld(0), p2 = stationWorld(1), sh = v3(S.sC).normalize();
      // 경로 차: 국 2 에서 ŝ 를 따라 국 1 을 지나는 파면까지(길이 = |B·ŝ| = c·|τg|)
      const foot = p2.clone().addScaledVector(sh, sh.dot(p1.clone().sub(p2)));
      if (pathRod) G.sky.remove(pathRod); pathRod = rodBetween(T, p2, foot, 0.06, pathMat); G.sky.add(pathRod);
      if (baseRod) G.sky.remove(baseRod); baseRod = rodBetween(T, p1, p2, 0.035, baseMat); G.sky.add(baseRod);
      if (!footDot) { footDot = new T.Mesh(new T.SphereGeometry(0.12, 16, 12), new T.MeshBasicMaterial({ color: 0xffc34d, depthTest: false, toneMapped: false })); G.sky.add(footDot); }
      footDot.position.copy(foot);
      return { p1, p2, sh };
    }

    // ── 기선 해석 결과 ──
    function setSolution(sol) {
      SOL = sol; while (solG.children.length) solG.remove(solG.children[0]);
      if (!sol || !ST[1].g) return;
      const g = new T.Group(); g.position.copy(v3(ST[1].xyz, M2U)); g.quaternion.copy(frameQ(ST[1].xyz)); solG.add(g);
      const C = sol.Cenu, smax = Math.max(Math.sqrt(C[0][0]), Math.sqrt(C[1][1]), Math.sqrt(C[2][2])), K = 1.0 / Math.max(smax, 1e-4);   // 가장 큰 σ → 1 단위
      // 3×3 대칭 고유분해(야코비)
      const ev = jacobi(C); const m = new T.Matrix4();
      const ax = ev.vec.map((v) => new T.Vector3(v[0], v[2], -v[1]));      // ENU → 모형(x 동 · y 위 · z 남)
      m.makeBasis(ax[0], ax[1], ax[2]);
      const ell = new T.Mesh(new T.SphereGeometry(1, 32, 20), new T.MeshBasicMaterial({ color: 0xff7fd0, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }));
      ell.quaternion.setFromRotationMatrix(m); ell.scale.set(Math.sqrt(ev.val[0]) * K, Math.sqrt(ev.val[1]) * K, Math.sqrt(ev.val[2]) * K); ell.position.y = 1.2; g.add(ell);
      const wire = new T.LineSegments(new T.EdgesGeometry(new T.SphereGeometry(1, 16, 10)), new T.LineBasicMaterial({ color: 0xff9fe0, transparent: true, opacity: 0.4, toneMapped: false })); wire.quaternion.copy(ell.quaternion); wire.scale.copy(ell.scale); wire.position.copy(ell.position); g.add(wire);
      const arrow = (enu, color) => { const v = new T.Vector3(enu[0], enu[2], -enu[1]).multiplyScalar(K), a = new T.ArrowHelper(v.clone().normalize(), new T.Vector3(0, 1.2, 0), v.length(), color, 0.18, 0.1); a.line.material.depthTest = false; g.add(a); };
      arrow(sol.enu, 0x5fe3ff); arrow(sol.enuTrue, 0xffd27a);
      dirty = true;
    }
    function jacobi(A) {
      const a = A.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let sw = 0; sw < 30; sw++) for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue; const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
        for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
        for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
        for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
      }
      return { val: [a[0][0], a[1][1], a[2][2]].map((x) => Math.max(x, 0)), vec: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]) };
    }

    // ── UT1 Intensive(0.13.1) — 자전축 · 적도면 · 기선의 적도면 투영 · 추정한 자전각 차(크게 키워) ──
    const ut1G = new T.Group(); G.sky.add(ut1G); ut1G.visible = false; let UT = null;
    function setUT1(u) {
      UT = u; while (ut1G.children.length) ut1G.remove(ut1G.children[0]);
      if (!u || !ST[0].g) return;
      const axisM = new T.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.85, toneMapped: false });
      ut1G.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, -RE * 1.6, 0), new T.Vector3(0, RE * 1.6, 0)]), axisM));
      const np = txt(T, '자전축(북극)', '#9fd0ff', 0.55); np.position.set(0, RE * 1.68, 0); ut1G.add(np);
      const ring = new T.Mesh(new T.RingGeometry(RE * 1.0, RE * 1.012, 160), ADD(0x5fb8ff, 0.5)); ring.rotation.x = -Math.PI / 2; ut1G.add(ring);
      const p1 = stationWorld(0), p2 = stationWorld(1), q1 = new T.Vector3(p1.x, 0, p1.z), q2 = new T.Vector3(p2.x, 0, p2.z);
      const line = (a, b, c, op, r) => { const m = rodBetween(T, a, b, r || 0.05, new T.MeshBasicMaterial({ color: c, transparent: true, opacity: op, depthTest: false, toneMapped: false })); ut1G.add(m); return m; };
      line(p1, q1, 0x6b86a8, 0.6, 0.02); line(p2, q2, 0x6b86a8, 0.6, 0.02);
      line(q1, q2, 0xffffff, 0.9, 0.06);                                       // 기선의 적도면 투영 B_eq
      const rot = (v, a) => new T.Vector3(v.x * Math.cos(a) + v.z * Math.sin(a), 0, -v.x * Math.sin(a) + v.z * Math.cos(a));
      const K = u.exag;
      line(rot(q1, u.dthTrue * K), rot(q2, u.dthTrue * K), 0xffc34d, 0.95, 0.05);   // 참 자전각
      line(rot(q1, u.dthEst * K), rot(q2, u.dthEst * K), 0x5fe3ff, 0.95, 0.05);     // 추정 자전각
      // ±σ 부채꼴(기선 가운데 둘레)
      const mid = q1.clone().add(q2).multiplyScalar(0.5), r = mid.length(), a0 = Math.atan2(mid.x, mid.z), w = Math.max(u.dthSig * K, 0.004);
      const sh = new T.Shape(); sh.moveTo(0, 0); for (let k = 0; k <= 24; k++) { const a = a0 - w + 2 * w * k / 24; sh.lineTo(r * 1.08 * Math.sin(a), r * 1.08 * Math.cos(a)); } sh.lineTo(0, 0);
      const fan = new T.Mesh(new T.ShapeGeometry(sh), ADD(0x5fe3ff, 0.16)); fan.rotation.x = Math.PI / 2; fan.rotation.y = 0; fan.position.y = 0.02;
      fan.geometry.rotateX(0); ut1G.add(fan);
      dirty = true;
    }

    // ── 사진기(끌어 돌리기 · 휠) ──
    const CAM = { sky: { r: 40, th: 1.15, ph: 0.6, tgt: [0, 0, 0] }, chain: { r: 14.5, th: 1.1, ph: Math.PI / 2 + 0.22, tgt: [-1.3, 0.8, 0] }, corr: { r: 10.5, th: 1.05, ph: Math.PI / 2 + 0.35, tgt: [2.0, 1.4, 0] }, base: { r: 30, th: 1.0, ph: 0.6, tgt: [0, 0, 0] }, ut1: { r: 36, th: 0.42, ph: 0.6, tgt: [0, 0, 0] } };
    const cur = { r: 40, th: 1.15, ph: 0.6, tgt: new T.Vector3() }; let want = CAM.sky, drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; want = Object.assign({}, want, { ph: want.ph - (e.clientX - drag.x) * 0.006, th: Math.max(0.15, Math.min(2.95, want.th - (e.clientY - drag.y) * 0.006)) }); drag = { x: e.clientX, y: e.clientY }; dirty = true; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); want = Object.assign({}, want, { r: Math.max(2, Math.min(220, want.r * (1 + e.deltaY * 0.0012))) }); dirty = true; }, { passive: false });
    function setMode(m) {
      mode = m; G.sky.visible = m === 'sky' || m === 'base' || m === 'ut1'; G.chain.visible = m === 'chain'; G.corr.visible = m === 'corr';
      solG.visible = m === 'base'; ut1G.visible = m === 'ut1'; for (const w of WF) w.visible = m === 'sky';
      if (beamLine) beamLine.visible = m !== 'ut1'; srcG.visible = m !== 'ut1';
      let c = CAM[m];
      if (m === 'ut1' && ST[0].g) {                          // 북극 위에서 비스듬히 — 기선 가운데 쪽
        const p1 = stationWorld(0), p2 = stationWorld(1), mid = p1.clone().add(p2); c = Object.assign({}, c, { ph: Math.atan2(mid.z, mid.x) });
      } else if ((m === 'sky' || m === 'base') && ST[0].g) {               // 두 국 가운데를 앞에 — 전파원 쪽에서 비스듬히
        const p1 = stationWorld(0), p2 = stationWorld(1), mid = p1.clone().add(p2).normalize(), sh = S ? v3(S.sC).normalize() : mid;
        const d = mid.clone().multiplyScalar(0.55).add(sh.clone().multiplyScalar(0.45)).normalize();
        c = Object.assign({}, c, { th: Math.acos(Math.max(-1, Math.min(1, d.y))), ph: Math.atan2(d.z, d.x) });
      }
      want = c; dirty = true;
    }

    // ── 그리기 ──
    let raf = 0, last = 0, visible = true, speed = 1;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) dirty = true; }).observe(cv);
    function frame(ms) {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      const dt = Math.min(0.05, (ms - last) / 1000 || 0); last = ms;
      // 사진기 따라가기
      const k = 1 - Math.pow(0.001, dt);
      cur.r += (want.r - cur.r) * k; cur.th += (want.th - cur.th) * k;
      let dph = want.ph - cur.ph; while (dph > Math.PI) dph -= 2 * Math.PI; while (dph < -Math.PI) dph += 2 * Math.PI; cur.ph += dph * k;
      cur.tgt.lerp(new T.Vector3().fromArray(want.tgt || [0, 0, 0]), k);
      cam.position.set(cur.tgt.x + cur.r * Math.sin(cur.th) * Math.cos(cur.ph), cur.tgt.y + cur.r * Math.cos(cur.th), cur.tgt.z + cur.r * Math.sin(cur.th) * Math.sin(cur.ph)); cam.lookAt(cur.tgt);
      const tt = (ms - t0) / 1000 * speed;
      if (mode === 'sky' && S && ST[0].g) {
        const g = updGeom(); const sh = g.sh, d1 = sh.dot(g.p1), d2 = sh.dot(g.p2), span = 70, per = 7.5;
        for (let i = 0; i < WF.length; i++) {
          const ph = ((tt / per + i / WF.length) % 1), d = 34 - ph * span;
          const w = WF[i]; w.position.copy(sh.clone().multiplyScalar(d)); w.lookAt(w.position.clone().add(sh));
          w.material.opacity = 0.55 * Math.min(1, ph * 6) * Math.min(1, (1 - ph) * 6);
          // 파면이 국을 지날 때 고리가 번쩍
          for (const [j, dj] of [[0, d1], [1, d2]]) if (Math.abs(d - dj) < 0.35) flashes[j] = 1;
        }
      }
      for (let j = 0; j < 2; j++) { flashes[j] *= Math.pow(0.04, dt); ringMat[j].opacity = 0.15 + 0.8 * flashes[j]; }
      if (mode === 'chain' && flowMesh && flowPaths.length) {
        const m = new T.Matrix4();
        for (let i = 0; i < flowPts.length; i++) { const f = flowPts[i]; f.u = (f.u + dt * 0.09 * speed) % 1; const p = pathAt(flowPaths[f.s], f.u); m.makeTranslation(p.x, p.y, p.z); flowMesh.setMatrixAt(i, m); }
        flowMesh.instanceMatrix.needsUpdate = true;
      }
      if (mode === 'corr' && surfPeak) { const s = 0.45 + 0.12 * Math.sin(ms / 260); surfPeak.scale.set(s, s, 1); }
      rn.render(scene, cam); dirty = false;
    }
    raf = requestAnimationFrame(frame);
    function resize() { const w = cv.clientWidth || 600, h = cv.clientHeight || 400; rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); dirty = true; }
    resize();
    const debug = () => ({ mode, wf: WF.map((w) => [w.visible, +w.material.opacity.toFixed(2), w.position.toArray().map((v) => +v.toFixed(1))]), cam: cam.position.toArray().map((v) => +v.toFixed(1)), stations: !!ST[0].g });
    return { debug, setMode, setScan, setFringe, setSolution, setUT1, resize, setSpeed: (v) => { speed = v; }, get mode() { return mode; }, dispose() { cancelAnimationFrame(raf); rn.dispose(); } };
  }
  window.VS3D = { create };
})();
