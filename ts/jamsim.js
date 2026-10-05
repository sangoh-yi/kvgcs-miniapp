/* jamsim.js — GPS 방해전파 실시간 역추적망 모의의 3D 와 흐름(2026-10-05). 계산은 jamsim_core.js(window.JamCore).
 *   실제 장소(동경 124.3~127.6° · 북위 36.8~38.45°) 지형·위성영상 위에 위성기준점 24곳, 교란원, 선박·항공기를 놓고
 *   교란 → 전파·영향 → 감지 → VLBI 식 상관(TDOA·FDOA) → 위치 → 경보·대응을 시간 막대로 돌린다. 화면 안 모의뿐 — 실제 장비 명령은 없다.
 *   쓰기: const S = JamSim.create(canvas, { onUpdate(state), onEvent(ev), onReady() }); S.setScenario('fixed'); S.play();
 *   크기: 1 칸 = 1 km · 높이는 VE 배 과장 · 모형은 보이게 키웠다(실제 크기 아님).
 */
'use strict';
(function () {
  const D2R = Math.PI / 180, VE = 6, KN = 0.514444;

  function create(canvas, ui) {
    const T = window.THREE, JC = window.JamCore;
    ui = ui || {};
    if (!T || !JC) throw new Error('three.js · JamCore 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    rn.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); rn.outputEncoding = T.sRGBEncoding;
    rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 1.0; rn.setClearColor(0x070c16);
    const scene = new T.Scene(); scene.fog = new T.Fog(0x070c16, 420, 900);
    const cam = new T.PerspectiveCamera(42, 1, 0.5, 3000);
    scene.add(new T.HemisphereLight(0xcfe2ff, 0x16202c, 0.85));
    const sun = new T.DirectionalLight(0xfff2e0, 1.4); sun.position.set(-120, 260, 160); scene.add(sun);
    const G = {}; for (const k of ['ter', 'over', 'st', 'traffic', 'jam', 'rays', 'hyp', 'est', 'wave', 'lab']) { G[k] = new T.Group(); scene.add(G[k]); }

    const st = {
      ready: false, key: 'fixed', t: 0, play: false, speed: 10, dur: 900, lastTick: -1, lastFp: null, layer: 10, show: { hyp: true, rays: true, fp: true, lab: true },
      p: { eirpScale: 1, T: 1, sdrBw: 5e6, mpNs: 5, clock: 'ocxo', tHold: 600, clockAware: true, noise: 1, seed: 7 },
      sol: null, events: [], alerted: false, cg: null, mag: 200,
    };
    let D = null, F = null, data = null, region = null, assets = {}, tex = null;

    // ── 자료 받기(미니앱 잠금판이면 TSX 가 암호문을 풀어 준다) ──
    const base = 'models/jamsim/';
    const get = async (u, t) => {
      if (window.TSX && TSX.fetch && TSX.has && TSX.has(u)) {
        const rel = new URL(u, location.href).href.split('?')[0].slice(TSX.base.length), b = await TSX.fetch(rel);
        return t === 'json' ? JSON.parse(new TextDecoder().decode(b)) : t === 'buf' ? b : new Blob([b], { type: 'image/jpeg' });
      }
      if (t === 'img') return u;
      const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u + ' ' + r.status);
      return t === 'json' ? r.json() : r.arrayBuffer();
    };
    const loadImg = async (src) => {
      if (typeof src === 'string') { const im = new Image(); im.decoding = 'async'; im.src = src; await im.decode(); return im; }
      return await createImageBitmap(src, { imageOrientation: 'flipY' });
    };

    // ── 좌표: (위도, 경도, 해발 m) → 화면(km · 높이 VE 배) ──
    const toV = (lat, lon, hAsl) => { const e = F.enu(lat, lon, 0); return new T.Vector3(e[0] / 1000, (hAsl || 0) * VE / 1000, -e[1] / 1000); };
    const groundY = (lat, lon) => D.at(lat, lon) * VE / 1000;

    // ── 지형 + 위성영상 · 영향 지도 겹침 ──
    function buildTerrain(i16, img) {
      const nx = 260, ny = 165, geo = new T.BufferGeometry(), pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const lat = region.lat1 - j / (ny - 1) * (region.lat1 - region.lat0), lon = region.lon0 + i / (nx - 1) * (region.lon1 - region.lon0);
        const v = toV(lat, lon, D.at(lat, lon)), k = j * nx + i;
        pos[3 * k] = v.x; pos[3 * k + 1] = v.y; pos[3 * k + 2] = v.z; uv[2 * k] = i / (nx - 1); uv[2 * k + 1] = 1 - j / (ny - 1);
        if (i < nx - 1 && j < ny - 1) idx.push(k, k + nx, k + 1, k + 1, k + nx, k + nx + 1);
      }
      geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('uv', new T.BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
      tex = new T.Texture(img); tex.flipY = typeof img.close !== 'function'; tex.encoding = T.sRGBEncoding; tex.anisotropy = rn.capabilities.getMaxAnisotropy(); tex.needsUpdate = true;
      const m = new T.MeshLambertMaterial({ map: tex, color: 0xd9dee6 });
      G.ter.add(new T.Mesh(geo, m));
      // 영향 지도 — 같은 지형을 조금 띄워 투명 무늬로
      const fc = document.createElement('canvas'); fc.width = 220; fc.height = 140;
      st.fpCanvas = fc; st.fpTex = new T.CanvasTexture(fc); st.fpTex.encoding = T.sRGBEncoding; st.fpTex.magFilter = T.LinearFilter;
      const om = new T.MeshBasicMaterial({ map: st.fpTex, transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false });
      const og = geo.clone(); const p2 = og.attributes.position; for (let k = 0; k < p2.count; k++) p2.setY(k, p2.getY(k) + 0.06);
      st.fpMesh = new T.Mesh(og, om); st.fpMesh.renderOrder = 2; G.over.add(st.fpMesh);
      // 바깥 테두리
      const c = [[region.lat0, region.lon0], [region.lat0, region.lon1], [region.lat1, region.lon1], [region.lat1, region.lon0], [region.lat0, region.lon0]].map(([a, b]) => toV(a, b, 0));
      G.ter.add(new T.Line(new T.BufferGeometry().setFromPoints(c), new T.LineBasicMaterial({ color: 0x2c4f7e, transparent: true, opacity: 0.8 })));
    }

    // ── 글씨(작은 이름표 — 상자 없이) ──
    function label(txt, col, size) {
      const c = document.createElement('canvas'), g = c.getContext('2d'), fs = 46; g.font = `700 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`;
      const w = Math.ceil(g.measureText(txt).width) + 16; c.width = w; c.height = fs + 18;
      g.font = `700 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`; g.textBaseline = 'middle';
      g.lineWidth = 7; g.strokeStyle = 'rgba(4,10,20,.85)'; g.strokeText(txt, 8, c.height / 2); g.fillStyle = col; g.fillText(txt, 8, c.height / 2);
      const t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding;
      const s = new T.Sprite(new T.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
      const h = size || 3.2; s.scale.set(h * w / c.height, h, 1); s.userData.base = [h * w / c.height, h]; s.renderOrder = 5; return s;
    }

    // ── 모형 꺼내기(블렌더 자산) ──
    function model(name, scale) {
      const src = assets[name];
      const o = src ? src.clone(true) : new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: 0xffffff }));
      o.scale.setScalar(scale); return o;
    }
    function ring(r, col, op) {
      const m = new T.Mesh(new T.RingGeometry(r * 0.86, r, 48), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: op == null ? 0.9 : op, side: T.DoubleSide, depthWrite: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2; return m;
    }

    // ── 위성기준점 ──
    const SV = {};
    function buildStations() {
      for (const s of data.stations) {
        const g = new T.Group(), hAsl = s.h - 25, v = toV(s.lat, s.lon, Math.max(hAsl, D.at(s.lat, s.lon)));
        g.position.copy(v);
        const m = model('CORS', 0.32); g.add(m);
        const halo = ring(1.6, 0x4fe3c1, 0.0); halo.position.y = 0.05; g.add(halo);
        const pin = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 4, 8), new T.MeshBasicMaterial({ color: 0x4fe3c1, toneMapped: false }));
        pin.position.y = 2.2; g.add(pin);
        const lab = label(s.id, '#bfe9ff', 2.4); lab.position.set(0, 5.6, 0); G.lab.add(lab); lab.userData.follow = g;
        G.st.add(g); SV[s.id] = { g, halo, pin, lab, s };
      }
      for (const p of data.places) {
        const v = toV(p.lat, p.lon, D.at(p.lat, p.lon)); const col = p.kind === 'virtual' ? '#ff9a8a' : p.kind === 'airport' ? '#ffe28a' : '#e6eef8';
        const lab = label(p.name, col, p.kind === 'city' ? 3.6 : 2.8); lab.position.set(v.x, v.y + 4.2, v.z); G.lab.add(lab);
        if (p.rwy) { const a = toV(p.rwy[0][0], p.rwy[0][1], 10), b = toV(p.rwy[1][0], p.rwy[1][1], 10); const l = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), new T.LineBasicMaterial({ color: 0xffe28a, toneMapped: false })); G.lab.add(l); }
      }
    }

    // ── 교통(가상 — 공개 항로·뱃길을 본뜬 모의) ──
    const TR = [];
    function route(pts, v, t0) {                    // pts [[lat,lon,alt]] · v m/s · t0 시작 위치(경로 몫)
      const seg = []; let L = 0;
      for (let i = 1; i < pts.length; i++) { const d = JC.gcDist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); seg.push(d); L += d; }
      return (t) => {
        let s = ((t0 * L + v * t) % L + L) % L, i = 0;
        while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
        const f = Math.min(1, s / seg[i]), a = pts[i], b = pts[i + 1];
        return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, alt: (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * f, hd: Math.atan2((b[1] - a[1]) * Math.cos(a[0] * D2R), b[0] - a[0]) };
      };
    }
    function buildTraffic() {
      const add = (name, kind, mdl, sc, fn, alt) => {
        const g = new T.Group(), m = model(mdl, sc); g.add(m);
        const halo = ring(kind === 'air' ? 2.2 : 1.8, 0x4fe3c1, 0.0); halo.position.y = 0.1; g.add(halo);
        G.traffic.add(g); TR.push({ name, kind, g, halo, fn, alt: alt || 0, state: 'ok', js: -99 });
      };
      add('여객선(인천 → 백령)', 'sea', 'Ship_Ferry', 0.03, route([[37.455, 126.600], [37.500, 126.350], [37.620, 125.900], [37.830, 124.720], [37.960, 124.670]], 18 * KN, 0.42));
      const fish = [[37.690, 125.620], [37.650, 125.760], [37.700, 125.480], [37.620, 125.520], [37.735, 125.700]];
      fish.forEach((p, i) => add(`어선 ${i + 1}(연평도 어장)`, 'sea', 'Ship_Fishing', 0.07, route([p, [p[0] + 0.03 * Math.cos(i), p[1] + 0.05 * Math.sin(i + 1)], p], 3 * KN, i / 5)));
      add('여객기 도착(서쪽 → 인천)', 'air', 'Aircraft', 0.045, route([[37.30, 124.50, 3500], [37.33, 125.60, 2400], [37.38, 126.53, 900], [37.4567, 126.4500, 50]], 130, 0.2));
      add('여객기 도착(남쪽 → 인천)', 'air', 'Aircraft', 0.045, route([[36.85, 126.20, 3500], [37.20, 126.62, 1800], [37.38, 126.53, 900], [37.4567, 126.4500, 50]], 130, 0.55));
      add('여객기 출발(인천 → 북서)', 'air', 'Aircraft', 0.045, route([[37.4851, 126.4231, 100], [37.62, 126.15, 1500], [37.90, 125.60, 3500], [38.30, 124.80, 4500]], 140, 0.1));
      add('여객기 출발(인천 → 서쪽)', 'air', 'Aircraft', 0.045, route([[37.4851, 126.4231, 100], [37.50, 125.90, 2000], [37.45, 124.60, 4000]], 140, 0.6));
      // 해경 경비정(인천 · 연평도) — 경보 뒤 추정 위치로
      for (const [nm, p] of [['해경 경비정(연평도)', [37.655, 125.715]], ['해경 경비정(인천)', [37.445, 126.585]]]) {
        const g = new T.Group(); g.add(model('Ship_CG', 0.05)); G.traffic.add(g);
        TR.push({ name: nm, kind: 'cg', g, halo: null, lat: p[0], lon: p[1], home: p.slice(), state: 'ok', js: -99, go: false });
      }
    }

    // ── 교란원 · 파면 ──
    let JM = null;
    function buildJammer() {
      G.jam.clear(); const S = JC.SCEN[st.key];
      const sc = { Jam_Tower: 0.12, Ship_Fishing: 0.09, Drone: 1.6 }[S.model] || 0.1;     // 보이게 키운 배율(실제 크기 아님)
      const g = new T.Group(); g.add(model(S.model, sc));
      const beacon = new T.Mesh(new T.CylinderGeometry(0.12, 0.12, 9, 8), new T.MeshBasicMaterial({ color: 0xff5a5a, toneMapped: false, transparent: true, opacity: 0.9 }));
      beacon.position.y = 5; g.add(beacon);
      const lab = label(`${S.name} — ${S.where}`, '#ffb3a8', 3.0); lab.position.y = 10.5; g.add(lab);
      G.jam.add(g); JM = { g, beacon };
      G.wave.clear(); st.waves = [];
      //   파면 — 바닥에 퍼지는 고리 넷 + 옅은 반구 하나(보이게 느리게 · 실제는 빛의 속도라 한순간). 지도를 덮지 않게 반지름을 줄였다
      for (let k = 0; k < 4; k++) {
        const m = new T.Mesh(new T.RingGeometry(0.96, 1, 96), new T.MeshBasicMaterial({ color: 0xff6b5a, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, toneMapped: false }));
        m.rotation.x = -Math.PI / 2; G.wave.add(m); st.waves.push({ m, ph: k / 4, ring: true });
      }
      const dome = new T.Mesh(new T.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), new T.MeshBasicMaterial({ color: 0xff7a6a, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, toneMapped: false, wireframe: true }));
      G.wave.add(dome); st.waves.push({ m: dome, ph: 0.5, ring: false });
    }

    // ── 한 박자(모의 1 s) — 교란원 위치 · 풀이 · 영향 · 경보 ──
    function jamNow() { const j = JC.jamAtTime(D, st.key, st.t); j.eirpW *= st.p.eirpScale; return j; }
    function tick(force) {
      const sec = Math.floor(st.t);
      if (!force && sec === st.lastTick) return; st.lastTick = sec;
      const S = JC.SCEN[st.key], jam = jamNow();
      const v = toV(jam.lat, jam.lon, jam.hAsl); JM.g.position.copy(v);
      // 영향 지도 — 교란원이 1 km 넘게 움직였거나 층·출력이 바뀌면
      const keyFp = `${st.key}|${st.layer}|${st.p.eirpScale}|${(jam.lat * 100).toFixed(2)}|${(jam.lon * 100).toFixed(2)}`;
      if (st.lastFp !== keyFp) { drawFootprint(jam); st.lastFp = keyFp; }
      // 감지·위치(교란 1 s 적분이 쌓인 뒤부터)
      const tHold = Math.max(st.p.tHold, st.t);
      st.sol = sec >= 1 ? JC.solve({ F, D, stations: data.stations, jam, T: st.p.T, sdrBw: st.p.sdrBw, mpNs: st.p.mpNs, clock: st.p.clock, tHold, clockAware: st.p.clockAware,
        noise: st.p.noise, seed: st.p.seed + sec, mode: S.mode, useFdoa: S.fdoa, hAssume: S.agl }) : null;
      drawStations(); drawRays(jam); drawHyp(); drawEst(jam);
      trafficTick(jam);
      events(sec, jam);
      if (ui.onUpdate) ui.onUpdate(snapshot(jam));
    }
    function drawFootprint(jam) {
      const fc = st.fpCanvas, g = fc.getContext('2d'), nx = fc.width, ny = fc.height;
      const fp = JC.footprint(D, jam, region, st.layer, nx, ny, st.layer > 500 ? 0 : -3);
      const im = g.createImageData(nx, ny); let L = 0, Gd = 0;
      for (let k = 0; k < nx * ny; k++) {
        const js = fp.js[k]; let r = 0, gg = 0, b = 0, a = 0;
        if (js >= JC.JS_LOSS) { r = 255; gg = 70; b = 70; a = 150 + Math.min(80, (js - 30) * 3); L++; }
        else if (js >= JC.JS_DEGRADE) { r = 255; gg = 190; b = 60; a = 70 + (js - 20) * 7; Gd++; }
        else if (js >= 10) { r = 255; gg = 230; b = 150; a = (js - 10) * 4; }
        im.data[4 * k] = r; im.data[4 * k + 1] = gg; im.data[4 * k + 2] = b; im.data[4 * k + 3] = a;
      }
      g.putImageData(im, 0, 0); st.fpTex.needsUpdate = true; st.fpMesh.visible = st.show.fp;
      const cell = (JC.gcDist(region.lat0, region.lon0, region.lat0, region.lon1) / nx) * (JC.gcDist(region.lat0, region.lon0, region.lat1, region.lon0) / ny) / 1e6;
      st.area = { loss: L * cell, degrade: Gd * cell };
    }
    function drawStations() {
      const s = st.sol; const det = new Set(s && s.det ? s.det.map((x) => x.id) : []);
      for (const id in SV) {
        const o = SV[id], x = s && s.st ? s.st.find((q) => q.id === id) : null;
        const col = !x ? 0x4fe3c1 : x.lost ? 0xf0b44c : det.has(id) ? (s.ref === id ? 0xffffff : 0x37e8cf) : 0x5b6f8c;
        o.pin.material.color.setHex(col); o.halo.material.color.setHex(col); o.halo.material.opacity = det.has(id) ? 0.85 : 0.0;
      }
    }
    function drawRays(jam) {
      G.rays.clear(); if (!st.show.rays || !st.sol || !st.sol.st) return;
      const a = toV(jam.lat, jam.lon, jam.hAsl);
      for (const x of st.sol.st) {
        if (!(x.corrSnr >= 7)) continue;
        const b = SV[x.id].g.position.clone().add(new T.Vector3(0, 1.2, 0));
        const op = Math.min(0.85, 0.15 + Math.log10(Math.min(1e4, x.corrSnr === Infinity ? 1e4 : x.corrSnr)) / 5);
        const m = x.los ? new T.LineBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: op, toneMapped: false })
          : new T.LineDashedMaterial({ color: 0xf0b44c, transparent: true, opacity: op, dashSize: 1.2, gapSize: 0.8, toneMapped: false });
        const l = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), m); if (!x.los) l.computeLineDistances(); G.rays.add(l);
      }
    }
    // TDOA 쌍곡선 — 기준점과 위 4 쌍, 측정한 τ 로 |p−rᵢ| − |p−r₀| = c·τ 인 자리(지면)를 격자 표식 법으로
    let HG = null;
    function hypGrid() {
      if (HG) return HG; const nx = 170, ny = 106, P = [], V = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const lat = region.lat1 - j / (ny - 1) * (region.lat1 - region.lat0), lon = region.lon0 + i / (nx - 1) * (region.lon1 - region.lon0), h = D.at(lat, lon);
        P.push(JC.ecef(lat, lon, h + 25)); V.push(toV(lat, lon, h));
      }
      return (HG = { nx, ny, P, V });
    }
    function drawHyp() {
      G.hyp.clear(); const s = st.sol; if (!st.show.hyp || !s || !s.ok) return;
      const H = hypGrid(), ref = s.st.find((q) => q.id === s.ref), cols = [0xbc8cff, 0x7cb8ff, 0xffcf5a, 0x4fe3c1];
      const pairs = s.pairs.slice().sort((a, b) => b.snr - a.snr).slice(0, 4);
      pairs.forEach((pr, pi) => {
        const si = s.st.find((q) => q.id === pr.id), dd = JC.C * pr.tdoa, f = new Float32Array(H.P.length);
        for (let k = 0; k < H.P.length; k++) { const p = H.P[k]; f[k] = Math.hypot(p[0] - si.p[0], p[1] - si.p[1], p[2] - si.p[2]) - Math.hypot(p[0] - ref.p[0], p[1] - ref.p[1], p[2] - ref.p[2]) - dd; }
        const pts = [];
        for (let j = 0; j < H.ny - 1; j++) for (let i = 0; i < H.nx - 1; i++) {
          const k = j * H.nx + i, c = [k, k + 1, k + H.nx + 1, k + H.nx], z = [];
          for (let e = 0; e < 4; e++) { const a = c[e], b = c[(e + 1) % 4]; if ((f[a] < 0) !== (f[b] < 0)) { const t = f[a] / (f[a] - f[b]); z.push(H.V[a].clone().lerp(H.V[b], t)); } }
          if (z.length >= 2) { pts.push(z[0], z[1]); if (z.length === 4) pts.push(z[2], z[3]); }
        }
        for (const p of pts) p.y += 0.35;
        G.hyp.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: cols[pi], transparent: true, opacity: 0.85, toneMapped: false })));
      });
    }
    function drawEst(jam) {
      G.est.clear(); const s = st.sol; if (!s || !s.ok) return;
      const v = toV(s.est.lat, s.est.lon, s.est.hAsl); v.y = Math.max(v.y, groundY(s.est.lat, s.est.lon)) + 0.3;
      const g = new T.Group(); g.position.copy(v);
      const r = ring(2.6, 0xffffff, 0.95); g.add(r);
      for (const [x, z] of [[1, 0], [0, 1]]) { const l = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-4 * x, 0, -4 * z), new T.Vector3(4 * x, 0, 4 * z)]), new T.LineBasicMaterial({ color: 0xffffff, toneMapped: false })); g.add(l); }
      // 오차 타원(수평 1σ · mag 배 확대 · 동쪽에서 반시계 ang)
      const e = s.ellipse, pts = []; for (let k = 0; k <= 64; k++) { const a = k / 64 * Math.PI * 2, x = e.a * Math.cos(a), y = e.b * Math.sin(a), ce = Math.cos(e.ang), sn = Math.sin(e.ang); pts.push(new T.Vector3((x * ce - y * sn) * st.mag / 1000, 0.1, -(x * sn + y * ce) * st.mag / 1000)); }
      g.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0xffe28a, toneMapped: false })));
      G.est.add(g);
      // 참 자리(옅게)
      const tv = toV(jam.lat, jam.lon, jam.hAsl); const tm = new T.Mesh(new T.OctahedronGeometry(0.7), new T.MeshBasicMaterial({ color: 0xff8080, wireframe: true, toneMapped: false })); tm.position.copy(tv); tm.position.y += 1.2; G.est.add(tm);
      // 움직이는 교란원 — 추정 속도 화살표(60 초 뒤 자리까지)
      if (s.est.ve != null) { const b = new T.Vector3(s.est.ve * 60 / 1000, 0, -s.est.vn * 60 / 1000).multiplyScalar(4); const l = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), b]), new T.LineBasicMaterial({ color: 0x37e8cf, toneMapped: false })); g.add(l); }
    }
    function trafficTick(jam) {
      const J = { lat: jam.lat, lon: jam.lon, h: jam.hAsl, eirpW: jam.eirpW, bw: jam.bw };
      for (const o of TR) {
        let p;
        if (o.kind === 'cg') {
          if (o.go && st.sol && st.sol.ok) {                       // 해경 — 추정 위치로 25 kn
            const tgt = st.sol.est, d = JC.gcDist(o.lat, o.lon, tgt.lat, tgt.lon), step = Math.min(d, 25 * KN * 1);
            if (d > 300) { o.lat += (tgt.lat - o.lat) * step / d; o.lon += (tgt.lon - o.lon) * step / d; o.hd = Math.atan2((tgt.lon - o.lon) * Math.cos(o.lat * D2R), tgt.lat - o.lat); }
            o.dist = d;
          }
          p = { lat: o.lat, lon: o.lon, alt: 0, hd: o.hd || 0 };
        } else p = o.fn(st.t);
        const y = o.kind === 'air' ? p.alt * VE / 1000 : groundY(p.lat, p.lon) + 0.02;
        const v = toV(p.lat, p.lon, 0); o.g.position.set(v.x, y, v.z); o.g.rotation.y = -p.hd + Math.PI / 2;
        o.lat = p.lat; o.lon = p.lon; o.alt = p.alt;
        if (o.kind !== 'cg') {
          const h = o.kind === 'air' ? p.alt : D.at(p.lat, p.lon) + 8;
          const r = JC.jamAt(D, J, { lat: p.lat, lon: p.lon, h }, o.kind === 'air' ? 0 : -3);
          o.js = r.js; const ns = JC.state(r.js);
          if (ns !== o.state && st.t >= 1) evt(ns === 'ok' ? 'ok' : ns, `${o.name} — GNSS ${ns === 'loss' ? '끊김' : ns === 'degrade' ? '저하' : '회복'}(J/S ${r.js.toFixed(0)} dB)`);
          o.state = ns;
          o.halo.material.color.setHex(ns === 'loss' ? 0xff5a5a : ns === 'degrade' ? 0xf0b44c : 0x4fe3c1); o.halo.material.opacity = ns === 'ok' ? 0.0 : 0.9;
        }
      }
    }
    function evt(kind, msg) { const e = { t: st.t, kind, msg }; st.events.push(e); if (st.events.length > 200) st.events.shift(); if (ui.onEvent) ui.onEvent(e); }
    function events(sec, jam) {
      const s = st.sol, S = JC.SCEN[st.key];
      if (sec === 0 && !st.ev0) { st.ev0 = 1; evt('jam', `교란 시작 — ${S.name}(${S.where}) · EIRP ${(jam.eirpW).toFixed(jam.eirpW < 10 ? 1 : 0)} W · ${S.type === 'chirp' ? '처프' : '잡음'} ${(S.bw / 1e6).toFixed(0)} MHz`); }
      if (s && s.det && s.det.length && !st.ev1) { st.ev1 = 1; evt('det', `감지 — 위성기준점 ${s.det.length} 곳이 L1 대역 세기 상승을 잡고 세종 상관기로 기록을 보냄(1 s 적분)`); }
      if (s && s.ok && !st.ev2) { st.ev2 = 1; evt('fix', `첫 위치 — ${s.est.lat.toFixed(4)}° N · ${s.est.lon.toFixed(4)}° E · 참값과 ${s.err.h.toFixed(1)} m · 1σ ${Math.hypot(s.sigma.e, s.sigma.n).toFixed(1)} m(TDOA ${s.pairs.length} 쌍${S.fdoa ? ' + FDOA' : ''})`); }
      if (s && s.ok && sec >= 3 && !st.alerted) {
        st.alerted = true;
        evt('alert', `경보 — 해경·인천 접근관제·서해 VTS 에 교란원 위치·영향 구역 통보 · 선박 VHF/AIS 안전 방송 · 항공 NOTAM 권고(대체 항법: 관성·지상 항행 안전 시설·eLoran)`);
        let best = null; for (const o of TR) if (o.kind === 'cg') { const d = JC.gcDist(o.lat, o.lon, s.est.lat, s.est.lon); if (!best || d < best.d) best = { o, d }; }
        if (best && (S.fdoa || st.key === 'drone' || best.d < 60000)) { best.o.go = true; evt('cg', `${best.o.name} 출동 — 추정 위치까지 ${(best.d / 1000).toFixed(1)} km · 25 kn 로 약 ${(best.d / (25 * KN) / 60).toFixed(0)} 분`); }
      }
      for (const o of TR) if (o.kind === 'cg' && o.go && o.dist != null && o.dist < 400 && !o.arr) { o.arr = 1; evt('cg', `${o.name} 도착 — 추정 위치 400 m 안`); }
    }
    function snapshot(jam) {
      const s = st.sol, S = JC.SCEN[st.key];
      return { key: st.key, S, t: st.t, dur: st.dur, play: st.play, jam, sol: s, area: st.area, traffic: TR.filter((o) => o.kind !== 'cg').map((o) => ({ name: o.name, kind: o.kind, js: o.js, state: o.state, alt: o.alt })),
        cg: TR.filter((o) => o.kind === 'cg').map((o) => ({ name: o.name, go: o.go, dist: o.dist })), p: st.p, layer: st.layer };
    }

    // ── 카메라 ──
    // 카메라는 남쪽에서 북쪽을 본다(화면 위 = 북) — ph = π/2 근처
    let th = 0.95, ph = 1.45, rad = 300, tgt = new T.Vector3(0, 0, 0), drag = 0, px = 0, py = 0, dirty = true;
    function aim() { cam.position.set(tgt.x + rad * Math.sin(th) * Math.cos(ph), tgt.y + rad * Math.cos(th), tgt.z + rad * Math.sin(th) * Math.sin(ph)); cam.lookAt(tgt); }
    canvas.addEventListener('pointerdown', (e) => { drag = e.button === 2 || e.shiftKey ? 2 : 1; px = e.clientX; py = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = 0; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
      if (drag === 1) { ph += dx * 0.006; th = Math.max(0.15, Math.min(1.45, th - dy * 0.006)); }
      else { const k = rad / 600, r = new T.Vector3(Math.sin(ph), 0, -Math.cos(ph)), f = new T.Vector3(Math.cos(ph), 0, Math.sin(ph)); tgt.addScaledVector(r, dx * k).addScaledVector(f, -dy * k); }
      dirty = true;
    });
    canvas.addEventListener('wheel', (e) => { rad = Math.max(12, Math.min(700, rad * (1 + Math.sign(e.deltaY) * 0.1))); dirty = true; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('dblclick', () => view('all'));
    function view(k) {
      if (k === 'jam' && JM) { tgt.copy(JM.g.position); th = 0.95; ph = 1.3; rad = 70; }
      else if (k === 'air') { const v = toV(37.43, 126.48, 0); tgt.copy(v); th = 0.9; ph = 1.2; rad = 95; }
      else if (k === 'west') { const v = toV(37.75, 125.2, 0); tgt.copy(v); th = 1.0; ph = 1.45; rad = 160; }
      else if (k === 'est' && st.sol && st.sol.ok) { tgt.copy(toV(st.sol.est.lat, st.sol.est.lon, st.sol.est.hAsl)); th = 0.6; ph = 1.35; rad = 22; }
      else { tgt.set(0, 0, 0); th = 0.95; ph = 1.45; rad = 300; }
      dirty = true;
    }
    function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); dirty = true; }
    new ResizeObserver(resize).observe(canvas);

    // ── 돌리기 ──
    let lastF = performance.now(), visible = true;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastF) / 1000); lastF = now;
      if (!st.ready || !visible || document.hidden) return;
      if (st.play) { st.t = Math.min(st.dur, st.t + dt * st.speed); if (st.t >= st.dur) { st.play = false; if (ui.onUpdate) ui.onUpdate(snapshot(jamNow())); } tick(); dirty = true; }
      // 파면(보이게 느리게 — 실제는 빛의 속도라 한순간)
      if (st.waves && JM) {
        const R0 = Math.min(60, 18 * Math.pow(st.p.eirpScale * JC.SCEN[st.key].eirpW, 0.25));
        for (const w of st.waves) {
          w.ph = (w.ph + dt * 0.22) % 1; const r = 0.8 + w.ph * R0; w.m.position.copy(JM.g.position);
          if (w.ring) { w.m.position.y = Math.max(JM.g.position.y - (JC.SCEN[st.key].agl * VE / 1000), 0) + 0.12; w.m.scale.set(r, r, 1); w.m.material.opacity = 0.55 * (1 - w.ph); }
          else { w.m.scale.set(r * 0.6, r * 0.3, r * 0.6); w.m.material.opacity = 0.07 * (1 - w.ph); }
        }
        dirty = true;
      }
      if (JM) JM.beacon.material.opacity = 0.55 + 0.4 * Math.sin(now / 250);
      const ks = Math.max(0.12, Math.min(1.6, rad / 300)) * 1.8;            // 이름표 — 멀리서도 읽히게 거리에 맞춰
      for (const l of G.lab.children) { if (l.userData.follow) l.position.copy(l.userData.follow.position).add(new T.Vector3(0, 5.6 * ks, 0)); if (l.userData.base) l.scale.set(l.userData.base[0] * ks, l.userData.base[1] * ks, 1); }
      if (JM) for (const c of JM.g.children) if (c.isSprite && c.userData.base) { c.scale.set(c.userData.base[0] * ks, c.userData.base[1] * ks, 1); c.position.y = 10.5 * Math.max(1, ks); }
      G.lab.visible = st.show.lab;
      if (dirty) { aim(); rn.render(scene, cam); dirty = st.play || !!st.waves; }
    }

    // ── 시작 ──
    (async () => {
      data = await get(base + 'jamsim_data.json', 'json'); region = data.region;
      F = JC.frame(0.5 * (region.lat0 + region.lat1), 0.5 * (region.lon0 + region.lon1));
      const buf = await get(base + region.dem, 'buf'); D = JC.dem(region, new Int16Array(buf));
      const small = Math.max(innerWidth, innerHeight) < 900;
      const img = await loadImg(await get(base + (small ? region.map_1k : region.map), 'img'));
      if (T.GLTFLoader) {
        const L = new T.GLTFLoader(), url = base + 'jamsim_assets.glb';
        const g = await new Promise((ok, no) => { if (window.TSX && TSX.glb) TSX.glb(url).then((b) => L.parse(b, '', ok, no), no); else L.load(url, ok, undefined, no); }).catch(() => null);
        if (g) g.scene.traverse((o) => { if (o.parent === g.scene) assets[o.name] = o; });
        for (const k in assets) assets[k].traverse((o) => { if (o.isMesh && o.material && o.material.map) o.material.map.encoding = T.sRGBEncoding; });
      }
      buildTerrain(null, img); buildStations(); buildTraffic(); buildJammer();
      st.ready = true; resize(); tick(true); if (ui.onReady) ui.onReady(data);
      requestAnimationFrame(frame);
    })().catch((e) => { if (ui.onError) ui.onError(e); });

    function reset() {
      st.t = 0; st.lastTick = -1; st.events = []; st.alerted = false; st.ev0 = st.ev1 = st.ev2 = 0; st.lastFp = null;
      for (const o of TR) { o.state = 'ok'; if (o.kind === 'cg') { o.lat = o.home[0]; o.lon = o.home[1]; o.go = false; o.arr = 0; o.dist = null; } }
      if (ui.onEvent) ui.onEvent(null);
    }
    return {
      setScenario(k) { st.key = k; st.dur = 900; reset(); if (st.ready) { buildJammer(); tick(true); view('all'); } },
      set(k, v) { st.p[k] = v; st.lastFp = null; if (st.ready) tick(true); },
      layer(h) { st.layer = h; st.lastFp = null; if (st.ready) tick(true); },
      toggle(k, on) { st.show[k] = on; if (st.ready) { if (k === 'fp') st.fpMesh.visible = on; tick(true); } dirty = true; },
      play() { if (st.t >= st.dur) reset(); st.play = true; }, pause() { st.play = false; }, speed(x) { st.speed = x; },
      seek(t) { st.t = t; st.lastTick = -1; if (st.ready) tick(true); dirty = true; }, reset() { reset(); if (st.ready) tick(true); },
      view, state: () => (st.ready ? snapshot(jamNow()) : null), core: () => ({ D, F, data }), mag: () => st.mag,
      debug: () => ({ assets: Object.keys(assets), jam: JM ? JM.g.position.toArray().map((v) => +v.toFixed(2)) : null, kids: JM ? JM.g.children.length : 0 }),
    };
  }
  window.JamSim = { create };
})();
