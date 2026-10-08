// ---------- Avatar abilities: sit, gestures, applause, raise hand, queues, walk-me-there, follow, photos ----------
class NavGrid { // 1 m grid over the venue for walk-me-there and follow
  constructor(CW) {
    const [x0, z0, x1, z1] = WORLD_BOUNDS; this.x0 = x0; this.z0 = z0; this.nx = Math.ceil(x1 - x0); this.nz = Math.ceil(z1 - z0);
    this.free = new Uint8Array(this.nx * this.nz); this.CW = CW; this.edges = new Map();
    for (let i = 0; i < this.nx; i++) for (let k = 0; k < this.nz; k++) { const x = x0 + i + 0.5, z = z0 + k + 0.5; this.free[i * this.nz + k] = zoneAt(x, z) && !CW.inside(x, 1.0, z, 0.42) && !CW.inside(x, 0.5, z, 0.42) ? 1 : 0; }
  }
  block(x, z, r) { for (let i = Math.floor(x - r - this.x0); i <= Math.floor(x + r - this.x0); i++) for (let k = Math.floor(z - r - this.z0); k <= Math.floor(z + r - this.z0); k++) if (i >= 0 && k >= 0 && i < this.nx && k < this.nz && Math.hypot(this.x0 + i + 0.5 - x, this.z0 + k + 0.5 - z) < r + 0.5) this.free[i * this.nz + k] = 0; }
  cell(x, z) { return [Math.floor(x - this.x0), Math.floor(z - this.z0)]; }
  ok(i, k) { return i >= 0 && k >= 0 && i < this.nx && k < this.nz && this.free[i * this.nz + k] === 1; }
  nearestFree(x, z) { const [ci, ck] = this.cell(x, z); for (let r = 0; r < 6; r++) for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++) if (this.ok(ci + di, ck + dk)) return [ci + di, ck + dk]; return null; }
  clear(ax, az, bx, bz) { const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 0.25); for (let j = 1; j < n; j++) { const t = j / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t; if (!zoneAt(x, z) || this.CW.inside(x, 1.0, z, 0.44) || this.CW.inside(x, 0.5, z, 0.44) || this.CW.inside(x, 0.15, z, 0.44)) return false; } return true; }
  edge(ai, ak, bi, bk) {
    const k = ai < bi || (ai === bi && ak < bk) ? ai + ',' + ak + '>' + bi + ',' + bk : bi + ',' + bk + '>' + ai + ',' + ak;
    let v = this.edges.get(k); if (v === undefined) { v = this.clear(this.x0 + ai + 0.5, this.z0 + ak + 0.5, this.x0 + bi + 0.5, this.z0 + bk + 0.5); this.edges.set(k, v); }
    return v;
  }
  path(ax, az, bx, bz) {
    const s = this.nearestFree(ax, az), g = this.nearestFree(bx, bz); if (!s || !g) return null;
    const N = this.nx * this.nz, key = (i, k) => i * this.nz + k, G = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [[0, key(s[0], s[1])]]; G[key(s[0], s[1])] = 0; const gk = key(g[0], g[1]);
    const h = (i, k) => Math.hypot(i - g[0], k - g[1]);
    let iter = 0;
    while (open.length && iter++ < 20000) {
      let bi = 0; for (let j = 1; j < open.length; j++) if (open[j][0] < open[bi][0]) bi = j;
      const [, cur] = open.splice(bi, 1)[0]; if (cur === gk) break; if (closed[cur]) continue; closed[cur] = 1;
      const ci = Math.floor(cur / this.nz), ck = cur % this.nz;
      for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
        if (!di && !dk) continue; const ni = ci + di, nk = ck + dk; if (!this.ok(ni, nk)) continue;
        if (di && dk && (!this.ok(ci + di, ck) || !this.ok(ci, ck + dk))) continue;
        if (!this.edge(ci, ck, ni, nk)) continue; // thin walls and boards between cell centres
        const nkk = key(ni, nk), ng = G[cur] + (di && dk ? 1.414 : 1);
        if (ng < G[nkk]) { G[nkk] = ng; from[nkk] = cur; open.push([ng + h(ni, nk), nkk]); }
      }
    }
    if (from[gk] === -1 && gk !== key(s[0], s[1])) return null;
    const cells = []; for (let c = gk; c !== -1; c = from[c]) cells.push(c); cells.reverse();
    const pts = cells.map(c => [this.x0 + Math.floor(c / this.nz) + 0.5, this.z0 + (c % this.nz) + 0.5]); pts.push([bx, bz]);
    const out = [[ax, az]]; let i = 0; // string-pull
    while (i < pts.length - 1) { let j = pts.length - 1; while (j > i + 1 && !this.clear(out[out.length - 1][0], out[out.length - 1][1], pts[j][0], pts[j][1])) j--; out.push(pts[j]); i = j; }
    return out.slice(1);
  }
}

class Abilities {
  constructor(ctx) {
    this.ctx = ctx; this.$ = (id) => document.getElementById(id);
    this.mode = null; // 'sit' | 'walk' | 'follow' | 'queue' | 'photo'
    this.nav = new NavGrid(ctx.CW);
    const crowd = ctx.crowd();
    this.occupied = new Set(crowd.list.filter(p => p.pose === 'sit').map(p => p.x.toFixed(2) + ',' + p.z.toFixed(2)));
    this.queues = this.makeQueues(); this.blockQueues();
    this.wireUI();
  }
  // ----- queues (registration desk and coffee bar)
  makeQueues() {
    const r = rng(77), crowd = this.ctx.crowd(), mk = (spec) => {
      const q = { ...spec, members: [], line: [], player: -1, t: 0 };
      for (let i = 0; i < spec.fill; i++) { const [x, z] = spec.slots[i]; const n = { x, z, y: 0, yaw: spec.face, pose: 'stand', phase: r() * 6, speed: 0, t: 0, look: makeLook(r, 'guest'), queued: q, state: 'queue' }; q.members.push(n); q.line.push(n); crowd.list.push(n); }
      return q;
    };
    const line = (x, z, dx, dz, n) => Array.from({ length: n }, (_, i) => [x + dx * i, z + dz * i]);
    return [
      mk({ id: 'reg', name: 'registration', slots: line(-19, 19.55, 0, 0.8, 7), face: Math.PI, fill: 4, period: 7, exit: [[-12.6, 20.4], [-12.6, 24.3], [-15.6, 24.3]], item: 'badge', say: 'Welcome! Here’s your badge. Enjoy the conference.' }),
      mk({ id: 'coffee', name: 'coffee bar', slots: line(42.55, -34, -0.8, 0, 6), face: Math.PI / 2, fill: 3, period: 8, exit: [[42.2, -30.4], [37.2, -29.6], [37.6, -34]], item: 'coffee', say: 'Here’s your coffee. Careful, it’s hot.' }),
    ];
  }
  blockQueues() { for (const q of this.queues) { const [fx, fz] = q.slots[0]; this.nav.block(fx + Math.sin(q.face) * 0.6, fz + Math.cos(q.face) * 0.6, 0.3); for (const [x, z] of q.slots) this.nav.block(x, z, 0.35); } }
  stepQueues(dt) {
    const t = this.ctx.time();
    for (const q of this.queues) {
      q.t += dt;
      if (q.t > q.period && q.line.length) {
        q.t = 0; const front = q.line[0];
        if (front === 'P') { if (this.mode === 'queue' && this.q === q && this.atSlot) { q.line.shift(); this.served(q); } }
        else { q.line.shift(); front.state = 'leave'; front.leg = 0; front.gesture = 'nod'; front.gT = t; }
      }
      q.player = q.line.indexOf('P');
      q.line.forEach((m, i) => { const sl = q.slots[Math.min(i, q.slots.length - 1)]; if (m === 'P') { this.playerSlot = sl; this.playerSlotIdx = i; return; } this.walkTo(m, sl, dt, q.face); });
      for (const m of q.members) if (m.state === 'leave') {
        if (m.leg < q.exit.length) { if (this.walkTo(m, q.exit[m.leg], dt)) m.leg++; }
        else if (q.line.length < q.slots.length) { m.state = 'queue'; q.line.push(m); } // rejoin the back of the line
        else { m.speed = 0; m.pose = 'stand'; }
      }
    }
  }
  walkTo(m, [tx, tz], dt, faceYaw) {
    const dx = tx - m.x, dz = tz - m.z, d = Math.hypot(dx, dz), v = 1.15;
    if (d > 0.05) { const s = Math.min(d, v * dt); m.x += dx / d * s; m.z += dz / d * s; let ty = Math.atan2(dx, dz), dd = ty - m.yaw; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); m.yaw += dd * Math.min(1, dt * 8); m.speed = v; m.pose = 'walk'; m.phase += v * dt * 5.2; return false; }
    m.speed = 0; m.pose = 'stand'; if (faceYaw != null) { let dd = faceYaw - m.yaw; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); m.yaw += dd * Math.min(1, dt * 5); }
    return true;
  }
  nearQueue() { const pl = this.ctx.player(); for (const q of this.queues) { const tail = q.slots[Math.min(q.line.length, q.slots.length - 1)]; if (Math.hypot(pl.x - tail[0], pl.z - tail[1]) < 3.2 && q.player < 0) return q; } return null; }
  joinQueue(q) {
    this.stop(); if (q.line.length >= q.slots.length) { this.toast(`The ${q.name} queue is full. Try again in a moment.`); return; } this.mode = 'queue'; this.q = q; q.line.push('P'); q.player = q.line.length - 1; this.atSlot = false; this.playerSlot = q.slots[q.player];
    this.toast(`You joined the queue for the ${q.name}.`); this.refresh();
  }
  served(q) {
    const pl = this.ctx.player(), staff = this.ctx.crowd().list.filter(p => (p.role === 'staff' || p.role === 'barista') && Math.hypot(p.x - pl.x, p.z - pl.z) < 4).sort((a, b) => Math.hypot(a.x - pl.x, a.z - pl.z) - Math.hypot(b.x - pl.x, b.z - pl.z))[0];
    this.lastServer = staff ? staff.role : null;
    if (staff && this.ctx.social) { this.ctx.social.persona(staff); this.ctx.social.bubble(staff, q.say, {}); this.ctx.social.speak(staff, q.say); staff.gesture = 'nod'; staff.gT = this.ctx.time(); }
    if (q.item === 'coffee') { pl.item = 'coffee'; pl.itemUntil = this.ctx.time() + 120; } else pl.badgeCollected = true;
    this.served_ = (this.served_ || 0) + 1;
    q.player = -1; this.mode = null; this.q = null; pl.yaw = q.face; this.toast(q.item === 'coffee' ? 'Coffee in hand.' : 'Badge collected.'); this.refresh();
  }
  // ----- sit
  freeSeatNear(radius = 3) {
    const pl = this.ctx.player(), seats = this.ctx.W.seats; let best = null, bd = radius;
    for (const s of seats) { const k = s.x.toFixed(2) + ',' + s.z.toFixed(2); if (this.occupied.has(k)) continue; const d = Math.hypot(s.x - pl.x, s.z - pl.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  sit() {
    const s = this.freeSeatNear(); if (!s) { this.toast('No free seat close by. Walk up to a row or a sofa.'); return; }
    const pl = this.ctx.player(); this.stop();
    this.sitFrom = [pl.x, pl.z, pl.yaw]; this.seat = s; this.occupied.add(s.x.toFixed(2) + ',' + s.z.toFixed(2));
    pl.x = s.x; pl.z = s.z; pl.y = 0; pl.vx = pl.vz = pl.vy = 0; pl.yaw = s.yaw; this.mode = 'sit';
    this.ctx.cam.yaw = s.yaw - Math.PI; this.ctx.cam.pitch = this.ctx.camView && this.ctx.camView() === 'eye' ? -0.04 : 0.42; this.refresh();
  }
  stand() {
    if (this.mode !== 'sit') return; const pl = this.ctx.player(), s = this.seat;
    this.occupied.delete(s.x.toFixed(2) + ',' + s.z.toFixed(2));
    const [x, z, yaw] = this.sitFrom; pl.x = x; pl.z = z; pl.yaw = yaw; this.mode = null; this.seat = null; this.refresh();
  }
  // ----- walk me there / follow
  walkTo_(x, z, label) {
    const pl = this.ctx.player(), p = this.nav.path(pl.x, pl.z, x, z);
    if (!p) { this.toast('Can’t find a way there. Jumping instead.'); return false; }
    this.stop(); this.mode = 'walk'; this.route = p; this.ri = 0; this.dest = label; this.destXZ = [x, z]; this.replans = 0; this.stuckT = 0; this.lastD = 1e9; this.walkStart = this.ctx.time();
    this.toast(`Walking you to the ${label}. Move to take over.`); this.refresh(); return true;
  }
  walkToZone(Z) { return this.walkTo_(Z.spawn[0], Z.spawn[1], Z.name); }
  follow(target, label) { this.stop(); this.mode = 'follow'; this.ft = target; this.flabel = label; this.replanT = 0; this.route = null; this.toast(`Following ${label}. Move to stop.`); this.refresh(); }
  steer(input, tx, tz, run) {
    const pl = this.ctx.player(), cy = this.ctx.cam.yaw, dx = tx - pl.x, dz = tz - pl.z, d = Math.hypot(dx, dz) || 1;
    const fx = -Math.sin(cy), fz = -Math.cos(cy), rx = -fz, rz = fx; // camera-relative axes, as Player.step uses them
    input.x = (dx * rx + dz * rz) / d; input.y = (dx * fx + dz * fz) / d; input.run = run; input.touch = true;
  }
  // called every fixed step before physics; returns true when physics should be skipped
  preStep(dt, input) {
    const pl = this.ctx.player();
    if (this.mode === 'sit') { pl.vx = pl.vz = 0; return true; }
    if (this.mode === 'queue') {
      const sl = this.playerSlot; if (!sl) return true;
      const dx = sl[0] - pl.x, dz = sl[1] - pl.z, d = Math.hypot(dx, dz);
      if (d > 0.06) { const s = Math.min(d, 1.2 * dt); pl.x += dx / d * s; pl.z += dz / d * s; pl.speed = 1.2; pl.phase += 1.2 * dt * 5; let ty = Math.atan2(dx, dz), dd = ty - pl.yaw; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); pl.yaw += dd * Math.min(1, dt * 8); this.atSlot = false; }
      else { pl.speed = 0; let dd = this.q.face - pl.yaw; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); pl.yaw += dd * Math.min(1, dt * 5); this.atSlot = true; }
      return true;
    }
    if (this.mode === 'walk') {
      const wp = this.route[this.ri], d = Math.hypot(wp[0] - pl.x, wp[1] - pl.z);
      if (d < 0.45) { this.ri++; this.stuckT = 0; this.lastD = 1e9; this.replans = 0; if (this.ri >= this.route.length) { this.arrived = (this.arrived || 0) + 1; this.toast(`You’ve arrived at the ${this.dest}.`); this.mode = null; input.x = input.y = 0; input.touch = false; input.run = false; this.refresh(); return false; } return false; }
      this.stuckT = d < this.lastD - 0.01 ? 0 : this.stuckT + dt; this.lastD = Math.min(this.lastD, d);
      if (this.stuckT > 1.0 && this.replans < 2) { const np = this.nav.path(pl.x, pl.z, this.destXZ[0], this.destXZ[1]); this.replans++; this.stuckT = 0; this.lastD = 1e9; if (np && np.length) { this.route = np; this.ri = 0; this.replanned = (this.replanned || 0) + 1; return false; } }
      if (this.stuckT > 2.0) { pl.x = wp[0]; pl.z = wp[1]; this.stuckT = 0; this.replans = 0; this.snaps = (this.snaps || 0) + 1; }
      this.steer(input, wp[0], wp[1], d > 3); return false;
    }
    if (this.mode === 'follow') {
      const t = this.ft; if (!t || (t.isPeer && !this.ctx.social.peers.has(t.peer))) { this.toast('Lost them in the crowd.'); this.stop(); return false; }
      const bx = t.x - Math.sin(t.yaw) * 1.3, bz = t.z - Math.cos(t.yaw) * 1.3, d = Math.hypot(t.x - pl.x, t.z - pl.z);
      this.replanT -= dt;
      if (this.replanT <= 0) { this.replanT = 0.8; this.route = d > 2.2 ? this.nav.path(pl.x, pl.z, bx, bz) : null; this.ri = 0; }
      if (d < 1.6 || !this.route || !this.route.length) { input.x = input.y = 0; input.touch = true; input.run = false; return false; }
      let wp = this.route[Math.min(this.ri, this.route.length - 1)]; if (Math.hypot(wp[0] - pl.x, wp[1] - pl.z) < 0.5 && this.ri < this.route.length - 1) { this.ri++; wp = this.route[this.ri]; }
      this.steer(input, wp[0], wp[1], d > 4); return false;
    }
    return false;
  }
  cancelByUser() { if (this.mode && this.mode !== 'photo') { if (this.mode === 'sit') this.stand(); else this.stop(); } }
  stop() {
    if (this.mode === 'sit') return this.stand();
    if (this.q) { const i = this.q.line.indexOf('P'); if (i >= 0) this.q.line.splice(i, 1); this.q.player = -1; this.q = null; }
    const inp = this.ctx.input; inp.x = inp.y = 0; inp.touch = false; inp.run = false;
    this.mode = null; this.route = null; this.ft = null; this.refresh();
  }
  // ----- gestures
  gesture(g) {
    const sc = this.ctx.social, pl = this.ctx.player(), t = this.ctx.time(), Z = this.ctx.zone();
    if (sc) sc.gesture(g); else { pl.gesture = g; pl.gT = t; }
    if (g === 'clap') {
      const room = Z && /plenary|hall|workshop/.test(Z.id); let n = 0;
      for (const p of this.ctx.crowd().list) { if (Math.hypot(p.x - pl.x, p.z - pl.z) > (room ? 30 : 10) || p.role === 'staff' || p.role === 'barista') continue; if (!room && Math.random() < 0.4) continue; p.gesture = 'clap'; p.gT = t + Math.random() * 0.6; n++; }
      this.lastClap = n; this.ctx.audio.applause(3, Math.min(1.5, 0.3 + n / 60));
    }
    if (g === 'raise') {
      const sp = this.ctx.crowd().list.find(p => p.pose === 'present' && zoneAt(p.x, p.z) === Z);
      if (sp && sc) setTimeout(() => {
        const line = 'Yes, a question from the floor? Go ahead.'; sc.persona(sp); sc.bubble(sp, line, {}); sc.speak(sp, line); sp.gesture = 'point'; sp.gT = this.ctx.time();
        this.speakerAnswered = (this.speakerAnswered || 0) + 1; if (this.ctx.onEvent) this.ctx.onEvent('speakerQ');
        setTimeout(() => { if (!sp.turns || !sp.turns.length) sc.open({ kind: 'npc', ref: sp, d: 99, remote: true, greet: 'Yes, a question from the floor? Go ahead, I’m listening.', quick: ['What’s the main takeaway?', 'How would this work in practice?', 'Will the slides be shared?', 'What should we watch for next year?'] }); else sc.open({ kind: 'npc', ref: sp, d: 99, remote: true }); }, 1600);
      }, 1100);
    }
  }
  // ----- photo
  async photo() {
    if (this.mode === 'photo') return; const prev = this.mode; if (prev === 'walk' || prev === 'follow') this.stop();
    const pl = this.ctx.player(), cam = this.ctx.cam, t = this.ctx.time();
    this.mode = 'photo'; this.prevMode = prev;
    const near = this.ctx.crowd().list.filter(p => p.pose !== 'sit' && Math.hypot(p.x - pl.x, p.z - pl.z) < 3.2 && !p.route);
    const yaw = pl.yaw, cx = pl.x + Math.sin(yaw) * 2.8, cz = pl.z + Math.cos(yaw) * 2.8;
    this.camOverride = { pos: [cx, (pl.y || 0) + 1.6, cz], tgt: [pl.x, (pl.y || 0) + 1.35, pl.z] };
    for (const p of near) { p._yaw = p.yaw; p.yaw = Math.atan2(cx - p.x, cz - p.z); p.gesture = 'wave'; p.gT = t + 0.6; }
    const cd = this.$('countdown'); cd.hidden = false;
    for (const n of ['3', '2', '1']) { cd.textContent = n; await new Promise(r => setTimeout(r, 650)); }
    cd.hidden = true; if (this.ctx.social) this.ctx.social.gesture('wave'); else { pl.gesture = 'wave'; pl.gT = this.ctx.time(); }
    await new Promise(r => setTimeout(r, 450));
    this.ctx.render(); const shot = this.ctx.canvas.toDataURL('image/jpeg', 0.92);
    this.ctx.audio.shutter(); this.$('flash').classList.add('on'); setTimeout(() => this.$('flash').classList.remove('on'), 180);
    for (const p of near) if (p._yaw != null) { p.yaw = p._yaw; delete p._yaw; }
    this.camOverride = null; this.mode = prev === 'sit' || (prev === 'queue' && this.q) ? prev : null; // a photo never drops you out of your seat or the queue
    await this.showPhoto(shot, near.length);
  }
  async showPhoto(url, n) {
    const img = new Image(); img.src = url; await img.decode().catch(() => { });
    const W = 1600, H = Math.round(W * img.height / Math.max(1, img.width)), band = 150;
    const c = document.createElement('canvas'); c.width = W; c.height = H + band; const x = c.getContext('2d');
    x.fillStyle = '#16100f'; x.fillRect(0, 0, W, H + band); x.drawImage(img, 0, 0, W, H);
    x.fillStyle = '#6d1624'; x.fillRect(0, H, W, 6);
    x.fillStyle = '#c8a46a'; x.font = `600 22px ${FONT_BODY}`; x.fillText('EMIRATES HEMATOLOGY CONFERENCE 2026', 48, H + 52);
    x.fillStyle = '#f3ece4'; x.font = `400 46px ${FONT_DISPLAY}`; const Z = this.ctx.zone(); x.fillText((Z ? Z.name : 'The venue') + ' · ' + EVENT.venue, 48, H + 106);
    x.textAlign = 'right'; x.fillStyle = 'rgba(243,236,228,.7)'; x.font = `500 22px ${FONT_BODY}`; x.fillText(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), W - 48, H + 52); x.fillText('Online venue preview', W - 48, H + 106);
    if (this.ctx.onEvent) this.ctx.onEvent('photo');
    const out = c.toDataURL('image/jpeg', 0.9); this.lastPhoto = { url: out, bytes: Math.round(out.length * 0.75), people: n };
    const sheet = this.$('photoSheet'); this.$('photoImg').src = out; sheet.hidden = false; this.ctx.onSheet(true);
  }
  // ----- UI
  wireUI() {
    const $ = this.$, map = { aWave: 'wave', aHeart: 'heart', aClap: 'clap', aRaise: 'raise' };
    for (const id in map) $(id).addEventListener('click', () => this.gesture(map[id]));
    $('aPhoto').addEventListener('click', () => this.photo());
    $('aSit').addEventListener('click', () => this.mode === 'sit' ? this.stand() : this.sit());
    $('aCtx').addEventListener('click', () => { const c = this.ctxAction; if (c) c.fn(); });
    $('tActions').addEventListener('click', () => { const b = $('abar'); b.classList.toggle('open'); $('tActions').setAttribute('aria-pressed', String(b.classList.contains('open'))); });
    $('photoClose').addEventListener('click', () => { $('photoSheet').hidden = true; this.ctx.onSheet(false); });
    $('photoSave').addEventListener('click', async () => {
      const p = this.lastPhoto; if (!p) return; const note = $('photoNote');
      const blob = await (await fetch(p.url)).blob(); const name = 'ehc-2026-photo-' + Date.now() + '.jpg';
      const dl = this.ctx.downloads && await this.ctx.downloads();
      if (dl) { try { const r = await dl.save({ filename: name, data: blob }); note.textContent = r && r.status === 'saved' ? 'Saved.' : 'Sent.'; } catch (e) { note.textContent = e && e.code === 'cancelled' ? '' : 'Couldn’t save the photo here. Long-press the picture to save it instead.'; } }
      else note.textContent = 'Long-press or right-click the picture to save it.';
    });
  }
  refresh() {
    const $ = this.$, sit = this.mode === 'sit';
    $('aSitL').textContent = sit ? 'Stand up' : 'Sit down'; $('aSit').setAttribute('aria-pressed', String(sit));
    $('aSit').disabled = !sit && !this.freeSeatNear();
    const pill = $('modePill');
    const label = this.mode === 'walk' ? `Walking to the ${this.dest}` : this.mode === 'follow' ? `Following ${this.flabel}` : this.mode === 'queue' ? `In the queue for the ${this.q.name}` : this.mode === 'sit' ? 'Seated' : '';
    pill.hidden = !label; pill.querySelector('span').textContent = label;
  }
  updateContext(nearP) { // contextual action: join queue / follow
    const q = this.mode ? null : this.nearQueue(), $ = this.$;
    let c = null;
    if (q) c = { label: 'Join the queue', fn: () => this.joinQueue(q) };
    else if (!this.mode && nearP && (nearP.ref.route || nearP.ref.isPeer)) { const nm = nearP.kind === 'npc' ? this.ctx.social.persona(nearP.ref).name : nearP.ref.name; c = { label: 'Follow', fn: () => this.follow(nearP.ref, nm) }; }
    this.ctxAction = c; $('aCtx').hidden = !c; if (c) $('aCtx').textContent = c.label;
    const can = this.mode === 'sit' || !!this.freeSeatNear(); if ($('aSit').disabled === can) $('aSit').disabled = !can;
  }
  toast(m) { this.ctx.toast(m); }
}
