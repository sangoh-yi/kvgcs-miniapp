/* flow3d.js — 신호 흐름 3D(2026-10-04 센터장님 "전체 자동화 · 첨단 · 실감나게 시각화" — 개선 2. 시각화 2).
 *   안테나 → 수신기 → DBBC3 → Core3H → FlexBuff → 망 → BONN · WACO 를 빛 알갱이 흐름으로 보인다.
 *   마디: 안테나는 세종 22m 실물 모형(작게, 지금 방위·고도) · 수신기 원통 · DBBC3·Core3H 육각 기둥 · FlexBuff 디스크 더미 ·
 *         망 고리 · 상관센터는 철망 지구. 마디 색 = 상태(정상 청록 · 대기 회청 · 장애 빨강 맥동 · 꺼짐 어둡게).
 *   줄: 흐름이면 알갱이가 그 속도로 흐르고(기록 중이면 빠르게, 전송은 MB/s 에 맞춰), 장애 마디 앞에서 멈추고 붉어진다.
 *   글은 캔버스에 쓰지 않는다 — 마디 이름·상태는 캔버스 아래 띠(labels)에, 마디 x 위치를 따라 놓는다.
 * 쓰기: const f = Flow3D.create(canvas, labelsEl, {glb}); f.set(state); f.resize(); f.dispose();
 *   state = { nodes: { ant:{st, sub}, rx, dbbc3, core3h, fb, net, bonn, waco }, chain: 'flow'|'idle'|'off', rec: bool,
 *             xfer: { to: 'BONN'|'WACO'|null, mbs, pct }, az, el }
 *   st: 'ok' | 'idle' | 'bad' | 'off' · sub: 띠에 쓸 짧은 글
 *   Flow3D.fromEngine(st, live) · Flow3D.fromMini(tsl, xfer) — 운용 화면·미니앱 자료에서 state 를 만든다
 */
'use strict';
(function () {
  const D2R = Math.PI / 180;
  const NODES = [
    ['ant', '안테나', -3.35, 0.0], ['rx', '수신기', -2.4, 0.18], ['dbbc3', 'DBBC3', -1.45, 0.26], ['core3h', 'Core3H', -0.5, 0.26],
    ['fb', 'FlexBuff', 0.45, 0.18], ['net', '망', 1.4, 0.0], ['bonn', 'BONN', 2.45, -0.5], ['waco', 'WACO', 3.3, 0.5],
  ];
  const LINKS = [['ant', 'rx', 'chain'], ['rx', 'dbbc3', 'chain'], ['dbbc3', 'core3h', 'chain'], ['core3h', 'fb', 'rec'],
                 ['fb', 'net', 'xfer'], ['net', 'bonn', 'xbonn'], ['net', 'waco', 'xwaco']];
  const COL = { ok: 0x3fdcb4, idle: 0x6c86a8, bad: 0xff4a3d, off: 0x2f3b4f, flow: 0x58d8ff };
  function glowTex(T) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new T.CanvasTexture(c); return t;
  }
  function create(canvas, labels, opts) {
    opts = opts || {};
    const T = window.THREE;
    if (!T) throw new Error('three.js 없음');
    const rn = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    rn.setClearColor(0x000000, 0); rn.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    rn.outputEncoding = T.sRGBEncoding; rn.toneMapping = T.ACESFilmicToneMapping; rn.toneMappingExposure = 0.9;
    const scene = new T.Scene(), cam = new T.PerspectiveCamera(26, 3, 0.1, 100);
    scene.add(new T.HemisphereLight(0xcfe3ff, 0x0c1424, 0.7));
    const key = new T.DirectionalLight(0xffffff, 1.6); key.position.set(-3, 6, 4); scene.add(key);
    const tex = glowTex(T);
    // 바닥 격자(아주 옅게)
    const grid = new T.GridHelper(9, 36, 0x1a3a63, 0x10233d); grid.position.y = -0.36; grid.material.transparent = true; grid.material.opacity = 0.5; grid.material.toneMapped = false; scene.add(grid);
    const N = {};
    const glass = (c) => new T.MeshStandardMaterial({ color: 0x0d1b2e, metalness: 0.4, roughness: 0.35, transparent: true, opacity: 0.85, emissive: c, emissiveIntensity: 0.08 });
    const edgeM = (c) => new T.LineBasicMaterial({ color: c, transparent: true, opacity: 0.9, toneMapped: false });
    for (const [k, name, x, z] of NODES) {
      const g = new T.Group(); g.position.set(x, 0, z); scene.add(g);
      let body = null;
      if (k === 'ant') body = null;                                                   // 실물 모형(아래)
      else if (k === 'rx') body = new T.CylinderGeometry(0.2, 0.2, 0.42, 24);
      else if (k === 'dbbc3' || k === 'core3h') body = new T.CylinderGeometry(0.24, 0.24, 0.46, 6);
      else if (k === 'fb') body = new T.BoxGeometry(0.42, 0.44, 0.34);
      else if (k === 'net') body = new T.TorusGeometry(0.2, 0.045, 10, 40);
      else body = new T.SphereGeometry(0.22, 18, 12);
      const n = { g, k, name, st: 'idle', col: new T.Color(COL.idle), meshes: [], edges: [] };
      if (body) {
        const m = new T.Mesh(body, glass(COL.idle)); if (k === 'net') m.rotation.x = Math.PI / 2; g.add(m); n.meshes.push(m);
        const e = new T.LineSegments(new T.EdgesGeometry(body, k === 'bonn' || k === 'waco' ? 30 : 1), edgeM(COL.idle));
        if (k === 'net') e.rotation.x = Math.PI / 2;
        if (k === 'bonn' || k === 'waco') { const w = new T.LineSegments(new T.WireframeGeometry(new T.SphereGeometry(0.225, 10, 7)), edgeM(COL.idle)); w.material.opacity = 0.35; g.add(w); n.edges.push(w); }
        g.add(e); n.edges.push(e);
        if (k === 'fb') for (let i = -1; i <= 1; i++) { const d = new T.Mesh(new T.BoxGeometry(0.44, 0.02, 0.36), new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.8, toneMapped: false })); d.position.y = i * 0.13; g.add(d); n.edges.push(d); }
      }
      const core = new T.Sprite(new T.SpriteMaterial({ map: tex, color: COL.idle, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.6 }));
      core.scale.set(0.5, 0.5, 1); core.position.y = k === 'ant' ? 0.32 : 0; g.add(core); n.core = core;
      const ring = new T.Mesh(new T.RingGeometry(0.3, 0.335, 48), new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.5, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = -0.34; g.add(ring); n.ring = ring;
      N[k] = n;
    }
    // 안테나 마디 = 실물 모형(작게)
    let ANT = null;
    if (window.Sejong22m && T.GLTFLoader) {
      const wrap = new T.Group(); wrap.position.y = -0.34; N.ant.g.add(wrap);
      ANT = Sejong22m.add(scene, { url: opts.glb || 'models/sejong22m.glb', scale: 0.024, shadow: false, glow: false, parent: wrap });
    }
    // 줄 — 마디 사이 곡선 · 알갱이
    const L = [];
    const P = (k) => N[k].g.position.clone().setY(0);
    for (const [a, b, kind] of LINKS) {
      const pa = P(a), pb = P(b), mid = pa.clone().lerp(pb, 0.5).add(new T.Vector3(0, 0.12, 0));
      const curve = new T.QuadraticBezierCurve3(pa, mid, pb);
      const tube = new T.Mesh(new T.TubeGeometry(curve, 40, 0.018, 6, false), new T.MeshBasicMaterial({ color: COL.idle, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
      scene.add(tube);
      const n = 26, pos = new Float32Array(n * 3), geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const mat = new T.PointsMaterial({ map: tex, color: COL.flow, size: 0.17, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.95, toneMapped: false });
      const pts = new T.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
      const u = []; for (let i = 0; i < n; i++) u.push(i / n + Math.random() * 0.02);
      L.push({ a, b, kind, curve, tube, pts, pos, geo, u, n, st: 'off', speed: 0 });
    }
    // 시점 — 앞 조금 위에서, 마우스를 대면 그쪽으로 살짝 기운다
    let th = 0.98, ph = 0, swayT = 0, mx = 0, my = 0, lw = 0, lh = 0, fitR = 8, visible = true, raf = 0, last = 0, state = null;
    canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mx = ((e.clientX - r.left) / r.width - 0.5) * 2; my = ((e.clientY - r.top) / r.height - 0.5) * 2; });
    canvas.addEventListener('pointerleave', () => { mx = 0; my = 0; });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);
    // 이름 띠
    const lab = {};
    if (labels) {
      labels.innerHTML = NODES.map(([k, name]) => `<div class="fl-lab" data-k="${k}"><b>${name}</b><span></span></div>`).join('');
      for (const el of labels.querySelectorAll('.fl-lab')) lab[el.dataset.k] = el;
    }
    const v3 = new T.Vector3();
    function placeLabels() {
      if (!labels || !lw) return;
      const nar = lw < 640;                                  // 좁으면(휴대폰) 이름을 두 줄로 엇갈려 놓는다
      if (labels.classList.contains('narrow') !== nar) labels.classList.toggle('narrow', nar);
      for (const k in lab) {
        v3.copy(N[k].g.position); v3.y = -0.36; v3.project(cam);
        lab[k].style.left = ((v3.x * 0.5 + 0.5) * 100).toFixed(2) + '%';
      }
    }
    function setNode(k, st, sub) {
      const n = N[k];
      if (!n) return;
      if (lab[k]) {
        const s = lab[k].querySelector('span'), t = sub || ({ ok: '정상', idle: '대기', bad: '장애', off: '꺼짐' }[st] || '');
        if (s.textContent !== t) s.textContent = t;
        lab[k].className = 'fl-lab st-' + st;
      }
      if (n.st === st) return;
      n.st = st; n.col.setHex(COL[st] || COL.idle);
      for (const m of n.meshes) { m.material.emissive.copy(n.col); m.material.emissiveIntensity = st === 'off' ? 0.02 : 0.12; }
      for (const e of n.edges) e.material.color.copy(n.col);
      n.core.material.color.copy(n.col); n.ring.material.color.copy(n.col);
    }
    function apply() {
      const s = state || { nodes: {} }, nd = s.nodes || {};
      for (const [k] of NODES) setNode(k, (nd[k] && nd[k].st) || 'off', nd[k] && nd[k].sub);
      // 줄 상태 — 앞 마디가 장애면 그 뒤로는 끊김, 들어가는 줄은 붉게 멈춤
      const order = ['ant', 'rx', 'dbbc3', 'core3h', 'fb', 'net'];
      let broken = -1;
      for (let i = 0; i < order.length; i++) if ((nd[order[i]] || {}).st === 'bad') { broken = i; break; }
      const xf = s.xfer || {}, mbs = +xf.mbs || 0;
      for (const l of L) {
        let st = 'off', sp = 0;
        if (l.kind === 'chain') { st = s.chain === 'flow' ? 'flow' : s.chain === 'idle' ? 'idle' : 'off'; sp = st === 'flow' ? 0.5 : 0.12; }
        else if (l.kind === 'rec') { st = s.rec ? 'flow' : s.chain === 'off' ? 'off' : 'idle'; sp = s.rec ? 0.75 : 0.08; }
        else if (l.kind === 'xfer') { st = xf.to ? 'flow' : 'off'; sp = 0.25 + Math.min(1.2, mbs / 150); }
        else if (l.kind === 'xbonn') { st = xf.to === 'BONN' ? 'flow' : 'off'; sp = 0.25 + Math.min(1.2, mbs / 150); }
        else if (l.kind === 'xwaco') { st = xf.to === 'WACO' ? 'flow' : 'off'; sp = 0.25 + Math.min(1.2, mbs / 150); }
        const ia = order.indexOf(l.a), ib = order.indexOf(l.b);
        if (broken >= 0) {
          if (ib === broken) st = 'bad';
          else if (ia >= broken && ia >= 0) st = 'off';
        }
        if ((nd[l.b] || {}).st === 'bad') st = 'bad';
        l.st = st; l.speed = sp;
        l.tube.material.color.setHex(st === 'bad' ? COL.bad : st === 'flow' ? COL.flow : st === 'idle' ? COL.idle : COL.off);
        l.tube.material.opacity = st === 'flow' ? 0.5 : st === 'bad' ? 0.6 : st === 'idle' ? 0.32 : 0.16;
        l.pts.material.color.setHex(st === 'bad' ? COL.bad : COL.flow);
        l.pts.visible = st === 'flow' || st === 'idle' || st === 'bad';
      }
      if (ANT && s.az != null && s.el != null) ANT.place(s.az, s.el);
    }
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !visible || !canvas.clientWidth) { last = t; return; }
      if (t - last < 33) return;
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      swayT += dt;
      const tph = ph + 0.07 * Math.sin(swayT * 0.25) + mx * 0.12, tth = th - my * 0.06;
      const r = fitR;
      cam.position.set(r * Math.sin(tth) * Math.sin(tph), r * Math.cos(tth), r * Math.sin(tth) * Math.cos(tph));
      cam.lookAt(0, -0.05, 0);
      const pulse = 0.5 + 0.5 * Math.sin(t / 260);
      for (const k in N) {
        const n = N[k], bad = n.st === 'bad';
        n.core.material.opacity = bad ? 0.45 + 0.5 * pulse : n.st === 'ok' ? 0.55 + 0.15 * Math.sin(t / 900 + n.g.position.x) : n.st === 'idle' ? 0.32 : 0.1;
        const s = bad ? 0.55 + 0.25 * pulse : 0.5; n.core.scale.set(s, s, 1);
        n.ring.material.opacity = bad ? 0.35 + 0.5 * pulse : n.st === 'off' ? 0.15 : 0.45;
        if (n.k === 'net' && n.meshes[0]) n.meshes[0].rotation.z += dt * (n.st === 'ok' ? 0.8 : 0.1);
        if ((n.k === 'bonn' || n.k === 'waco') && n.edges[0]) n.edges[0].rotation.y += dt * 0.3;
      }
      for (const l of L) {
        if (!l.pts.visible) continue;
        const v = l.st === 'bad' ? 0 : l.speed;
        for (let i = 0; i < l.n; i++) {
          let u = l.u[i] + v * dt;
          if (u >= 1) u -= 1;
          if (l.st === 'bad') u = Math.min(u, 0.92);                     // 장애 마디 앞에서 멈춘다
          l.u[i] = u;
          const p = l.curve.getPoint(l.st === 'idle' && i % 4 ? 2 : u);  // 대기는 네 알갱이 가운데 하나만
          l.pos[i * 3] = p.x; l.pos[i * 3 + 1] = p.y; l.pos[i * 3 + 2] = p.z;
        }
        l.geo.attributes.position.needsUpdate = true;
        l.pts.material.opacity = l.st === 'bad' ? 0.4 + 0.5 * pulse : l.st === 'idle' ? 0.45 : 0.95;
        l.pts.material.size = l.st === 'flow' ? 0.17 : 0.1;
      }
      placeLabels();
      rn.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);
    return {
      set(s) { state = s; apply(); },
      resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return false;
        if (w === lw && h === lh) return true;
        lw = w; lh = h; rn.setSize(w, h, false); cam.aspect = w / h;
        const half = w < 640 ? 3.75 : 3.95, hf = Math.atan(Math.tan(cam.fov * D2R / 2) * cam.aspect);   // 가로로 마디 여덟이 다 들게
        fitR = Math.max(3.4, half / Math.tan(hf) + (w < 640 ? 0.9 : 1.6));
        cam.updateProjectionMatrix(); return true;
      },
      dispose() { cancelAnimationFrame(raf); rn.dispose(); },
    };
  }

  // ── 자료 → 상태 ──
  const SPEED = (s) => { const m = String(s || '').match(/([\d.]+)\s*(G|M|K)?B\/s/i); if (!m) return 0; const v = +m[1]; const u = (m[2] || 'M').toUpperCase(); return u === 'G' ? v * 1000 : u === 'K' ? v / 1000 : v; };
  function corrOf(x) { const c = String(x || '').toUpperCase(); return c.indexOf('WACO') >= 0 || c.indexOf('WASH') >= 0 ? 'WACO' : c ? 'BONN' : null; }
  // 운용 화면 — 엔진 /api/state(+ 콘솔 /api/live 전송)
  function fromEngine(st, live) {
    st = st || {};
    const r = st.real || {}, real = r.mode === 'real', a = st.antenna || {}, sess = st.session || null;
    const al = (st.alerts && st.alerts.active) || [], has = (re) => al.some((x) => re.test(String((x && x.key) || '')));
    const SJ = window.Sejong22m, fl = SJ ? SJ.faults(al) : { mount: false, hub: false, data: false };
    const rts = (st.recorder && st.recorder.runtimes) || [], nrec = rts.filter((x) => x && x.on).length, rec = nrec > 0;
    const mc = r.mcast || {}, tun = r.tunnel ? !!r.tunnel.alive : !real;
    const running = !!(sess && ['RUNNING', 'ARMED', 'REC_TEST', 'SETUP', 'CROSS', 'FINISHING'].indexOf(sess.state) >= 0);
    const sig = real ? (!!mc.connected || running) : !!sess;          // 신호가 오고 있다고 볼 근거 — 실장비는 멀티캐스트
    const et = live && live.ok !== false && live.et, xto = et && !et.done && et.pct != null ? corrOf(et.corr) : null;
    const point = String(a.point || '');
    const nodes = {
      ant: { st: fl.mount ? 'bad' : point.indexOf('Halt') >= 0 ? 'bad' : (a.az != null ? 'ok' : 'off'),
             sub: a.az != null ? `${Math.round(((+a.az % 360) + 360) % 360)}° · ${Math.round(+a.el || 0)}°` : '' },
      rx: { st: has(/^(rx|tsys_nocal)/) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      dbbc3: { st: has(/^(dbbc3|tsys_frozen|bbc_|setup_)/) ? 'bad' : (real ? (mc.connected ? 'ok' : 'idle') : sig ? 'ok' : 'idle'),
               sub: real && mc.connected ? '멀티캐스트 ' + Math.round(+mc.age || 0) + ' s' : '' },
      core3h: { st: has(/^core3h/) ? 'bad' : rec || sig ? 'ok' : 'idle', sub: '' },
      fb: { st: has(/^(rec_|boot_recorder)/) ? 'bad' : rec ? 'ok' : 'idle', sub: rec ? `기록 ${nrec}줄기` : '대기' },
      net: { st: has(/^tunnel_down/) || (real && !tun) ? 'bad' : xto ? 'ok' : tun ? 'idle' : 'off', sub: real ? (tun ? '터널 열림' : '터널 끊김') : '' },
      bonn: { st: xto === 'BONN' ? 'ok' : 'off', sub: xto === 'BONN' ? `${et.speed || ''} · ${Math.round(+et.pct || 0)}%` : '' },
      waco: { st: xto === 'WACO' ? 'ok' : 'off', sub: xto === 'WACO' ? `${et.speed || ''} · ${Math.round(+et.pct || 0)}%` : '' },
    };
    return { nodes, chain: sig ? 'flow' : (a.az != null ? 'idle' : 'off'), rec, xfer: { to: xto, mbs: et ? SPEED(et.speed) : 0, pct: et ? +et.pct : null },
             az: a.az != null ? +a.az : null, el: a.el != null ? +a.el : null };
  }
  // 미니앱 — threestar_live(경보는 제목만) · 전송은 콘솔 상태의 transfers 가운데 지금 도는 것
  function fromMini(t, xfers) {
    t = t || {};
    const a = t.antenna || {}, sess = t.session || null, open = t.real_open || [], mc = t.mcast || {};
    const SJ = window.Sejong22m, fl = SJ ? SJ.faults(t.alerts || []) : { mount: false, hub: false, data: false };
    const rts = (t.recorder && t.recorder.runtimes) || [], nrec = rts.filter((x) => x && x.on).length, rec = nrec > 0;
    const running = !!(sess && ['RUNNING', 'ARMED', 'REC_TEST', 'SETUP', 'CROSS', 'FINISHING'].indexOf(sess.state) >= 0);
    const sig = !!mc.connected || running, tun = !!t.tunnel;
    // 미니앱 전송(콘솔 kvgcs_status.transfers) — {exp, target, pct, rate_mbs, eta_h, done_groups, total_groups}
    const x = (xfers || []).find((v) => v && !v.done && (v.pct == null || +v.pct < 100) && (v.pct != null || v.rate_mbs != null || v.speed)) || null;
    const xto = x ? corrOf(x.corr || x.target || x.dest || x.to) : null, xmbs = x ? (isFinite(+x.rate_mbs) && x.rate_mbs != null ? +x.rate_mbs : SPEED(x.speed)) : 0;
    const xsub = x ? `${xmbs ? Math.round(xmbs) + ' MB/s' : ''}${x.pct != null ? (xmbs ? ' · ' : '') + Math.round(+x.pct) + '%' : ''}` : '';
    const point = String(a.point || '');
    const nodes = {
      ant: { st: fl.mount || point.indexOf('Halt') >= 0 ? 'bad' : a.az != null ? 'ok' : 'off', sub: a.az != null ? `${Math.round(((+a.az % 360) + 360) % 360)}° · ${Math.round(+a.el || 0)}°` : '' },
      rx: { st: fl.hub && /수신기|다이오드/.test(fl.why.hub.join(' ')) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      dbbc3: { st: fl.hub && /DBBC3|BBC|Tsys|채널/.test(fl.why.hub.join(' ')) ? 'bad' : mc.connected ? 'ok' : 'idle', sub: mc.connected ? '멀티캐스트' : '' },
      core3h: { st: fl.hub && /Core3H/.test(fl.why.hub.join(' ')) ? 'bad' : sig ? 'ok' : 'idle', sub: '' },
      fb: { st: fl.data && /기록|FlexBuff|빈 스캔|용량/.test(fl.why.data.join(' ')) ? 'bad' : rec ? 'ok' : 'idle', sub: rec ? `기록 ${nrec}줄기` : '대기' },
      net: { st: !tun ? 'bad' : xto ? 'ok' : 'idle', sub: tun ? '터널 열림' : '터널 끊김' },
      bonn: { st: xto === 'BONN' ? 'ok' : 'off', sub: xto === 'BONN' ? xsub : '' },
      waco: { st: xto === 'WACO' ? 'ok' : 'off', sub: xto === 'WACO' ? xsub : '' },
    };
    return { nodes, chain: sig ? 'flow' : a.az != null ? 'idle' : 'off', rec, xfer: { to: xto, mbs: xmbs, pct: x && x.pct != null ? +x.pct : null },
             az: a.az != null ? +a.az : null, el: a.el != null ? +a.el : null };
  }
  window.Flow3D = { create, fromEngine, fromMini };
})();
