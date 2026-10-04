/* sejong22m.js — 세종 22m 실물 모형(Blender 로 만든 sejong22m.glb)을 이미 있는 three.js 장면에 얹는다.
 *   2026-10-04 센터장님 "기존 안테나 구동 관련 모형을 실물 모형으로 전면 대체 — 대시보드하고 미니앱에".
 *   쓰는 곳: ThreeStar 안테나 카드(threestar/web/antenna3d.html) · 운영 콘솔 3D 안테나(antenna3d.html) ·
 *            미니앱 3D 탭(miniapp/antenna3d.html) · 지금 스캔 하늘(threestar/web/sky3d.js, 작게).
 *   (명령 칸·미니앱 상태 칸의 antmodel.js 는 자기 장면을 따로 갖는 같은 모형이다.)
 *   원본: threestar/web/models/build_sejong22m.py — 노드 Base(고정)·AZ(방위)·EL(고도), m 실척(높이 28 m · 고도축 16.2 m).
 *
 * 쓰기: const A = Sejong22m.add(scene, {url, scale, shadow, envI, linear, onload, onerror});
 *       A.place(az, el)   — 방위(북→동)·고도(°). 불러오기 전에 불러도 되며, 다 불러오면 그 자세로 놓인다
 *       A.parts.<이름>    — 이름표 자리(Object3D): feed sub dish quad bus rx elax alid yoke cone found
 *       A.ready()         — 다 불러왔는가
 *   돌리기: AZ.rotation.y = (180 − 방위)° · EL.rotation.x = (90 − 고도)° (쉼 자세가 고도 90°, three 좌표 북 −Z · 동 +X)
 *   linear: 렌더러 출력이 sRGB 가 아닐 때(sky3d) 그림 무늬를 선형으로 둔다 — 안 그러면 벽화·글씨가 어둡게 나온다
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
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
  function add(scene, o) {
    o = o || {};
    const T = window.THREE, parts = {};
    let AZN = null, ELN = null, az = 180, el = 90, ok = false;
    function place(a, e) {
      if (a != null) az = a;
      if (e != null) el = e;
      if (!ok) return;
      AZN.rotation.y = (180 - az) * D2R; ELN.rotation.x = (90 - el) * D2R;
    }
    if (!T || !T.GLTFLoader) { if (o.onerror) o.onerror(new Error('three.js · GLTFLoader 없음')); return { place, parts, ready: () => false }; }
    new T.GLTFLoader().load(o.url || 'models/sejong22m.glb', (g) => {
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
      (o.parent || scene).add(m);
      ok = true; place();
      if (o.onload) o.onload(m);
    }, undefined, (e) => { if (o.onerror) o.onerror(e); });
    return { place, parts, ready: () => ok };
  }
  window.Sejong22m = { add, EL_Z: 16.2, HEIGHT: 28 };
})();
