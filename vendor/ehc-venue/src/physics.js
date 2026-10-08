// ---------- Physics: capsule player, rigid balls, camera spring arm ----------
const PH = { R: 0.34, H: 1.78, STEP: 0.45, G: 22, WALK: 3.1, RUN: 6.4, JUMP: 7.0 };

class CollisionWorld {
  constructor(cols) {
    this.cols = cols; this.cell = 4; this.grid = new Map();
    cols.forEach((c, i) => {
      const [x0, z0, x1, z1] = c.c ? [c.cx - c.r, c.cz - c.r, c.cx + c.r, c.cz + c.r] : [c.x0, c.z0, c.x1, c.z1];
      c.bx0 = x0; c.bz0 = z0; c.bx1 = x1; c.bz1 = z1;
      for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
        for (let gz = Math.floor(z0 / this.cell); gz <= Math.floor(z1 / this.cell); gz++) { const k = gx * 1000 + gz; if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i); }
    });
    this.mark = new Uint32Array(cols.length); this.stamp = 0;
  }
  near(x, z, r) {
    this.stamp++; const out = [];
    for (let gx = Math.floor((x - r) / this.cell); gx <= Math.floor((x + r) / this.cell); gx++)
      for (let gz = Math.floor((z - r) / this.cell); gz <= Math.floor((z + r) / this.cell); gz++) {
        const l = this.grid.get(gx * 1000 + gz); if (!l) continue;
        for (const i of l) if (this.mark[i] !== this.stamp) { this.mark[i] = this.stamp; out.push(this.cols[i]); }
      }
    return out;
  }
  top(c) { return c.c ? c.y1 : c.y1; }
  bottom(c) { return c.y0; }
  // signed penetration of circle (x,z,r) into collider footprint; returns [depth, nx, nz] or null
  pen(c, x, z, r) {
    if (c.c) { const dx = x - c.cx, dz = z - c.cz, d = Math.hypot(dx, dz), rr = c.r + r; if (d >= rr) return null; return d > 1e-6 ? [rr - d, dx / d, dz / d] : [rr, 1, 0]; }
    const cx = Math.max(c.x0, Math.min(x, c.x1)), cz = Math.max(c.z0, Math.min(z, c.z1));
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 > 1e-12) { if (d2 >= r * r) return null; const d = Math.sqrt(d2); return [r - d, dx / d, dz / d]; }
    // centre inside box: push out the nearest face
    const l = x - c.x0, rgt = c.x1 - x, b = z - c.z0, f = c.z1 - z, m = Math.min(l, rgt, b, f);
    if (m === l) return [l + r, -1, 0]; if (m === rgt) return [rgt + r, 1, 0]; if (m === b) return [b + r, 0, -1]; return [f + r, 0, 1];
  }
  inside(x, y, z, pad = 0) { // is a point inside any collider?
    for (const c of this.near(x, z, pad + 0.1)) {
      if (y < c.y0 - pad || y > c.y1 + pad) continue;
      if (c.c) { if (Math.hypot(x - c.cx, z - c.cz) < c.r + pad) return true; }
      else if (x > c.x0 - pad && x < c.x1 + pad && z > c.z0 - pad && z < c.z1 + pad) return true;
    }
    return false;
  }
}

class Player {
  constructor(x, z, yaw) { this.x = x; this.z = z; this.y = 0; this.vx = 0; this.vz = 0; this.vy = 0; this.yaw = yaw; this.ground = true; this.phase = 0; this.speed = 0; this.landed = 0; this.stepEvt = 0; }
  step(dt, input, camYaw, CW, crowd, balls) {
    // desired velocity in camera space
    let ix = input.x, iz = input.y; const mag = Math.min(1, Math.hypot(ix, iz));
    const run = input.run || mag > 0.92 && input.touch;
    const max = (run ? PH.RUN : PH.WALK) * (input.touch ? Math.min(1, mag * 1.15) : 1);
    let tx = 0, tz = 0;
    if (mag > 0.05) {
      const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = -fz, rz = fx; // forward is away from camera
      tx = (fx * iz + rx * ix) / Math.max(mag, 1e-6) * max; tz = (fz * iz + rz * ix) / Math.max(mag, 1e-6) * max;
      const ty = Math.atan2(tx, tz); let d = ty - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); this.yaw += d * Math.min(1, dt * 12);
    }
    const acc = this.ground ? (mag > 0.05 ? 16 : 20) : 4;
    this.vx += (tx - this.vx) * Math.min(1, dt * acc); this.vz += (tz - this.vz) * Math.min(1, dt * acc);
    if (input.jump && this.ground) { this.vy = PH.JUMP; this.ground = false; input.jump = false; this.jumped = true; }
    this.vy -= PH.G * dt;
    let nx = this.x + this.vx * dt, nz = this.z + this.vz * dt, ny = this.y + this.vy * dt;
    // people are soft obstacles (resolved before walls so they can never push the player into geometry)
    for (const q of crowd) { const dx = nx - q.x, dz = nz - q.z, d = Math.hypot(dx, dz); if (d < 0.62 && d > 1e-4 && Math.abs((q.y || 0) - ny) < 1.2) { const k = (0.62 - d), ux = dx / d, uz = dz / d; nx += (ux + uz * 0.35) * k; nz += (uz - ux * 0.35) * k; } }
    // horizontal collision resolution (4 iterations)
    for (let it = 0; it < 4; it++) {
      for (const c of CW.near(nx, nz, PH.R + 0.1)) {
        if (c.y1 <= ny + PH.STEP || c.y0 >= ny + PH.H) continue; // walkable step or overhead
        const p = CW.pen(c, nx, nz, PH.R); if (!p) continue;
        nx += p[1] * p[0]; nz += p[2] * p[0];
        const vn = this.vx * p[1] + this.vz * p[2]; if (vn < 0) { this.vx -= vn * p[1]; this.vz -= vn * p[2]; }
      }
    }
    // ground height
    let g = 0;
    for (const c of CW.near(nx, nz, PH.R)) {
      if (c.y1 > ny + PH.STEP + 0.001) continue;
      const m = PH.R - 0.06; // support whenever the body overlaps the top (no wedging in gaps narrower than the body)
      if (c.c ? Math.hypot(nx - c.cx, nz - c.cz) < c.r + m : (nx > c.x0 - m && nx < c.x1 + m && nz > c.z0 - m && nz < c.z1 + m)) g = Math.max(g, c.y1);
    }
    if (ny <= g) { if (!this.ground && this.vy < -4) this.landed = Math.min(1, -this.vy / 12); ny = g; this.vy = 0; this.ground = true; }
    else if (this.ground && this.vy <= 0 && ny - g < 0.32) { ny = g; this.vy = 0; }
    else this.ground = false;
    // ceiling
    const Z = zoneAt(nx, nz); if (Z && ny + PH.H > Z.ceil) { ny = Z.ceil - PH.H; this.vy = Math.min(0, this.vy); }
    this.x = nx; this.z = nz; this.y = ny;
    this.speed = Math.hypot(this.vx, this.vz);
    const prev = this.phase; this.phase += this.speed * dt * 5.0 / (this.speed > 4 ? 1.35 : 1);
    if (this.ground && this.speed > 0.6 && Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) this.stepEvt++;
    // push balls
    for (const b of balls) {
      const dx = b.p[0] - this.x, dz = b.p[2] - this.z, d = Math.hypot(dx, dz), rr = b.r + PH.R;
      if (d < rr && b.p[1] - b.r < this.y + PH.H && b.p[1] + b.r > this.y) {
        const nxv = dx / (d || 1), nzv = dz / (d || 1), pen = rr - d;
        b.p[0] += nxv * pen; b.p[2] += nzv * pen;
        const rel = (this.vx - b.v[0]) * nxv + (this.vz - b.v[2]) * nzv;
        if (rel > 0) { b.v[0] += nxv * rel * 1.6; b.v[2] += nzv * rel * 1.6; b.v[1] += rel * 0.35; b.hit = Math.max(b.hit || 0, rel); }
      }
    }
  }
}

function stepBalls(balls, dt, CW) {
  const sub = 2, h = dt / sub;
  for (let s = 0; s < sub; s++) {
    for (const b of balls) {
      b.v[1] -= PH.G * h;
      b.p[0] += b.v[0] * h; b.p[1] += b.v[1] * h; b.p[2] += b.v[2] * h;
      // floor and walkable tops
      let g = 0;
      for (const c of CW.near(b.p[0], b.p[2], b.r)) {
        const pen = CW.pen(c, b.p[0], b.p[2], b.r);
        if (!pen) continue;
        if (c.y1 <= b.p[1] - b.r * 0.4) { if (pen[0] > b.r * 0.9) g = Math.max(g, c.y1); continue; }
        if (c.y0 > b.p[1] + b.r) continue;
        b.p[0] += pen[1] * pen[0]; b.p[2] += pen[2] * pen[0];
        const vn = b.v[0] * pen[1] + b.v[2] * pen[2];
        if (vn < 0) { b.v[0] -= 1.6 * vn * pen[1]; b.v[2] -= 1.6 * vn * pen[2]; b.hit = Math.max(b.hit || 0, -vn); }
      }
      if (b.p[1] - b.r < g) { b.p[1] = g + b.r; if (b.v[1] < -1) b.hit = Math.max(b.hit || 0, -b.v[1] * 0.6); b.v[1] = -b.v[1] * 0.62; if (Math.abs(b.v[1]) < 0.4) b.v[1] = 0; b.v[0] *= 1 - 1.1 * h; b.v[2] *= 1 - 1.1 * h; }
      const Z = zoneAt(b.p[0], b.p[2]); if (Z && b.p[1] + b.r > Z.ceil) { b.p[1] = Z.ceil - b.r; b.v[1] = -Math.abs(b.v[1]) * 0.5; }
      b.rot = (b.rot || 0) + Math.hypot(b.v[0], b.v[2]) * h / b.r; b.dir = Math.atan2(b.v[0], b.v[2]);
    }
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], c = balls[j], dx = c.p[0] - a.p[0], dy = c.p[1] - a.p[1], dz = c.p[2] - a.p[2], d = Math.hypot(dx, dy, dz), rr = a.r + c.r;
      if (d < rr && d > 1e-6) {
        const nx = dx / d, ny = dy / d, nz = dz / d, pen = (rr - d) / 2;
        a.p[0] -= nx * pen; a.p[1] -= ny * pen; a.p[2] -= nz * pen; c.p[0] += nx * pen; c.p[1] += ny * pen; c.p[2] += nz * pen;
        const rel = (a.v[0] - c.v[0]) * nx + (a.v[1] - c.v[1]) * ny + (a.v[2] - c.v[2]) * nz;
        if (rel > 0) { const k = rel * 0.9; a.v[0] -= nx * k; a.v[1] -= ny * k; a.v[2] -= nz * k; c.v[0] += nx * k; c.v[1] += ny * k; c.v[2] += nz * k; a.hit = Math.max(a.hit || 0, rel); }
      }
    }
  }
}

// camera spring arm with collision: returns the safe distance along the arm
function armLength(CW, tx, ty, tz, dx, dy, dz, want) {
  const steps = Math.ceil(want / 0.12), Z0 = zoneAt(tx, tz);
  for (let i = 1; i <= steps; i++) {
    const d = want * i / steps, x = tx + dx * d, y = ty + dy * d, z = tz + dz * d;
    const Z = zoneAt(x, z);
    if (!Z || (Z0 && Z !== Z0 && d > 1.2) || y > Z.ceil - 0.25 || y < 0.25 || CW.inside(x, y, z, 0.22)) return Math.max(0.35, d - 0.2);
  }
  return want;
}
