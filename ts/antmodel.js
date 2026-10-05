/* antmodel.js — 세종 22m VLBI 안테나 실시간 모형(three.js r128 + GLTFLoader, 2026-10-04 센터장님 "블렌더로 실제 우리 세종 VLBI 안테나 모델링 ·
 *   실제 구동하는 모델 · 첨단스럽고 실제랑 똑같이"). 모형 models/sejong22m.glb 는 Blender 로 만든 것(models/build_sejong22m.py —
 *   사진·IVS 2012 제원: 지름 22 m · 성형 카세그레인 · 높이 28 m). 불러오기·돌리기·부품 빛은 공용 lib/sejong22m.js.
 *   연출: 어두운 바닥 · 방위 눈금 고리(10°/30°)와 북 표시 · 안테나 방위 바늘 · 관측 중이면 접시 축을 따라 빔(맥동) · 상태 색 고리 ·
 *   사실적 재질(PBR, 하늘 반사) · **실제 해 쪽 그림자**(밤이면 옅은 달빛) · 바닥을 흐르는 **바람 결** · 받침을 감는 **케이블 나선** ·
 *   기단에서 나가는 **데이터 줄기**(기록·전송 중이면 빛이 흐른다) · 장애 난 부품이 **붉게 빛나고** 풀리면 초록으로 사그라진다(10-04).
 *   끌면 둘러보고 · 휠 확대 · 두 번 누르면 처음 시점. 글은 캔버스에 쓰지 않는다.
 * 쓰기: const m = AntModel.create(canvas, { url: '/web/models/sejong22m.glb', ortho: '/web/models/terrain/site_ortho_core.jpg', orthoSpan: 64 (선택 — 정사영상 바닥) });
 *       m.set({ az, el, state, faults: {mount, hub, data}, hexapod, flow, wrapAz, wind: {wdir, wsp} }); m.resize();
 *   state: idle 파랑 · run 초록 · busy 호박 · halt 빨강 · off 회색
 *   faults: Sejong22m.faults(...) 결과 — 받침·구동부(ACU) · 허브(수신기·DBBC3) · 데이터 줄기(기록·전송)
 *   hexapod: 부반사경 자리 잡는 중(ACU Dio Out 0x40) · flow: 'flow' | 'idle' | 'bad' · wrapAz: ACU 방위 원값(−90~450)
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const COL = { idle: 0x58a6ff, run: 0x3fb950, busy: 0xe3b341, halt: 0xf85149, off: 0x6e7f94 };
  function ringTex(T) {                              // 방위 눈금 고리(바닥) — 10° 잔 · 30° 긴 · 북 빨강
    const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), C = S / 2;
    g.strokeStyle = 'rgba(140,190,255,.55)'; g.lineWidth = 3; g.beginPath(); g.arc(C, C, S * 0.47, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(140,190,255,.25)'; g.lineWidth = 2; g.beginPath(); g.arc(C, C, S * 0.40, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(C, C, S * 0.30, 0, Math.PI * 2); g.stroke();
    for (let a = 0; a < 360; a += 5) {
      const L = a % 30 ? (a % 10 ? 10 : 18) : 34, r0 = S * 0.47, rad = (a - 90) * D2R;
      g.strokeStyle = a === 0 ? 'rgba(255,110,100,1)' : 'rgba(160,205,255,.8)'; g.lineWidth = a % 30 ? 2 : 4;
      g.beginPath(); g.moveTo(C + r0 * Math.cos(rad), C + r0 * Math.sin(rad)); g.lineTo(C + (r0 - L) * Math.cos(rad), C + (r0 - L) * Math.sin(rad)); g.stroke();
    }
    g.fillStyle = 'rgba(255,110,100,1)'; g.beginPath(); g.moveTo(C, S * 0.005); g.lineTo(C - 16, S * 0.045); g.lineTo(C + 16, S * 0.045); g.closePath(); g.fill();
    const t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  }
  function glowTex(T) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new T.CanvasTexture(c);
  }
  // 하늘 반사(PMREM) — 위 밝은 하늘색 → 지평선 옅은 회청 → 아래 어두운 땅
  function envMap(T, rn) {
    const sc = new T.Scene(), geo = new T.SphereGeometry(10, 32, 16), cols = [];
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 10, c = new T.Color();
      if (y > 0) c.setRGB(0.55 + 0.25 * (1 - y), 0.68 + 0.18 * (1 - y), 0.88); else c.setRGB(0.18, 0.2, 0.22);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    sc.add(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
    const pm = new T.PMREMGenerator(rn); const rt = pm.fromScene(sc, 0.02); pm.dispose(); return rt.texture;
  }

  function create(canvas, opts) {
    opts = opts || {};
    const T = window.THREE, SJ = window.Sejong22m;
    if (!T || !T.GLTFLoader || !SJ) throw new Error('three.js · GLTFLoader · sejong22m.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0); rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    rn.outputEncoding = T.sRGBEncoding; rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 0.8;
    rn.shadowMap.enabled = true; rn.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene();
    scene.environment = envMap(T, rn);
    const cam = new T.PerspectiveCamera(30, 1.4, 0.5, 600);
    // 빛 — 하늘·땅 · 해(그림자, 실제 해 쪽 — 1분마다) · 뒤쪽 파란 테두리 빛(첨단 느낌)
    const hemi = new T.HemisphereLight(0xcfe3ff, 0x101828, 0.32); scene.add(hemi);
    const sun = new T.DirectionalLight(0xfff4e6, 2.8); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 180 });
    sun.shadow.bias = -0.0006; scene.add(sun); scene.add(sun.target);
    const rim = new T.DirectionalLight(0x6fb0ff, 0.9); rim.position.set(30, 20, -40); scene.add(rim);
    let sunT = -1e9, sunNow = null;
    function sunUpdate(t) {
      if (t - sunT < 60000) return;
      sunT = t; sunNow = SJ.sunLight(sun, { R: 80, center: { x: 0, y: 10, z: 0 }, base: 2.8 });
      sun.shadow.camera.updateProjectionMatrix();
      hemi.intensity = sunNow.el > 0 ? 0.32 : 0.2;
    }
    // 바닥 — 어두운 원판 · 방위 눈금 고리 · 그림자 받기
    // 바닥은 빛을 받지 않는 어두운 면 + 그림자만 얹는 면(해를 받아 밝게 뜨지 않게)
    const floor = new T.Mesh(new T.CircleGeometry(30, 96), new T.MeshBasicMaterial({ color: 0x060d1a }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const shadowF = new T.Mesh(new T.CircleGeometry(30, 96), new T.ShadowMaterial({ opacity: 0.55 }));
    shadowF.rotation.x = -Math.PI / 2; shadowF.position.y = 0.01; shadowF.receiveShadow = true; scene.add(shadowF);
    const grid = new T.PolarGridHelper(29, 24, 6, 96, 0x1f3f6e, 0x15294a); grid.position.y = 0.02; scene.add(grid);
    // 정사영상 바닥(10-04 디지털 트윈 — 가볍게): opts.ortho 의 가운데 ±29 m 를 깐다. 가장자리는 어둠으로 흐린다
    //   10-05 화질(센터장님 "정사영상 화질이 너무 안 좋은데"): 590 m 1k 판의 가운데만 잘라 100 화소로 뭉개지던 것을 ±32 m 조각
    //   (site_ortho_core.jpg · 1024 px · opts.orthoSpan 64)으로 · 톤 매핑을 빼 사진 색 그대로 · 이방성 최대
    if (opts.ortho) {
      const fade = document.createElement('canvas'); fade.width = fade.height = 128;
      const fg = fade.getContext('2d'), gr = fg.createRadialGradient(64, 64, 20, 64, 64, 64);
      gr.addColorStop(0, '#fff'); gr.addColorStop(0.7, '#bbb'); gr.addColorStop(1, '#000'); fg.fillStyle = gr; fg.fillRect(0, 0, 128, 128);
      const og = new T.CircleGeometry(29.5, 96), uv = og.attributes.uv, pp = og.attributes.position;
      const span = opts.orthoSpan || 590;                  // 무늬 한 변(m) — 조각 64 · 옛 전체 판 590
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + pp.getX(i) / span, 0.5 + pp.getY(i) / span);
      const om = new T.MeshBasicMaterial({ color: 0xb4bec8, transparent: true, alphaMap: new T.CanvasTexture(fade), depthWrite: false, toneMapped: false });
      const disc = new T.Mesh(og, om); disc.rotation.x = -Math.PI / 2; disc.position.y = 0.006; disc.visible = false; scene.add(disc);
      const put = (tex) => { tex.encoding = T.sRGBEncoding; tex.anisotropy = rn.capabilities.getMaxAnisotropy(); om.map = tex; om.needsUpdate = true; disc.visible = true; grid.material.opacity = 0.45; grid.material.transparent = true; dirty = true; };
      const u = opts.ortho;
      if (window.TSX && window.TSX.has && window.TSX.has(u)) {
        const rel = new URL(u, location.href).href.split('?')[0].slice(window.TSX.base.length);
        window.TSX.fetch(rel).then((b) => createImageBitmap(new Blob([b], { type: 'image/jpeg' }), { imageOrientation: 'flipY' }))
          .then((bm) => { const t = new T.Texture(bm); t.flipY = false; t.needsUpdate = true; put(t); }).catch(() => {});
      } else new T.TextureLoader().load(u, put, undefined, () => {});
    }
    const ring = new T.Mesh(new T.PlaneGeometry(46, 46), new T.MeshBasicMaterial({ map: ringTex(T), transparent: true, depthWrite: false, color: COL.idle }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; scene.add(ring);
    const glowM = new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
    const halo = new T.Mesh(new T.RingGeometry(21.6, 22.6, 128), glowM); halo.rotation.x = -Math.PI / 2; halo.position.y = 0.05; scene.add(halo);
    // 안테나 방위 바늘(바닥) · 빔
    const needle = new T.Mesh(new T.PlaneGeometry(0.7, 12), new T.MeshBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending }));
    needle.geometry.translate(0, 6 + 9.5, 0); needle.rotation.x = -Math.PI / 2; const needleG = new T.Group(); needleG.add(needle); needleG.position.y = 0.06; scene.add(needleG);
    const beamM = new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.0, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
    const beamG = new T.ConeGeometry(4.0, 60, 32, 1, true); beamG.translate(0, -30, 0); beamG.rotateX(-Math.PI / 2);   // 꼭지 = 원점, 넓은 쪽 +Z
    const beam = new T.Mesh(beamG, beamM); scene.add(beam);
    const glow = new T.Sprite(new T.SpriteMaterial({ map: glowTex(T), color: COL.idle, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    glow.scale.set(9, 9, 1); scene.add(glow);
    // 바람 결(바닥) — 풍향·풍속을 받으면 보인다
    const W = SJ.wind(scene, { radius: 27, y: 0.22 });

    let loadErr = null;
    const A = SJ.add(scene, { url: opts.url || '/web/models/sejong22m.glb', trunk: { az: 150, len: 17 }, wrap: true,
                              onload: () => { dirty = true; }, onerror: (e) => { loadErr = e; } });

    // 시점 — 남서쪽 조금 높은 데서(정문 사진처럼). 끌면 둘러보기
    const TH0 = 1.22, PH0 = -0.62, RAD0 = 72;
    let th = TH0, ph = PH0, rad = RAD0, sway = 0, lastUser = -1e9, drag = false, px = 0, py = 0;
    const tgt = new T.Vector3(0, 14.2, 0);
    canvas.addEventListener('pointerdown', (e) => { drag = true; px = e.clientX; py = e.clientY; lastUser = performance.now(); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = false; lastUser = performance.now(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      ph -= (e.clientX - px) * 0.008; th = Math.max(0.35, Math.min(1.5, th - (e.clientY - py) * 0.006));
      px = e.clientX; py = e.clientY; lastUser = performance.now(); dirty = true;
    });
    canvas.addEventListener('wheel', (e) => { rad = Math.max(40, Math.min(140, rad + e.deltaY * 0.05)); lastUser = performance.now(); dirty = true; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { th = TH0; ph = PH0; rad = RAD0; sway = 0; lastUser = -1e9; dirty = true; });
    let visible = true;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);

    let az = 0, el = 90, azN = 0, elN = 90, st = 'idle', col = new T.Color(COL.idle), dirty = true, last = 0, raf = 0, lw = 0, lh = 0;
    function place() {
      // 모형 기본: 고도 90°(위) · 방위 0 에서 접시 축이 남(+Z). three: 북 = −Z · 동 = +X → AZ 회전 = 180° − 방위
      A.place(azN, Math.max(0, Math.min(90, elN)));
      needleG.rotation.y = -azN * D2R;
      // 빔 — 부반사경 근처에서 접시가 보는 쪽으로
      const ax = Math.sin(azN * D2R) * Math.cos(elN * D2R), ay = Math.sin(elN * D2R), az2 = -Math.cos(azN * D2R) * Math.cos(elN * D2R);
      const d = new T.Vector3(ax, ay, az2);
      const o = new T.Vector3(0, 16.2, 0).add(d.clone().multiplyScalar(8.4));
      beam.position.copy(o); beam.lookAt(o.clone().add(d)); glow.position.copy(o);
    }
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !visible || !canvas.clientWidth) return;
      if (t - last < 33 && !dirty) return;
      const dt = Math.min(4, (t - last) / 33); last = t; dirty = false;
      const da = ((((az - azN) % 360) + 540) % 360) - 180;
      azN += da * Math.min(1, 0.08 * dt); elN += (el - elN) * Math.min(1, 0.08 * dt);
      place(); sunUpdate(t); A.tick(t); W.tick(t);
      if (!drag && t - lastUser > 6000) { sway += 0.003 * dt; ph = PH0 + 0.35 * Math.sin(sway); }
      cam.position.set(tgt.x + rad * Math.sin(th) * Math.sin(ph), tgt.y + rad * Math.cos(th) * 0.9, tgt.z + rad * Math.sin(th) * Math.cos(ph));
      cam.lookAt(tgt);
      const k = 0.5 + 0.5 * Math.sin(t / (st === 'run' ? 380 : st === 'halt' ? 170 : 900));
      glowM.opacity = 0.35 + 0.35 * k;
      beamM.opacity = st === 'run' ? 0.10 + 0.10 * k : st === 'busy' ? 0.06 + 0.05 * k : 0.0;
      glow.material.opacity = st === 'run' || st === 'busy' ? 0.5 + 0.4 * k : 0.0;
      rn.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);
    return {
      set(o) {
        if (o.az != null && isFinite(o.az)) az = ((+o.az % 360) + 360) % 360;
        if (o.el != null && isFinite(o.el)) el = +o.el;
        if (o.state && o.state !== st) {
          st = o.state; col = new T.Color(COL[st] || COL.idle);
          [ring.material, glowM, beamM, glow.material].forEach((m) => m.color.copy(col));
        }
        const s = {};
        if (o.faults) { s.mount = !!o.faults.mount; s.hub = !!o.faults.hub; s.data = !!o.faults.data; }
        if ('hexapod' in o) s.hexapod = !!o.hexapod;
        if (o.flow) s.flow = o.flow;
        if ('wrapAz' in o) s.wrapAz = o.wrapAz;
        A.status(s);
        if (o.wind) W.set(o.wind.wdir, o.wind.wsp);
        dirty = true;
      },
      resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h || (w === lw && h === lh)) return !!(w && h);
        lw = w; lh = h; rn.setSize(w, h, false); cam.aspect = w / h;
        cam.fov = w / h < 1.1 ? 36 : 30; cam.updateProjectionMatrix(); dirty = true; return true;
      },
      get ready() { return A.ready(); }, get error() { return loadErr; }, get sun() { return sunNow; },
      dispose() { cancelAnimationFrame(raf); rn.dispose(); },
    };
  }
  window.AntModel = { create, COL };
})();
