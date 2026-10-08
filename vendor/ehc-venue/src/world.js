// ---------- Venue: Emirates Hematology Conference 2026 · Conrad Dubai (digital twin layout) ----------
// Units are metres. +x = east, -z = north. Floor at y = 0.
const EVENT = {
  name: 'Emirates Hematology Conference 2026',
  short: 'EHC 2026',
  date: '4 September 2026',
  venue: 'Conrad Dubai',
  organiser: 'Emirates Society of Haematology',
};
// EA-SYS: the event's real name, dates and venue arrive as window.EHC_EVENT (strings only), so the
// signs can never disagree with the event; anything not sent keeps the value above.
(() => {
  const src = typeof window !== 'undefined' && window.EHC_EVENT && typeof window.EHC_EVENT === 'object' ? window.EHC_EVENT : {};
  for (const k of Object.keys(EVENT)) if (typeof src[k] === 'string' && src[k].trim()) EVENT[k] = src[k].trim().slice(0, 120);
  if (typeof document === 'undefined') return;
  const set = (sel, t, i = 0) => { const el = document.querySelectorAll(sel)[i]; if (el) el.textContent = t; };
  document.title = EVENT.short + ' Venue';
  set('.start-hero .k', EVENT.organiser); set('#st', EVENT.name);
  set('.start-hero .facts span', EVENT.date, 0); set('.start-hero .facts span', EVENT.venue, 1);
  set('.zone .k', EVENT.short + ' · ' + EVENT.venue);
  set('#agenda .card > .k', EVENT.name + ' · ' + EVENT.date + ' · ' + EVENT.venue);
})();

const ZONES = [
  { id: 'foyer', name: 'Grand Foyer', sub: 'Registration · Welcome', rect: [-30, 0, 30, 30], ceil: 7, spawn: [0, 26.5, Math.PI], floor: 'marble' },
  { id: 'plenary', name: 'Plenary Ballroom', sub: 'Main stage', rect: [-22, -44, 22, 0], ceil: 9, spawn: [0, -2.5, Math.PI], floor: 'carpetG' },
  { id: 'posters', name: 'Poster Gallery', sub: 'Abstracts · E-posters', rect: [-30, -44, -22, 0], ceil: 5.5, spawn: [-24.2, -9, Math.PI], floor: 'wood' },
  { id: 'hallA', name: 'Hall A', sub: 'Parallel sessions', rect: [-56, 12, -30, 30], ceil: 6, spawn: [-33.5, 16.5, -Math.PI / 2], floor: 'carpet', tint: [0.3, 0.5, 0.52] },
  { id: 'hallB', name: 'Hall B', sub: 'Parallel sessions', rect: [-56, -6, -30, 12], ceil: 6, spawn: [-33.5, 1.5, -Math.PI / 2], floor: 'carpet', tint: [0.38, 0.4, 0.64] },
  { id: 'hallC', name: 'Hall C', sub: 'Parallel sessions', rect: [-56, -24, -30, -6], ceil: 6, spawn: [-33.5, -19.5, -Math.PI / 2], floor: 'carpet', tint: [0.56, 0.34, 0.48] },
  { id: 'workshop', name: 'Workshop Room', sub: 'Hands-on sessions', rect: [-56, -44, -30, -24], ceil: 5.5, spawn: [-32.8, -31.5, -Math.PI / 2], floor: 'carpet', tint: [0.7, 0.64, 0.56] },
  { id: 'promenade', name: 'East Promenade', sub: 'Link to lounge & exhibition', rect: [22, -20, 30, 0], ceil: 5.5, spawn: [26, -2, Math.PI], floor: 'marble' },
  { id: 'lounge', name: 'Networking Lounge', sub: 'Coffee · Meetings', rect: [22, -44, 46, -20], ceil: 5.5, spawn: [27, -22.5, Math.PI], floor: 'wood' },
  { id: 'expo', name: 'Exhibition Hall', sub: 'Partners · Host society', rect: [30, -20, 70, 30], ceil: 7, spawn: [33, 15, Math.PI / 2], floor: 'carpet', tint: [0.42, 0.4, 0.42] },
];
const WORLD_BOUNDS = [-56, -44, 70, 30];

function zoneAt(x, z) {
  for (const Z of ZONES) { const r = Z.rect; if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return Z; }
  return null;
}

function buildWorld(R, Q) {
  const B = {};
  const T = {
    marble: R.texFromCanvas(TEX.marble()), carpetG: R.texFromCanvas(TEX.carpetGarnet()), carpet: R.texFromCanvas(TEX.carpetGrey()),
    wood: R.texFromCanvas(TEX.wood()), fabric: R.texFromCanvas(TEX.fabric()), ceil: R.texFromCanvas(TEX.ceiling()),
    blob: R.texFromCanvas(TEX.blob(), { clamp: true }), sky: R.texFromCanvas(TEX.skyline(), { clamp: true }),
  };
  const MAT = {
    marble: { tex: 'marble', spec: 0.9, shin: 70 }, carpetG: { tex: 'carpetG', spec: 0.05 }, carpet: { tex: 'carpet', spec: 0.05 },
    wood: { tex: 'wood', spec: 0.35, shin: 40 }, wall: { tex: 'fabric', ao: 1.4, spec: 0.08 }, ceil: { tex: 'ceil', spec: 0 },
    plain: { spec: 0.25, shin: 30 }, metal: { spec: 1.4, shin: 90 }, emis: { spec: 0 }, green: { spec: 0.1 },
    glass: { spec: 1.6, shin: 140, alpha: 0.14 }, signs: { tex: 'atlas', unlit: 0.8 }, sky: { tex: 'sky', unlit: 1 },
    shadow: { tex: 'blob', unlit: 1, blend: true }, inlay: { tex: 'inlay', blend: true, spec: 0.7, shin: 60 },
  };
  const bat = (m) => B[m] || (B[m] = new Batch(m, MAT[m]));
  const colliders = [], lights = [], interact = [], people = [], screens = [], seats = [], balls = [], halo = [];
  const A = new Atlas(2048);

  // --- primitives
  const UVW = { marble: 0.5, carpetG: 1 / 3, carpet: 0.45, wood: 0.5, wall: 0.5, ceil: 1 / 3 };
  const uvFor = (m) => UVW[m] ? { mode: 'world', s: UVW[m] } : null;
  function box(m, x0, y0, z0, x1, y1, z1, col = [1, 1, 1, 0], o = {}) {
    bat(m).add(MESH.box, M4.trs((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, x1 - x0, y1 - y0, z1 - z0), col, o.uv || uvFor(m));
    if (o.col) colliders.push({ x0, y0, z0, x1, y1, z1 });
  }
  function boxR(m, cx, cy, cz, sx, sy, sz, ry, col, o = {}) { bat(m).add(MESH.box, M4.trs(cx, cy, cz, ry, sx, sy, sz), col, o.uv || uvFor(m)); }
  function cyl(m, cx, y0, cz, r, y1, col, o = {}) {
    bat(m).add(o.lo ? MESH.cylLo : MESH.cyl, M4.trs(cx, (y0 + y1) / 2, cz, 0, r * 2, y1 - y0, r * 2), col, o.uv || null);
    if (o.col) colliders.push({ c: 1, cx, cz, r, y0, y1 });
  }
  function sph(m, cx, cy, cz, sx, sy, sz, col) { bat(m).add(MESH.sphereLo, M4.trs(cx, cy, cz, 0, sx, sy, sz), col); }
  function quad(m, cx, cy, cz, w, h, ry, col, uv) { bat(m).add(MESH.plane, M4.trs(cx, cy, cz, ry, w, h, 1), col, uv); }
  const signCache = {};
  function sign(cx, cy, cz, w, h, ry, spec) { const key = JSON.stringify([w, h, spec]); const d = Math.min(90, 900 / w); const r = signCache[key] || (signCache[key] = DRAW.sign(A, Math.round(w * d), Math.round(h * d), spec)); quad('signs', cx, cy, cz, w, h, ry, [1, 1, 1, 0], { mode: 'rect', r: r.uv }); }
  function blob(cx, cz, sx, sz, y = 0.015) { const m = M4.ident(); M4.t(m, cx, y, cz); M4.rx(m, -Math.PI / 2); M4.s(m, sx, sz, 1); bat('shadow').add(MESH.plane, m, [0, 0, 0, 0]); }
  function light(x, y, z, range, c, i) { lights.push({ p: [x, y, z], r: range, c, i }); }
  function plant(x, z, s = 1) {
    cyl('plain', x, 0, z, 0.38 * s, 0.7 * s, [0.2, 0.17, 0.16, 0], { col: true });
    cyl('metal', x, 0.66 * s, z, 0.4 * s, 0.72 * s, [0.78, 0.62, 0.38, 0]);
    for (let k = 0; k < 6; k++) { const a = k * 1.05; sph('green', x + Math.cos(a) * 0.22 * s, (0.95 + (k % 3) * 0.22) * s, z + Math.sin(a) * 0.22 * s, 0.5 * s, 0.6 * s, 0.5 * s, [0.22 + k * 0.02, 0.4, 0.24, 0]); }
    sph('green', x, 1.45 * s, z, 0.45 * s, 0.55 * s, 0.45 * s, [0.25, 0.45, 0.27, 0]);
    blob(x, z, 1.3 * s, 1.3 * s);
  }
  function chair(x, z, yaw, frame, cushion, seatList, y = 0) {
    const m = (lx, ly, lz, sx, sy, sz, col, mt = 'plain') => { const M = M4.ident(); M4.t(M, x, y, z); M4.ry(M, yaw); M4.t(M, lx, ly, lz); M4.s(M, sx, sy, sz); bat(mt).add(MESH.box, M, col); };
    m(0, 0.45, 0, 0.48, 0.08, 0.46, cushion); m(0, 0.78, -0.21, 0.46, 0.5, 0.06, cushion);
    m(-0.22, 0.21, 0, 0.035, 0.42, 0.42, frame, 'metal'); m(0.22, 0.21, 0, 0.035, 0.42, 0.42, frame, 'metal');
    if (seatList) seatList.push({ x, z, yaw });
  }
  function screen(cx, cy, cz, w, h, ry, spec) {
    const cv = mkCanvas(1024, Math.round(1024 * h / w)); drawScreen(cv, 0, spec);
    const tex = R.texFromCanvas(cv, { clamp: true, nomip: true });
    const b = new Batch('screen', { unlit: 1 }); b.add(MESH.plane, M4.trs(cx, cy, cz, ry, w, h, 1), [1, 1, 1, 0]);
    // bezel
    boxR('plain', cx - Math.sin(ry) * 0.06, cy, cz - Math.cos(ry) * 0.06, w + 0.18, h + 0.18, 0.1, ry, [0.06, 0.05, 0.05, 0]);
    screens.push({ cv, tex, batch: b, spec, pos: [cx, cy, cz], dirty: true });
  }
  function hit(id, x, z, r, prompt, title, body, kind = 'info') { interact.push({ id, x, z, r, prompt, title, body, kind }); }

  // --- walls with openings
  const WT = 0.3;
  function wall(axis, k, a0, a1, h, opens = [], o = {}) {
    opens = opens.slice().sort((p, q) => p.a - q.a);
    let cur = a0; const segs = [];
    for (const op of opens) { if (op.a > cur) segs.push([cur, op.a]); cur = op.b; }
    if (cur < a1) segs.push([cur, a1]);
    const mk = (p0, p1, y0, y1, mat, collide, thick = WT, col = [0.93, 0.89, 0.84, 0]) => {
      if (axis === 'x') box(mat, p0, y0, k - thick / 2, p1, y1, k + thick / 2, col, { col: collide });
      else box(mat, k - thick / 2, y0, p0, k + thick / 2, y1, p1, col, { col: collide });
    };
    for (const [p0, p1] of segs) { mk(p0, p1, 0, h, 'wall', true); mk(p0, p1, 0, 0.14, 'wood', false, WT + 0.06, [0.45, 0.32, 0.24, 0]); }
    for (const op of opens) {
      const y0 = op.y0 || 0, y1 = op.y1 || 3.6;
      if (y0 > 0) mk(op.a, op.b, 0, y0, 'wall', true);
      if (y1 < h) mk(op.a, op.b, y1, h, 'wall', true);
      if (op.glass) {
        if (axis === 'x') { colliders.push({ x0: op.a, y0: 0, z0: k - 0.15, x1: op.b, y1: h, z1: k + 0.15 }); quad('glass', (op.a + op.b) / 2, (y0 + y1) / 2, k, op.b - op.a, y1 - y0, 0, [0.75, 0.85, 0.9, 0]); }
        else { colliders.push({ x0: k - 0.15, y0: 0, z0: op.a, x1: k + 0.15, y1: h, z1: op.b }); quad('glass', k, (y0 + y1) / 2, (op.a + op.b) / 2, op.b - op.a, y1 - y0, Math.PI / 2, [0.75, 0.85, 0.9, 0]); }
        const n = Math.max(1, Math.round((op.b - op.a) / 2.5));
        for (let i = 0; i <= n; i++) { const p = op.a + (op.b - op.a) * i / n; mk(p - 0.05, p + 0.05, y0, y1, 'metal', false, 0.2, [0.2, 0.19, 0.2, 0]); }
        mk(op.a, op.b, y1 - 0.08, y1, 'metal', false, 0.2, [0.2, 0.19, 0.2, 0]);
      } else {
        const brass = [0.8, 0.64, 0.4, 0];
        mk(op.a - 0.12, op.a, 0, y1, 'metal', false, WT + 0.1, brass); mk(op.b, op.b + 0.12, 0, y1, 'metal', false, WT + 0.1, brass); mk(op.a - 0.12, op.b + 0.12, y1, y1 + 0.12, 'metal', false, WT + 0.1, brass);
      }
    }
  }

  // --- floors & ceilings
  for (const Z of ZONES) {
    const [x0, z0, x1, z1] = Z.rect, t = Z.tint || [1, 1, 1];
    const ft = Z.floor === 'marble' ? 0.8 : Z.floor === 'wood' ? 0.85 : 1;
    box(Z.floor, x0, -0.2, z0, x1, 0, z1, [t[0] * ft, t[1] * ft, t[2] * ft, 0]);
    bat('ceil').add(MESH.plane, (() => { const m = M4.ident(); M4.t(m, (x0 + x1) / 2, Z.ceil, (z0 + z1) / 2); M4.rx(m, Math.PI / 2); M4.s(m, x1 - x0, z1 - z0, 1); return m; })(), [1, 1, 1, 0], { mode: 'world', s: 1 / 3 });
    // ceiling light pattern + point lights
    const sp = Z.id === 'plenary' ? 0 : 6.5;
    if (sp) for (let x = x0 + sp / 2; x < x1; x += sp) for (let z = z0 + sp / 2; z < z1; z += sp) {
      if (Z.id === 'foyer' || Z.id === 'promenade' || Z.id === 'lounge') cyl('emis', x, Z.ceil - 0.04, z, 0.28, Z.ceil, [1, 0.92, 0.8, 1.2], { lo: true });
      else box('emis', x - 1.4, Z.ceil - 0.06, z - 0.12, x + 1.4, Z.ceil, z + 0.12, [1, 0.97, 0.92, 1.1]);
    }
    const ls = 9;
    for (let x = x0 + ls / 2; x < x1 + 0.1; x += ls) for (let z = z0 + ls / 2; z < z1 + 0.1; z += ls)
      if (Z.id !== 'plenary') light(Math.min(x, x1 - 1), Z.ceil - 0.8, Math.min(z, z1 - 1), 13, [1, 0.88, 0.74], 1.05);
  }

  // --- walls
  const glassH = { glass: true, y0: 0, y1: 6.4 };
  wall('x', 30, -56, 70, 7, [{ a: -29, b: 29, ...glassH }]);                       // south façade (glass in foyer)
  wall('z', -56, -44, 30, 6);                                                       // west
  wall('x', -44, -56, 46, 9, [{ a: 24, b: 44, glass: true, y0: 0.55, y1: 4.9 }]);   // north (lounge windows)
  wall('z', 70, -20, 30, 7);                                                        // east
  wall('x', -20, 46, 70, 7);                                                        // expo north (beyond lounge)
  wall('z', 46, -44, -20, 5.5);                                                     // lounge east
  wall('z', -30, -44, 30, 7, [{ a: -37, b: -33 }, { a: -17, b: -13 }, { a: 4, b: 8 }, { a: 19, b: 23 }]);
  wall('x', 12, -56, -30, 6); wall('x', -6, -56, -30, 6); wall('x', -24, -56, -30, 6);
  wall('z', -22, -44, 0, 9, [{ a: -12, b: -9 }]);
  wall('x', 0, -30, 30, 9, [{ a: -29, b: -23 }, { a: -4, b: 4, y1: 4.6 }, { a: 23, b: 29 }]);
  wall('z', 22, -44, 0, 9, [{ a: -12, b: -9 }]);
  wall('z', 30, -20, 30, 7, [{ a: -14, b: -6 }, { a: 8, b: 22, y1: 4.8 }]);
  wall('x', -20, 30, 46, 7, [{ a: 33, b: 43, y1: 4.2 }]);

  // skyline backdrops
  quad('sky', 0, 16, 62, 230, 58, Math.PI, [1, 1, 1, 0], { mode: 'mesh' });
  quad('sky', 34, 16, -78, 200, 50, 0, [1, 1, 1, 0], { mode: 'mesh' });

  // ===== GRAND FOYER =====
  for (const [px, pz] of [[-18, 6], [18, 6], [-18, 25], [18, 25]]) {
    box('marble', px - 0.55, 0, pz - 0.55, px + 0.55, 7, pz + 0.55, [0.92, 0.88, 0.82, 0], { col: true });
    for (const y of [0.2, 6.6]) box('metal', px - 0.6, y, pz - 0.6, px + 0.6, y + 0.12, pz + 0.6, [0.8, 0.64, 0.4, 0]);
    blob(px, pz, 2.2, 2.2);
  }
  // registration desk (west) and information desk (east)
  for (const [x0, x1, title, sub] of [[-26, -12, 'Registration', 'Badge collection · Delegate services'], [12, 22, 'Information', 'Programme & venue help']]) {
    box('wood', x0, 0, 17.6, x1, 1.0, 18.6, [0.55, 0.38, 0.28, 0], { col: true });
    box('marble', x0 - 0.1, 1.0, 17.5, x1 + 0.1, 1.08, 18.7, [0.95, 0.92, 0.88, 0]);
    box('emis', x0, 0.12, 18.61, x1, 0.16, 18.63, [0.95, 0.25, 0.32, 0.9]);
    sign((x0 + x1) / 2, 4.3, 18.1, 7, 1.3, 0, { kicker: EVENT.name, title, sub });
    for (const dx of [-2.8, 2.8]) cyl('metal', (x0 + x1) / 2 + dx, 4.95, 18.1, 0.015, 7, [0.6, 0.6, 0.6, 0], { lo: true });
    blob((x0 + x1) / 2, 18.1, x1 - x0 + 1, 2.2);
    const n = Math.max(2, Math.round((x1 - x0) / 4));
    for (let i = 0; i < n; i++) { const sx = x0 + (i + 0.5) * (x1 - x0) / n; people.push({ x: sx, z: 17.0, yaw: 0, pose: 'stand', role: 'staff' }); boxR('plain', sx, 1.2, 17.9, 0.5, 0.32, 0.03, -0.25, [0.1, 0.1, 0.12, 0]); }
    hit(title, (x0 + x1) / 2, 19.6, 3.2, title === 'Registration' ? 'Collect your badge' : 'Ask the information desk', title === 'Registration' ? 'Registration & badge collection' : 'Information desk',
      title === 'Registration' ? 'Delegates collect badges here on arrival. In the live build this desk links to EA-SYS registration so a delegate sees their own badge and session bookings.' : 'Programme queries and venue help. Link the official agenda to show the full day programme here.');
  }
  // self-service badge kiosks
  for (const z of [22, 24, 26]) { box('plain', -9.3, 0, z - 0.25, -8.7, 1.25, z + 0.25, [0.92, 0.9, 0.88, 0], { col: true }); boxR('emis', -8.68, 1.05, z, 0.02, 0.32, 0.4, 0, [0.6, 0.75, 0.95, 0.8]); blob(-9, z, 0.9, 0.9); }
  hit('kiosk', -8, 24, 1.8, 'Print your badge', 'Self-service badge kiosks', 'Scan your QR confirmation to print a badge. Placeholder kiosk; connect to the registration system for a working demo.');

  // floor medallion (brass and garnet inlay) under the installation
  { const cv = mkCanvas(512), x = cv.getContext('2d');
    const ring = (rad, col, wd) => { x.strokeStyle = col; x.lineWidth = wd; x.beginPath(); x.arc(256, 256, rad, 0, 7); x.stroke(); };
    x.fillStyle = '#6d1624'; x.beginPath(); x.arc(256, 256, 250, 0, 7); x.fill(); x.fillStyle = '#e9e1d4'; x.beginPath(); x.arc(256, 256, 226, 0, 7); x.fill();
    ring(238, '#c8a46a', 5); ring(220, '#c8a46a', 2);
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; x.fillStyle = k % 2 ? '#c8a46a' : '#8e1b2c'; x.beginPath(); x.moveTo(256 + Math.cos(a) * 160, 256 + Math.sin(a) * 160); x.lineTo(256 + Math.cos(a + 0.2) * 216, 256 + Math.sin(a + 0.2) * 216); x.lineTo(256 + Math.cos(a) * 222, 256 + Math.sin(a) * 222); x.lineTo(256 + Math.cos(a - 0.2) * 216, 256 + Math.sin(a - 0.2) * 216); x.closePath(); x.fill(); }
    T.inlay = R.texFromCanvas(cv, { clamp: true });
    const m = M4.ident(); M4.t(m, 0, 0.008, 14); M4.rx(m, -Math.PI / 2); M4.s(m, 11, 11, 1); bat('inlay').add(MESH.plane, m, [0.8, 0.8, 0.8, 0]); }
  // centre piece: suspended halo of discs over a round bench
  cyl('wood', 0, 0, 14, 3.2, 0.45, [0.5, 0.35, 0.26, 0], { col: true });
  cyl('marble', 0, 0.45, 14, 3.25, 0.5, [0.95, 0.92, 0.88, 0]);
  cyl('plain', 0, 0.5, 14, 2.5, 0.75, [0.18, 0.15, 0.14, 0]);
  for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2; sph('green', Math.cos(a) * 1.7, 0.95, 14 + Math.sin(a) * 1.7, 0.9, 0.7, 0.9, [0.22 + (k % 3) * 0.03, 0.42, 0.26, 0]); }
  sph('green', 0, 1.1, 14, 1.6, 1.0, 1.6, [0.24, 0.44, 0.27, 0]);
  blob(0, 14, 8, 8);
  for (let k = 0; k < 42; k++) {
    const a = k / 42 * Math.PI * 2, ring = k % 3, rr = 2.4 + ring * 0.75, y = 3.6 + ring * 0.55 + Math.sin(a * 3) * 0.25;
    halo.push({ a, rr, y, tilt: 0.5 + ring * 0.25, ring });
    if (k % 2 === 0) cyl('metal', Math.cos(a) * rr, y + 0.2, 14 + Math.sin(a) * rr, 0.006, 7, [0.55, 0.55, 0.55, 0], { lo: true });
  }
  light(0, 4.2, 14, 9, [1, 0.45, 0.4], 1.1);
  hit('halo', 0, 14, 4.6, 'About this installation', 'Foyer installation (concept)', 'A suspended halo of 42 brass and garnet discs, a quiet nod to the red cell. This is a design proposal for the foyer, not something that was at the event.');

  // event banners by the ballroom doors
  let bannerR = null;
  const banner = (x) => {
    const r = bannerR || (bannerR = A.alloc(220, 500)), x2 = A.x; x2.save(); x2.translate(r.x, r.y);
    const g = x2.createLinearGradient(0, 0, 0, 500); g.addColorStop(0, '#6d1624'); g.addColorStop(1, '#2a0a12'); x2.fillStyle = g; x2.fillRect(0, 0, 220, 500);
    x2.strokeStyle = 'rgba(200,164,106,.35)'; x2.lineWidth = 1.5; for (let k = 0; k < 7; k++) { x2.beginPath(); x2.arc(110, 520, 60 + k * 26, Math.PI, 0); x2.stroke(); }
    x2.fillStyle = '#c8a46a'; x2.font = `600 13px ${FONT_BODY}`; x2.letterSpacing = '3px'; x2.fillText('ESH · 2026', 22, 40); x2.letterSpacing = '0px';
    x2.fillStyle = '#f3ece4'; x2.font = `400 44px ${FONT_DISPLAY}`; ['Emirates', 'Hematology', 'Conference'].forEach((l, i) => x2.fillText(l, 20, 110 + i * 46));
    x2.fillStyle = '#c8a46a'; x2.font = `400 64px ${FONT_DISPLAY}`; x2.fillText('2026', 20, 300);
    x2.fillStyle = 'rgba(243,236,228,.8)'; x2.font = `500 15px ${FONT_BODY}`; x2.fillText(EVENT.date, 22, 350); x2.fillText(EVENT.venue, 22, 372);
    x2.restore();
    quad('signs', x, 3.0, 0.6, 2.2, 5, 0, [1, 1, 1, 0], { mode: 'rect', r: r.uv });
    cyl('metal', x, 0, 0.6, 0.03, 5.6, [0.7, 0.58, 0.4, 0]); cyl('metal', x, 0, 0.5, 0.35, 0.04, [0.2, 0.2, 0.2, 0]);
  };
  banner(-6.6); banner(6.6);
  // door signs from the foyer side
  sign(0, 5.6, 0.18, 9, 1.4, 0, { kicker: 'Main stage', title: 'Plenary Ballroom', sub: 'Opening, keynotes and plenary sessions' });
  sign(-26, 4.6, 0.18, 5.6, 1.0, 0, { title: 'Poster Gallery', arrow: '↑' });
  sign(26, 4.6, 0.18, 5.6, 1.0, 0, { title: 'Lounge & Promenade', arrow: '↑' });
  sign(-29.82, 4.4, 21, 4.6, 1.0, Math.PI / 2, { title: 'Hall A', sub: 'Parallel sessions' });
  sign(-29.82, 4.4, 6, 4.6, 1.0, Math.PI / 2, { title: 'Hall B', sub: 'Parallel sessions' });
  sign(29.82, 5.6, 15, 8, 1.2, -Math.PI / 2, { kicker: 'Partners & host society', title: 'Exhibition Hall' });
  // directory totem near the entrance
  { const r = DRAW.directory(A, 300, 560, [['Plenary Ballroom', '↑'], ['Halls A · B', '←'], ['Hall C · Workshop', '↖'], ['Poster Gallery', '↖'], ['Exhibition Hall', '→'], ['Networking Lounge', '↗'], ['Registration', '←'], ['Information', '→']]);
    quad('signs', 10.5, 1.75, 25.0, 1.3, 2.4, 0, [1, 1, 1, 0], { mode: 'rect', r: r.uv }); box('plain', 9.8, 0, 24.88, 11.2, 3.05, 24.98, [0.1, 0.08, 0.08, 0], { col: true }); blob(10.5, 25, 1.8, 0.8); }
  plant(-28.5, 28.5, 1.2); plant(28.5, 28.5, 1.2); plant(-28.5, 1.5, 1.1); plant(28.5, 1.5, 1.1); plant(-10, 1.6); plant(10, 1.6);
  // lounge seating in the foyer
  for (const [cx, cz] of [[-14, 9], [14, 9]]) { box('plain', cx - 1.6, 0, cz - 0.45, cx + 1.6, 0.45, cz + 0.45, [0.3, 0.12, 0.16, 0], { col: true }); box('plain', cx - 1.6, 0.45, cz + 0.3, cx + 1.6, 0.9, cz + 0.45, [0.3, 0.12, 0.16, 0]); blob(cx, cz, 4, 1.6); }

  // ===== PLENARY BALLROOM =====
  // panelled walls
  for (const [x0, x1, z0, z1] of [[-21.85, -21.8, -43.8, -0.2], [21.8, 21.85, -43.8, -0.2]]) {
    box('wood', x0, 0.14, z0, x1, 3.0, z1, [0.5, 0.33, 0.24, 0]);
    for (let z = z0 + 3; z < z1; z += 6) { box('metal', Math.min(x0, x1) - 0.02, 3.0, z - 0.3, Math.max(x0, x1) + 0.02, 8.6, z + 0.3, [0.42, 0.3, 0.22, 0]); box('emis', Math.min(x0, x1) - 0.06, 3.6, z - 0.12, Math.max(x0, x1) + 0.06, 4.0, z + 0.12, [1, 0.8, 0.55, 1.2]); }
  }
  box('wood', -21.8, 0.14, -0.2, -4.14, 3.0, -0.15, [0.5, 0.33, 0.24, 0]); box('wood', 4.14, 0.14, -0.2, 21.8, 3.0, -0.15, [0.5, 0.33, 0.24, 0]);
  // cove lighting
  for (const [x0, z0, x1, z1] of [[-21.8, -43.8, 21.8, -43.6], [-21.8, -0.4, 21.8, -0.2], [-21.8, -43.8, -21.6, -0.2], [21.6, -43.8, 21.8, -0.2]]) box('emis', x0, 8.7, z0, x1, 8.8, z1, [1, 0.75, 0.6, 1.4]);
  // stage, steps, fascia
  box('wood', -15, 0, -44, 15, 0.9, -35, [0.2, 0.13, 0.12, 0], { col: true });
  box('emis', -15, 0.12, -34.99, 15, 0.16, -34.97, [1, 0.3, 0.35, 1.3]);
  for (const sx of [-12.5, 12.5]) { box('wood', sx - 1.5, 0, -35, sx + 1.5, 0.3, -33.8, [0.24, 0.16, 0.14, 0], { col: true }); box('wood', sx - 1.5, 0, -35, sx + 1.5, 0.6, -34.4, [0.24, 0.16, 0.14, 0], { col: true }); }
  box('carpetG', -15, 0.9, -44, 15, 0.91, -35, [0.6, 0.6, 0.6, 0]);
  screen(0, 4.6, -43.7, 20, 6.2, 0, { plenary: true, kicker: 'Plenary · Main stage', title: EVENT.name, sub: EVENT.venue + ' · ' + EVENT.date + ' · ' + EVENT.organiser });
  screen(-17.3, 4.4, -36.5, 6, 3.4, 0.38, { plenary: true, kicker: 'Plenary · Relay', title: 'Welcome to the Plenary', sub: 'Session recordings play here once linked' });
  screen(17.3, 4.4, -36.5, 6, 3.4, -0.38, { plenary: true, kicker: 'Plenary · Relay', title: 'Welcome to the Plenary', sub: 'Session recordings play here once linked' });
  box('plain', -20, 0, -38, -14.6, 1.1, -35, [0.1, 0.1, 0.1, 0], { col: true }); box('plain', 14.6, 0, -38, 20, 1.1, -35, [0.1, 0.1, 0.1, 0], { col: true }); // speaker stacks
  // lectern + panel table
  box('wood', 8.6, 0.9, -37.9, 9.4, 2.05, -37.3, [0.35, 0.22, 0.18, 0], { col: true }); box('emis', 8.7, 1.6, -37.29, 9.3, 1.75, -37.28, [1, 0.6, 0.5, 1]);
  people.push({ x: 9, z: -38.35, y: 0.9, yaw: 0, pose: 'present', role: 'speaker' });
  box('plain', -10, 0.9, -38.6, -3, 1.66, -37.8, [0.94, 0.92, 0.9, 0], { col: true }); box('carpetG', -10.02, 0.92, -37.82, -2.98, 1.6, -37.78, [0.9, 0.9, 0.9, 0]);
  for (let i = 0; i < 4; i++) { chair(-9.1 + i * 1.7, -39.1, 0, [0.8, 0.64, 0.4, 0], [0.42, 0.1, 0.16, 0], null, 0.9); }
  people.push({ x: -9.1, z: -39.1, y: 0.9, yaw: 0, pose: 'sit', role: 'panel' }); people.push({ x: -4.0, z: -39.1, y: 0.9, yaw: 0, pose: 'sit', role: 'panel' });
  // truss + stage lights
  box('metal', -16, 7.6, -33.6, 16, 7.9, -33.3, [0.25, 0.25, 0.27, 0]);
  for (let x = -14; x <= 14; x += 4) { const M = M4.ident(); M4.t(M, x, 7.35, -33.45); M4.rx(M, 0.5); M4.s(M, 0.32, 0.5, 0.32); bat('plain').add(MESH.cylLo, M, [0.08, 0.08, 0.08, 0]); sph('emis', x, 7.1, -33.6, 0.24, 0.24, 0.24, [1, 0.95, 0.85, 2]); }
  for (const x of [-10, 0, 10]) light(x, 6, -37, 12, [1, 0.92, 0.82], 1.7);
  light(0, 6, -40, 10, [0.9, 0.3, 0.35], 0.9);
  // chandeliers
  for (const z of [-8, -19, -30]) {
    for (let ring = 0; ring < 3; ring++) { const rr = 1.6 - ring * 0.45, y = 7.3 - ring * 0.45, n = 18 - ring * 4;
      for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; cyl('emis', Math.cos(a) * rr, y - 0.35, z + Math.sin(a) * rr, 0.02, y, [1, 0.9, 0.75, 0.6], { lo: true }); sph('emis', Math.cos(a) * rr, y - 0.4, z + Math.sin(a) * rr, 0.1, 0.16, 0.1, [1, 0.92, 0.8, 1.5]); } }
    cyl('metal', 0, 7.3, z, 0.04, 9, [0.8, 0.64, 0.4, 0], { lo: true });
    light(0, 6.4, z, 15, [1, 0.86, 0.68], 1.35); light(-12, 6.4, z, 12, [1, 0.86, 0.68], 0.9); light(12, 6.4, z, 12, [1, 0.86, 0.68], 0.9);
  }
  // audience seating (two blocks, central aisle)
  const gold = [0.82, 0.66, 0.4, 0], garnet = [0.5, 0.11, 0.17, 0];
  for (let rz = -30.5; rz <= -7.5; rz += 1.15) {
    for (const [bx0, bx1] of [[-18, -2.6], [2.6, 18]]) {
      for (let x = bx0 + 0.31; x < bx1; x += 0.62) chair(x, rz, Math.PI, gold, garnet, seats);
      colliders.push({ x0: bx0, y0: 0, z0: rz - 0.28, x1: bx1, y1: 0.98, z1: rz + 0.3 });
    }
  }
  box('plain', -18, 0, -5.8, -14, 1.05, -3.6, [0.12, 0.12, 0.13, 0], { col: true }); boxR('emis', -16, 1.12, -4.7, 1.6, 0.04, 0.6, 0, [0.4, 0.6, 1, 0.5]); // FOH desk
  people.push({ x: -16, z: -3.1, yaw: Math.PI, pose: 'stand', role: 'tech' });
  hit('plenary-screen', 0, -33, 6, 'Watch the plenary', 'Plenary Ballroom · Main stage', 'This screen is ready for the opening and plenary session recordings. Add the recordings folder and the official agenda, and each session will play here in sequence with spatial audio.', 'screen');

  // ===== POSTER GALLERY =====
  let pn = 1;
  for (const zc of [-5, -12.5, -20, -27.5, -35]) {
    box('plain', -26.06, 0, zc - 1.6, -25.94, 2.4, zc + 1.6, [0.15, 0.12, 0.12, 0], { col: true });
    box('metal', -26.1, 2.4, zc - 1.62, -25.9, 2.5, zc + 1.62, [0.8, 0.64, 0.4, 0]);
    for (const side of [-1, 1]) for (const dz of [-0.78, 0.78]) {
      const id = 'P-' + String(pn).padStart(2, '0'), r = DRAW.poster(A, 150, 210, id, pn * 13);
      quad('signs', -26 + side * 0.065, 1.35, zc + dz * side, 1.0, 1.4, side * Math.PI / 2, [1, 1, 1, 0], { mode: 'rect', r: r.uv });
      pn++;
    }
    blob(-26, zc, 1.2, 3.8);
    hit('poster' + zc, -26, zc, 2.6, 'View posters', 'Poster stand', 'Four poster slots per stand, plus wall boards: 34 slots in the gallery. The layouts are placeholders. Add the accepted abstracts list and each slot becomes a readable, zoomable poster.');
  }
  for (const z of [-22, -30]) { box('plain', -22.3, 0, z - 0.6, -22.15, 2.2, z + 0.6, [0.1, 0.1, 0.1, 0], { col: true }); boxR('emis', -22.32, 1.35, z, 0.02, 1.4, 1.0, 0, [0.85, 0.9, 1, 0.55]); }
  sign(-26, 4.2, -43.8, 5.5, 1.0, 0, { kicker: 'Scientific programme', title: 'Poster Gallery' });
  for (const [wx, ry, zs] of [[-29.83, Math.PI / 2, [-41, -29.5, -26, -22.5, -9.5, -6, -2.5]], [-22.17, -Math.PI / 2, [-41, -37.5, -34, -26, -16.5, -5.5, -2.5]]]) for (const z of zs) {
    const id = 'P-' + String(pn).padStart(2, '0'), r = DRAW.poster(A, 150, 210, id, pn * 13); pn++;
    box('metal', Math.min(wx, wx + Math.sin(ry) * 0.03), 0.55, z - 0.62, Math.max(wx, wx + Math.sin(ry) * 0.03), 2.25, z + 0.62, [0.8, 0.64, 0.4, 0]);
    quad('signs', wx + Math.sin(ry) * 0.04, 1.4, z, 1.1, 1.54, ry, [1, 1, 1, 0], { mode: 'rect', r: r.uv });
  }
  sign(-29.82, 4.2, -15, 4.4, 1.0, Math.PI / 2, { title: 'Hall C', sub: 'Parallel sessions' });
  sign(-29.82, 4.2, -35, 4.4, 1.0, Math.PI / 2, { title: 'Workshop Room', sub: 'Hands-on sessions' });
  people.push({ x: -24.6, z: -12.5, yaw: -Math.PI / 2, pose: 'stand', role: 'viewer' }, { x: -27.4, z: -20.3, yaw: Math.PI / 2, pose: 'stand', role: 'viewer' }, { x: -24.7, z: -27.9, yaw: -Math.PI / 2, pose: 'talk', role: 'viewer' }, { x: -24.5, z: -27.0, yaw: -Math.PI / 2 - 0.4, pose: 'stand', role: 'viewer' });
  for (let z = -40; z <= -4; z += 6) light(-26, 4.6, z, 9, [1, 0.94, 0.86], 1.0);

  // ===== HALLS A, B, C =====
  for (const id of ['hallA', 'hallB', 'hallC']) {
    const Z = ZONES.find(q => q.id === id), [x0, z0, x1, z1] = Z.rect, zc = (z0 + z1) / 2;
    box('wood', -56, 0, z0 + 2, -52, 0.45, z1 - 2, [0.22, 0.15, 0.13, 0], { col: true });
    box('emis', -52.01, 0.08, z0 + 2, -51.99, 0.12, z1 - 2, [0.4, 0.8, 0.9, 0.8]);
    screen(-55.75, 3.3, zc, 8, 4.4, Math.PI / 2, { kicker: Z.name + ' · Parallel session', title: 'Track to be confirmed', sub: 'Link the official agenda to name this track and load its recordings' });
    box('wood', -53.6, 0.45, zc + 2.6, -53.0, 1.55, zc + 3.4, [0.35, 0.22, 0.18, 0], { col: true });
    people.push({ x: -53.95, z: zc + 3.0, y: 0.45, yaw: Math.PI / 2, pose: 'present', role: 'speaker' });
    for (let rx = -49; rx <= -36.5; rx += 1.15) for (const [b0, b1] of [[z0 + 1.6, zc - 0.9], [zc + 0.9, z1 - 1.6]]) {
      for (let z = b0 + 0.31; z < b1; z += 0.62) chair(rx, z, -Math.PI / 2, [0.18, 0.18, 0.2, 0], [0.28, 0.3, 0.34, 0], seats);
      colliders.push({ x0: rx - 0.3, y0: 0, z0: b0, x1: rx + 0.28, y1: 0.98, z1: b1 });
    }
    for (const z of [z0 + 0.2, z1 - 0.2]) for (let x = -52; x < -31; x += 5) box('emis', x, 4.2, z - 0.05, x + 0.25, 4.6, z + 0.05, [1, 0.85, 0.65, 1]);
    hit(id + '-screen', -48.5, zc, 6, 'Watch this session', Z.name + ' · Parallel session', 'This room is set up for a parallel track. The track name and its recordings come from the official agenda and the recordings folder, which have not been supplied yet.', 'screen');
  }

  // ===== WORKSHOP ROOM =====
  { const Z = ZONES.find(q => q.id === 'workshop'), zc = (Z.rect[1] + Z.rect[3]) / 2;
    screen(-55.75, 3.0, zc, 7, 3.9, Math.PI / 2, { kicker: 'Workshop Room', title: 'Hands-on workshop', sub: 'Workshop titles and facilitators to be added from the agenda' });
    for (const tx of [-50, -43, -36]) for (const tz of [-38.5, -29.5]) {
      cyl('plain', tx, 0, tz, 0.95, 0.74, [0.96, 0.95, 0.93, 0], { col: true }); cyl('carpet', tx, 0, tz, 0.97, 0.7, [0.45, 0.12, 0.18, 0]);
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + 0.3, cx = tx + Math.cos(a) * 1.45, cz = tz + Math.sin(a) * 1.45; const yaw = Math.atan2(tx - cx, tz - cz);
        chair(cx, cz, yaw, [0.2, 0.2, 0.22, 0], [0.32, 0.3, 0.3, 0], seats); colliders.push({ c: 1, cx, cz, r: 0.3, y0: 0, y1: 0.95 }); }
      for (const k of [0, 3]) { const a = k / 6 * Math.PI * 2 + 0.3, mx = tx + Math.cos(a) * 0.55, mz = tz + Math.sin(a) * 0.55; // microscope
        box('plain', mx - 0.12, 0.74, mz - 0.16, mx + 0.12, 0.79, mz + 0.16, [0.92, 0.92, 0.94, 0]); box('plain', mx - 0.03, 0.79, mz - 0.1, mx + 0.03, 1.05, mz - 0.04, [0.92, 0.92, 0.94, 0]);
        box('plain', mx - 0.08, 0.86, mz - 0.06, mx + 0.08, 0.9, mz + 0.08, [0.2, 0.2, 0.22, 0]); cyl('plain', mx, 1.0, mz - 0.02, 0.03, 1.16, [0.15, 0.15, 0.16, 0], { lo: true }); }
      blob(tx, tz, 4, 4);
    }
    hit('workshop', -43, -34, 5, 'About this room', 'Workshop Room', 'Round tables with microscopes for small-group, hands-on sessions. Workshop titles and facilitators are added from the official agenda.');
  }

  // ===== EAST PROMENADE =====
  for (const z of [-18, -3]) { box('plain', 28.9, 0, z - 1.2, 29.7, 0.45, z + 1.2, [0.3, 0.12, 0.16, 0], { col: true }); blob(29.3, z, 1.4, 3); }
  for (const z of [-16, -6]) { const r = A.alloc(260, 340), x = A.x; x.save(); x.translate(r.x, r.y); const g = x.createLinearGradient(0, 0, 260, 340); g.addColorStop(0, z < -10 ? '#2a3d4a' : '#5a1a28'); g.addColorStop(1, '#141012'); x.fillStyle = g; x.fillRect(0, 0, 260, 340);
    x.strokeStyle = 'rgba(200,164,106,.5)'; x.lineWidth = 2; for (let k = 0; k < 18; k++) { x.beginPath(); x.ellipse(130, 170, 20 + k * 7, 12 + k * 4.5, k * 0.17, 0, 7); x.stroke(); } x.restore();
    quad('signs', 22.19, 2.4, z, 2.6, 3.4, Math.PI / 2, [1, 1, 1, 0], { mode: 'rect', r: r.uv }); box('metal', 22.15, 0.6, z - 1.42, 22.18, 4.2, z + 1.42, [0.8, 0.64, 0.4, 0]); }
  plant(23, -19, 1.1); plant(29, -1, 1.0);

  // ===== NETWORKING LOUNGE =====
  box('wood', 43.4, 0, -40, 44.3, 1.05, -28, [0.32, 0.2, 0.16, 0], { col: true }); box('marble', 43.3, 1.05, -40.1, 44.4, 1.12, -27.9, [0.95, 0.93, 0.9, 0]);
  box('wood', 45.5, 1.2, -40, 45.85, 3.4, -28, [0.32, 0.2, 0.16, 0]); for (const y of [1.8, 2.5, 3.2]) box('emis', 45.3, y, -39.8, 45.5, y + 0.04, -28.2, [1, 0.8, 0.55, 1.1]);
  sign(45.82, 4.3, -34, 5, 1.0, -Math.PI / 2, { title: 'Coffee Bar', sub: 'Espresso · Tea · Water' });
  people.push({ x: 44.9, z: -33, yaw: -Math.PI / 2, pose: 'stand', role: 'barista' }, { x: 44.9, z: -37, yaw: -Math.PI / 2, pose: 'talk', role: 'barista' });
  hit('coffee', 42.3, -34, 2.6, 'Order a coffee', 'Coffee Bar', 'Coffee, tea and water for delegates between sessions.');
  for (const [cx, cz] of [[27, -39], [34.5, -39], [28, -30.5]]) {
    for (const s of [-1, 1]) { const zz = cz + s * 1.25; box('plain', cx - 1.2, 0, zz - 0.45, cx + 1.2, 0.44, zz + 0.45, [0.24, 0.27, 0.3, 0], { col: true }); box('plain', cx - 1.2, 0.44, zz + s * 0.3, cx + 1.2, 0.95, zz + s * 0.45, [0.24, 0.27, 0.3, 0]); seats.push({ x: cx - 0.5, z: zz, yaw: s > 0 ? Math.PI : 0, sofa: true }); seats.push({ x: cx + 0.5, z: zz, yaw: s > 0 ? Math.PI : 0, sofa: true }); }
    box('wood', cx - 0.6, 0, cz - 0.4, cx + 0.6, 0.42, cz + 0.4, [0.4, 0.26, 0.2, 0], { col: true }); blob(cx, cz, 3.6, 4.2);
  }
  for (const [tx, tz] of [[37.5, -26], [40.5, -31.5], [33, -24]]) { cyl('metal', tx, 0, tz, 0.05, 1.05, [0.2, 0.2, 0.2, 0]); cyl('marble', tx, 1.05, tz, 0.4, 1.1, [0.95, 0.93, 0.9, 0], { col: true }); colliders.push({ c: 1, cx: tx, cz: tz, r: 0.42, y0: 0, y1: 1.1 }); blob(tx, tz, 1.2, 1.2); }
  people.push({ x: 37.5, z: -25.2, yaw: Math.PI, pose: 'talk', role: 'guest' }, { x: 36.8, z: -26.6, yaw: 0.8, pose: 'stand', role: 'guest' }, { x: 38.3, z: -26.6, yaw: -0.8, pose: 'stand', role: 'guest' });
  people.push({ x: 40.5, z: -30.7, yaw: Math.PI, pose: 'stand', role: 'guest' }, { x: 41.3, z: -32.1, yaw: -0.9, pose: 'talk', role: 'guest' });
  plant(23, -43, 1.2); plant(45, -21, 1.1); plant(45, -43, 1.2);
  for (const x of [26, 32, 38, 44]) light(x, 3.6, -42.5, 7, [1, 0.7, 0.5], 0.6);

  // ===== EXHIBITION HALL =====
  const boothFloor = (x0, z0, x1, z1, c) => { box('carpet', x0, 0, z0, x1, 0.1, z1, c, { col: true }); };
  const counter = (x0, z0, x1, z1, accent) => { box('plain', x0, 0.1, z0, x1, 1.05, z1, [0.96, 0.95, 0.93, 0], { col: true }); box('emis', x0, 0.2, z1 + 0.001, x1, 0.24, z1 + 0.01, accent); box('emis', x0, 0.2, z0 - 0.01, x1, 0.24, z0 - 0.001, accent); };
  const tiers = { Platinum: '#5b5f6a', Gold: '#7a5a22', Silver: '#3e4a56', Host: '#6d1624' };
  function wallBooth(x0, z0, x1, z1, face, tier, label, staff = 1) {
    // face: direction the booth opens toward: 'n','s','w'
    const accent = tier === 'Host' ? [1, 0.3, 0.35, 1] : [1, 0.82, 0.55, 1];
    boothFloor(x0, z0, x1, z1, tier === 'Host' ? [0.55, 0.14, 0.2, 0] : [0.3, 0.3, 0.33, 0]);
    const gk = tier + label; const gr = signCache[gk] || (signCache[gk] = DRAW.boothGraphic(A, 420, 170, { tier: tier === 'Host' ? 'Host society' : tier + ' partner', label, color: tiers[tier] }));
    let cx, cz;
    if (face === 'n' || face === 's') {
      const bz = face === 'n' ? z1 - 0.1 : z0 + 0.1, ry = face === 'n' ? Math.PI : 0, off = face === 'n' ? -0.08 : 0.08;
      box('plain', x0, 0.1, bz - 0.1, x1, 3.2, bz + 0.1, [0.95, 0.94, 0.92, 0], { col: true });
      quad('signs', (x0 + x1) / 2, 2.1, bz + off * 1.4, x1 - x0 - 0.6, 1.95, ry, [1, 1, 1, 0], { mode: 'rect', r: gr.uv });
      for (const sx of [x0, x1]) box('plain', sx - 0.05, 0.1, Math.min(bz, face === 'n' ? z1 - 3 : z0 + 3), sx + 0.05, 2.6, Math.max(bz, face === 'n' ? z1 - 3 : z0 + 3), [0.95, 0.94, 0.92, 0], { col: true });
      const fz = face === 'n' ? z0 + 1.6 : z1 - 1.6; cx = (x0 + x1) / 2; cz = fz;
      counter(cx - 1.2, fz - 0.3, cx + 1.2, fz + 0.3, accent);
      const sz = face === 'n' ? fz + 1.0 : fz - 1.0;
      for (let i = 0; i < staff; i++) people.push({ x: cx - 0.5 + i, z: sz, y: 0.1, yaw: face === 'n' ? Math.PI : 0, pose: i ? 'stand' : 'talk', role: 'exhibitor' });
      boxR('emis', (x0 + x1) / 2 + (x1 - x0) * 0.32, 1.6, bz + off * 1.9, 1.2, 0.7, 0.02, ry, [0.5, 0.7, 0.95, 0.6]);
    } else {
      const bx = x1 - 0.1;
      box('plain', bx - 0.1, 0.1, z0, bx + 0.1, 3.2, z1, [0.95, 0.94, 0.92, 0], { col: true });
      quad('signs', bx - 0.12, 2.1, (z0 + z1) / 2, z1 - z0 - 0.6, 1.95, -Math.PI / 2, [1, 1, 1, 0], { mode: 'rect', r: gr.uv });
      for (const sz of [z0, z1]) box('plain', x1 - 3, 0.1, sz - 0.05, bx, 2.6, sz + 0.05, [0.95, 0.94, 0.92, 0], { col: true });
      cx = x0 + 1.6; cz = (z0 + z1) / 2;
      counter(cx - 0.3, cz - 1.2, cx + 0.3, cz + 1.2, accent);
      for (let i = 0; i < staff; i++) people.push({ x: cx + 1.0, z: cz - 0.5 + i, y: 0.1, yaw: -Math.PI / 2, pose: i ? 'stand' : 'talk', role: 'exhibitor' });
    }
    plant(face === 'w' ? x1 - 0.7 : x0 + 0.7, face === 'n' ? z1 - 0.8 : face === 's' ? z0 + 0.8 : z0 + 0.8, 0.8);
    blob((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0 + 1, z1 - z0 + 1);
    hit('booth-' + label + x0, cx, cz, 3, tier === 'Host' ? 'Visit the society booth' : 'Visit this booth', tier === 'Host' ? EVENT.organiser : tier + ' partner booth',
      tier === 'Host' ? 'The host society’s stand for membership and society information. Booth artwork and handouts can be added from ESH brand files.' : 'Booth size follows the sponsorship tier. The partner name, logo and artwork are left blank until the confirmed sponsor list and approved artwork are supplied.');
  }
  wallBooth(34, 18, 42, 26, 'n', 'Gold', 'Gold partner', 2);
  wallBooth(58, 18, 66, 26, 'n', 'Gold', 'Gold partner', 2);
  wallBooth(34, -14, 40, -8, 's', 'Silver', 'Silver partner');
  wallBooth(44, -14, 50, -8, 's', 'Silver', 'Silver partner');
  wallBooth(54, -14, 60, -8, 's', 'Silver', 'Silver partner');
  wallBooth(62, -6, 68, 0, 'w', 'Silver', 'Silver partner');
  wallBooth(60, 5, 68, 12, 'w', 'Host', 'Emirates Society of Haematology', 2);
  // platinum island
  { const x0 = 44, z0 = 2, x1 = 56, z1 = 12, cx = 50, cz = 7;
    boothFloor(x0, z0, x1, z1, [0.34, 0.34, 0.38, 0]);
    box('plain', cx - 1, 0.1, cz - 1, cx + 1, 4.4, cz + 1, [0.12, 0.12, 0.14, 0], { col: true });
    const gr = DRAW.boothGraphic(A, 420, 170, { tier: 'Platinum partner', label: 'Platinum partner', color: tiers.Platinum });
    for (let k = 0; k < 4; k++) { const ry = k * Math.PI / 2; quad('signs', cx + Math.sin(ry) * 1.02, 2.6, cz + Math.cos(ry) * 1.02, 1.9, 0.78, ry, [1, 1, 1, 0], { mode: 'rect', r: gr.uv }); boxR('emis', cx + Math.sin(ry) * 1.02, 1.35, cz + Math.cos(ry) * 1.02, 1.5, 0.85, 0.02, ry, [0.55, 0.75, 1, 0.6]); }
    for (let k = 0; k < 4; k++) { const ry = k * Math.PI / 2; const hx = cx + Math.sin(ry) * 3.6, hz = cz + Math.cos(ry) * 3.6; boxR('plain', hx, 5.7, hz, 7.2, 1.0, 0.12, ry, [0.1, 0.1, 0.12, 0]); sign(hx + Math.sin(ry) * 0.07, 5.7, hz + Math.cos(ry) * 0.07, 7.0, 0.9, ry, { title: 'Platinum partner', sub: 'Name and logo to be supplied' }); }
    for (const [px, pz] of [[cx - 3.6, cz - 3.6], [cx + 3.6, cz + 3.6]]) cyl('metal', px, 0.1, pz, 0.04, 5.2, [0.6, 0.6, 0.62, 0], { lo: true });
    counter(x0 + 0.6, z0 + 0.6, x0 + 3.2, z0 + 1.2, [0.7, 0.85, 1, 1]); counter(x1 - 3.2, z1 - 1.2, x1 - 0.6, z1 - 0.6, [0.7, 0.85, 1, 1]);
    people.push({ x: x0 + 1.9, z: z0 + 1.8, y: 0.1, yaw: Math.PI, pose: 'talk', role: 'exhibitor' }, { x: x1 - 1.9, z: z1 - 1.8, y: 0.1, yaw: 0, pose: 'stand', role: 'exhibitor' }, { x: cx + 2.2, z: cz - 1.6, y: 0.1, yaw: 2.3, pose: 'talk', role: 'guest' }, { x: cx + 2.9, z: cz - 2.3, y: 0.1, yaw: -0.8, pose: 'stand', role: 'guest' });
    blob(cx, cz, 13, 11);
    hit('platinum', cx, cz, 5, 'Visit this booth', 'Platinum partner island', 'The largest stand, open on all four sides. The partner name, logo and artwork are left blank until the confirmed sponsor list and approved artwork are supplied. Pharma stands follow UAE rules: branding only, no product claims.');
  }
  // coffee point
  box('wood', 33, 0, -5.4, 38.5, 1.05, -4.6, [0.32, 0.2, 0.16, 0], { col: true }); box('marble', 32.9, 1.05, -5.5, 38.6, 1.12, -4.5, [0.95, 0.93, 0.9, 0]);
  people.push({ x: 35.5, z: -5.9, yaw: 0, pose: 'stand', role: 'barista' });
  for (const [tx, tz] of [[35, -1.5], [38.5, -0.5]]) { cyl('metal', tx, 0, tz, 0.05, 1.05, [0.2, 0.2, 0.2, 0]); cyl('marble', tx, 1.05, tz, 0.4, 1.1, [0.95, 0.93, 0.9, 0]); colliders.push({ c: 1, cx: tx, cz: tz, r: 0.42, y0: 0, y1: 1.1 }); blob(tx, tz, 1.2, 1.2); }
  people.push({ x: 35, z: -0.7, yaw: Math.PI, pose: 'talk', role: 'guest' }, { x: 35.7, z: -2.0, yaw: -0.7, pose: 'stand', role: 'guest' });
  for (const [bx, bz] of [[37, 6], [63, 0], [44, -4], [56, 16]]) for (const ry of [-Math.PI / 2, Math.PI / 2]) { quad('signs', bx + (ry > 0 ? 0.01 : -0.01), 4.6, bz, 1.6, 3.6, ry, [1, 1, 1, 0], { mode: 'rect', r: bannerR.uv }); cyl('metal', bx, 6.4, bz, 0.02, 7, [0.6, 0.6, 0.6, 0], { lo: true }); }
  sign(51, 6.2, 29.8, 10, 1.4, Math.PI, { kicker: EVENT.name, title: 'Exhibition Hall', sub: 'Partners · Host society · Coffee' });
  // giveaway exercise balls (physics props)
  for (let i = 0; i < 6; i++) balls.push({ p: [46 + (i % 3) * 2.6, 0.45 + (i > 2 ? 1.5 : 0), 21 + Math.floor(i / 3) * 2.4], r: 0.38, v: [0, 0, 0], col: i % 2 ? [0.95, 0.92, 0.88] : [0.6, 0.1, 0.17] });
  hit('balls', 50, 22.5, 3.5, 'Kick a ball', 'Physics test area', 'Walk or run into the balls to push them. They bounce off walls, booths and each other.');
  plant(31, 29, 1.2); plant(69, 29, 1.2); plant(69, -19, 1.2); plant(31, -19, 1.0);

  // walker routes
  const routes = [
    { pts: [[-7.5, 14], [0, 6.2], [7.5, 14], [0, 21.8]], n: 5, loop: true },
    { pts: [[6.4, 27], [6.4, 3], [-5.5, 3], [-5.5, 27]], n: 3, loop: true },
    { pts: [[41.5, -0.5], [58.5, -0.5], [58.5, 14.5], [41.5, 14.5]], n: 5, loop: true },
    { pts: [[33, 15], [52, 15.2], [52, 29], [33, 28.5]], n: 2, loop: true },
    { pts: [[-28.4, -1], [-28.4, -40], [-23.6, -40], [-23.6, -1]], n: 2, loop: true },
    { pts: [[26, -2], [26, -19], [31, -24], [26, -19]], n: 2, loop: true },
    { pts: [[0, -1.5], [0, -33], [0, -1.5]], n: 1, loop: true },
  ];
  // standing groups in foyer
  for (const [gx, gz] of [[-10, 8], [11, 25], [-21, 27], [21, 12], [9, 4]]) {
    for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2 + gx; people.push({ x: gx + Math.cos(a) * 0.65, z: gz + Math.sin(a) * 0.65, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)), pose: k === 0 ? 'talk' : 'stand', role: 'guest' }); }
  }

  // upload
  const draws = [];
  const order = ['marble', 'carpetG', 'carpet', 'wood', 'wall', 'ceil', 'plain', 'metal', 'green', 'emis', 'signs', 'sky'];
  T.atlas = R.texFromCanvas(A.c);
  const stats = { verts: 0, tris: 0, atlasUsed: A.shelves.reduce((m, s) => Math.max(m, s.y + s.h), 0) / A.H };
  for (const k of order) if (B[k]) { draws.push(R.upload(B[k], MAT[k].tex ? T[MAT[k].tex] : null)); stats.verts += B[k].verts; stats.tris += B[k].i.length / 3; }
  const screenDraws = screens.map(s => { const d = R.upload(s.batch, s.tex); s.draw = d; return d; });
  const late = [];
  if (B.inlay) late.push(R.upload(B.inlay, T.inlay));
  if (B.shadow) late.push(R.upload(B.shadow, T.blob));
  if (B.glass) late.push(R.upload(B.glass, null));
  return { draws, screenDraws, late, colliders, lights, interact, people, screens, seats, balls, routes, halo, T, stats };
}
