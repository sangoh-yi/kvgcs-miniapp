/* radiocam.js — 전파 카메라 모의의 3D(three.js r128, 2026-10-05). 계산은 radiocam_core.js(RCCore), 모형은 블렌더
 *   models/radiocam/rc_<장소>.glb(방·가구·숨긴 기기) · rc_device.glb(휴대폰 + 위상 배열 판).
 *   층 0 = 방·기기(휴대폰 화면 시점도 이것만 본다) · 층 1 = 점검 기기·시야·광선·결과 표지·경로·세기 지도(바깥 시점만).
 *   방 벽·천장은 안쪽 면만 보이므로 밖에서 들여다보면 가까운 벽이 사라진다. 3D 위에 글 상자는 띄우지 않는다.
 */
'use strict';
(function () {
  const C24 = 0xffb44c, C58 = 0x5fe3ff, CSUS = 0xff4f6d, CLEG = 0x3ddc97, CGH = 0x9aa8bd;
  const bandCol = (b) => (b > 4 ? C58 : C24);

  function create(cv, phoneCv, opt) {
    const T = window.THREE;
    opt = opt || {};
    const rn = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: false });
    rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    rn.outputEncoding = T.sRGBEncoding; rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 1.05;
    rn.setClearColor(0x050a14, 1);
    const prn = new T.WebGLRenderer({ canvas: phoneCv, antialias: true, alpha: false, preserveDrawingBuffer: true });
    prn.setPixelRatio(1); prn.outputEncoding = T.sRGBEncoding; prn.toneMapping = T.ACESFilmicToneMapping; prn.toneMappingExposure = 1.15;
    prn.setClearColor(0x101010, 1);
    const scene = new T.Scene();
    // 실내 환경(반사용) — 위 밝은 회백 · 아래 따뜻한 회색 공. 거울·금속·화이트보드가 새까맣지 않게. 렌더러마다 따로(문맥이 다르다)
    function envFor(r) {
      const es = new T.Scene(), g = new T.SphereGeometry(20, 32, 16), col = [], pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 20, t = (y + 1) / 2; col.push(0.35 + 0.55 * t, 0.34 + 0.55 * t, 0.32 + 0.6 * t); }
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      es.add(new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
      const pm = new T.PMREMGenerator(r), tx = pm.fromScene(es, 0.04).texture; pm.dispose(); return tx;
    }
    const ENV1 = envFor(rn), ENV2 = envFor(prn);
    scene.add(new T.HemisphereLight(0xdfe9ff, 0x2a2420, 0.75));
    const sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(3, 8, 5); scene.add(sun);
    const lamps = [new T.PointLight(0xfff3e0, 0.55, 12, 1.6), new T.PointLight(0xfff3e0, 0.45, 12, 1.6)];
    lamps.forEach((l) => scene.add(l));
    const cam = new T.PerspectiveCamera(42, 1, 0.05, 200);
    const pcam = new T.PerspectiveCamera(opt.vfov || 52, 4 / 3, 0.03, 60);   // 휴대폰 카메라
    cam.layers.enable(1); pcam.layers.set(0);
    const L1 = (o) => { o.traverse((x) => x.layers.set(1)); return o; };

    // 배경 바닥(방 밖 어둠 속 격자) — 층 1
    const grid = L1(new T.GridHelper(40, 80, 0x1a3354, 0x0f1d33)); grid.position.y = -0.002; scene.add(grid);

    let room = null, roomBox = null, devNodes = {}, SC = null;
    const helpers = L1(new T.Group()); scene.add(helpers);
    const rayG = L1(new T.Group()), resG = L1(new T.Group()), truthG = L1(new T.Group()), pathG = L1(new T.Group()), covG = L1(new T.Group()), capG = L1(new T.Group());
    [rayG, resG, truthG, pathG, covG, capG].forEach((g) => helpers.add(g));

    // 점검 기기(블렌더 모형) + 시야 원뿔
    const phone = L1(new T.Group()); scene.add(phone);
    let phoneModel = null, arr8 = [], arr16 = [];
    const fr = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0x7ff0ff, transparent: true, opacity: 0.55 }));
    phone.add(L1(fr));
    function frustum(hf, vf, d) {
      const x = Math.tan(hf / 2 * Math.PI / 180) * d, y = Math.tan(vf / 2 * Math.PI / 180) * d, c = [[x, y], [-x, y], [-x, -y], [x, -y]], v = [];
      for (const [a, b] of c) v.push(0, 0, 0, a, b, -d);
      for (let i = 0; i < 4; i++) { const [a, b] = c[i], [e, f] = c[(i + 1) % 4]; v.push(a, b, -d, e, f, -d); }
      fr.geometry.setAttribute('position', new T.Float32BufferAttribute(v, 3));
    }
    frustum(opt.hfov || 66, opt.vfov || 52, 0.7);
    const loader = T.GLTFLoader ? new T.GLTFLoader() : null;
    // 잠금판(miniapp_lock)이면 GLB 도 암호문 — TSX 로 풀어 parse 한다(10-05). 아니면 주소 그대로
    const loadGLB = (url, ok, _prog, no) => {                     // loader.load 와 같은 인자 순서
      const bad = no || (() => {});
      if (window.TSX && TSX.has && TSX.has(url)) {
        const rel = new URL(url, location.href).href.split('?')[0].slice(TSX.base.length);
        TSX.fetch(rel).then((b) => loader.parse(b, '', ok, bad), bad);
      } else loader.load(url, ok, undefined, no);
    };
    if (loader) loadGLB(opt.base + 'rc_device.glb', (g) => {
      phoneModel = g.scene; phone.add(L1(phoneModel));
      phoneModel.traverse((o) => { if (/^array8/.test(o.name)) arr8.push(o); if (/^array16/.test(o.name)) arr16.push(o); });
      setArray(opt.n || 8); dirty = true;
    });
    function setArray(n) { arr8.forEach((o) => (o.visible = n === 8)); arr16.forEach((o) => (o.visible = n === 16)); dirty = true; }

    function loadScene(sc, url) {
      SC = sc;
      return new Promise((ok, no) => {
        if (room) { scene.remove(room); room = null; }
        devNodes = {};
        if (!loader) { no(new Error('GLTFLoader 없음')); return; }
        loadGLB(url, (g) => {
          room = g.scene; scene.add(room);
          room.traverse((o) => {
            const m = /^dev_([A-Z0-9]+)/.exec(o.name || ''); if (m) (devNodes[m[1]] = devNodes[m[1]] || []).push(o);
            if (o.isMesh && o.material) { o.material.envMapIntensity = 0.6; }
          });
          const { W, H, D } = sc.room;
          roomBox = { W, H, D };
          lamps[0].position.set(W * 0.3, H - 0.15, D * 0.35); lamps[1].position.set(W * 0.7, H - 0.15, D * 0.7);
          resetView(); dirty = true; ok();
        }, undefined, (e) => no(e));
      });
    }

    // ── 바깥 시점(끌어 돌리기 · 휠 · 오른쪽 끌기 이동 · 두 번 눌러 처음) ──
    const V = { th: 0.85, ph: 0.62, r: 9, tg: new T.Vector3() };
    function resetView() {
      if (!roomBox) return; const { W, H, D } = roomBox;
      V.tg.set(W / 2, H * 0.35, D / 2); V.r = Math.max(W, D) * 1.55 + 2; V.th = 0.95; V.ph = 0.72; place();
    }
    function place() {
      const s = Math.sin(V.th);
      cam.position.set(V.tg.x + V.r * s * Math.sin(V.ph), V.tg.y + V.r * Math.cos(V.th), V.tg.z + V.r * s * Math.cos(V.ph));
      cam.lookAt(V.tg); dirty = true;
    }
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, b: e.button, sh: e.shiftKey }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.b === 2 || drag.sh) {
        const rgt = new T.Vector3().subVectors(cam.position, V.tg).cross(cam.up).normalize(), k = V.r * 0.0016;
        V.tg.addScaledVector(rgt, dx * k); V.tg.y += dy * k;
      } else { V.ph -= dx * 0.006; V.th = Math.min(1.5, Math.max(0.12, V.th - dy * 0.005)); }
      place();
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => { e.preventDefault(); V.r = Math.min(40, Math.max(1.2, V.r * Math.exp(e.deltaY * 0.0012))); place(); }, { passive: false });
    cv.addEventListener('dblclick', resetView);

    // ── 자세·경로 ──
    const PB = new T.Matrix4();
    let curPose = null;
    function poseMatrix(P) {
      PB.makeBasis(new T.Vector3(...P.r), new T.Vector3(...P.u), new T.Vector3(-P.f[0], -P.f[1], -P.f[2]));
      PB.setPosition(new T.Vector3(...P.o)); return PB;
    }
    function setPhone(P) {
      curPose = P; phone.matrixAutoUpdate = false; phone.matrix.copy(poseMatrix(P)); phone.matrixWorldNeedsUpdate = true;
      pcam.matrixAutoUpdate = false; pcam.matrix.copy(poseMatrix(P)); pcam.matrixWorldNeedsUpdate = true; pcam.updateMatrixWorld(true);
      dirty = true;
    }
    function setCaps(poses, done) {
      capG.clear();
      if (!poses.length) return;
      const pts = poses.map((P) => new T.Vector3(...P.o));
      const ln = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineDashedMaterial({ color: 0x6d86a8, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.8 }));
      ln.computeLineDistances(); capG.add(L1(ln));
      poses.forEach((P, i) => {
        const m = new T.Mesh(new T.SphereGeometry(0.035, 12, 8), new T.MeshBasicMaterial({ color: i < done ? 0x7ff0ff : 0x40506a }));
        m.position.set(...P.o); capG.add(L1(m));
      });
      dirty = true;
    }
    // ── 광선 ──
    function addRays(cap, len) {
      for (const b of cap.bands) for (const k of b.classes) for (const t of k.dets) {
        const o = new T.Vector3(...cap.pose.o), e = o.clone().addScaledVector(new T.Vector3(...t.dir), len || 4.5);
        const a = Math.min(0.85, 0.25 + 0.12 * Math.log10(Math.max(t.snr, 1)));
        const l = new T.Line(new T.BufferGeometry().setFromPoints([o, e]), new T.LineBasicMaterial({ color: bandCol(b.band), transparent: true, opacity: a }));
        l.userData = { cap: cap.ci, band: b.band, cls: k.cls }; rayG.add(L1(l));
      }
      dirty = true;
    }
    function clearRays() { rayG.clear(); dirty = true; }
    function fadeRays(k) { rayG.children.forEach((l) => { l.material.opacity *= k; }); dirty = true; }

    // ── 결과 표지(의심 = 붉은 고리 · 등록 = 초록 고리 · 허상 = 회색 구 + 진짜와 잇는 점선) ──
    let pulse = [];
    function setResults(pts) {
      resG.clear(); pulse = [];
      for (const p of pts) {
        const c = p.kind === 'suspect' ? CSUS : p.kind === 'legit' ? CLEG : CGH, pos = new T.Vector3(...p.p);
        if (p.kind === 'ghost') {
          const s = new T.Mesh(new T.SphereGeometry(0.07, 14, 10), new T.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.7 }));
          s.position.copy(pos); resG.add(L1(s));
          const ref = pts.find((q) => q.kind !== 'ghost' && q.band === p.band && q.cls === p.cls);
          if (ref) {
            const l = new T.Line(new T.BufferGeometry().setFromPoints([pos, new T.Vector3(...ref.p)]), new T.LineDashedMaterial({ color: c, dashSize: 0.06, gapSize: 0.06, transparent: true, opacity: 0.6 }));
            l.computeLineDistances(); resG.add(L1(l));
          }
        } else {
          const g = new T.Group(); g.position.copy(pos);
          const ring = new T.Mesh(new T.TorusGeometry(0.12, 0.012, 8, 40), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.95 }));
          ring.rotation.x = Math.PI / 2; g.add(ring);
          const core = new T.Mesh(new T.SphereGeometry(0.03, 14, 10), new T.MeshBasicMaterial({ color: c })); g.add(core);
          const beam = new T.Mesh(new T.CylinderGeometry(0.004, 0.004, 0.6, 6), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5 }));
          beam.position.y = 0.3; g.add(beam);
          g.userData.p = p; resG.add(L1(g)); pulse.push(ring);
        }
      }
      dirty = true;
    }
    function setTruth(on, devs) {
      truthG.clear();
      if (on) for (const d of devs) {
        if (d.on === false) continue;
        const m = new T.Mesh(new T.OctahedronGeometry(0.05), new T.MeshBasicMaterial({ color: d.legit ? 0x6dffb0 : 0xffe066, wireframe: true }));
        m.position.set(...d.pos); truthG.add(L1(m));
      }
      dirty = true;
    }
    // ── 전파 경로(직접·1·2차 반사) ──
    function showPaths(ps, band) {
      pathG.clear();
      if (!ps) { dirty = true; return; }
      const amax = Math.max(...ps.map((p) => Math.abs(p.coef * p.tau) / Math.max(0.3, pathLen(p))));
      for (const p of ps) {
        const a = Math.abs(p.coef * p.tau) / Math.max(0.3, pathLen(p)) / amax;
        if (a < 0.03) continue;
        const l = new T.Line(new T.BufferGeometry().setFromPoints(p.pts.map((q) => new T.Vector3(...q))),
          new T.LineBasicMaterial({ color: p.order === 0 ? 0xffffff : bandCol(band), transparent: true, opacity: 0.35 + 0.65 * Math.sqrt(a), depthTest: false }));
        l.renderOrder = 5;
        pathG.add(L1(l));
        for (const q of p.pts.slice(1, -1)) { const s = new T.Mesh(new T.SphereGeometry(0.02, 8, 6), new T.MeshBasicMaterial({ color: bandCol(band) })); s.position.set(...q); pathG.add(L1(s)); }
      }
      dirty = true;
    }
    const pathLen = (p) => { let s = 0; for (let i = 1; i < p.pts.length; i++) s += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1], p.pts[i][2] - p.pts[i - 1][2]); return s; };
    // ── 세기 지도(바닥 위 반투명) ──
    function setCoverage(cov, y, lo, hi) {
      covG.clear();
      if (!cov) { dirty = true; return; }
      const c = document.createElement('canvas'); c.width = cov.nx; c.height = cov.nz; const g = c.getContext('2d'), im = g.createImageData(cov.nx, cov.nz);
      for (let k = 0; k < cov.nz; k++) for (let i = 0; i < cov.nx; i++) {
        const v = Math.max(0, Math.min(1, (cov.map[k * cov.nx + i] - lo) / (hi - lo))), col = turbo(v), o = (k * cov.nx + i) * 4;
        im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = 170;
      }
      g.putImageData(im, 0, 0);
      const tx = new T.CanvasTexture(c); tx.magFilter = T.LinearFilter; tx.encoding = T.sRGBEncoding;
      const W = cov.nx * cov.step, D = cov.nz * cov.step;
      const m = new T.Mesh(new T.PlaneGeometry(W, D), new T.MeshBasicMaterial({ map: tx, transparent: true, depthWrite: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(W / 2, y, D / 2);
      covG.add(L1(m)); dirty = true;                    // 캔버스 첫 줄(z=0) = 평면 위쪽(v=1, −x 축 회전 뒤 z=0 쪽) — 기본 flipY 그대로
    }
    function turbo(t) {                                  // 무지개 대신 터보(어두운 파랑 → 노랑 → 빨강)
      const r = 34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
      const g = 23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
      const b = 27.2 + t * (3211.1 - t * (15327.97 - t * (27814 - t * (22569.18 - t * 6838.66))));
      return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
    }
    function highlight(ids) {
      for (const k in devNodes) for (const o of devNodes[k]) if (o.material && o.material.emissive) {
        if (!o.userData.e0) o.userData.e0 = o.material.emissive.clone();
        o.material.emissive.copy(ids && ids.includes(k) ? new T.Color(0x552222) : o.userData.e0);
      }
      dirty = true;
    }
    function setDevVisible(id, on) { for (const o of devNodes[id] || []) o.visible = on; dirty = true; }

    // ── 그리기 ──
    let dirty = true, wantPhone = false, last = 0;
    function resize() {
      const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
      rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
      const pw = phoneCv.clientWidth || 320, ph = phoneCv.clientHeight || 240;
      prn.setSize(pw, ph, false); pcam.aspect = pw / ph; pcam.updateProjectionMatrix(); dirty = true; wantPhone = true;
    }
    function frame(t) {
      requestAnimationFrame(frame);
      if (pulse.length) { const k = 1 + 0.12 * Math.sin(t * 0.004); pulse.forEach((r) => r.scale.set(k, k, k)); dirty = true; }
      if (!dirty && !wantPhone) return;
      if (document.hidden) return;
      if (t - last < 30) return; last = t;
      if (dirty) { scene.environment = ENV1; rn.render(scene, cam); }
      if (wantPhone && curPose) { scene.environment = ENV2; prn.render(scene, pcam); wantPhone = false; if (opt.onPhone) opt.onPhone(); }
      dirty = false;
    }
    requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    resize();
    return { loadScene, setPhone, setCaps, addRays, clearRays, fadeRays, setResults, setTruth, showPaths, setCoverage, highlight, setDevVisible, setArray, resize,
      renderPhone: () => { wantPhone = true; }, resetView, pcam, phoneCanvas: phoneCv, devNodes: () => devNodes, turbo };
  }
  window.RC3D = { create };
})();
