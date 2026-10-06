/* wxtomo3d.js — '동네 단위 10분 뒤 소나기 예보' 모의의 3D(2026-10-05). three.js r128 · GLTFLoader.
 *   한 단위 = 1 km(가로) · 높이는 지형·대기·건물 모두 VZ 배(1.6). three 좌표: X = 동 x · Y = 높이 · Z = −북 y.
 *   지형(AWS Terrain Tiles) 위에 위성영상(Sentinel-2 cloudless 2020, EOX — CC BY-NC-SA 4.0) · 읍면동 경계(vuski/admdongkor) · OSM 아파트 · 위성기준점(실제) ·
 *   조밀망(가정, 블렌더 자산 인스턴스) · GPS 광선(IGS 궤도) · 수증기 부피(단층 영상/참값) · 대류 구름·비 · 경보 덧그림(땅에 입힘).
 *   글 상자는 3D 위에 띄우지 않는다 — 이름은 작은 글자 스프라이트(실제 기준점·지점만).
 */
(function () {
  'use strict';
  const VZ = 1.6, D2R = Math.PI / 180, IN = 16;           // 안쪽 영역 반쪽(km) — 덧그림·고해상 영상
  const LV = [null, [240, 180, 76], [255, 92, 110]];      // 경보 색: 주의 · 경보

  function textSprite(T, txt, color, h) {
    const fs = 44, cv = document.createElement('canvas'), g = cv.getContext('2d');
    g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`;
    const w = Math.ceil(g.measureText(txt).width) + 16; cv.width = w; cv.height = fs + 16;
    g.font = `600 ${fs}px "Noto Sans KR","Malgun Gothic",sans-serif`; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 8; g.fillStyle = color; g.fillText(txt, 8, cv.height / 2);
    const tx = new T.CanvasTexture(cv); tx.encoding = T.sRGBEncoding;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tx, transparent: true, depthWrite: false, toneMapped: false }));
    sp.scale.set(h * w / cv.height, h, 1); sp.renderOrder = 8; return sp;
  }
  function puffTex(T) {                                   // 구름 알갱이 — 부드러운 원 + 잔결
    const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s; const g = cv.getContext('2d');
    const gr = g.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    const im = g.getImageData(0, 0, s, s), d = im.data;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < d.length; k += 4) d[k + 3] = Math.max(0, d[k + 3] - 40 * rnd());
    g.putImageData(im, 0, 0);
    const t = new T.CanvasTexture(cv); return t;
  }
  // 색 지도(이상 PWV) — 마른 쪽 갈색 · 0 투명 · 젖은 쪽 청록 → 흰
  function cmapAn(v) {
    const a = Math.max(-1, Math.min(1, v / 6));
    if (a >= 0) { const t = a; return [Math.round(40 + 180 * t), Math.round(150 + 105 * t), 255, Math.min(1, 0.15 + 0.85 * t) * (t > 0.08 ? 1 : t / 0.08)]; }
    const t = -a; return [200, Math.round(140 - 40 * t), Math.round(80 - 40 * t), 0.55 * t];
  }
  function cmapP(p) { if (p < 0.12) return [0, 0, 0, 0]; const t = Math.min(1, (p - 0.12) / 0.8); return [255, Math.round(210 - 130 * t), Math.round(70 - 20 * t), 0.18 + 0.55 * t]; }

  function create(canvas, opts) {
    opts = opts || {};
    const T = window.THREE; if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
    rn.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); rn.outputEncoding = T.sRGBEncoding;
    rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 1.0;
    rn.setClearColor(new T.Color(0x070d18));
    const scene = new T.Scene(); scene.fog = new T.Fog(new T.Color(0x0a1424).convertSRGBToLinear(), 70, 190);
    const cam = new T.PerspectiveCamera(42, 1, 0.02, 800);
    scene.add(new T.HemisphereLight(0xdfe9ff, 0x2a3240, 0.9));
    const sun = new T.DirectionalLight(0xfff0d8, 1.6); sun.position.set(-40, 60, 30); scene.add(sun);
    const G = {}; for (const k of ['ground', 'over', 'admin', 'bld', 'sta', 'lbl', 'rays', 'vap', 'cloud', 'rain', 'poi', 'arrow']) { G[k] = new T.Group(); scene.add(G[k]); }
    const st = { dirty: true, data: null, res: null, scen: null, t: 0, frame: null, dem: null,
      L: { img: true, vap: 'recon', cloud: true, rays: true, alert: true, bld: true, lbl: true }, ov: { mode: 'alert', lead: 10, net: 'dense' }, anim: 0 };

    // ── 불러오기 ──
    const get = async (u, t) => {
      if (window.TSX && TSX.fetch && TSX.has && TSX.has(u)) {
        const rel = new URL(u, location.href).href.split('?')[0].slice(TSX.base.length), b = await TSX.fetch(rel);
        return t === 'json' ? JSON.parse(new TextDecoder().decode(b)) : t === 'buf' ? b : new Blob([b], { type: 'image/jpeg' });
      }
      if (t === 'img') return u;
      const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u + ' ' + r.status);
      return t === 'json' ? r.json() : t === 'buf' ? r.arrayBuffer() : r.blob();
    };
    const tex = async (u) => {
      const s = await get(u, 'img'), t = new T.Texture();
      if (typeof s === 'string') { const im = new Image(); im.decoding = 'async'; im.src = s; await im.decode(); t.image = im; t.flipY = true; }
      else { t.image = await createImageBitmap(s, { imageOrientation: 'flipY' }); t.flipY = false; }
      t.encoding = T.sRGBEncoding; t.anisotropy = rn.capabilities.getMaxAnisotropy(); t.needsUpdate = true; return t;
    };

    let dem = null;
    const H = (x, y) => dem(x, y) * VZ;                 // 땅 높이(장면 단위)
    function plane(half, n, h0, hole) {
      const g = new T.PlaneGeometry(2 * half, 2 * half, n - 1, n - 1); g.rotateX(-Math.PI / 2);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) { const x = p.getX(k), z = p.getZ(k);
        // 바깥 판은 안쪽 판 밑으로 조금 내린다 — 거친 삼각형이 고운 안쪽 지형을 뚫고 올라오지 않게
        const sink = hole && Math.abs(x) < hole - 0.4 && Math.abs(z) < hole - 0.4 ? 0.25 : 0;
        p.setY(k, H(x, -z) + h0 - sink); }
      g.computeVertexNormals(); return g;
    }
    let overCv = null, overTex = null;

    async function load(D, base) {
      st.data = D; dem = WXCore.demSampler(D.dem);
      const mob = innerWidth < 720 || !!opts.light;
      const [tOut, tIn] = await Promise.all([tex(base + 'wx_img_out.jpg'), tex(base + (mob ? 'wx_img_in_1k.jpg' : 'wx_img_in.jpg'))]);
      const mOut = new T.Mesh(plane(32, 161, -0.004, IN), new T.MeshLambertMaterial({ map: tOut }));
      const mIn = new T.Mesh(plane(IN, mob ? 129 : 193, 0), new T.MeshLambertMaterial({ map: tIn, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
      G.ground.add(mOut, mIn);
      // 덧그림(경보·PWV·예보) — 안쪽 지형과 같은 판에 캔버스 무늬
      overCv = document.createElement('canvas'); overCv.width = overCv.height = mob ? 512 : 1024;
      overTex = new T.CanvasTexture(overCv); overTex.encoding = T.sRGBEncoding;
      const mOv = new T.Mesh(mIn.geometry, new T.MeshBasicMaterial({ map: overTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false }));
      mOv.renderOrder = 2; G.over.add(mOv);
      // 읍면동 경계(지형 따라)
      const pts = [];
      for (const u of D.admin) for (const r of u.rings) for (let i = 0; i < r.length - 1; i++) {
        const [x1, y1] = r[i], [x2, y2] = r[i + 1], n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.25));
        for (let k = 0; k < n; k++) { const a = k / n, b = (k + 1) / n, xa = x1 + (x2 - x1) * a, ya = y1 + (y2 - y1) * a, xb = x1 + (x2 - x1) * b, yb = y1 + (y2 - y1) * b;
          pts.push(xa, H(xa, ya) + 0.03, -ya, xb, H(xb, yb) + 0.03, -yb); }
      }
      const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      G.admin.add(new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0xe8f1ff, transparent: true, opacity: 0.5, depthWrite: false })));
      // 아파트(OSM) — 한 덩어리로
      if (D.bld && D.bld.b) G.bld.add(buildings(D.bld.b));
      // 블렌더 자산
      if (T.GLTFLoader) {
        const buf = await get(base + 'wxtomo_assets.glb', 'buf');
        const gl = await new Promise((ok, no) => new T.GLTFLoader().parse(buf, '', ok, no));
        st.assets = {}; for (const k of ['CORS', 'Tower', 'Roof', 'Underpass', 'ParkSign', 'AlertPole']) { const o = gl.scene.getObjectByName(k); if (o) st.assets[k] = merge(o); }
      }
      stations(D.sta);
      view('all', true); st.dirty = true;
    }

    function buildings(B) {
      const pos = [], col = [];
      for (const b of B) {
        const ring = b.r.map((p) => [p[0] / 1000, p[1] / 1000]); if (ring.length < 3) continue;
        let cx = 0, cy = 0; for (const p of ring) { cx += p[0]; cy += p[1]; } cx /= ring.length; cy /= ring.length;
        const y0 = H(cx, cy), y1 = y0 + b.h / 1000 * VZ, sh = 0.78 + 0.18 * ((Math.abs(Math.sin(cx * 91.7 + cy * 13.1)) * 7) % 1);
        for (let i = 0; i < ring.length; i++) {
          const [xa, ya] = ring[i], [xb, yb] = ring[(i + 1) % ring.length];
          pos.push(xa, y0, -ya, xb, y0, -yb, xb, y1, -yb, xa, y0, -ya, xb, y1, -yb, xa, y1, -ya);
          for (let k = 0; k < 6; k++) col.push(0.62 * sh, 0.66 * sh, 0.72 * sh);
        }
        const tri = T.ShapeUtils.triangulateShape(ring.map((p) => new T.Vector2(p[0], p[1])), []);
        for (const t of tri) for (const k of t) { pos.push(ring[k][0], y1, -ring[k][1]); col.push(0.86 * sh, 0.88 * sh, 0.9 * sh); }
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      return new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }));
    }
    function merge(root) {                               // 자산 하나 → 재질별로 합친 기하(m 단위, 원점 = 자산 바닥)
      root.updateMatrixWorld(true); const inv = new T.Matrix4().copy(root.matrixWorld).invert(), by = new Map();
      root.traverse((o) => { if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld)), m = o.material, key = m.name || m.uuid;
        if (!by.has(key)) by.set(key, { m, gs: [] }); by.get(key).gs.push(g.index ? g.toNonIndexed() : g); });
      const out = [];
      for (const { m, gs } of by.values()) {
        let n = 0; for (const g of gs) n += g.attributes.position.count;
        const P = new Float32Array(n * 3), N = new Float32Array(n * 3); let o = 0;
        // 무늬 UV(uv)·AO UV(uv2, 블렌더가 구운 occlusionTexture 용)도 함께 옮긴다 — 없으면 0(10-06 PBR 판)
        const U = gs.some((g) => g.attributes.uv) ? new Float32Array(n * 2) : null, U2 = gs.some((g) => g.attributes.uv2) ? new Float32Array(n * 2) : null;
        for (const g of gs) { const a = g.attributes;
          P.set(a.position.array, o * 3); if (a.normal) N.set(a.normal.array, o * 3);
          if (U && a.uv) U.set(a.uv.array, o * 2); if (U2 && a.uv2) U2.set(a.uv2.array, o * 2); o += a.position.count; }
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3));
        if (U) g.setAttribute('uv', new T.BufferAttribute(U, 2));
        if (U2 || (U && m.aoMap)) g.setAttribute('uv2', new T.BufferAttribute(U2 || U, 2));
        const mm = m.clone(); out.push({ g, m: mm });
      }
      return out;
    }
    function instanced(asset, list, scale) {             // list: [{x, y, base(장면 높이), rot}]
      const grp = new T.Group(), M = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(scale / 1000, scale / 1000 * VZ, scale / 1000);
      for (const { g, m } of asset) {
        const im = new T.InstancedMesh(g, m, list.length);
        list.forEach((p, i) => { q.setFromAxisAngle(new T.Vector3(0, 1, 0), p.rot || 0); M.compose(new T.Vector3(p.x, p.base, -p.y), q, s); im.setMatrixAt(i, M); });
        im.instanceMatrix.needsUpdate = true; grp.add(im);
      }
      return grp;
    }
    function stations(S) {
      G.sta.clear(); G.lbl.clear();
      const near = (x, y) => { let best = null, bd = 0.3; if (st.data.bld) for (const b of st.data.bld.b) { const c = b._c || (b._c = b.r.reduce((a, p) => [a[0] + p[0] / 1000 / b.r.length, a[1] + p[1] / 1000 / b.r.length], [0, 0]));
        const d = Math.hypot(c[0] - x, c[1] - y); if (d < bd) { bd = d; best = { x: c[0], y: c[1], h: b.h }; } } return best; };
      const real = S.filter((s) => s.real), tw = S.filter((s) => s.kind === 'tower'), rf = S.filter((s) => s.kind === 'roof');
      if (st.assets) {
        G.sta.add(instanced(st.assets.CORS, real.map((s) => ({ x: s.x, y: s.y, base: H(s.x, s.y) })), 60));
        G.sta.add(instanced(st.assets.Tower, tw.map((s, i) => ({ x: s.x, y: s.y, base: H(s.x, s.y), rot: i * 1.7 })), 9));
        G.sta.add(instanced(st.assets.Roof, rf.map((s) => { const b = near(s.x, s.y); return b ? { x: b.x, y: b.y, base: H(b.x, b.y) + b.h / 1000 * VZ } : { x: s.x, y: s.y, base: H(s.x, s.y) + 0.055 * VZ }; }), 14));
      }
      for (const s of real) {                              // 실제 기준점 — 빛 고리 + 이름
        const ring = new T.Mesh(new T.RingGeometry(0.35, 0.45, 48), new T.MeshBasicMaterial({ color: 0x4fe3c1, transparent: true, opacity: 0.85, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.set(s.x, H(s.x, s.y) + 0.05, -s.y); G.sta.add(ring);
        const lb = textSprite(T, s.id, '#7ff5dc', 0.4); lb.position.set(s.x, H(s.x, s.y) + 1.0, -s.y); G.lbl.add(lb);
      }
    }

    // ── 한 판 결과 ──
    function setResult(res) {
      st.res = res; st.scen = res.scen.id;
      G.poi.clear();
      if (st.assets) for (const p of res.scen.pois) {
        const k = p.kind === 'underpass' ? 'Underpass' : p.kind === 'park' ? 'ParkSign' : 'AlertPole';
        const g = instanced(st.assets[k], [{ x: p.x, y: p.y, base: H(p.x, p.y), rot: 0.6 }], k === 'Underpass' ? 14 : 40);
        const ring = new T.Mesh(new T.RingGeometry(0.25, 0.33, 40), new T.MeshBasicMaterial({ color: 0x4fe3c1, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, H(p.x, p.y) + 0.06, -p.y); g.add(ring); g.userData = { p, ring };
        const lb = textSprite(T, p.name, '#ffe3a6', 0.2); lb.position.set(p.x, H(p.x, p.y) + 0.45 + 0.28 * (res.scen.pois.indexOf(p) % 3), -p.y); g.add(lb);
        G.poi.add(g);
      }
      setTime(0);
    }
    function frameAt(t) { const F = st.res.frames; let f = F[0]; for (const x of F) if (x.t <= t + 1e-6) f = x; return f; }

    // 수증기 부피(복셀 점)
    const vapMat = new T.ShaderMaterial({
      uniforms: { uS: { value: 420 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      vertexShader: 'attribute float a; attribute vec3 c; varying float va; varying vec3 vc; uniform float uS; void main(){ va=a; vc=c; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=uS*2.0/(-mv.z); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying float va; varying vec3 vc; void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d)*4.0; if(r>1.0) discard; gl_FragColor=vec4(vc, va*(1.0-r)*(1.0-r)); }' });
    let vapPts = null;
    function vapor(arr) {
      const V = WXCore.VX, nx = V.nx;
      if (!vapPts) {
        const p = new Float32Array(V.n * 3);
        for (let k = 0; k < V.nz; k++) { const zm = 0.5 * (V.ze[k] + V.ze[k + 1]); for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++) { const o = ((k * nx + i) * nx + j) * 3;
          p[o] = -V.half + (j + 0.5) * V.dx; p[o + 1] = zm * VZ; p[o + 2] = -(-V.half + (i + 0.5) * V.dx); } }
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(p, 3));
        g.setAttribute('a', new T.BufferAttribute(new Float32Array(V.n), 1)); g.setAttribute('c', new T.BufferAttribute(new Float32Array(V.n * 3), 3));
        vapPts = new T.Points(g, vapMat); vapPts.frustumCulled = false; G.vap.add(vapPts);
      }
      const A = vapPts.geometry.attributes.a.array, C = vapPts.geometry.attributes.c.array;
      // 층마다 가로 평균을 빼 대류 세포(국지 이상)만 보인다 · 광선이 적은 가장자리(±22 km 밖)는 그리지 않는다
      const R = 3;                                         // 층마다 ±6 km(복셀 3칸) 평균을 빼는 고역 통과 — 배경 경도는 지우고 세포만
      for (let k = 0; k < V.nz; k++) {
        for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++) {
          const v = (k * nx + i) * nx + j, xx = -V.half + (j + 0.5) * V.dx, yy = -V.half + (i + 0.5) * V.dx, inside = Math.abs(xx) <= 22 && Math.abs(yy) <= 22;
          let m = 0, c = 0; if (arr && inside) for (let a = -R; a <= R; a++) for (let b2 = -R; b2 <= R; b2++) { const ii = i + a, jj = j + b2; if (ii < 0 || jj < 0 || ii >= nx || jj >= nx) continue; m += arr[(k * nx + ii) * nx + jj]; c++; }
          const d = arr && inside ? arr[v] - m / Math.max(1, c) : 0, x = Math.max(0, Math.min(1, (d - 1.5) / 8.0));
          A[v] = x * 0.42; C[v * 3] = 0.3 + 0.7 * x; C[v * 3 + 1] = 0.66 + 0.34 * x; C[v * 3 + 2] = 1.0;
        }
      }
      vapPts.geometry.attributes.a.needsUpdate = true; vapPts.geometry.attributes.c.needsUpdate = true;
    }

    // 구름·비(참 대기 상태 — 화면용)
    const cloudMat = new T.ShaderMaterial({
      uniforms: { map: { value: puffTex(T) }, uS: { value: 900 } }, transparent: true, depthWrite: false,
      vertexShader: 'attribute float a; attribute float s; attribute float sh; varying float va; varying float vs; uniform float uS; void main(){ va=a; vs=sh; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=uS*s/(-mv.z); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'uniform sampler2D map; varying float va; varying float vs; void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(vec3(vs), t.a*va); }' });
    const NC = 2600; let cloud = null, rainL = null;
    function ensureCloud() {
      if (cloud) return;
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(NC * 3), 3));
      for (const [k, n] of [['a', 1], ['s', 1], ['sh', 1]]) g.setAttribute(k, new T.BufferAttribute(new Float32Array(NC * n), n));
      cloud = new T.Points(g, cloudMat); cloud.frustumCulled = false; cloud.renderOrder = 5; G.cloud.add(cloud);
      const rg = new T.BufferGeometry(); rg.setAttribute('position', new T.BufferAttribute(new Float32Array(6000 * 6), 3));
      rainL = new T.LineSegments(rg, new T.LineBasicMaterial({ color: 0x9fc8ff, transparent: true, opacity: 0.55, depthWrite: false })); rainL.frustumCulled = false; G.rain.add(rainL);
    }
    const hsh = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    function clouds(t, phase) {
      ensureCloud(); const S = WXCore.scenState(st.data, st.scen, t);
      const P = cloud.geometry.attributes.position.array, A = cloud.geometry.attributes.a.array, Sz = cloud.geometry.attributes.s.array, Sh = cloud.geometry.attributes.sh.array;
      let n = 0;
      const put = (x, y, z, a, s, sh) => { if (n >= NC) return; P[n * 3] = x; P[n * 3 + 1] = z * VZ; P[n * 3 + 2] = -y; A[n] = a; Sz[n] = s; Sh[n] = sh; n++; };
      if (S.band) { const ca = Math.cos(S.band.ang * D2R), sa = Math.sin(S.band.ang * D2R);
        for (let k = 0; k < 520; k++) { const u = (hsh(k) - 0.5) * 2 * S.band.sl * 1.1, v = (hsh(k + 911) - 0.5) * 2.2 * S.band.sw, z = 2.2 + 3.8 * hsh(k + 77);
          const x = S.band.x + u * ca - v * sa, y = S.band.y + u * sa + v * ca; if (Math.abs(x) > 31 || Math.abs(y) > 31) continue;
          put(x, y, z, 0.18 * Math.exp(-0.5 * (v / S.band.sw) ** 2), 2.6 + 2 * hsh(k + 5), 0.62 + 0.25 * (z - 2.2) / 3.8); } }
      S.cells.forEach((c, ci) => {
        if (c.A < 0.08) return; const top = 1.8 + 8.6 * c.A, m = Math.round(70 + 120 * c.A);
        for (let k = 0; k < m; k++) { const h = hsh(ci * 1000 + k), r = c.sig * 0.95 * Math.sqrt(hsh(ci * 1000 + k + 333)) * (0.55 + 0.45 * (1 - h)), a = hsh(ci * 1000 + k + 555) * 6.283;
          const z = 1.2 + (top - 1.2) * h, wide = z > top - 1.5 ? 1.5 : 1;     // 위가 퍼진 모루
          put(c.x + Math.cos(a) * r * wide, c.y + Math.sin(a) * r * wide, z, Math.min(0.9, 0.25 + 0.7 * c.A), 1.3 + 1.4 * hsh(ci * 1000 + k + 77), 0.55 + 0.42 * h); }
      });
      for (let k = n; k < NC; k++) A[k] = 0;
      for (const k of ['position', 'a', 's', 'sh']) cloud.geometry.attributes[k].needsUpdate = true;
      // 비 줄기 — 비 세기만큼 · 떨어지는 결은 phase 로
      const R = rainL.geometry.attributes.position.array; let m = 0;
      S.cells.forEach((c, ci) => {
        if (c.R <= 0.02) return; const cnt = Math.round(160 * c.R * Math.min(1.5, c.rr / 40));
        for (let k = 0; k < cnt && m < 6000; k++) { const a = hsh(ci * 77 + k) * 6.283, r = 0.72 * c.sig * Math.sqrt(hsh(ci * 77 + k + 13)), x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
          const g = H(x, y) / VZ, f = (hsh(ci * 77 + k + 99) + phase) % 1, z1 = g + (1.2 - g) * f, z0 = Math.max(g, z1 - 0.45);
          R[m * 6] = x; R[m * 6 + 1] = z1 * VZ; R[m * 6 + 2] = -y; R[m * 6 + 3] = x; R[m * 6 + 4] = z0 * VZ; R[m * 6 + 5] = -y; m++; }
      });
      for (let k = m * 6; k < R.length; k++) R[k] = 0;
      rainL.geometry.attributes.position.needsUpdate = true; rainL.geometry.setDrawRange(0, m * 2);
    }

    // GPS 광선 — 국에서 위 끝(10 km)까지 · 습한 길은 밝은 청록
    let rayPulse = null;
    function rays(f) {
      G.rays.clear(); if (!f || !f.rays.length) return;
      const S = st.res.st, pts = [], col = [], zen = f.rays.map((r) => r.swd * Math.sin(r.el)), md = zen.slice().sort((a, b) => a - b)[zen.length >> 1];
      const pulse = [];
      f.rays.forEach((r, i) => {
        const s = S[r.s], L = (WXCore.ZTOP - s.z) / r.d[2], x0 = s.x, y0 = s.y, z0 = s.z, x1 = x0 + r.d[0] * L, y1 = y0 + r.d[1] * L;
        pts.push(x0, z0 * VZ, -y0, x1, WXCore.ZTOP * VZ, -y1);
        const w = Math.max(0, Math.min(1, (zen[i] - md) / 8 + 0.4)), c = [0.35 + 0.6 * w, 0.55 + 0.45 * w, 0.85 + 0.15 * w];
        col.push(...c, ...c); pulse.push({ x0, y0, z0, x1, y1, k: hsh(i) });
      });
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pts, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      G.rays.add(new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false })));
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(new Float32Array(pulse.length * 3), 3));
      rayPulse = { pts: new T.Points(pg, new T.PointsMaterial({ color: 0xc8fbff, size: 0.28, transparent: true, opacity: 0.95, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false })), list: pulse };
      G.rays.add(rayPulse.pts);
    }
    function pulseTick(ph) {
      if (!rayPulse) return; const P = rayPulse.pts.geometry.attributes.position.array;
      rayPulse.list.forEach((r, i) => { const f = 1 - ((ph * 0.6 + r.k) % 1); P[i * 3] = r.x0 + (r.x1 - r.x0) * f; P[i * 3 + 1] = (r.z0 + (WXCore.ZTOP - r.z0) * f) * VZ; P[i * 3 + 2] = -(r.y0 + (r.y1 - r.y0) * f); });
      rayPulse.pts.geometry.attributes.position.needsUpdate = true;
    }

    // 덧그림(땅에 입힘)
    function overlay() {
      const f = st.frame, c = overCv, g = c.getContext('2d'), S = c.width, MG = WXCore.MG; g.clearRect(0, 0, S, S); overTex.needsUpdate = true;
      if (!f || !st.L.alert) return;
      const px = (x) => (x + IN) / (2 * IN) * S, py = (y) => (IN - y) / (2 * IN) * S;
      const mode = st.ov.mode, net = st.ov.net, L = st.ov.lead;
      const grid = mode === 'truth' ? f.truthAn : mode === 'recon' ? (f[net] && f[net].an) : mode === 'err' ? (f[net] && f[net].an && f.truthAn ? f[net].an.map((v, k) => v - f.truthAn[k]) : null) : mode === 'fc' ? (f[net] && f[net].p && f[net].p[L]) : null;
      if (grid) {                                           // 61×61 격자 → 작은 그림 → 늘려 그리기(부드럽게)
        const n = MG.n, sc = document.createElement('canvas'); sc.width = sc.height = n; const sg = sc.getContext('2d'), im = sg.createImageData(n, n);
        for (let k = 0; k < n * n; k++) { const v = grid[k], rgba = mode === 'fc' ? cmapP(v) : mode === 'err' ? cmapAn(v * 2) : cmapAn(v);
          im.data[k * 4] = rgba[0]; im.data[k * 4 + 1] = rgba[1]; im.data[k * 4 + 2] = rgba[2]; im.data[k * 4 + 3] = Math.round(255 * rgba[3]); }
        sg.putImageData(im, 0, 0); g.imageSmoothingEnabled = true;
        const o = (MG.half - IN) / (2 * MG.half) * n, w = 2 * IN / (2 * MG.half) * n;     // 안쪽 ±16 km 만
        g.drawImage(sc, o, o, w, w, 0, 0, S, S);
      }
      if (mode === 'alert' && f.units) {                    // 읍면동 채움 — 앞때 L 의 경보 수준
        st.data.admin.forEach((u, i) => { const pu = f.units[i], lv = pu ? (pu.p[L] >= st.res.cfg.warn ? 2 : pu.p[L] >= st.res.cfg.watch ? 1 : 0) : 0; if (!lv) return;
          const col = LV[lv]; g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${lv === 2 ? 0.3 : 0.2})`;
          for (const r of u.rings) { g.beginPath(); r.forEach((p, k) => (k ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1])))); g.closePath(); g.fill(); } });
      }
      if (mode === 'alert' || mode === 'fc') {              // 지금 비(참) — 푸른 점묘
        const n = MG.n, R = f.rain; g.fillStyle = 'rgba(110,170,255,.55)';
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = R[i * n + j]; if (v < 1) continue; const x = -MG.half + j, y = MG.half - i; if (Math.abs(x) > IN || Math.abs(y) > IN) continue;
          const rr = Math.min(1, v / 40) * S / (2 * IN) * 0.5 + 1; g.beginPath(); g.arc(px(x), py(y), rr, 0, 6.283); g.fill(); }
      }
      g.strokeStyle = 'rgba(232,241,255,.55)'; g.lineWidth = Math.max(1, S / 700);
      for (const u of st.data.admin) for (const r of u.rings) { g.beginPath(); r.forEach((p, k) => (k ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1])))); g.closePath(); g.stroke(); }
    }
    function arrow() {
      G.arrow.clear(); const f = st.frame; if (!f || !f[st.ov.net] || !st.L.alert) return;
      const v = f[st.ov.net].v, L = Math.hypot(v[0], v[1]) * 30; if (L < 0.2) return;
      const a = new T.ArrowHelper(new T.Vector3(v[0], 0, -v[1]).normalize(), new T.Vector3(-14, H(-14, 13) + 0.5, -13), L, 0x6fe9ff, Math.min(1.6, L * 0.3), Math.min(0.9, L * 0.18));
      a.line.material.toneMapped = false; a.cone.material.toneMapped = false; G.arrow.add(a);
    }
    function poiTick(ph) {
      const f = st.frame; if (!f || !f.pois) return;
      G.poi.children.forEach((g, i) => { const q = f.pois[i]; if (!q || !g.userData.ring) return; const lv = q.lv;
        g.userData.ring.material.color.setHex(lv === 2 ? 0xff5c6e : lv === 1 ? 0xf0b44c : 0x4fe3c1);
        g.userData.ring.scale.setScalar(lv ? 1 + 0.35 * Math.abs(Math.sin(ph * 6.28 * (lv === 2 ? 1.6 : 0.9))) : 1); });
    }

    function setTime(t) {
      if (!st.res) return; st.t = t; const f = frameAt(t);
      if (f !== st.frame) { st.frame = f; overlay(); rays(st.L.rays ? f : null); arrow();
        if (st.L.vap === 'recon') vapor(f.vox); else if (st.L.vap === 'truth') vapor(WXCore.truthVox(st.data, st.scen, f.t, st.res.cfg)); else vapor(null); }
      if (st.L.cloud) clouds(t, st.anim); st.dirty = true;
    }
    function layers(o) {
      Object.assign(st.L, o || {});
      G.ground.visible = true; G.ground.children.forEach((m) => { m.material.map && (m.material.color.setScalar(st.L.img ? 1 : 0.35)); });
      G.bld.visible = st.L.bld; G.cloud.visible = G.rain.visible = st.L.cloud; G.rays.visible = st.L.rays; G.lbl.visible = st.L.lbl; G.vap.visible = st.L.vap !== 'off';
      G.over.visible = st.L.alert; G.arrow.visible = st.L.alert;
      if (st.frame) { const f = st.frame; st.frame = null; setTime(st.t); void f; }
      st.dirty = true;
    }
    function overlayMode(o) { Object.assign(st.ov, o || {}); if (st.frame) { overlay(); arrow(); } st.dirty = true; }

    // ── 카메라 ──
    const cv = { tgt: new T.Vector3(0, 1.5, 3), r: 62, th: 0.95, ph: 1.95 }; let goal = null;
    function view(name, now) {
      const V = { all: { tgt: [0, 1.2, 3], th: 0.95, ph: 1.95, r: 62 }, city: { tgt: [-1, 0.4, 4.2], th: 1.08, ph: 2.1, r: 13 }, river: { tgt: [0.8, 0.3, 8.2], th: 1.12, ph: 1.75, r: 8.5 },
        side: { tgt: [0, 5, 2], th: 1.42, ph: 1.62, r: 54 }, top: { tgt: [0, 0, 2], th: 0.08, ph: 1.571, r: 64 }, north: { tgt: [1, 0.4, -7], th: 1.05, ph: 1.9, r: 12 } }[name] || null;
      if (!V) return; goal = { tgt: new T.Vector3(...V.tgt), th: V.th, ph: V.ph, r: V.r };
      if (now) { cv.tgt.copy(goal.tgt); cv.th = goal.th; cv.ph = goal.ph; cv.r = goal.r; goal = null; } st.dirty = true;
    }
    function camApply() { const s = Math.sin(cv.th); cam.position.set(cv.tgt.x + cv.r * s * Math.cos(cv.ph), cv.tgt.y + cv.r * Math.cos(cv.th), cv.tgt.z + cv.r * s * Math.sin(cv.ph)); cam.lookAt(cv.tgt); }
    let drag = 0, px = 0, py = 0, pinch = 0;
    canvas.addEventListener('pointerdown', (e) => { drag = e.button === 2 || e.shiftKey ? 2 : 1; px = e.clientX; py = e.clientY; goal = null; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = 0; });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
      if (drag === 1) { cv.ph += dx * 0.006; cv.th = Math.max(0.06, Math.min(1.52, cv.th - dy * 0.006)); }
      else { const k = cv.r * 0.0016, f = new T.Vector3(Math.cos(cv.ph), 0, Math.sin(cv.ph)), rt = new T.Vector3(-f.z, 0, f.x); cv.tgt.addScaledVector(rt, dx * k).addScaledVector(f, dy * k); }
      st.dirty = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { cv.r = Math.max(1.2, Math.min(180, cv.r * Math.exp(e.deltaY * 0.0012))); goal = null; st.dirty = true; e.preventDefault(); }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { if (e.touches.length === 2) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (pinch) cv.r = Math.max(1.2, Math.min(180, cv.r * pinch / d)); pinch = d; st.dirty = true; e.preventDefault(); } }, { passive: false });
    canvas.addEventListener('touchend', () => { pinch = 0; });
    canvas.addEventListener('dblclick', () => view('all'));

    function resize() { const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1; rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); st.dirty = true; }
    addEventListener('resize', resize);
    let last = performance.now(), vis = true;
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { vis = es[0].isIntersecting; }).observe(canvas);
    function loop(t) {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      if (!vis || document.hidden) return;
      if (goal) { const f = 1 - Math.pow(0.002, dt); cv.tgt.lerp(goal.tgt, f); cv.th += (goal.th - cv.th) * f; cv.ph += (goal.ph - cv.ph) * f; cv.r += (goal.r - cv.r) * f; st.dirty = true; if (Math.abs(goal.r - cv.r) < 0.03) goal = null; }
      if (st.res) { st.anim = (st.anim + dt * 0.9) % 1; if (st.L.rays) pulseTick(st.anim); poiTick(st.anim); if (st.L.cloud) clouds(st.t, st.anim); st.dirty = true; }
      if (!st.dirty) return; st.dirty = false; camApply(); rn.render(scene, cam);
    }
    resize(); requestAnimationFrame(loop);
    function focus(x, y, r, th) { goal = { tgt: new T.Vector3(x, H(x, y) + 0.1, -y), th: th == null ? 1.1 : th, ph: cv.ph, r: r || 3 }; st.dirty = true; }
    return { load, setResult, setTime, layers, overlay: overlayMode, view, focus, resize, get state() { return st; } };
  }
  window.WX3D = { create, VZ };
})();
