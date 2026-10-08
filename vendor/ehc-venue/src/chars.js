// ---------- Stylised premium people (instanced primitives; fictional, no likeness of real people) ----------
const SKIN = [[0.96, 0.8, 0.67], [0.86, 0.66, 0.5], [0.74, 0.54, 0.38], [0.58, 0.4, 0.27], [0.44, 0.3, 0.2], [0.9, 0.72, 0.58]];
const HAIR = [[0.07, 0.05, 0.04], [0.16, 0.1, 0.06], [0.3, 0.2, 0.12], [0.5, 0.48, 0.46], [0.1, 0.08, 0.08], [0.42, 0.28, 0.16]];
const SUITS = [[0.1, 0.12, 0.2], [0.16, 0.16, 0.17], [0.06, 0.06, 0.07], [0.3, 0.31, 0.34], [0.42, 0.35, 0.27], [0.2, 0.24, 0.32], [0.3, 0.1, 0.14]];
const SMART = [[0.62, 0.2, 0.26], [0.2, 0.38, 0.42], [0.82, 0.76, 0.68], [0.3, 0.3, 0.45], [0.94, 0.93, 0.9], [0.55, 0.45, 0.32], [0.18, 0.32, 0.26]];
const TROUSERS = [[0.08, 0.09, 0.12], [0.12, 0.12, 0.13], [0.24, 0.23, 0.23], [0.4, 0.36, 0.3], [0.85, 0.82, 0.76]];
const TIES = [[0.55, 0.1, 0.16], [0.12, 0.2, 0.42], [0.62, 0.5, 0.3], [0.2, 0.2, 0.22], [0.3, 0.45, 0.6]];
// badge lanyard colour by role (real-event convention)
const ROLE_LANYARD = { speaker: [0.62, 0.1, 0.16], panel: [0.62, 0.1, 0.16], exhibitor: [0.16, 0.5, 0.3], staff: [0.8, 0.62, 0.25], tech: [0.1, 0.1, 0.1], barista: null, guest: [0.12, 0.2, 0.42], viewer: [0.12, 0.2, 0.42], delegate: [0.12, 0.2, 0.42] };

function makeLook(r, role) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const roll = r();
  let outfit = roll < 0.17 ? 'kandura' : roll < 0.31 ? 'abaya' : roll < 0.5 ? 'smart' : 'suit';
  if (role === 'staff' || role === 'barista' || role === 'tech') outfit = 'staff';
  const g = outfit === 'abaya' ? 'f' : outfit === 'kandura' ? 'm' : (r() < 0.45 ? 'f' : 'm');
  const look = { outfit, g, role: role || 'guest', skin: pick(SKIN), hair: pick(HAIR), top: pick(SUITS), legs: pick(TROUSERS), shirt: r() < 0.7 ? [0.96, 0.96, 0.97] : [0.72, 0.82, 0.93], tie: pick(TIES), h: (g === 'f' ? 0.93 : 0.97) + r() * 0.09, seed: r() * 10 };
  look.hairStyle = g === 'f' ? pick(['long', 'long', 'bun', 'bob', 'side']) : pick(['short', 'short', 'side', 'bald', 'curly']);
  look.beard = g === 'm' && r() < (outfit === 'kandura' ? 0.7 : 0.3);
  look.bottom = g === 'f' && outfit !== 'abaya' && r() < 0.55 ? 'skirt' : 'trousers';
  look.tieOn = outfit === 'suit' && g === 'm' && r() < 0.75;
  if (outfit === 'smart') look.top = pick(SMART);
  if (outfit === 'staff') { look.top = role === 'barista' ? [0.18, 0.13, 0.11] : role === 'tech' ? [0.08, 0.08, 0.09] : [0.32, 0.07, 0.13]; look.legs = [0.07, 0.07, 0.08]; look.tieOn = false; look.bottom = 'trousers'; }
  look.lanyard = ROLE_LANYARD[role] === undefined ? ROLE_LANYARD.guest : ROLE_LANYARD[role];
  return look;
}

const GEST_DUR = { wave: 2.0, shake: 1.6, point: 1.8, think: 2.2, nod: 1.1, laugh: 1.4, heart: 2.2, clap: 3.0, raise: 4.0 };
const _m = new Float32Array(16);
function partM(base, ops) { _m.set(base); for (const o of ops) { if (o[0] === 't') M4.t(_m, o[1], o[2], o[3]); else if (o[0] === 'x') M4.rx(_m, o[1]); else if (o[0] === 'y') M4.ry(_m, o[1]); else if (o[0] === 'z') M4.rz(_m, o[1]); else M4.s(_m, o[1], o[2], o[3]); } return _m; }
const dk = (c, k) => [c[0] * k, c[1] * k, c[2] * k, 0];
const C4 = (c, e = 0) => [c[0], c[1], c[2], e];

// p: {x,y,z,yaw,phase,speed,pose,look,t,gesture,gT,speaking}; lod 0 near (full), 1 mid, 2 far (simple)
function drawPerson(R, I, p, lod = 0) {
  const L = p.look, base = M4.ident(); M4.t(base, p.x, p.y || 0, p.z); M4.ry(base, p.yaw); M4.s(base, L.h, L.h, L.h);
  const box = I.box, sph = lod ? I.sph : (I.sphHi || I.sph), cyl = lod ? (I.cylLo || I.cyl) : I.cyl;
  const walk = p.pose === 'walk', sit = p.pose === 'sit';
  const sw = walk ? Math.sin(p.phase) * Math.min(0.55, 0.25 + p.speed * 0.07) : 0;
  const hipY = sit ? 0.5 : 0.93 + (walk ? Math.abs(Math.cos(p.phase)) * 0.025 : 0), up = hipY - 0.93;
  const robe = L.outfit === 'kandura' || L.outfit === 'abaya';
  const robeCol = L.outfit === 'kandura' ? [0.97, 0.96, 0.94, 0] : [0.05, 0.045, 0.05, 0];
  const legCol = C4(L.legs), topCol = C4(L.top), skin = C4(L.skin), shoe = [0.05, 0.045, 0.045, 0], hair = C4(L.hair);
  const skirt = L.bottom === 'skirt' && !robe;
  const shinCol = skirt ? dk(L.skin, 0.92) : robe ? robeCol : legCol;
  const gt = p.gesture ? p.t - p.gT : 99, gOn = gt < (GEST_DUR[p.gesture] || 0) ? p.gesture : null;

  if (lod === 2) { // far: light silhouette
    R.push(box, partM(base, [['t', 0, (robe ? 0.75 : 1.05) + up, 0], ['s', 0.42, robe ? 1.4 : 0.85, 0.25]]), robe ? robeCol : topCol);
    if (!robe) for (const s of [-1, 1]) R.push(box, partM(base, [['t', 0.1 * s, hipY, 0], ['x', sit ? -1.5 : sw * s], ['t', 0, -0.45, 0], ['s', 0.15, 0.9, 0.17]]), legCol);
    R.push(sph, partM(base, [['t', 0, 1.62 + up, 0], ['s', 0.22, 0.26, 0.24]]), L.outfit === 'kandura' ? robeCol : L.outfit === 'abaya' ? robeCol : skin);
    return;
  }
  // ----- legs
  for (const s of [-1, 1]) {
    const a = sit ? -1.5 : sw * s, knee = sit ? 1.5 : (walk ? Math.max(0, Math.sin(p.phase * s + (s > 0 ? 0 : Math.PI) - 0.9)) * 0.8 * Math.min(1, p.speed / 2) : 0);
    const hip = [['t', 0.095 * s, hipY, 0], ['x', a]];
    if (!robe || sit) {
      R.push(cyl, partM(base, [...hip, ['t', 0, -0.22, 0], ['s', 0.15, 0.46, 0.16]]), robe ? robeCol : skirt ? shinCol : legCol);
      if (!lod) R.push(sph, partM(base, [...hip, ['t', 0, -0.44, 0], ['s', 0.13, 0.13, 0.14]]), robe ? robeCol : skirt ? shinCol : legCol);
      R.push(cyl, partM(base, [...hip, ['t', 0, -0.44, 0], ['x', knee], ['t', 0, -0.21, 0], ['s', 0.12, 0.44, 0.13]]), shinCol);
    }
    const ank = robe && !sit ? [...hip, ['t', 0, -0.87, 0]] : [...hip, ['t', 0, -0.44, 0], ['x', knee], ['t', 0, -0.43, 0], ['x', -knee - a]];
    R.push(sph, partM(base, [...ank, ['t', 0, -0.025, 0.05], ['s', 0.11, 0.075, 0.26]]), shoe);
  }
  // ----- body
  if (robe && !sit) {
    R.push(cyl, partM(base, [['t', 0, 0.5, 0], ['z', sw * 0.03], ['s', 0.46, 0.9, 0.31]]), robeCol);
    R.push(cyl, partM(base, [['t', 0, 1.2, 0], ['s', 0.42, 0.56, 0.27]]), robeCol);
  } else if (robe && sit) {
    R.push(cyl, partM(base, [['t', 0, hipY + 0.27, 0], ['s', 0.42, 0.6, 0.27]]), robeCol);
    R.push(box, partM(base, [['t', 0, hipY - 0.02, 0.22], ['s', 0.36, 0.14, 0.48]]), robeCol);
    R.push(box, partM(base, [['t', 0, hipY * 0.5, 0.44], ['s', 0.34, hipY, 0.16]]), robeCol);
  } else {
    R.push(cyl, partM(base, [['t', 0, 0.95 + up, 0], ['s', 0.35, 0.16, 0.22]]), skirt ? topCol : legCol);
    if (skirt && !sit) R.push(cyl, partM(base, [['t', 0, 0.72, 0], ['s', 0.38, 0.44, 0.27]]), dk(L.top, 0.85));
    if (skirt && sit) R.push(box, partM(base, [['t', 0, hipY, 0.18], ['s', 0.36, 0.1, 0.42]]), dk(L.top, 0.85));
    R.push(cyl, partM(base, [['t', 0, 1.17 + up, 0], ['s', L.g === 'f' ? 0.34 : 0.37, 0.42, 0.22]]), topCol);
    R.push(cyl, partM(base, [['t', 0, 1.36 + up, 0], ['s', L.g === 'f' ? 0.38 : 0.43, 0.16, 0.24]]), topCol);
    if (!lod) {
      // shirt V, tie, lapels
      R.push(box, partM(base, [['t', 0, 1.34 + up, 0.116], ['s', 0.1, 0.16, 0.01]]), C4(L.shirt));
      if (L.tieOn) R.push(box, partM(base, [['t', 0, 1.3 + up, 0.122], ['s', 0.034, 0.22, 0.01]]), C4(L.tie));
      if (L.outfit !== 'staff') for (const s of [-1, 1]) R.push(box, partM(base, [['t', 0.052 * s, 1.33 + up, 0.12], ['z', 0.32 * s], ['s', 0.045, 0.2, 0.01]]), dk(L.top, 0.78));
      if (L.role === 'barista') R.push(box, partM(base, [['t', 0, 0.95 + up, 0.12], ['s', 0.34, 0.5, 0.012]]), [0.12, 0.08, 0.06, 0]);
    }
  }
  for (const s of [-1, 1]) R.push(sph, partM(base, [['t', 0.2 * s, 1.415 + up, 0], ['s', 0.15, 0.13, 0.17]]), robe ? robeCol : topCol);
  // badge on a role-coloured lanyard
  const cz = robe ? 0.14 : 0.124, chestY = 1.2 + up;
  if (L.lanyard) {
    R.push(box, partM(base, [['t', 0, chestY, cz + 0.006], ['s', 0.085, 0.115, 0.008]]), [0.97, 0.96, 0.94, 0.12]);
    if (!lod) R.push(box, partM(base, [['t', 0, chestY + 0.035, cz + 0.011], ['s', 0.085, 0.03, 0.004]]), C4(L.lanyard));
    for (const s of [-1, 1]) R.push(box, partM(base, [['t', 0.055 * s, chestY + 0.17, cz - 0.002], ['z', 0.28 * s], ['s', 0.016, 0.26, 0.008]]), C4(L.lanyard));
  }
  // ----- arms
  const shY = 1.41 + up;
  for (const s of [-1, 1]) {
    let a = walk ? -sw * 0.9 : 0, bend = walk ? -0.25 : -0.12, out = 0.07;
    if (sit) { a = -0.5; bend = -0.6; out = 0.05; }
    if (p.pose === 'talk' && s > 0) { a = -0.5 + Math.sin(p.t * 2.2 + p.x) * 0.25; bend = -0.9; }
    if (p.pose === 'present' && s > 0) { a = -0.9 + Math.sin(p.t * 1.6) * 0.35; bend = -0.6; out = 0.25 + Math.sin(p.t * 0.9) * 0.15; }
    if (p.pose === 'present' && s < 0) { a = -0.35; bend = -0.8; }
    if (s > 0 && p.item === 'coffee' && !gOn && !sit) { a = -0.45; bend = -1.35; out = 0.04; }
    if (s > 0 && p.speaking && !gOn) { a = -0.55 + Math.sin(p.t * 3.1) * 0.22; bend = -0.95 + Math.sin(p.t * 2.3) * 0.2; }
    if (gOn) {
      const g = gOn;
      if (s > 0 && g === 'wave') { a = -2.75; out = 0.3 + Math.sin(gt * 12) * 0.32; bend = -0.2; }
      else if (s > 0 && g === 'shake') { a = -1.05; bend = -0.3 + Math.sin(gt * 14) * 0.14; out = -0.08; }
      else if (s > 0 && g === 'point') { a = -1.55; bend = 0; out = 0.12; }
      else if (s > 0 && g === 'think') { a = -0.3; bend = -2.35; out = 0.12; }
      else if (s > 0 && g === 'raise') { a = -3.05; bend = -0.1; out = 0.12 + Math.sin(gt * 3) * 0.04; }
      else if (s < 0 && g === 'heart') { a = -0.45; bend = -1.95; out = -0.42; }
      else if (g === 'clap') { a = -0.95; bend = -1.15; out = -0.32 - Math.max(0, Math.sin(gt * 17)) * 0.16; }
      else if (g === 'laugh') { a = -0.25 + Math.sin(gt * 15) * 0.08; bend = -0.6; }
    }
    const col = robe ? robeCol : topCol, sh = [['t', 0.215 * s, shY, 0], ['z', out * s], ['x', a]];
    R.push(cyl, partM(base, [...sh, ['t', 0, -0.145, 0], ['s', 0.11, 0.29, 0.115]]), col);
    if (!lod) R.push(sph, partM(base, [...sh, ['t', 0, -0.29, 0], ['s', 0.1, 0.1, 0.105]]), col);
    R.push(cyl, partM(base, [...sh, ['t', 0, -0.29, 0], ['x', bend], ['t', 0, -0.13, 0], ['s', 0.095, 0.26, 0.1]]), col);
    if (!lod && !robe) R.push(cyl, partM(base, [...sh, ['t', 0, -0.29, 0], ['x', bend], ['t', 0, -0.255, 0], ['s', 0.085, 0.02, 0.09]]), C4(L.shirt));
    R.push(sph, partM(base, [...sh, ['t', 0, -0.29, 0], ['x', bend], ['t', 0, -0.31, 0.005], ['s', 0.072, 0.1, 0.05]]), skin);
    if (s > 0 && p.item === 'coffee') { R.push(cyl, partM(base, [...sh, ['t', 0, -0.29, 0], ['x', bend], ['t', 0, -0.34, 0.03], ['x', -(a + bend)], ['z', -out * s], ['s', 0.075, 0.1, 0.075]]), [0.96, 0.95, 0.92, 0]); R.push(cyl, partM(base, [...sh, ['t', 0, -0.29, 0], ['x', bend], ['t', 0, -0.34, 0.03], ['x', -(a + bend)], ['z', -out * s], ['t', 0, 0.052, 0], ['s', 0.078, 0.012, 0.078]]), [0.25, 0.16, 0.1, 0]); }
  }
  // ----- head
  const hy = 1.62 + up + (walk ? Math.abs(Math.sin(p.phase)) * 0.01 : 0);
  let nod = p.pose === 'talk' || p.speaking ? Math.sin(p.t * 3 + p.z) * 0.06 : sit ? Math.sin(p.t * 0.4 + p.x * 3) * 0.04 : 0;
  if (gOn === 'nod') nod = Math.sin(gt * 9) * 0.2; else if (gOn === 'laugh') nod = -0.22 + Math.sin(gt * 16) * 0.07; else if (gOn === 'think') nod = 0.12; else if (gOn === 'heart') nod = 0.18;
  R.push(cyl, partM(base, [['t', 0, 1.51 + up, 0], ['s', 0.09, 0.1, 0.09]]), robe ? robeCol : skin);
  const head = new Float32Array(partM(base, [['t', 0, hy, 0], ['x', nod]]));
  R.push(sph, partM(head, [['s', 0.2, 0.245, 0.22]]), skin);
  if (!lod) {
    const blink = ((p.t * 0.6 + L.seed) % 4) < 0.1 ? 0.12 : 1;
    for (const s of [-1, 1]) {
      R.push(I.sph, partM(head, [['t', 0.042 * s, 0.018, 0.096], ['s', 0.024, 0.024 * blink, 0.014]]), [0.05, 0.04, 0.04, 0]);
      R.push(box, partM(head, [['t', 0.044 * s, 0.05, 0.1], ['z', -0.12 * s], ['s', 0.042, 0.008, 0.008]]), dk(L.hair, 0.8));
      R.push(I.sph, partM(head, [['t', 0.1 * s, 0.0, -0.005], ['s', 0.03, 0.05, 0.035]]), dk(L.skin, 0.95));
    }
    R.push(I.sph, partM(head, [['t', 0, -0.012, 0.11], ['s', 0.026, 0.04, 0.03]]), dk(L.skin, 0.96));
    const open = p.speaking ? (0.5 + 0.5 * Math.sin(p.t * 15 + L.seed)) * 0.022 : 0;
    R.push(box, partM(head, [['t', 0, -0.062 - open * 0.3, 0.1], ['s', 0.044, 0.009 + open, 0.01]]), [0.35, 0.12, 0.12, 0]);
    if (L.beard) R.push(sph, partM(head, [['t', 0, -0.075, 0.035], ['s', 0.17, 0.11, 0.15]]), hair);
  }
  if (L.outfit === 'kandura') {
    R.push(sph, partM(head, [['t', 0, 0.04, -0.045], ['s', 0.25, 0.26, 0.24]]), robeCol);
    for (const s of [-1, 1]) R.push(box, partM(head, [['t', 0.112 * s, -0.12, -0.03], ['s', 0.03, 0.3, 0.17]]), robeCol);
    R.push(box, partM(head, [['t', 0, -0.13, -0.1], ['s', 0.26, 0.33, 0.05]]), robeCol);
    R.push(cyl, partM(head, [['t', 0, 0.115, -0.04], ['s', 0.22, 0.022, 0.23]]), [0.05, 0.05, 0.05, 0]);
    if (!lod) R.push(cyl, partM(head, [['t', 0, 0.095, -0.04], ['s', 0.226, 0.018, 0.236]]), [0.05, 0.05, 0.05, 0]);
  } else if (L.outfit === 'abaya') {
    R.push(sph, partM(head, [['t', 0, 0.03, -0.045], ['s', 0.245, 0.28, 0.24]]), robeCol);
    R.push(box, partM(head, [['t', 0, -0.14, -0.06], ['s', 0.27, 0.2, 0.17]]), robeCol);
  } else {
    const hs = L.hairStyle;
    if (hs !== 'bald') R.push(sph, partM(head, [['t', 0, 0.055, -0.018], ['s', 0.212, 0.17, 0.232]]), hair);
    if (hs === 'long') R.push(box, partM(head, [['t', 0, -0.08, -0.085], ['s', 0.21, 0.3, 0.07]]), hair);
    if (hs === 'bob') R.push(sph, partM(head, [['t', 0, -0.01, -0.03], ['s', 0.235, 0.21, 0.23]]), hair);
    if (hs === 'bun') R.push(sph, partM(head, [['t', 0, 0.08, -0.12], ['s', 0.1, 0.1, 0.1]]), hair);
    if (hs === 'side' && !lod) R.push(box, partM(head, [['t', 0.03, 0.105, 0.075], ['z', -0.25], ['s', 0.14, 0.03, 0.05]]), hair);
    if (hs === 'curly' && !lod) for (let k = 0; k < 5; k++) { const ang = k / 5 * Math.PI * 2; R.push(I.sph, partM(head, [['t', Math.cos(ang) * 0.07, 0.1, Math.sin(ang) * 0.07 - 0.01], ['s', 0.08, 0.07, 0.08]]), hair); }
  }
  if (!sit) { const m = M4.ident(); M4.t(m, p.x, (p.y || 0) + 0.02, p.z); M4.rx(m, -Math.PI / 2); M4.s(m, 0.9, 0.9, 1); R.push(I.shadow, m, [0, 0, 0, 0]); }
}

class Crowd {
  constructor(W, Q) {
    const r = rng(42); this.list = [];
    const keep = Q.crowd;
    for (const s of W.people) this.list.push({ ...s, y: s.y || 0, phase: r() * 6, speed: 0, t: 0, look: makeLook(r, s.role) });
    // seated audience
    const seats = W.seats.filter(s => !s.sofa);
    for (const s of seats) if (r() < 0.3 * keep) this.list.push({ x: s.x, z: s.z, y: 0, yaw: s.yaw, pose: 'sit', phase: 0, speed: 0, t: 0, look: makeLook(r, 'guest') });
    for (const s of W.seats.filter(s => s.sofa)) if (r() < 0.55) this.list.push({ x: s.x, z: s.z, y: 0, yaw: s.yaw, pose: 'sit', phase: 0, speed: 0, t: 0, look: makeLook(r, 'guest') });
    // walkers
    this.walkers = [];
    for (const rt of W.routes) {
      const segs = []; let total = 0; const P = rt.pts;
      for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, len, s0: total }); total += len; }
      for (let k = 0; k < Math.max(1, Math.round(rt.n * (0.5 + keep / 2))); k++) {
        const w = { x: P[0][0], z: P[0][1], y: 0, yaw: 0, pose: 'walk', phase: r() * 6, speed: 1.2, t: 0, look: makeLook(r, 'guest'), route: { segs, total }, s: total * (k / rt.n) + r() * 2, v: 1.05 + r() * 0.35, wait: 0 };
        this.walkers.push(w); this.list.push(w);
      }
    }
  }
  update(dt, t, player) {
    for (const p of this.list) p.t = t;
    for (const w of this.walkers) {
      // stop politely if the player is just ahead
      const ahead = Math.hypot(player.x + 0 - (w.x + Math.sin(w.yaw) * 0.9), player.z - (w.z + Math.cos(w.yaw) * 0.9));
      const target = ahead < 0.85 || w.hold ? 0 : w.v;
      w.speed += (target - w.speed) * Math.min(1, dt * 4);
      w.s = (w.s + w.speed * dt) % w.route.total;
      let seg = w.route.segs[0]; for (const sg of w.route.segs) if (w.s >= sg.s0) seg = sg;
      const f = (w.s - seg.s0) / seg.len, nx = seg.a[0] + (seg.b[0] - seg.a[0]) * f, nz = seg.a[1] + (seg.b[1] - seg.a[1]) * f;
      const dx = nx - w.x, dz = nz - w.z; if (Math.hypot(dx, dz) > 1e-4) { const ty = Math.atan2(dx, dz); let d = ty - w.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); w.yaw += d * Math.min(1, dt * 6); }
      if (w.hold && w.faceYaw != null) { let d = w.faceYaw - w.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); w.yaw += d * Math.min(1, dt * 8); }
      w.x = nx; w.z = nz; w.phase += w.speed * dt * 5.2; w.pose = w.speed > 0.15 ? 'walk' : (w.hold ? 'stand' : 'stand');
    }
  }
}
