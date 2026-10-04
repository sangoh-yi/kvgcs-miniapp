/* sejong22m.js — 세종 22m 실물 모형(Blender 로 만든 sejong22m.glb)을 이미 있는 three.js 장면에 얹는다.
 *   2026-10-04 센터장님 "기존 안테나 구동 관련 모형을 실물 모형으로 전면 대체 — 대시보드하고 미니앱에".
 *   쓰는 곳: ThreeStar 안테나 카드(threestar/web/antenna3d.html) · 명령 칸·미니앱 상태 칸(antmodel.js) · 운영 콘솔 3D 안테나(antenna3d.html) ·
 *            미니앱 3D 탭(miniapp/antenna3d.html) · 지금 스캔 하늘(threestar/web/sky3d.js, 작게) · 상황실 화면(wall.html).
 *   원본: threestar/web/models/build_sejong22m.py — 노드 Base(고정)·AZ(방위)·EL(고도), m 실척(높이 28 m · 고도축 16.2 m).
 *
 * 쓰기: const A = Sejong22m.add(scene, {url, scale, shadow, envI, linear, parent, trunk, wrap, onload, onerror});
 *       A.place(az, el)   — 방위(북→동)·고도(°). 불러오기 전에 불러도 되며, 다 불러오면 그 자세로 놓인다
 *       A.status({mount, hub, data, hexapod, flow, wrapAz})
 *         mount·hub·data: 참이면 그 부품이 붉게 빛난다(장애), 참 → 거짓이 되면 초록으로 잠깐 빛나고(복구) 사그라진다
 *           — 받침·구동부(ACU) · 허브(수신기·DBBC3) · 데이터 줄기(기록·전송, trunk 를 켰을 때)
 *         hexapod: 참이면 부반사경이 아직 자리 잡는 중(ACU Dio Out 0x40) — 호박색 맥동, 잡히면 초록 한 번
 *         flow: 'flow'(기록·전송 중 — 빛이 흐른다) · 'idle'(옅게) · 'bad'(멈추고 붉다) — 데이터 줄기
 *         wrapAz: ACU 방위 원값(−90~450) — 받침을 감는 나선(케이블 감김)에서 지금 자리까지 밝힌다(wrap 를 켰을 때)
 *       A.setTrunk(pts)   — 데이터 줄기 길을 바꾼다([[x, y, z], …] 모형 좌표 m — 지형 쌍둥이에서 관측동 현관까지)
 *       A.tick(ms)        — 그리기 직전에 부른다. 빛이 움직이는 중이면 참(계속 그려야 한다)
 *       A.parts.<이름>    — 이름표 자리(Object3D): feed sub dish quad bus rx elax alid yoke cone found
 *       A.ready()         — 다 불러왔는가
 *   돌리기: AZ.rotation.y = (180 − 방위)° · EL.rotation.x = (90 − 고도)° (쉼 자세가 고도 90°, three 좌표 북 −Z · 동 +X)
 *   linear: 렌더러 출력이 sRGB 가 아닐 때(sky3d) 그림 무늬를 선형으로 둔다 — 안 그러면 벽화·글씨가 어둡게 나온다
 *
 * 함께 쓰는 도구(10-04 "장애를 모형 위에 · 실제 해 그림자 · 바람"):
 *   Sejong22m.sun(ms)                       → {az, el} 세종에서 본 해(°, 근사식 — 그림자 방향용, 0.1° 안팎)
 *   Sejong22m.sunLight(light, {ms, R, center, base, minEl}) → 주광을 실제 해 쪽에 둔다(밤이면 옅은 달빛 쪽)
 *   Sejong22m.wind(scene, {radius, y, scale}) → {set(wdir, wsp), tick(ms), group} — 바닥을 흐르는 바람 결(풍향 = 불어오는 쪽)
 *   Sejong22m.faults(alerts, flags)         → {mount, hub, data, why} — 경보(키가 있으면 키, 없으면 제목)로 부품을 가른다
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const LAT = 36.5219, LON = 127.3025;
  // 이름표 자리(m, 노드 좌표 — glTF 는 Y 가 위, Blender −Y → three +Z). 부품 상자 가운데는 한가운데로 몰려 겹쳐서 부품마다 따로 잡았다
  const ANCHOR = {
    feed: ['EL', 0, 3.5, 0],          // 접시 꼭짓점 피드 덮개
    sub: ['EL', 0, 8.7, 0],           // 부반사경
    dish: ['EL', -11.2, 8.5, 0],      // 주반사면 테
    quad: ['EL', 4.2, 6.6, -4.2],     // 다리(4개 중 하나)
    bus: ['EL', 7.6, 5.5, 0],         // 뒷면 판넬 원뿔
    rx: ['EL', 0, 1.2, 2.2],          // 허브(수신기실)
    elax: ['AZ', 3.6, 16.2, 0],       // 고도축 베어링
    alid: ['AZ', 0, 10.9, 2.7],       // 방위 받침 상자
    yoke: ['AZ', -2.75, 14.2, 0.9],   // 갈래 팔
    cone: ['Base', 0, 6.0, 2.5],      // 받침 원뿔
    found: ['Base', 0, 1.8, 3.6],     // 기단 건물(벽화)
  };
  // 빛나는 부품 묶음(GLB 노드 이름)
  const GROUP = {
    mount: ['Pedestal_Cone', 'Az_Bearing', 'Alidade_Skirt', 'Alidade_Box', 'Alidade_Top', 'Yoke_L', 'Yoke_R',
            'El_Bearing_L', 'El_Bearing_R', 'El_Bearing_Cap_L', 'El_Bearing_Cap_R', 'El_CableWrap'],
    hub: ['Hub_Cabin', 'Hub_Collar', 'Feed_Cover'],
    hexapod: ['Subreflector_Housing', 'Subreflector'],
  };
  const C_BAD = 0xff4a3d, C_OK = 0x3fdc6a, C_HEX = 0xf0b43c;
  const ZC = { ccw: 0x39c5cf, n: 0xc9d1d9, cw: 0xf778ba };          // 운용 화면 케이블 구역 색(--z-ccw · --z-n · --z-cw)
  const ZC3 = { ccw: 0x1fb3c4, n: 0x4f78b0, cw: 0xe0559b };         // 흰 받침 위 나선 — 중립 회색은 흰 칠에 묻혀 강철 파랑으로

  // 테두리 빛(프레넬) — 면 가장자리가 밝은 홀로그램 껍질. 원래 면 위로 법선 방향 3 cm 띄워 겹침 깜빡임을 피한다
  function shellMat(T, color) {
    return new T.ShaderMaterial({
      uniforms: { uC: { value: new T.Color(color) }, uI: { value: 0 }, uP: { value: 0.035 } },
      vertexShader: 'uniform float uP; varying float vF;' +
        'void main(){ vec3 p = position + normal * uP; vec4 mv = modelViewMatrix * vec4(p, 1.0);' +
        ' vec3 n = normalize(normalMatrix * normal); vec3 v = normalize(-mv.xyz);' +
        ' vF = 1.0 - abs(dot(n, v)); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uC; uniform float uI; varying float vF;' +
        'void main(){ float r = pow(vF, 1.8); gl_FragColor = vec4(mix(uC, vec3(1.0), 0.18 * r), clamp((0.16 + 0.78 * r) * uI, 0.0, 0.92)); }',
      transparent: true, depthWrite: false,          // 흰 칠 위에서는 가산 빛이 하얗게 묻혀 보이지 않는다 — 보통 섞기로 물들인다
    });
  }
  // 흐르는 빛 줄(데이터 줄기·케이블 나선) — 관 표면 u(길이 0~1)를 따라 빛 마디가 움직인다
  function flowMat(T) {
    return new T.ShaderMaterial({
      uniforms: { uC: { value: new T.Color(0x58d8ff) }, uI: { value: 0.5 }, uT: { value: 0 }, uS: { value: 0.6 }, uN: { value: 9.0 } },
      vertexShader: 'varying float vU; varying float vF;' +
        'void main(){ vU = uv.x; vec4 mv = modelViewMatrix * vec4(position, 1.0);' +
        ' vec3 n = normalize(normalMatrix * normal); vF = 1.0 - abs(dot(n, normalize(-mv.xyz)));' +
        ' gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uC; uniform float uI; uniform float uT; uniform float uS; uniform float uN; varying float vU; varying float vF;' +
        'void main(){ float s = fract(vU * uN - uT * uS); float pk = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.08, 0.5, s));' +
        ' float a = (0.28 + 1.4 * pk) * (0.45 + 0.75 * vF) * uI; gl_FragColor = vec4(uC * a, 1.0); }',
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    });
  }
  // 케이블 나선 — u(0~1) = ACU 방위 −90~450. 지금 자리(uA)까지 구역 색으로 밝히고, 그 너머는 옅게
  function wrapMat(T) {
    return new T.ShaderMaterial({
      uniforms: { uA: { value: 0.5 }, uI: { value: 1 }, c1: { value: new T.Color(ZC3.ccw) }, c2: { value: new T.Color(ZC3.n) }, c3: { value: new T.Color(ZC3.cw) } },
      vertexShader: 'varying float vU; void main(){ vU = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uA; uniform float uI; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; varying float vU;' +
        'void main(){ vec3 c = vU < 0.3333 ? c1 : (vU < 0.6667 ? c2 : c3);' +
        ' float on = step(vU, uA); float tip = exp(-pow((vU - uA) * 45.0, 2.0));' +
        ' vec3 col = mix(vec3(0.16, 0.20, 0.28), c, on); col = mix(col, vec3(1.0), 0.8 * tip);' +
        ' gl_FragColor = vec4(col, (0.62 + 0.36 * on + 0.02 * tip) * uI); }',
      transparent: true, depthWrite: false,          // 흰 받침 위에 놓이니 보통 섞기 — 감긴 만큼 구역 색, 남은 쪽은 어두운 띠, 지금 자리는 흰 매듭
    });
  }

  function add(scene, o) {
    o = o || {};
    const T = window.THREE, parts = {};
    let AZN = null, ELN = null, az = 180, el = 90, ok = false, model = null;
    const G = {};                                // 묶음 → {mat, meshes, st: 'off'|'bad'|'rec'|'busy', t0}
    const want = { mount: false, hub: false, data: false, hexapod: false, flow: 'idle', wrapAz: null };
    let trunk = null, trunkM = null, wrapM = null, wrapG = null;
    function place(a, e) {
      if (a != null) az = a;
      if (e != null) el = e;
      if (!ok) return;
      AZN.rotation.y = (180 - az) * D2R; ELN.rotation.x = (90 - el) * D2R;
    }
    let trunkPath = null;
    // 데이터 줄기 길 바꾸기(10-04 디지털 트윈 — 지형 위로 관측동 현관까지). pts = [[x, y, z], …] 모형 좌표(m, x 동 · y 높이 · z −북)
    let trunk0 = null;
    function setTrunk(pts) {                    // pts 가 없으면 처음 길(기단 둘레 짧은 빛 관)로 되돌린다
      trunkPath = pts;
      if (!trunk) return;
      if (!trunk0) trunk0 = trunk.geometry;
      let g = trunk0, len = 15;
      if (pts && pts.length >= 2) {
        const curve = new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(p[0], p[1], p[2])));
        g = new T.TubeGeometry(curve, Math.max(96, pts.length * 10), 0.16, 8, false); len = curve.getLength();
      }
      if (trunk.geometry !== trunk0 && trunk.geometry !== g) trunk.geometry.dispose();
      trunk.geometry = g;
      if (G.data) for (const m of G.data.meshes) m.geometry = g;
      trunkM.uniforms.uN.value = pts ? Math.max(6, len / 1.8) : 9.0;
    }
    const api = { place, parts, ready: () => ok, status, tick, setTrunk, get model() { return model; } };
    if (!T || !T.GLTFLoader) { if (o.onerror) o.onerror(new Error('three.js · GLTFLoader 없음')); return api; }
    // 미니앱 잠금판(miniapp_lock.py)이면 window.TSX 가 암호문을 받아 풀어 준다 — 아니면 지금처럼 주소로
    const L = new T.GLTFLoader(), url = o.url || 'models/sejong22m.glb';
    const fail = (e) => { if (o.onerror) o.onerror(e); };
    const done = (g) => {
      const m = g.scene;
      m.scale.setScalar(o.scale || 1);
      m.traverse((x) => {
        if (!x.isMesh) return;
        x.castShadow = x.receiveShadow = o.shadow !== false;
        const mt = x.material;
        if (mt) { if (mt.map) mt.map.encoding = o.linear ? T.LinearEncoding : T.sRGBEncoding; mt.envMapIntensity = o.envI != null ? o.envI : 0.55; }
      });
      AZN = m.getObjectByName('AZ'); ELN = m.getObjectByName('EL');
      if (!AZN || !ELN) { if (o.onerror) o.onerror(new Error('모형에 AZ·EL 노드가 없음')); return; }
      for (const k in ANCHOR) {
        const a = ANCHOR[k], n = m.getObjectByName(a[0]);
        if (!n) continue;
        const p = new T.Object3D(); p.position.set(a[1], a[2], a[3]); n.add(p); parts[k] = p;
      }
      if (o.glow !== false) {                    // 부품 껍질(처음엔 숨김 — 장애·복구 때만 그린다)
        for (const k in GROUP) {
          const mat = shellMat(T, k === 'hexapod' ? C_HEX : C_BAD), meshes = [];
          for (const nm of GROUP[k]) {
            const n = m.getObjectByName(nm);
            if (!n) continue;
            n.traverse((x) => {
              if (!x.isMesh || x.userData.shell) return;
              const s = new T.Mesh(x.geometry, mat); s.userData.shell = true; s.renderOrder = 4; s.visible = false;
              x.add(s); meshes.push(s);
            });
          }
          G[k] = { mat, meshes, st: 'off', t0: 0 };
        }
      }
      const base = m.getObjectByName('Base') || m;
      if (o.trunk) {                             // 데이터 줄기 — 기단에서 바닥을 따라 바깥(관측동 쪽)으로 나가는 빛 관
        const ta = (o.trunk.az != null ? o.trunk.az : 150) * D2R, len = o.trunk.len || 15, side = (o.trunk.bend || 0.18);
        const pt = (r, s) => new T.Vector3(Math.sin(ta + s) * r, 0.14, -Math.cos(ta + s) * r);
        const curve = new T.CatmullRomCurve3([pt(3.7, 0), pt(3.7 + len * 0.3, side * 0.25), pt(3.7 + len * 0.65, side), pt(3.7 + len, side * 0.6)]);
        trunkM = flowMat(T);
        trunk = new T.Mesh(new T.TubeGeometry(curve, 96, 0.16, 8, false), trunkM); trunk.renderOrder = 3;
        base.add(trunk);
        G.data = { mat: shellMat(T, C_BAD), meshes: [], st: 'off', t0: 0 };
        const sh = new T.Mesh(trunk.geometry, G.data.mat); sh.visible = false; sh.renderOrder = 4; trunk.add(sh); G.data.meshes.push(sh);
      }
      if (o.wrap) {                              // 케이블 감김 — 받침 원뿔을 1.5 바퀴 도는 나선(ACU 방위 −90 → 450 이 아래 → 위)
        const y0 = 5.45, y1 = 7.35, cr = (y) => 2.55 - (y - 5.2) * (0.7 / 2.4) + 0.32;
        class Helix extends T.Curve {
          getPoint(u, v) { v = v || new T.Vector3(); const a = (-90 + 540 * u) * D2R, y = y0 + (y1 - y0) * u, r = cr(y); return v.set(Math.sin(a) * r, y, -Math.cos(a) * r); }
        }
        wrapM = wrapMat(T);
        wrapG = new T.Mesh(new T.TubeGeometry(new Helix(), 240, o.wrap.r || 0.2, 8, false), wrapM); wrapG.renderOrder = 3;
        base.add(wrapG);
      }
      model = m;
      (o.parent || scene).add(m);
      ok = true; place(); status({});
      if (trunkPath) setTrunk(trunkPath);
      if (o.onload) o.onload(m);
    };
    if (window.TSX && window.TSX.glb) window.TSX.glb(url).then((buf) => L.parse(buf, '', done, fail), fail);
    else L.load(url, done, undefined, fail);

    function setGroup(k, on, now) {
      const g = G[k];
      if (!g) return;
      if (k === 'hexapod') {
        if (on && g.st !== 'busy') { g.st = 'busy'; g.t0 = now; g.mat.uniforms.uC.value.setHex(C_HEX); }
        else if (!on && g.st === 'busy') { g.st = 'rec'; g.t0 = now; g.mat.uniforms.uC.value.setHex(C_OK); }
        return;
      }
      if (on && g.st !== 'bad') { g.st = 'bad'; g.t0 = now; g.mat.uniforms.uC.value.setHex(C_BAD); }
      else if (!on && g.st === 'bad') { g.st = 'rec'; g.t0 = now; g.mat.uniforms.uC.value.setHex(C_OK); }
    }
    function status(s) {
      s = s || {};
      for (const k of ['mount', 'hub', 'data', 'hexapod', 'flow', 'wrapAz']) if (k in s) want[k] = s[k];
      if (!ok) return;
      const now = performance.now();
      setGroup('mount', !!want.mount, now); setGroup('hub', !!want.hub, now); setGroup('hexapod', !!want.hexapod, now);
      setGroup('data', !!want.data || want.flow === 'bad', now);
      if (wrapM && want.wrapAz != null && isFinite(want.wrapAz)) wrapM.uniforms.uA.value = Math.max(0, Math.min(1, (+want.wrapAz + 90) / 540));
      if (wrapG) wrapG.visible = want.wrapAz != null && isFinite(want.wrapAz);
    }
    // 빛 움직이기 — 장애는 맥동(1.4 s), 복구는 초록이 4 s 동안 사그라짐, 부반사경 대기는 느린 호박 맥동
    function tick(t) {
      if (!ok) return false;
      let anim = false;
      for (const k in G) {
        const g = G[k], u = g.mat.uniforms.uI;
        let I = 0;
        if (g.st === 'bad') { I = 0.55 + 0.45 * Math.sin((t - g.t0) / 1400 * Math.PI * 2); anim = true; }
        else if (g.st === 'busy') { I = 0.35 + 0.3 * Math.sin((t - g.t0) / 2200 * Math.PI * 2); anim = true; }
        else if (g.st === 'rec') {
          const dur = k === 'hexapod' ? 2200 : 4000, f = (t - g.t0) / dur;
          if (f >= 1) { g.st = 'off'; I = 0; } else { I = 1.1 * (1 - f) * (1 - f); anim = true; }
        }
        u.value = I;
        const vis = I > 0.002;
        for (const m of g.meshes) m.visible = vis;
      }
      if (trunkM) {
        const f = want.flow, bad = f === 'bad' || want.data;
        trunkM.uniforms.uT.value = t / 1000;
        trunkM.uniforms.uS.value = bad ? 0 : f === 'flow' ? 0.9 : 0.12;
        trunkM.uniforms.uI.value = bad ? 0.35 : f === 'flow' ? 0.85 : 0.32;
        trunkM.uniforms.uC.value.setHex(bad ? C_BAD : 0x58d8ff);
        if (!bad) anim = true;
      }
      return anim;
    }
    return api;
  }

  // ── 해의 자리(세종) — 그림자 방향용 근사식(USNO 저정밀, 0.1° 안팎) ──
  function sun(ms, lat, lon) {
    lat = lat == null ? LAT : lat; lon = lon == null ? LON : lon;
    const d = (ms == null ? Date.now() : ms) / 86400000 + 2440587.5 - 2451545.0;
    const g = ((357.529 + 0.98560028 * d) % 360) * D2R, q = (280.459 + 0.98564736 * d) % 360;
    const Lr = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, e = (23.439 - 0.00000036 * d) * D2R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(Lr), Math.cos(Lr)), dec = Math.asin(Math.sin(e) * Math.sin(Lr));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const H = (gmst * 15 + lon) * D2R - ra, la = lat * D2R;
    const elv = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const azv = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
    return { az: ((azv / D2R) % 360 + 360) % 360, el: elv / D2R, ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
  }
  // 주광을 실제 해 쪽에(낮) — 밤에는 남동쪽 위 옅고 푸른 빛(달빛 느낌)으로 그림자는 흐리게
  function sunLight(light, o) {
    o = o || {};
    const s = sun(o.ms), R = o.R || 80, c = o.center || { x: 0, y: 0, z: 0 }, base = o.base == null ? light.intensity : o.base;
    const day = s.el > -2;
    const e = (day ? Math.max(s.el, o.minEl || 7) : 38) * D2R, a = (day ? s.az : 160) * D2R;
    light.position.set(c.x + R * Math.sin(a) * Math.cos(e), c.y + R * Math.sin(e), c.z - R * Math.cos(a) * Math.cos(e));
    if (light.target) { light.target.position.set(c.x, c.y, c.z); light.target.updateMatrixWorld(); }
    const k = day ? Math.min(1, 0.45 + 0.55 * Math.sin(Math.max(s.el, 0) * D2R * 1.6)) : 0.32;
    light.intensity = base * k;
    if (light.color) light.color.setHex(day ? (s.el < 12 ? 0xffd9a8 : 0xfff4e6) : 0xa9c2ff);
    return s;
  }

  // ── 바람 결 — 바닥 원판 위를 바람이 불어 가는 쪽으로 흐르는 가는 빛 줄(세기에 따라 수·길이·속도, 15 m/s 넘으면 호박 · 20 넘으면 빨강) ──
  function wind(scene, o) {
    o = o || {};
    const T = window.THREE, R = o.radius || 28, Y = o.y == null ? 0.3 : o.y, K = o.scale || 1, N = 220;
    const pos = new Float32Array(N * 6), col = new Float32Array(N * 6);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('color', new T.BufferAttribute(col, 3));
    const mat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false });
    const lines = new T.LineSegments(geo, mat); lines.frustumCulled = false; lines.renderOrder = 2; lines.visible = false;
    const group = new T.Group(); group.add(lines); scene.add(group);
    const P = [];
    for (let i = 0; i < N; i++) P.push({ u: Math.random() * 2 - 1, v: Math.random() * 2 - 1, life: Math.random() });
    let dir = 0, spd = 0, n = 0, last = 0, amp = 1, rgb = new T.Color(0x9fd4ff);
    function set(wdir, wsp) {
      if (wdir == null || wsp == null || !isFinite(wdir) || !isFinite(wsp)) { lines.visible = false; spd = 0; return; }
      dir = ((+wdir + 180) % 360) * D2R; spd = Math.max(0, +wsp);
      n = Math.min(N, Math.round(36 + spd * 14)); amp = Math.min(1, 0.32 + spd / 9);   // 약한 바람은 옅고 성기게
      rgb.setHex(spd >= 20 ? 0xf85149 : spd >= 15 ? 0xe3b341 : 0x9fd4ff);
      lines.visible = spd > 0.2;
    }
    function tick(t) {
      if (!lines.visible) { last = t; return false; }
      const dt = Math.min(0.1, (t - last) / 1000 || 0); last = t;
      const dx = Math.sin(dir), dz = -Math.cos(dir), px = -dz, pz = dx;          // 흐름 방향 · 가로 방향
      const v = (1.6 + spd * 1.6) * K, L = (1.6 + spd * 0.45) * K;
      for (let i = 0; i < N; i++) {
        const p = P[i], j = i * 6;
        if (i >= n) { for (let k = 0; k < 6; k++) pos[j + k] = 0; for (let k = 0; k < 6; k++) col[j + k] = 0; continue; }
        p.u += v * dt / R;
        if (p.u > 1) { p.u = -1; p.v = Math.random() * 2 - 1; }
        const r2 = p.u * p.u + p.v * p.v;
        const fade = Math.max(0, 1 - r2) * Math.min(1, (p.u + 1) * 3) * amp;
        const x = (dx * p.u + px * p.v) * R, z = (dz * p.u + pz * p.v) * R;
        pos[j] = x - dx * L; pos[j + 1] = Y; pos[j + 2] = z - dz * L; pos[j + 3] = x; pos[j + 4] = Y; pos[j + 5] = z;
        col[j] = 0; col[j + 1] = 0; col[j + 2] = 0;                              // 꼬리는 어둡게(가산이라 사라짐)
        col[j + 3] = rgb.r * fade; col[j + 4] = rgb.g * fade; col[j + 5] = rgb.b * fade;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      return true;
    }
    return { set, tick, group, get speed() { return spd; } };
  }

  // ── 경보 → 부품 — 키(운용 화면)가 있으면 키로, 없으면(미니앱은 제목만 싣는다) 제목 낱말로 ──
  //   flags: {acu, dbbc3, rec, net} — 실장비 관측 단계에서 장비 연결이 끊긴 것(거짓이면 장애로 본다). 없으면 보지 않는다
  function faults(alerts, flags) {
    const why = { mount: [], hub: [], data: [] };
    for (const a of alerts || []) {
      const k = String((a && a.key) || ''), t = String((a && (a.title || a.key)) || '');
      if (k) {
        if (/^(acu_|boot_acu|zone_|park_fail|estop|blocked)/.test(k)) why.mount.push(t);
        else if (/^(tsys_nocal|tsys_frozen|tsys_contcal|chanmap|setup_|bbc_|core3h|dbbc3|clock_|rx)/.test(k)) why.hub.push(t);   // tsys_rfi·tsys_step 은 간섭·변화 알림(장비 장애 아님)
        else if (/^(rec_|boot_recorder|tunnel_down|ops_write_fail|xfer|etrans|transfer)/.test(k)) why.data.push(t);
      } else if (/ACU|DCU|구동|Halt|tick|ZoneMode|Remote|비상 정지/.test(t)) why.mount.push(t);
      else if (/DBBC3|Core3H|수신기|다이오드|연속 캘|BBC|채널 지도|클럭/.test(t)) why.hub.push(t);
      else if (/기록|FlexBuff|전송|터널|빈 스캔|용량/.test(t)) why.data.push(t);
    }
    const f = flags || {};
    if (f.acu === false) why.mount.push('ACU 연결 없음');
    if (f.dbbc3 === false) why.hub.push('DBBC3 연결 없음');
    if (f.rec === false) why.data.push('기록기 연결 없음');
    if (f.net === false) why.data.push('KVG2 터널 끊김');
    return { mount: why.mount.length > 0, hub: why.hub.length > 0, data: why.data.length > 0, why };
  }

  window.Sejong22m = { add, sun, sunLight, wind, faults, EL_Z: 16.2, HEIGHT: 28, LAT, LON, ZONE_COLOR: ZC };
})();
