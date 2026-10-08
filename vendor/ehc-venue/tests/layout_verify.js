// EA-SYS (phase 6): the venue's own walking checks, run on a venue generated from an event's rooms
// (window.EHC_LAYOUT). Sections 1, 2 and 5 of verify.js are generic and are repeated here unchanged
// in substance; the door, room-to-room and hotspot checks read the generated layout instead of
// EHC's hand-placed coordinates. Returns a JSON report with exact counts.
(() => {
  const E = window.__EHC, P = () => E.player, Z = E.ZONES, CW = E.CW, L = window.EHC_LAYOUT, A = E.abil;
  const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const rep = {};
  const zoneOf = (x, z) => { for (const q of Z) { const r = q.rect; if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return q.id; } return null; };
  const stepCheck = (inp) => { E.sim(1, inp); const pen = E.penetration(); const p = P(); return { pen, oob: !zoneOf(p.x, p.z), under: p.y < -0.001 }; };

  // 1. random-walk collision bot (verify.js section 1)
  { let steps = 0, maxPen = 0, oob = 0, under = 0, viol = 0;
    for (const q of Z) { E.teleport(q.id); for (let seg = 0; seg < 40; seg++) {
      const inp = { x: rnd() * 2 - 1, y: rnd() * 2 - 1, run: rnd() < 0.5, jump: rnd() < 0.15 }; E.cam.yaw = rnd() * 6.283;
      for (let k = 0; k < 25; k++) { const r = stepCheck(inp); inp.jump = false; steps++; maxPen = Math.max(maxPen, r.pen); if (r.pen > 0.01) viol++; if (r.oob) oob++; if (r.under) under++; } } }
    rep.randomWalk = { zones: Z.length, steps, maxPenetration_m: +maxPen.toFixed(4), penetrationViolations: viol, outOfBounds: oob, belowFloor: under }; }

  // 2. wall push (verify.js section 2): run straight into every tall wall segment from both sides
  { let tests = 0, crossed = 0, maxPen = 0;
    const walls = CW.cols.filter(c => !c.c && c.y1 >= 5 && c.y0 < 0.5 && ((c.x1 - c.x0) < 0.35 || (c.z1 - c.z0) < 0.35));
    for (const w of walls) {
      const alongX = (w.x1 - w.x0) > (w.z1 - w.z0), len = alongX ? w.x1 - w.x0 : w.z1 - w.z0;
      for (const f of [0.25, 0.5, 0.75]) for (const side of [-1, 1]) {
        if (len < 1.2) continue;
        let x, z; if (alongX) { x = w.x0 + len * f; z = (side < 0 ? w.z0 : w.z1) + side * 0.7; } else { z = w.z0 + len * f; x = (side < 0 ? w.x0 : w.x1) + side * 0.7; }
        if (!zoneOf(x, z) || CW.inside(x, 1, z, 0.36)) continue;
        E.place(x, z, 0); E.cam.yaw = 0;
        const dir = alongX ? { x: 0, y: side > 0 ? 1 : -1 } : { x: side > 0 ? -1 : 1, y: 0 };
        for (let k = 0; k < 90; k++) { E.sim(1, { ...dir, run: true }); maxPen = Math.max(maxPen, E.penetration()); }
        const p = P(); const now = alongX ? Math.sign(p.z - (w.z0 + w.z1) / 2) : Math.sign(p.x - (w.x0 + w.x1) / 2);
        tests++; if (now !== side) crossed++;
      }
    }
    rep.wallPush = { wallSegments: walls.length, pushTests: tests, wallsCrossed: crossed, maxPenetration_m: +maxPen.toFixed(4) }; }

  // 3. every generated doorway: steer from one side to the other and arrive in the other room
  { const res = [];
    for (const d of L.doors) {
      const across = d.axis === 'x' ? [[d.x, d.z + 1.6], [d.x, d.z - 1.6]] : [[d.x - 1.6, d.z], [d.x + 1.6, d.z]];
      for (const [from, to] of [[across[0], across[1]], [across[1], across[0]]]) {
        const a = zoneOf(from[0], from[1]), b = zoneOf(to[0], to[1]); if (!a || !b || a === b) continue;
        E.place(from[0], from[1], 0); E.cam.yaw = 0;
        for (let k = 0; k < 600; k++) { const p = P(), dx = to[0] - p.x, dz = to[1] - p.z, dd = Math.hypot(dx, dz); if (dd < 0.35) break; E.sim(1, { x: dx / dd, y: -dz / dd }); }
        res.push({ from: a, to: b, ok: zoneOf(P().x, P().z) === b });
      }
    }
    rep.doors = { tested: res.length, passed: res.filter(r => r.ok).length, failed: res.filter(r => !r.ok).map(r => r.from + '→' + r.to) }; }

  // 4. walk-me-there from every room to every other (test_abilities walkAllPairs)
  { let n = 0, ok = 0, maxPen = 0; const fails = [];
    for (const S of Z) for (const T of Z) { if (S === T) continue; E.teleport(S.id); n++; if (!A.walkToZone(T)) { fails.push(S.id + '>' + T.id + ' nopath'); continue; }
      let t = 0; while (A.mode === 'walk' && t < 60 * 120) { E.tick(15); t += 15; maxPen = Math.max(maxPen, E.penetration()); }
      if (A.mode === null && E.zone === T.id) ok++; else fails.push(S.id + '>' + T.id); }
    rep.walkAllPairs = { pairs: n, arrived: ok, failed: fails, maxPenetration_m: +maxPen.toFixed(4) }; }

  // 5. camera spring-arm (verify.js section 5)
  { let poses = 0, inside = 0, outside = 0, aboveCeil = 0;
    while (poses < 400) {
      const q = Z[Math.floor(rnd() * Z.length)], r = q.rect, x = r[0] + 0.5 + rnd() * (r[2] - r[0] - 1), z = r[1] + 0.5 + rnd() * (r[3] - r[1] - 1);
      if (CW.inside(x, 1, z, 0.4)) continue;
      E.place(x, z, rnd() * 6.28); E.setView(rnd() * 6.283, -0.25 + rnd() * 1.4, 2 + rnd() * 7);
      const c = E.cam.pos; poses++;
      if (CW.inside(c[0], c[1], c[2], 0)) inside++;
      const zq = Z.find(qq => qq.id === zoneOf(c[0], c[2])); if (!zq) outside++; else if (c[1] > zq.ceil) aboveCeil++;
    }
    rep.camera = { poses, lensInsideGeometry: inside, lensOutsideVenue: outside, lensAboveCeiling: aboveCeil }; }

  // 6. every hotspot: stand within its reach, clear of furniture and people, and open it
  { const hs = E.W.interact; let opened = 0; const failed = [];
    for (const h of hs) {
      let found = false;
      for (let k = 0; k < 200 && !found; k++) { const a = k * 2.399, d = Math.min(h.r * 0.85, 0.3 + k * 0.02), x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
        if (!zoneOf(x, z) || CW.inside(x, 1, z, 0.38)) continue; E.place(x, z, 0); found = true; }
      const got = found && E.openNear(); const vis = !document.getElementById('info').hidden; E.closeSheets();
      if (found && got === h.id && vis) opened++; else failed.push(h.id);
    }
    rep.hotspots = { count: hs.length, opened, failed }; }

  rep.scene = { zones: Z.length, staticTriangles: E.W.stats.tris, colliders: CW.cols.length, people: E.W.people.length, seats: E.W.seats.length, screens: E.W.screens.length };
  E.teleport(Z[0].id);
  return JSON.stringify(rep);
})()
