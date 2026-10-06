/* flow3d.js — 신호 흐름 3D v3(2026-10-06 센터장님 "신호 흐름 시각화가 너무 구려. 입체적이고 실체적이고 블렌더로 실물로 만들어서 다시 이쁘고 첨단스럽게").
 *   블렌더 실물 자산(models/flow/flow_assets.glb — 원본 build_flow.py)을 실제 장소처럼 놓는다. 받침대 진열은 걷었다.
 *     바깥: 세종 22 m(sejong22m.glb, 0.26 배) 기단 → 케이블 트렌치(덮개 사이로 빛) → 관측동 문·창
 *     제어실(지붕을 걷은 단면): 수소메이저 · DBBC3 · Core3H · FlexBuff · 망 랙 줄 · 천장 사다리 트레이 · 광케이블 · 바닥 비침 · 은은한 실내 조명
 *     수신기는 안테나 수신기실 안(볼 때만 둘레를 투시로 비운다) · 하늘 → 주반사면 → 부반사경 → 혼으로 빛이 모인다
 *     밖으로: 벽 관 → 바닥 덕트 → 홀로그램 지구(공중) → 대권 호 → BONN · WACO 서버 홀
 *   상태: 상태 띠(Ring_*)·장비 LED 색(정상 초록 · 대기 파랑 · 주의 호박 · 장애 빨강 맥동 · 꺼짐 어둡게), 흐를 때는 활동 LED 가 깜박인다.
 *   흐름: 빛 펄스는 실제 케이블 길(lp_*)을 따른다. 속도 = 기록·전송 속도(MB/s). 장애 마디 앞에서 멈추고 붉어진다. 기준 신호선은 1초에 한 번(1PPS).
 *   카메라: 장소를 따라 도는 자동 순회(바깥 → 수신기실 → 문 → 랙 줄 → 지구 → 상관센터) · 끌기·휠 · 두 번 누르기(처음 시점) ·
 *           마우스를 대면 그 장비가 빛나고, 누르면 다가가 아래 띠에 상세를 보인다.
 *   글은 캔버스에 쓰지 않는다 — 장비 이름·상태는 캔버스 아래 띠(labels), 상세는 그 아래 한 줄(fl-detail).
 * 쓰기: const f = Flow3D.create(canvas, labelsEl, {glb, base}); f.set(state); f.resize(); f.dispose();
 *   state = { nodes: { ant:{st, sub}, rx, maser, dbbc3, core3h, fb, net, globe, bonn, waco }, chain: 'flow'|'idle'|'off', rec: bool,
 *             xfer: { to: 'BONN'|'WACO'|null, mbs, pct }, az, el }
 *   st: 'ok' | 'idle' | 'warn' | 'bad' | 'off' · sub: 띠에 쓸 짧은 글
 *   Flow3D.fromEngine(st, live) · Flow3D.fromMini(tsl, xfer) — 운용 화면·미니앱 자료에서 state 를 만든다
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const NODES = [['ant', '안테나'], ['rx', '수신기'], ['maser', '수소메이저'], ['dbbc3', 'DBBC3'], ['core3h', 'Core3H'], ['fb', 'FlexBuff'],
                 ['net', '망·KVG2'], ['globe', '연구망'], ['bonn', 'BONN'], ['waco', 'WACO']];
  const NAME = Object.assign(Object.fromEntries(NODES), { door: '관측동 입구' });
  const DESC = {
    ant: '세종 22 m 카세그레인 — 방위·고도는 ACU 실측',
    rx: '안테나 수신기실 — S/X 코러게이트 혼 · 냉각 LNA(약 20 K) · IF 동축은 방위 감김을 지나 기단으로',
    door: '안테나 기단에서 트렌치로 온 IF 동축이 관측동 벽 아래로 들어가 오름 사다리 · 천장 트레이로',
    maser: '수소메이저 — 10 MHz·1PPS 기준(1000 s 안정도 ~1×10⁻¹⁵)을 금색 동축으로 DBBC3·FlexBuff 에',
    dbbc3: 'DBBC3 — IF 를 BBC 채널로 나누고 2비트로 표본화',
    core3h: 'Core3H — VDIF 묶음을 10 GbE 광섬유로 기록기에',
    fb: 'FlexBuff(mk6sj2) — 디스크 36칸에 VDIF 기록',
    net: 'KVG2 제어 서버 · 스위치 · 광 패치 — 벽 관을 지나 연구망으로',
    globe: '연구망 → 상관센터(e-transfer) — 대권 호',
    bonn: 'BONN 상관센터(독일 본)', waco: 'WACO 상관센터(미국 워싱턴)',
  };
  const ST_KO = { ok: '정상', idle: '대기', warn: '주의', bad: '장애', off: '꺼짐' };
  const COL = { ok: 0x35e07a, idle: 0x4a7cc0, warn: 0xffaa2a, bad: 0xff3b30, off: 0x1a2230 };
  const FLOW = 0x62d6ff, REF = 0xffc35a;
  const TOUR = ['*', 'ant', 'rx', 'door', 'maser', 'dbbc3', 'core3h', 'fb', 'net', 'globe', 'bonn', 'waco'];
  const VIEW = { ant: [0.42, 0.16], rx: [0.62, 0.20], door: [-1.0, 0.22], maser: [0.32, 0.26], dbbc3: [-0.24, 0.26], core3h: [0.24, 0.26], fb: [-0.24, 0.26],
                 net: [0.26, 0.26], globe: [-0.32, 0.16], bonn: [0.30, 0.28], waco: [-0.30, 0.28] };          // [방위 돌림, 내려다봄]
  const LINKS = [['ant', 'rx', 'chain', null], ['rx', 'dbbc3', 'chain', 'rx_dbbc3'], ['dbbc3', 'core3h', 'chain', 'dbbc3_core3h'], ['core3h', 'fb', 'rec', 'core3h_fb'],
                 ['fb', 'net', 'xfer', 'fb_net'], ['net', 'globe', 'xfer', 'net_globe'], ['globe', 'bonn', 'xbonn', 'bonn_in'], ['globe', 'waco', 'xwaco', 'waco_in'],
                 ['maser', 'dbbc3', 'ref', 'ref_dbbc3'], ['maser', 'fb', 'ref', 'ref_fb']];
  const ROW = ['maser', 'dbbc3', 'core3h', 'fb', 'net'];
  const CITY = { sj: [36.522, 127.303], bonn: [50.734, 7.099], waco: [38.920, -77.066] };
  const RX_IN = { pos: [0, 2.12, -0.2], s: 2.16 };     // 수신기실 안 자리(EL 마디 좌표, 모형 m) · 크기
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function cometTex(T, n, sharp, vert) {              // 빛 펄스 무늬(반복 — 머리는 밝고 꼬리는 흐림). vert 면 세로로
    const W = 256, c = document.createElement('canvas'); c.width = vert ? 4 : W; c.height = vert ? W : 4;
    const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    for (let k = 0; k < n; k++) {
      const x1 = (k + 0.82) * W / n, len = (W / n) * (sharp ? 0.35 : 0.7);
      const gr = vert ? g.createLinearGradient(0, x1 - len, 0, x1) : g.createLinearGradient(x1 - len, 0, x1, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.75, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = gr; if (vert) g.fillRect(0, x1 - len, 4, len); else g.fillRect(x1 - len, 0, len, 4);
    }
    const t = new T.CanvasTexture(c);
    if (vert) { t.wrapT = T.RepeatWrapping; t.wrapS = T.ClampToEdgeWrapping; } else { t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; }
    return t;
  }
  function glowTex(T) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c);
  }
  function columnTex(T) {                              // 투사 기둥(아래 밝고 위로 사라짐 · 가는 세로 줄무늬)
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    g.globalCompositeOperation = 'destination-out';
    for (let x = 0; x < 128; x += 8) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x + 4, 0, 4, 128); }
    const t = new T.CanvasTexture(c); t.wrapS = T.RepeatWrapping; t.repeat.set(6, 1); return t;
  }

  function studioEnv(T, rn) {                          // 반사용 실내 조명 환경(어두운 방 + 위 소프트박스 셋 + 뒤 차가운 빛)
    const s = new T.Scene();
    const geo = new T.SphereGeometry(40, 32, 16), col = [], pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 40, k = Math.max(0, y); col.push(0.02 + 0.10 * k, 0.03 + 0.12 * k, 0.05 + 0.16 * k); }
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    s.add(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
    const box = (x, y, z, w, h, c, I) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(c).multiplyScalar(I), side: T.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m); };
    box(-10, 18, 10, 14, 6, 0xfff1e0, 2.2); box(10, 16, 8, 12, 5, 0xdfeaff, 1.6); box(0, 12, -18, 30, 6, 0x7fb6ff, 1.0); box(0, 20, 0, 18, 18, 0xffffff, 0.6);
    const pm = new T.PMREMGenerator(rn), env = pm.fromScene(s, 0.04).texture; pm.dispose(); return env;
  }
  function latlon(T, la, lo) { const p = la * D2R, l = lo * D2R; return new T.Vector3(Math.cos(l) * Math.cos(p), Math.sin(p), -Math.sin(l) * Math.cos(p)); }
  function relOf(u) { return new URL(u, location.href).href.split('?')[0].slice(window.TSX.base.length); }


  function create(canvas, labels, opts) {
    opts = opts || {};
    const T = window.THREE;
    if (!T || !T.GLTFLoader) throw new Error('three.js · GLTFLoader 없음');
    const base = opts.base || (opts.glb ? opts.glb.replace(/[^/]*$/, '') : 'models/');
    const mobile = !!(window.matchMedia && matchMedia('(max-width: 640px)').matches) || /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    rn.setClearColor(0x000000, 0); rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
    rn.outputEncoding = T.sRGBEncoding; rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 1.0;
    rn.shadowMap.enabled = true; rn.shadowMap.type = T.PCFSoftShadowMap; rn.shadowMap.autoUpdate = false;
    const scene = new T.Scene();
    scene.environment = studioEnv(T, rn);
    canvas.addEventListener('webglcontextrestored', () => { try { scene.environment = studioEnv(T, rn); } catch (e) { /* 다음에 */ } rn.shadowMap.needsUpdate = true; }, false);   // 맥락이 이어지면(10-06)
    const cam = new T.PerspectiveCamera(30, 4, 0.05, 260);
    scene.add(new T.HemisphereLight(0xcfe0ff, 0x1c2416, 0.5));
    const key = new T.DirectionalLight(0xfff0dc, 2.3); key.position.set(-12, 26, 15); key.target.position.set(2, 0, -3); scene.add(key.target);
    key.castShadow = true; key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.03;
    Object.assign(key.shadow.camera, { left: -32, right: 32, top: 16, bottom: -16, near: 1, far: 90 }); key.shadow.camera.updateProjectionMatrix();
    scene.add(key);
    const fill = new T.DirectionalLight(0xc8dcff, 0.5); fill.position.set(12, 8, 10); scene.add(fill);
    const rim = new T.DirectionalLight(0x8fc4ff, 0.7); rim.position.set(0, 18, -6); scene.add(rim);   // 높이 — 바닥에 비친 띠가 화면에 안 들어오게
    const tex = glowTex(T);

    // ── 자산 ──
    const ST = {}, RING = {}, LED = {}, LEDB = {}, DISP = {}, PICK = [], BLOCK = [], LPT = {}, IN = {}, XR = [];
    let ready = false, globe = null, antA = null, antWrap = null, floorY = 0.15, vwDoor = null, ELN = null, rxRoom = null, roomBox = null;
    const load = (url, ok, no) => {
      const L = new T.GLTFLoader();
      if (window.TSX && TSX.has && TSX.has(url)) TSX.fetch(relOf(url)).then((b) => L.parse(b, '', ok, no), no);
      else L.load(url, ok, undefined, no);
    };
    const FC = new T.Vector2(3.1, -3.2), FR = new T.Vector2(30, 12);      // 바깥 땅이 사라지는 타원(가운데 · 반지름)
    function fadeGround(mt) {
      mt.transparent = true;
      mt.onBeforeCompile = (sh) => {
        sh.uniforms.uFc = { value: FC }; sh.uniforms.uFr = { value: FR };
        sh.vertexShader = 'varying vec2 vFw;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vFw = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = 'uniform vec2 uFc;\nuniform vec2 uFr;\nvarying vec2 vFw;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.a *= 1.0 - smoothstep(0.55, 1.0, length((vFw - uFc) / uFr));');
      };
      mt.needsUpdate = true;
    }
    load(opts.assets || base + 'flow/flow_assets.glb', (g) => {
      const root = g.scene; scene.add(root); root.updateMatrixWorld(true);
      const lpRaw = {}, faded = new Set();
      root.traverse((o) => {
        const nm = o.name || '';
        let m;
        if ((m = /^st_([a-z0-9]+)$/.exec(nm))) ST[m[1]] = o;
        else if ((m = /^lp_([a-z0-9]+_[a-z0-9]+)_(\d+)$/.exec(nm))) (lpRaw[m[1]] = lpRaw[m[1]] || []).push([+m[2], o.getWorldPosition(new T.Vector3())]);
        else if ((m = /^in_([a-z0-9]+)$/.exec(nm))) IN[m[1]] = o.getWorldPosition(new T.Vector3());
        else if (nm === 'globe_c') globe = { c: o.getWorldPosition(new T.Vector3()), r: o.getWorldScale(new T.Vector3()).x };
        else if (nm === 'ant_c') { antWrap = new T.Group(); antWrap.position.copy(o.getWorldPosition(new T.Vector3())); scene.add(antWrap); }
        else if (nm === 'vw_door') vwDoor = o.getWorldPosition(new T.Vector3());
        else if (nm === 'floor_z') floorY = o.getWorldPosition(new T.Vector3()).y;
        else if (nm === 'env_room') roomBox = new T.Box3().setFromObject(o);
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        const mt = o.material, mn = (mt && mt.name) || '';
        if (!mt) return;
        mt.envMapIntensity = 1.0;
        let q;
        if (/^Glass/.test(mn)) { Object.assign(mt, { transparent: true, opacity: mn === 'Glass_Door' ? 0.16 : 0.3, roughness: 0.04, metalness: 0.1, depthWrite: false }); mt.color.setHex(0x9fbad6); o.castShadow = false; }
        else if ((q = /^Ring_([a-z0-9]+)/.exec(mn))) { RING[q[1]] = mt; mt.toneMapped = false; o.castShadow = false; }
        else if ((q = /^LED(b?)_([a-z0-9]+)(?:_(\d+))?/.exec(mn))) {
          const k = q[2]; mt.toneMapped = false; o.castShadow = false;
          if (q[1]) { (LEDB[k] = LEDB[k] || []); if (LEDB[k].indexOf(mt) < 0) { mt.userData.ph = Math.random() * 6.28; mt.userData.sp = 5 + Math.random() * 9; LEDB[k].push(mt); } }
          else { (LED[k] = LED[k] || []); if (LED[k].indexOf(mt) < 0) LED[k].push(mt); }
        } else if ((q = /^Disp_([a-z0-9]+)/.exec(mn))) { DISP[q[1]] = mt; mt.toneMapped = false; mt.userData.c0 = mt.emissive.clone(); }
        else if (mn === 'Grass') { if (!faded.has(mt)) { fadeGround(mt); faded.add(mt); } o.castShadow = false; mt.envMapIntensity = 0.25; }
        else if (mn === 'Floor_Room') { Object.assign(mt, { transparent: true, opacity: 0.66, roughness: 0.16, metalness: 0.25 }); o.renderOrder = -1; o.castShadow = false; mt.envMapIntensity = 0.9; }   // 비침 판(아래 거울 랙이 은은히)
        else if (mn === 'Pave' || mn === 'Concrete' || mn === 'Wall_Paint' || mn === 'Wall_Inner') mt.envMapIntensity = 0.35;
        else if (mn === 'Pit_Dark') { o.visible = false; o.castShadow = false; }   // 바닥 밑 어두운 통 — 옅어지는 잔디 너머로 관측동 앞에 검은 사각형으로 비쳤다(0.15.0, 빼도 비침 판은 그대로)
        if (/^(Panel_Grey|Steel_Galv|Wall_Cut|Lamp_Room|Duct_Fiber)$/.test(mn) && /^env_/.test((o.parent && o.parent.name) || '')) o.castShadow = false;   // 천장 보·트레이·광 덕트 그림자 줄무늬 없게
        if (mn === 'Lamp_Room' || mn === 'Screen_Ops' || mn === 'Holo_Emit') { mt.toneMapped = false; o.castShadow = false; }
        let a = o; while (a && !/^(st_[a-z0-9]+|env_[a-z0-9]+)$/.test(a.name || '')) a = a.parent;   // 합친 부품 이름(st_fb__Rack_Black)은 건너뛰고 묶음까지
        if (a && a.name.startsWith('st_')) { o.userData.node = a.name.slice(3); PICK.push(o); }
        else if (a && /^env_(room|desk)$/.test(a.name)) BLOCK.push(o);
      });
      for (const k in lpRaw) LPT[k] = lpRaw[k].sort((p, q) => p[0] - q[0]).map((p) => p[1]);
      if (ST.rx) ST.rx.visible = false;                    // 안테나 모형이 오면 수신기실 안으로 옮긴다
      // 랙 줄 비침 — 바닥 아래에 거꾸로 한 벌(재질을 같이 써서 LED 도 같이 깜박인다)
      const mir = new T.Group(); mir.scale.y = -1; mir.position.y = 2 * floorY; scene.add(mir);
      for (const k of ROW) if (ST[k]) mir.add(ST[k].clone(true));
      const desk = root.getObjectByName('env_desk'); if (desk) mir.add(desk.clone(true));
      mir.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      // 제어실 은은한 조명(그림자 없음)
      for (const x of [-3.6, 1.6]) { const L = new T.PointLight(0xdbe7ff, 0.8, 10, 2); L.position.set(x, 3.0, -2.2); scene.add(L); }
      if (window.Sejong22m && antWrap) {
        antA = Sejong22m.add(scene, { url: opts.glb || base + 'sejong22m.glb', scale: 0.26, parent: antWrap, shadow: true, glow: true, envI: 0.8,
          onload: (m) => {
            ELN = m.getObjectByName('EL'); rxRoom = m.getObjectByName('Receiver_Room');
            m.traverse((o) => { if (o.isMesh && !o.userData.shell) { o.userData.node = 'ant'; PICK.push(o); } });
            if (ELN) ELN.traverse((o) => { if (o.isMesh && !o.userData.shell) { const c = o.material.clone(); c.userData.c0 = c.color.clone(); c.userData.e0 = c.emissive.clone(); o.material = c; XR.push(c); } });   // 투시용 제 재질
            if (ELN && ST.rx) {                            // 수신기 → 수신기실 안(EL 마디를 따라 움직인다)
              ELN.add(ST.rx); ST.rx.position.fromArray(RX_IN.pos); ST.rx.quaternion.identity(); ST.rx.scale.setScalar(RX_IN.s); ST.rx.visible = true;
              ST.rx.traverse((o) => { if (o.isMesh) o.castShadow = false; });
            }
            if (ELN) buildAntBeam();
            if (ready && !drag) fitAll(false); apply(); dirty = 3;   // 모형이 늦게 오면 시점을 다시 맞춘다
          } });
      }
      buildGlobe(); buildLinks(); ready = true; apply(); fitAll(true); dirty = 3;
    }, () => {});

    // ── 홀로그램 지구 · 대권 호 ──
    let gGrp = null, arcs = {}, holo = null;
    function buildGlobe() {
      if (!globe) return;
      gGrp = new T.Group(); gGrp.position.copy(globe.c); scene.add(gGrp);
      const R = globe.r, inner = new T.Group(); gGrp.add(inner);
      const em = new T.MeshStandardMaterial({ color: 0x08121f, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.35, emissive: 0xc8ecff, emissiveIntensity: 0.0,
                                              transparent: true, opacity: 0.94 });
      const sph = new T.Mesh(new T.SphereGeometry(R, 64, 40), em); sph.userData.node = 'globe'; PICK.push(sph); inner.add(sph);
      const url = opts.earth || base + 'flow/flow_earth.jpg';
      const put = (t) => { t.encoding = T.sRGBEncoding; t.anisotropy = rn.capabilities.getMaxAnisotropy(); em.emissiveMap = t; em.emissiveIntensity = 0.95; em.needsUpdate = true; dirty = 3; };
      if (window.TSX && TSX.has && TSX.has(url)) TSX.fetch(relOf(url)).then((b) => createImageBitmap(new Blob([b], { type: 'image/jpeg' }), { imageOrientation: 'flipY' })).then((bm) => { const t = new T.Texture(bm); t.flipY = false; t.needsUpdate = true; put(t); }).catch(() => {});
      else new T.TextureLoader().load(url, put);
      const add = (o) => { o.renderOrder = 2; gGrp.add(o); return o; };
      const AB = { transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false };
      add(new T.Mesh(new T.SphereGeometry(R * 1.07, 48, 32), new T.MeshBasicMaterial(Object.assign({ color: 0x2f9dff, opacity: 0.17, side: T.BackSide }, AB))));
      const gp = [];                                       // 경위선 격자(15°)
      for (let la = -75; la <= 75; la += 15) for (let k = 0; k < 72; k++) { const a1 = k * 5 * D2R, a2 = (k + 1) * 5 * D2R, r = Math.cos(la * D2R) * R * 1.012, y = Math.sin(la * D2R) * R * 1.012;
        gp.push(r * Math.cos(a1), y, r * Math.sin(a1), r * Math.cos(a2), y, r * Math.sin(a2)); }
      for (let lo = 0; lo < 180; lo += 15) for (let k = 0; k < 72; k++) { const b1 = k * 5 * D2R, b2 = (k + 1) * 5 * D2R, c = Math.cos(lo * D2R), s = Math.sin(lo * D2R);
        gp.push(Math.cos(b1) * c * R * 1.012, Math.sin(b1) * R * 1.012, Math.cos(b1) * s * R * 1.012, Math.cos(b2) * c * R * 1.012, Math.sin(b2) * R * 1.012, Math.cos(b2) * s * R * 1.012); }
      const gg = new T.BufferGeometry(); gg.setAttribute('position', new T.Float32BufferAttribute(gp, 3));
      const grid = add(new T.LineSegments(gg, new T.LineBasicMaterial(Object.assign({ color: 0x7fdcff, opacity: 0.20 }, AB))));
      const ring1 = add(new T.Mesh(new T.TorusGeometry(R * 1.30, 0.007, 6, 160), new T.MeshBasicMaterial(Object.assign({ color: 0x6fe0ff, opacity: 0.55 }, AB))));
      const ring2 = add(new T.Mesh(new T.TorusGeometry(R * 1.42, 0.005, 6, 160), new T.MeshBasicMaterial(Object.assign({ color: 0x9fe8ff, opacity: 0.32 }, AB))));
      ring1.rotation.set(1.30, 0.2, 0); ring2.rotation.set(1.75, -0.35, 0);
      const scan = add(new T.Mesh(new T.TorusGeometry(1, 0.006, 6, 128), new T.MeshBasicMaterial(Object.assign({ color: 0xbff4ff, opacity: 0.7 }, AB)))); scan.rotation.x = Math.PI / 2;
      const ch = globe.c.y - R * 0.86 - 0.18;               // 투사 기둥(투사대 위 → 지구 밑)
      const col = new T.Mesh(new T.CylinderGeometry(R * 0.50, 0.47, ch, 48, 1, true), new T.MeshBasicMaterial(Object.assign({ map: columnTex(T), color: 0x56d4ff, opacity: 0.30, side: T.DoubleSide }, AB)));
      col.position.set(globe.c.x, 0.18 + ch / 2, globe.c.z); col.renderOrder = 2; scene.add(col);
      holo = { grid, ring1, ring2, scan, col, R, em };
      // 세 도시가 다 보이게 돌린다(평균 방향 → 앞 조금 위, 북극 → 위)
      const vs = Object.values(CITY).map(([a, b]) => latlon(T, a, b)), mdir = vs.reduce((s, v) => s.add(v), new T.Vector3()).normalize();
      const N = new T.Vector3(0, 1, 0), u0 = N.clone().sub(mdir.clone().multiplyScalar(N.dot(mdir))).normalize(), r0 = new T.Vector3().crossVectors(u0, mdir);
      const f1 = new T.Vector3(0.18, 0.40, 1).normalize(), u1 = N.clone().sub(f1.clone().multiplyScalar(N.dot(f1))).normalize(), r1 = new T.Vector3().crossVectors(u1, f1);
      const A = new T.Matrix4().makeBasis(r0, u0, mdir), B = new T.Matrix4().makeBasis(r1, u1, f1);
      inner.quaternion.setFromRotationMatrix(B.multiply(A.transpose()));
      gGrp.userData.inner = inner; gGrp.updateMatrixWorld(true);
      const dot = (k, c, s) => { const p = latlon(T, ...CITY[k]).multiplyScalar(R * 1.005); const d = new T.Mesh(new T.SphereGeometry(s, 12, 8), new T.MeshBasicMaterial({ color: c, toneMapped: false })); d.position.copy(p); inner.add(d);
        const g2 = new T.Sprite(new T.SpriteMaterial({ map: tex, color: c, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.8 })); g2.scale.set(s * 10, s * 10, 1); g2.position.copy(p); inner.add(g2); return g2; };
      arcs.sjDot = dot('sj', 0x62d6ff, 0.03); arcs.bonnDot = dot('bonn', 0xffffff, 0.025); arcs.wacoDot = dot('waco', 0xffffff, 0.025);
      const wp = (k, lift) => latlon(T, ...CITY[k]).multiplyScalar(R * (lift || 1.01)).applyQuaternion(inner.quaternion).add(globe.c);
      arcs.sjW = wp('sj');
      for (const k of ['bonn', 'waco']) {
        const a = latlon(T, ...CITY.sj), b = latlon(T, ...CITY[k]), pts = [];
        const om = Math.acos(Math.min(1, a.dot(b)));
        for (let i = 0; i <= 48; i++) { const t = i / 48, s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
          pts.push(a.clone().multiplyScalar(s1).add(b.clone().multiplyScalar(s2)).normalize().multiplyScalar(R * (1.01 + 0.20 * Math.sin(Math.PI * t)))); }
        arcs[k] = { curve: new T.CatmullRomCurve3(pts), parent: inner };
        const P = wp(k), n = P.clone().sub(globe.c).normalize(), Q = IN[k];   // 공중 호 — 도시 자리에서 솟아 서버 홀 지붕 입선으로
        if (Q) { const mid = P.clone().lerp(Q, 0.5); mid.y = Math.max(P.y, Q.y) + 2.2;
          arcs[k + 'Air'] = new T.CatmullRomCurve3([P, P.clone().addScaledVector(n, 0.7), mid, Q.clone().add(new T.Vector3(0, 0.9, 0)), Q], false, 'centripetal', 0.5); }
      }
    }

    // ── 빛 선(신호 · 기준) ──
    const LK = [];
    function lightTube(curve, r, color, nPulse, parent, sharp, segs) {
      const len = curve.getLength(), geo = new T.TubeGeometry(curve, segs || Math.max(24, Math.round(len * 14)), r, 8, false);
      const t = cometTex(T, nPulse, sharp); t.repeat.set(Math.max(1, Math.round(len / 1.1)), 1);
      const m = new T.MeshBasicMaterial({ map: t, color, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new T.Mesh(geo, m); mesh.renderOrder = 3; (parent || scene).add(mesh);
      const bm = new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false, blending: T.AdditiveBlending });
      const baseM = new T.Mesh(new T.TubeGeometry(curve, Math.max(16, Math.round(len * 8)), r * 0.5, 6, false), bm); (parent || scene).add(baseM);
      const hm = new T.MeshBasicMaterial({ map: t, color, transparent: true, opacity: 0.26, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });   // 번짐(같은 질감이라 함께 흐른다)
      const halo = new T.Mesh(new T.TubeGeometry(curve, Math.max(16, Math.round(len * 8)), r * 3.0, 6, false), hm); halo.renderOrder = 3; mesh.add(halo);
      return { mesh, m, t, baseM, bm, hm, len };
    }
    const curveOf = (pts) => new T.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    function buildLinks() {
      for (const [a, b, kind, lp] of LINKS) {
        const parts = [], pts = lp && LPT[lp];
        if ((kind === 'xbonn' || kind === 'xwaco') && arcs[b]) {
          parts.push(lightTube(arcs[b].curve, 0.018, FLOW, 2, arcs[b].parent, true, 80));
          if (arcs[b + 'Air']) parts.push(lightTube(arcs[b + 'Air'], 0.03, FLOW, 3));
        }
        if (pts && pts.length > 1) {
          const p = lightTube(curveOf(pts), kind === 'ref' ? 0.016 : 0.028, kind === 'ref' ? REF : FLOW, kind === 'ref' ? 1 : 3, null, kind === 'ref');
          if (kind === 'ref') p.t.repeat.set(1, 1);
          parts.push(p);
        }
        if (kind === 'xfer' && b === 'globe' && globe && arcs.sjW && pts) {   // 투사대 → 기둥 → 지구 세종 자리
          const c = globe.c, R = globe.r, n = arcs.sjW.clone().sub(c).normalize(), st = pts[pts.length - 1];
          const below = new T.Vector3(c.x + n.x * R * 0.35, c.y - R * 1.12, c.z + n.z * R * 0.35);
          parts.push(lightTube(new T.CatmullRomCurve3([st, new T.Vector3(c.x, 0.9, c.z), below, c.clone().addScaledVector(n, R * 1.22), arcs.sjW], false, 'centripetal', 0.5), 0.024, FLOW, 2));
        }
        LK.push({ a, b, kind, parts, st: 'off', speed: 0 });
      }
    }
    function buildAntBeam() {                              // 하늘 → 주반사면 → 부반사경 → 혼(EL 마디 좌표, 모형 m — 축척은 부모가 준다)
      const lk = LK.find((l) => l.a === 'ant'); if (!lk || lk.parts.length) return;
      const cone = new T.Mesh(new T.CylinderGeometry(0.9, 10.6, 2.0, 64, 1, true), null);
      const ct = cometTex(T, 3, false, true); ct.repeat.set(1, 2);
      const cm = new T.MeshBasicMaterial({ map: ct, color: FLOW, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, side: T.DoubleSide });
      cone.material = cm; cone.position.set(0, 10.1, 0); cone.renderOrder = 3; ELN.add(cone);
      const p = lightTube(new T.LineCurve3(new T.Vector3(0, 11.1, 0), new T.Vector3(0, 5.25, 0)), 0.11, FLOW, 2, ELN, false, 32);
      lk.parts.push(p, { mesh: cone, m: cm, t: ct, bm: null, hm: null, cone: true });
      if (ready) apply();
    }

    // ── 상태 ──
    let state = null, hov = null, foc = null, dirty = 3;
    const nodeSt = {};
    function apply() {
      const s = state || { nodes: {} }, nd = s.nodes || {};
      for (const [k] of NODES) nodeSt[k] = (nd[k] && nd[k].st) || 'off';
      const order = ['ant', 'rx', 'dbbc3', 'core3h', 'fb', 'net', 'globe'];   // 앞 마디가 장애면 그 뒤로는 끊김
      let broken = -1;
      for (let i = 0; i < order.length; i++) if (nodeSt[order[i]] === 'bad') { broken = i; break; }
      const xf = s.xfer || {}, mbs = +xf.mbs || 0;
      for (const l of LK) {
        let st = 'off', sp = 0;
        if (l.kind === 'chain') { st = s.chain === 'flow' ? 'flow' : s.chain === 'idle' ? 'idle' : 'off'; sp = st === 'flow' ? 0.9 : 0.2; }
        else if (l.kind === 'rec') { st = s.rec ? 'flow' : s.chain === 'off' ? 'off' : 'idle'; sp = s.rec ? 1.5 : 0.15; }
        else if (l.kind === 'xfer') { st = xf.to ? 'flow' : 'off'; sp = 0.4 + Math.min(2.0, mbs / 110); }
        else if (l.kind === 'xbonn') { st = xf.to === 'BONN' ? 'flow' : 'off'; sp = 0.4 + Math.min(2.0, mbs / 110); }
        else if (l.kind === 'xwaco') { st = xf.to === 'WACO' ? 'flow' : 'off'; sp = 0.4 + Math.min(2.0, mbs / 110); }
        else if (l.kind === 'ref') { st = nodeSt.maser === 'bad' ? 'bad' : nodeSt.maser === 'off' ? 'off' : 'flow'; sp = 1; }
        if (l.kind !== 'ref') {
          const ia = order.indexOf(l.a), ib = order.indexOf(l.b);
          if (broken >= 0) { if (ib === broken) st = 'bad'; else if (ia >= broken && ia >= 0) st = 'off'; }
          if (nodeSt[l.b] === 'bad') st = 'bad';
        }
        l.st = st; l.speed = sp;
        for (const p of l.parts) {
          const c = st === 'bad' ? COL.bad : l.kind === 'ref' ? REF : FLOW;
          p.m.color.setHex(c); if (p.hm) p.hm.color.setHex(c);
          if (p.bm) { p.bm.color.setHex(st === 'bad' ? COL.bad : st === 'off' ? 0x22324a : c); p.bm.opacity = st === 'off' ? 0.08 : st === 'idle' ? 0.12 : 0.2; }
          p.mesh.visible = st !== 'off';
        }
      }
      if (antA && s.az != null && s.el != null) antA.place(s.az, s.el);
      if (antA && antA.status) antA.status({ mount: nodeSt.ant === 'bad' });
      if (labels) for (const [k] of NODES) {
        const el = lab[k]; if (!el) continue;
        const t = (nd[k] && nd[k].sub) || ST_KO[nodeSt[k]] || '';
        const sp = el.querySelector('span'); if (sp.textContent !== t) sp.textContent = t;
        el.className = 'fl-lab st-' + nodeSt[k] + (k === hov ? ' hov' : '') + (k === foc ? ' foc' : '');
      }
      if (labels) measure();
      showDetail(); dirty = 3;
    }
    function active(k) {
      const s = state || {}, xf = s.xfer || {};
      if (nodeSt[k] === 'off' || nodeSt[k] === 'bad') return false;
      if (k === 'rx' || k === 'dbbc3') return s.chain === 'flow';
      if (k === 'core3h') return s.chain === 'flow' || !!s.rec;
      if (k === 'fb') return !!s.rec || !!xf.to;
      if (k === 'net' || k === 'globe') return !!xf.to || nodeSt[k] === 'ok';
      if (k === 'bonn') return xf.to === 'BONN';
      if (k === 'waco') return xf.to === 'WACO';
      return nodeSt[k] === 'ok';
    }

    // ── 이름 띠 · 상세 줄(캔버스 밖) ──
    const lab = {};
    let det = null;
    if (labels) {
      labels.innerHTML = NODES.map(([k, n]) => `<div class="fl-lab" data-k="${k}"><b>${n}</b><span></span></div>`).join('');
      for (const el of labels.querySelectorAll('.fl-lab')) lab[el.dataset.k] = el;
      det = labels.nextElementSibling && labels.nextElementSibling.classList.contains('fl-detail') ? labels.nextElementSibling : null;
      if (!det) { det = document.createElement('div'); det.className = 'fl-detail'; labels.insertAdjacentElement('afterend', det); }
    }
    function showDetail() {
      if (!det) return;
      const nd = (state && state.nodes) || {}, stop = tourOn && !foc && !hov && TOUR[tourIdx] !== '*' ? TOUR[tourIdx] : null, k = foc || hov || stop;
      let h;
      if (k === 'door') h = `<b>${NAME.door}</b><span>${DESC.door}</span>`;
      else if (k) {
        const st = nodeSt[k] || 'off', sub0 = (nd[k] && nd[k].sub) || '', sub = sub0 === ST_KO[st] ? '' : sub0;
        h = `<b>${NAME[k]}</b><i class="st-${st}">${ST_KO[st]}</i>${sub ? `<em>${sub}</em>` : ''}<span>${DESC[k] || ''}</span>`;
      } else h = `<span>${tourOn ? '자동 순회 중' : '둘러보기'} — ${mobile ? '장비를 누르면 다가가 자세히 보인다 · 두 번 누르면 처음 시점' : '장비에 마우스를 대면 빛나고, 누르면 다가가 자세히 보인다 · 두 번 누르면 처음 시점'}</span>`;
      if (det.innerHTML !== h) det.innerHTML = h;
    }

    // ── 카메라(자동 순회 · 끌기 · 휠 · 누르기) ──
    let lw = 0, lh = 0, tourOn = true, tourIdx = 0, tourT0 = 0, pauseTo = 0;
    const cs = { tgt: new T.Vector3(), dist: 20, yaw: 0, pitch: 0.28 }, from = { tgt: new T.Vector3(), dist: 20, yaw: 0, pitch: 0.28 }, goal = { tgt: new T.Vector3(), dist: 20, yaw: 0, pitch: 0.28 };
    let trT = 1, trDur = 2.2, user = { yaw: 0, pitch: 0, z: 1 };
    const bbOf = (k) => {
      const b = new T.Box3();
      if (k === 'ant' && antWrap) { b.setFromObject(antWrap); if (ST.ant) b.expandByObject(ST.ant); }
      else if (k === 'rx') { if (rxRoom) { rxRoom.updateWorldMatrix(true, false); b.setFromObject(rxRoom); b.expandByScalar(0.15); } else if (ST.rx) b.setFromObject(ST.rx); }
      else if (k === 'door' && vwDoor) b.setFromCenterAndSize(vwDoor, new T.Vector3(4.6, 2.8, 4.2));
      else if (k === 'globe' && gGrp && ST.globe) { b.setFromObject(ST.globe); b.expandByPoint(gGrp.position.clone().add(new T.Vector3(0, globe.r * 1.15, 0))); }
      else if (ST[k]) b.setFromObject(ST[k]);
      return b;
    };
    const tc = new T.PerspectiveCamera(), q3 = new T.Vector3();
    const corners = (bb, out) => { if (!bb.isEmpty()) for (let i = 0; i < 8; i++) out.push(new T.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)); return out; };
    function fitPts(pts, yaw, pitch, m) {                   // 점들이 화면 가운데에 m 만큼 차게 — 비스듬한 원근에서도 맞도록 몇 번 고쳐 잡는다
      const c = pts.reduce((a, p) => a.add(p), new T.Vector3()).multiplyScalar(1 / pts.length);
      const f = new T.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const r = new T.Vector3().crossVectors(new T.Vector3(0, 1, 0), f).normalize(), u = new T.Vector3().crossVectors(f, r);
      tc.fov = cam.fov; tc.aspect = cam.aspect; tc.near = 0.05; tc.far = 500; tc.updateProjectionMatrix();
      const th = Math.tan(cam.fov * D2R / 2) * cam.aspect, tv = Math.tan(cam.fov * D2R / 2);
      let d = 0;
      for (const p of pts) { q3.copy(p).sub(c); const z = q3.dot(f); d = Math.max(d, Math.abs(q3.dot(r)) / th + z, Math.abs(q3.dot(u)) / tv + z); }
      for (let it = 0; it < 5; it++) {
        tc.position.copy(c).addScaledVector(f, d); tc.lookAt(c); tc.updateMatrixWorld();
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const p of pts) { q3.copy(p).project(tc); x0 = Math.min(x0, q3.x); x1 = Math.max(x1, q3.x); y0 = Math.min(y0, q3.y); y1 = Math.max(y1, q3.y); }
        c.addScaledVector(r, ((x0 + x1) / 2) * d * th).addScaledVector(u, ((y0 + y1) / 2) * d * tv);
        d *= Math.max((x1 - x0) / 2, (y1 - y0) / 2) / m;
      }
      return { tgt: c, dist: d, yaw, pitch };
    }
    function viewFor(k) {
      const nr = Math.max(0, Math.min(1, (3 - cam.aspect) / 1.6));    // 0 = 넓은 띠 · 1 = 휴대폰
      if (k === '*') {                                       // 넓은 띠는 정면(앞벽 너머로 랙 줄이 보이게 조금 내려다봄), 좁은 화면은 안테나 쪽에서 비스듬히
        const pts = []; for (const kk in ST) if (kk !== 'rx') corners(bbOf(kk), pts);
        if (roomBox) corners(roomBox, pts);
        if (!pts.length) return { tgt: new T.Vector3(0, 1, 0), dist: 30, yaw: 0, pitch: 0.3 };
        return fitPts(pts, -0.62 * nr, 0.20 + 0.42 * nr, 0.98);
      }
      const b = bbOf(k); if (b.isEmpty()) return null;
      const [yaw, pitch] = VIEW[k] || [0.25, 0.26];
      const v = fitPts(corners(b, []), yaw, pitch, nr > 0.5 ? 0.8 : 0.88); v.dist = Math.max(1.2, v.dist);
      const end = k === 'ant' ? 1 : k === 'waco' ? -1 : 0;   // 넓은 띠에서 줄 끝 장소는 한쪽으로 — 빈 땅 대신 이웃이 보이게
      if (end && nr < 0.5) v.tgt.x += end * 0.24 * 2 * v.dist * Math.tan(cam.fov * D2R / 2) * cam.aspect;
      return v;
    }
    function go(k, dur) {
      const v = viewFor(k); if (!v) return false;
      from.tgt.copy(cs.tgt); from.dist = cs.dist; from.yaw = cs.yaw; from.pitch = cs.pitch;
      goal.tgt.copy(v.tgt); goal.dist = v.dist; goal.yaw = v.yaw; goal.pitch = v.pitch;
      trT = 0; trDur = dur || 2.4; user = { yaw: 0, pitch: 0, z: 1 }; dirty = 3; return true;
    }
    function fitAll(snap) {
      const v = viewFor(foc || (tourOn ? TOUR[tourIdx] : '*')) || viewFor('*');
      if (!v) return;
      if (snap) { cs.tgt.copy(v.tgt); cs.dist = v.dist; cs.yaw = v.yaw; cs.pitch = v.pitch; goal.tgt.copy(v.tgt); Object.assign(goal, { dist: v.dist, yaw: v.yaw, pitch: v.pitch }); trT = 1; }
      else go(foc || TOUR[tourIdx], 0.8);
    }
    let drag = null, moved = 0, mx = -1, my = -1, pointerIn = false;
    const ray = new T.Raycaster(), ndc = new T.Vector2();
    canvas.style.touchAction = 'pan-y';                     // 휴대폰: 세로 끌기는 페이지 스크롤, 가로 끌기는 돌리기
    canvas.addEventListener('pointerdown', (e) => {         // 손가락은 앞선 move 가 없으니 누른 자리를 여기서 잡는다
      const r = canvas.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width; my = (e.clientY - r.top) / r.height;
      drag = { x: e.clientX, y: e.clientY }; moved = 0; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width; my = (e.clientY - r.top) / r.height; pointerIn = true;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        user.yaw -= dx * 0.006; user.pitch = Math.max(-0.2, Math.min(0.9, user.pitch + dy * 0.004)); pauseTo = performance.now() + 25000; dirty = 3;
      } else pickHover();
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });   // 세로로 끌어 페이지가 스크롤되면 끌기를 놓는다
    canvas.addEventListener('pointerleave', () => { pointerIn = false; if (hov) { hov = null; apply(); } });
    canvas.addEventListener('pointerup', () => {
      if (drag && moved < 5) {                                  // 누르기 — 그 장비로 다가간다
        const k = pickAt(mx, my);
        if (k) { foc = k; pauseTo = performance.now() + 30000; go(k, 1.6); apply(); }
      }
      drag = null;
    });
    canvas.addEventListener('wheel', (e) => { user.z = Math.max(0.35, Math.min(2.2, user.z * (1 + e.deltaY * 0.0012))); pauseTo = performance.now() + 25000; dirty = 3; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { foc = null; hov = null; tourOn = true; tourIdx = 0; tourT0 = performance.now(); pauseTo = 0; go('*', 1.6); apply(); });
    function pickAt(x, y) {
      if (!ready || x < 0) return null;
      ndc.set(x * 2 - 1, -(y * 2 - 1)); ray.setFromCamera(ndc, cam);
      const h = ray.intersectObjects(PICK.concat(BLOCK), false).find((z) => z.object.visible);   // 벽이 앞에 있으면 고르지 않는다
      return h && h.object.userData.node ? h.object.userData.node : null;
    }
    let lastPick = 0;
    function pickHover() {
      const t = performance.now(); if (t - lastPick < 60) return; lastPick = t;
      const k = pickAt(mx, my);
      if (k !== hov) { hov = k; canvas.style.cursor = k ? 'pointer' : 'grab'; apply(); }
    }

    // ── 이름 띠 자리(겹치면 부제를 접고, 이름도 겹치면 뒤 것을 숨긴다) ──
    const v3 = new T.Vector3(), LW = {}, LP = [];
    function measure() {
      for (const [k] of NODES) {
        const el = lab[k]; if (!el) continue;
        const sp = el.lastChild, d = sp.style.display;
        sp.style.display = 'none'; const b = el.offsetWidth; sp.style.display = ''; LW[k] = { b, s: el.offsetWidth }; sp.style.display = d;
      }
    }
    function anchor(k, out) {                               // 수신기는 안테나 안이라 이름표만 기단 오른쪽(트렌치 쪽)에
      if (k === 'rx' && ST.ant) { ST.ant.getWorldPosition(out); out.x += 2.7; return out; }
      return ST[k].getWorldPosition(out);
    }
    function placeLabels() {
      if (!labels || !lw) return;
      const nar = lw < 640; if (labels.classList.contains('narrow') !== nar) { labels.classList.toggle('narrow', nar); measure(); }
      LP.length = 0;
      NODES.forEach(([k], i) => {
        const el = lab[k]; if (!el || !ST[k]) return;
        anchor(k, v3); v3.y = 0; v3.project(cam);
        const x = (v3.x * 0.5 + 0.5) * lw;
        if (v3.z < 1 && x > -0.02 * lw && x < 1.02 * lw) LP.push({ k, i, x, el }); else el.style.visibility = 'hidden';
        el.style.left = ((x / lw) * 100).toFixed(2) + '%';
      });
      const on = (p) => p.k === hov || p.k === foc;
      LP.sort((p, q) => (on(q) - on(p)) || p.x - q.x);
      const P = [], free = (row, l, r) => P.every((z) => z[0] !== row || r + 6 <= z[1] || l >= z[2] + 6);
      for (const p of LP) {
        const row = nar ? p.i % 2 : 0, w = LW[p.k] || { b: 60, s: 60 }, wf = Math.max(w.b, w.s);
        const m = !nar && (free(row, p.x - wf / 2, p.x + wf / 2) || on(p)) ? 2 : free(row, p.x - w.b / 2, p.x + w.b / 2) || on(p) ? 1 : 0;   // 좁으면 이름만(두 줄 엇갈림)
        const sp = p.el.lastChild, d = m === 1 ? 'none' : '';
        if (sp.style.display !== d) sp.style.display = d;
        p.el.style.visibility = m ? 'visible' : 'hidden';
        if (m) { const hw = (m === 2 ? wf : w.b) / 2; P.push([row, p.x - hw, p.x + hw]); }
      }
    }

    // ── 그리기 ──
    let raf = 0, last = 0, visible = true, shadowT = 0, xr = 0;
    const XRC = new T.Color(0x8fc6ff), XRE = new T.Color(0x0b3358);
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
    const colT = new T.Color();
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !visible || !canvas.clientWidth) { last = t; return; }
      if (t - last < (mobile ? 40 : 30)) return;
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      if (ready && tourOn && !foc && t > pauseTo) {         // 자동 순회
        if (!tourT0) tourT0 = t;
        const dwell = TOUR[tourIdx] === '*' ? 7000 : TOUR[tourIdx] === 'rx' ? 6500 : 5200;
        if (t - tourT0 > dwell + trDur * 1000) { tourIdx = (tourIdx + 1) % TOUR.length; tourT0 = t; go(TOUR[tourIdx], TOUR[tourIdx] === '*' ? 2.6 : 2.2); showDetail(); }
      }
      if (foc && t > pauseTo) { foc = null; tourT0 = t; apply(); }
      if (trT < 1) {
        trT = Math.min(1, trT + dt / trDur); const e = ease(trT);
        cs.tgt.lerpVectors(from.tgt, goal.tgt, e); cs.dist = from.dist + (goal.dist - from.dist) * e;
        cs.yaw = from.yaw + (goal.yaw - from.yaw) * e; cs.pitch = from.pitch + (goal.pitch - from.pitch) * e;
      }
      const sway = Math.sin(t / 5200) * 0.05 + (pointerIn && !drag ? (mx - 0.5) * 0.05 : 0);
      const yaw = cs.yaw + user.yaw + sway, pitch = Math.max(0.02, Math.min(1.2, cs.pitch + user.pitch)), d = cs.dist * user.z;
      cam.position.set(cs.tgt.x + d * Math.sin(yaw) * Math.cos(pitch), cs.tgt.y + d * Math.sin(pitch), cs.tgt.z + d * Math.cos(yaw) * Math.cos(pitch));
      cam.lookAt(cs.tgt);
      // 수신기실 투시(수신기를 볼 때만)
      const xrT = foc === 'rx' || hov === 'rx' || (tourOn && !foc && TOUR[tourIdx] === 'rx' && trT > 0.5) ? 1 : 0;
      if (Math.abs(xr - xrT) > 0.002 && XR.length) {
        xr += (xrT - xr) * Math.min(1, dt * 3.5); if (Math.abs(xr - xrT) < 0.01) xr = xrT;
        for (const mt of XR) {                              // 둘레는 옅은 청색 유령으로, 안의 수신기만 제 빛깔
          mt.transparent = xr > 0.01; mt.opacity = 1 - 0.9 * xr; mt.depthWrite = xr < 0.4;
          mt.color.copy(mt.userData.c0).lerp(XRC, xr); mt.emissive.copy(mt.userData.e0).lerp(XRE, xr);
        }
      }
      // 빛 · LED
      const pulse = 0.5 + 0.5 * Math.sin(t / 240);
      for (const l of LK) {
        const v = l.st === 'bad' ? 0 : l.st === 'off' ? 0 : l.st === 'idle' ? 0.25 : l.speed;
        for (const p of l.parts) {
          if (!p.mesh.visible) continue;
          if (p.cone) p.t.offset.y += (v * dt) / 1.6;
          else if (l.kind === 'ref') p.t.offset.x = -((t / 1000) % 1);   // 1초에 한 번
          else p.t.offset.x -= (v * dt) / 1.1;
          const o = l.st === 'bad' ? 0.35 + 0.55 * pulse : l.st === 'idle' ? 0.35 : 0.95;
          p.m.opacity = p.cone ? o * 0.24 : o; if (p.hm) p.hm.opacity = o * 0.26;
        }
      }
      for (const [k] of NODES) {
        const st = nodeSt[k] || 'off', c = COL[st], on = k === hov || k === foc;
        const rm = RING[k];
        if (rm) { rm.emissive.setHex(c); rm.emissiveIntensity = (st === 'bad' ? 0.7 + 1.8 * pulse : st === 'off' ? 0.12 : st === 'idle' ? 0.7 : 1.6) * (on ? 2.2 : 1); }
        for (const m of LED[k] || []) { m.emissive.setHex(c); m.emissiveIntensity = st === 'bad' ? 0.5 + 2.5 * pulse : st === 'off' ? 0.05 : 2.2; }
        const act = active(k);
        for (const m of LEDB[k] || []) {
          if (!act) { m.emissive.setHex(st === 'bad' ? COL.bad : COL[st]); m.emissiveIntensity = st === 'bad' ? 0.5 + 2.5 * pulse : st === 'off' ? 0.04 : 0.5; continue; }
          const f = Math.sin(t / 1000 * m.userData.sp + m.userData.ph) + Math.sin(t / 1000 * m.userData.sp * 2.3 + 1.7 * m.userData.ph);
          m.emissive.setHex(k === 'fb' ? 0x7dffb0 : 0x6be6ff); m.emissiveIntensity = f > 0.4 ? 3.0 : 0.35;
        }
        const dm = DISP[k];
        if (dm) { colT.copy(dm.userData.c0); dm.emissive.copy(st === 'bad' ? colT.setHex(COL.bad) : colT); dm.emissiveIntensity = st === 'off' ? 0.1 : 1.4; }
      }
      if (holo) {                                           // 홀로그램 — 고리 돌고 훑는 띠가 오르내린다(도시 자리는 그대로)
        const R = holo.R, gs = nodeSt.globe || 'off', gon = gs !== 'off';
        holo.ring1.rotation.z = t / 9000; holo.ring2.rotation.z = -t / 13000; holo.grid.rotation.y = t / 30000;
        const h = Math.sin(t / 2300) * R * 0.92; holo.scan.position.y = h; const sr = Math.sqrt(Math.max(0, R * R - h * h)) * 1.02; holo.scan.scale.set(sr, sr, 1);
        holo.col.material.opacity = (gon ? 0.26 : 0.10) * (0.85 + 0.15 * Math.sin(t / 380)); holo.col.material.map.offset.x = t / 20000;
        holo.col.material.color.setHex(gs === 'bad' ? COL.bad : 0x56d4ff); holo.em.emissiveIntensity = holo.em.emissiveMap ? (gon ? 0.95 : 0.55) : 0;
      }
      if (arcs.sjDot) arcs.sjDot.material.opacity = 0.5 + 0.4 * Math.sin(t / 500);
      if (antA && antA.tick) antA.tick(t);
      if (t - shadowT > 900) { rn.shadowMap.needsUpdate = true; shadowT = t; }
      placeLabels();
      rn.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);
    return {
      set(s) { state = s; if (ready) apply(); },
      resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return false;
        if (w === lw && h === lh) return true;
        lw = w; lh = h; rn.setSize(w, h, false); cam.aspect = w / h;
        cam.fov = Math.max(10, Math.min(42, 2 * Math.atan(Math.tan(35 * D2R) / cam.aspect) / D2R));   // 가로 화각 ~70° — 넓은 띠에서도 일그러지지 않게
        cam.updateProjectionMatrix();
        if (ready) fitAll(true);
        return true;
      },
      where(k) { const b = bbOf(k); if (b.isEmpty()) return null; b.getCenter(v3).project(cam); return [(v3.x * 0.5 + 0.5) * lw, (0.5 - v3.y * 0.5) * lh]; },   // 시험용 — 장비 화면 자리(px)
      focus(k) { foc = k || null; if (k) { pauseTo = performance.now() + 30000; go(k, 1.6); } else go('*', 1.6); apply(); },
      dispose() { cancelAnimationFrame(raf); rn.dispose(); },
    };
  }

  // ── 자료 → 상태(v1 과 같은 꼴 + maser · globe) ──
  const SPEED = (s) => { const m = String(s || '').match(/([\d.]+)\s*(G|M|K)?B\/s/i); if (!m) return 0; const v = +m[1]; const u = (m[2] || 'M').toUpperCase(); return u === 'G' ? v * 1000 : u === 'K' ? v / 1000 : v; };
  function corrOf(x) { const c = String(x || '').toUpperCase(); return c.indexOf('WACO') >= 0 || c.indexOf('WASH') >= 0 ? 'WACO' : c ? 'BONN' : null; }
  function fromEngine(st, live) {
    st = st || {};
    const r = st.real || {}, real = r.mode === 'real', a = st.antenna || {}, sess = st.session || null;
    const al = (st.alerts && st.alerts.active) || [], has = (re) => al.some((x) => re.test(String((x && x.key) || '')));
    const SJ = window.Sejong22m, fl = SJ ? SJ.faults(al) : { mount: false, hub: false, data: false };
    const rts = (st.recorder && st.recorder.runtimes) || [], nrec = rts.filter((x) => x && x.on).length, rec = nrec > 0;
    const mc = r.mcast || {}, tun = r.tunnel ? !!r.tunnel.alive : !real;
    const running = !!(sess && ['RUNNING', 'ARMED', 'REC_TEST', 'SETUP', 'CROSS', 'FINISHING'].indexOf(sess.state) >= 0);
    const sig = real ? (!!mc.connected || running) : !!sess;
    const et = live && live.ok !== false && live.et, xto = et && !et.done && et.pct != null ? corrOf(et.corr) : null;
    const point = String(a.point || ''), ck = st.clock || {}, ckOk = ck.t && Date.now() / 1000 - ck.t < 900;
    const nodes = {
      ant: { st: fl.mount ? 'bad' : point.indexOf('Halt') >= 0 ? 'bad' : has(/^acu_tick_/) ? 'warn' : (a.az != null ? 'ok' : 'off'),   // tick 넘침 D-day 는 주의
             sub: a.az != null ? `${Math.round(((+a.az % 360) + 360) % 360)}° · ${Math.round(+a.el || 0)}°` : '' },
      rx: { st: has(/^(rx|tsys_nocal)/) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      maser: { st: has(/^(clock_jump|tic_fail|clock_fail)/) ? 'bad' : (ckOk || sig) ? 'ok' : 'idle', sub: ck.fmout_gps_us != null ? `GPS 차 ${(+ck.fmout_gps_us).toFixed(2)} µs` : '' },
      dbbc3: { st: has(/^(dbbc3|tsys_frozen|bbc_|setup_)/) ? 'bad' : (real ? (mc.connected ? 'ok' : 'idle') : sig ? 'ok' : 'idle'),
               sub: real && mc.connected ? '멀티캐스트 ' + Math.round(+mc.age || 0) + ' s' : '' },
      core3h: { st: has(/^core3h/) ? 'bad' : rec || sig ? 'ok' : 'idle', sub: '' },
      fb: { st: has(/^rec_capacity/) ? 'warn' : has(/^(rec_|boot_recorder)/) ? 'bad' : rec ? 'ok' : 'idle', sub: rec ? `기록 ${nrec}줄기` : '대기' },   // 용량 예보는 주의
      net: { st: has(/^tunnel_down/) || (real && !tun) ? 'bad' : xto ? 'ok' : tun ? 'idle' : 'off', sub: real ? (tun ? '터널 열림' : '터널 끊김') : '' },
      globe: { st: xto ? 'ok' : tun ? 'idle' : 'off', sub: xto ? `→ ${xto}` : '' },
      bonn: { st: xto === 'BONN' ? 'ok' : 'off', sub: xto === 'BONN' ? `${et.speed || ''} · ${Math.round(+et.pct || 0)}%` : '' },
      waco: { st: xto === 'WACO' ? 'ok' : 'off', sub: xto === 'WACO' ? `${et.speed || ''} · ${Math.round(+et.pct || 0)}%` : '' },
    };
    if (real && !tun) for (const k of ['rx', 'dbbc3', 'core3h', 'fb']) if (nodes[k].st === 'idle') nodes[k].st = 'off';
    return { nodes, chain: sig ? 'flow' : (a.az != null ? 'idle' : 'off'), rec, xfer: { to: xto, mbs: et ? SPEED(et.speed) : 0, pct: et ? +et.pct : null },
             az: a.az != null ? +a.az : null, el: a.el != null ? +a.el : null };
  }
  function fromMini(t, xfers) {
    t = t || {};
    const a = t.antenna || {}, sess = t.session || null, mc = t.mcast || {};
    const SJ = window.Sejong22m, fl = SJ ? SJ.faults(t.alerts || []) : { mount: false, hub: false, data: false, why: { hub: [], data: [] } };
    const rts = (t.recorder && t.recorder.runtimes) || [], nrec = rts.filter((x) => x && x.on).length, rec = nrec > 0;
    const running = !!(sess && ['RUNNING', 'ARMED', 'REC_TEST', 'SETUP', 'CROSS', 'FINISHING'].indexOf(sess.state) >= 0);
    const sig = !!mc.connected || running, tun = !!t.tunnel;
    const x = (xfers || []).find((v) => v && !v.done && (v.pct == null || +v.pct < 100) && (v.pct != null || v.rate_mbs != null || v.speed)) || null;
    const xto = x ? corrOf(x.corr || x.target || x.dest || x.to) : null, xmbs = x ? (isFinite(+x.rate_mbs) && x.rate_mbs != null ? +x.rate_mbs : SPEED(x.speed)) : 0;
    const xsub = x ? `${xmbs ? Math.round(xmbs) + ' MB/s' : ''}${x.pct != null ? (xmbs ? ' · ' : '') + Math.round(+x.pct) + '%' : ''}` : '';
    const point = String(a.point || ''), why = fl.why || { hub: [], data: [] }, ck = t.clock || {};
    const altxt = (t.alerts || []).map((v) => String((v && (v.title || v.key)) || '')).join(' ');
    const nodes = {
      ant: { st: fl.mount || point.indexOf('Halt') >= 0 ? 'bad' : a.az != null ? 'ok' : 'off', sub: a.az != null ? `${Math.round(((+a.az % 360) + 360) % 360)}° · ${Math.round(+a.el || 0)}°` : '' },
      rx: { st: fl.hub && /수신기|다이오드/.test((why.hub || []).join(' ')) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      maser: { st: /클럭 계단|시각비교|시계/.test(altxt) ? 'bad' : (ck.t || sig) ? 'ok' : 'idle', sub: ck.fmout_gps_us != null ? `GPS 차 ${(+ck.fmout_gps_us).toFixed(2)} µs` : '' },
      dbbc3: { st: fl.hub && /DBBC3|BBC|Tsys|채널/.test((why.hub || []).join(' ')) ? 'bad' : mc.connected ? 'ok' : 'idle', sub: mc.connected ? '멀티캐스트' : '' },
      core3h: { st: fl.hub && /Core3H/.test((why.hub || []).join(' ')) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      fb: { st: fl.data && /기록|FlexBuff|빈 스캔|용량/.test((why.data || []).join(' ')) ? 'bad' : rec ? 'ok' : 'idle', sub: rec ? `기록 ${nrec}줄기` : '대기' },
      net: { st: !tun ? 'bad' : xto ? 'ok' : 'idle', sub: tun ? '터널 열림' : '터널 끊김' },
      globe: { st: xto ? 'ok' : tun ? 'idle' : 'off', sub: xto ? `→ ${xto}` : '' },
      bonn: { st: xto === 'BONN' ? 'ok' : 'off', sub: xto === 'BONN' ? xsub : '' },
      waco: { st: xto === 'WACO' ? 'ok' : 'off', sub: xto === 'WACO' ? xsub : '' },
    };
    return { nodes, chain: sig ? 'flow' : a.az != null ? 'idle' : 'off', rec, xfer: { to: xto, mbs: xmbs, pct: x && x.pct != null ? +x.pct : null },
             az: a.az != null ? +a.az : null, el: a.el != null ? +a.el : null };
  }
  window.Flow3D = { create, fromEngine, fromMini };
})();
