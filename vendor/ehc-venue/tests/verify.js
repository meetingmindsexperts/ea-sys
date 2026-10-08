// In-page verification suite. Returns a JSON report with exact counts.
(() => {
  const E = window.__EHC, P = () => E.player, Z = E.ZONES, CW = E.CW;
  const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const rep = {};
  const zoneOf = (x, z) => { for (const q of Z) { const r = q.rect; if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return q.id; } return null; };
  const stepCheck = (inp) => { E.sim(1, inp); const pen = E.penetration(); const p = P(); return { pen, oob: !zoneOf(p.x, p.z), under: p.y < -0.001 }; };

  // 1. random-walk collision bot
  { let steps = 0, maxPen = 0, oob = 0, under = 0, viol = 0;
    for (const q of Z) { E.teleport(q.id); for (let seg = 0; seg < 60; seg++) {
      const inp = { x: rnd() * 2 - 1, y: rnd() * 2 - 1, run: rnd() < 0.5, jump: rnd() < 0.15 }; E.cam.yaw = rnd() * 6.283;
      for (let k = 0; k < 25; k++) { const r = stepCheck(inp); inp.jump = false; steps++; maxPen = Math.max(maxPen, r.pen); if (r.pen > 0.01) viol++; if (r.oob) oob++; if (r.under) under++; } } }
    rep.randomWalk = { zones: Z.length, steps, maxPenetration_m: +maxPen.toFixed(4), penetrationViolations: viol, outOfBounds: oob, belowFloor: under }; }

  // 2. wall push test: run straight into every tall wall segment from both sides
  { let tests = 0, crossed = 0, maxPen = 0;
    const walls = CW.cols.filter(c => !c.c && c.y1 >= 5 && c.y0 < 0.5 && ((c.x1 - c.x0) < 0.35 || (c.z1 - c.z0) < 0.35));
    for (const w of walls) {
      const alongX = (w.x1 - w.x0) > (w.z1 - w.z0), len = alongX ? w.x1 - w.x0 : w.z1 - w.z0;
      for (const f of [0.25, 0.5, 0.75]) for (const side of [-1, 1]) {
        if (len < 1.2) continue;
        let x, z; if (alongX) { x = w.x0 + len * f; z = (side < 0 ? w.z0 : w.z1) + side * 0.7; } else { z = w.z0 + len * f; x = (side < 0 ? w.x0 : w.x1) + side * 0.7; }
        if (!zoneOf(x, z) || CW.inside(x, 1, z, 0.36)) continue;
        E.place(x, z, 0); E.cam.yaw = 0;
        const dir = alongX ? { x: 0, y: side > 0 ? 1 : -1 } : { x: side > 0 ? -1 : 1, y: 0 }; // camYaw 0: input.x=+x, input.y=-z
        for (let k = 0; k < 90; k++) { E.sim(1, { ...dir, run: true }); maxPen = Math.max(maxPen, E.penetration()); }
        const p = P(); const now = alongX ? Math.sign(p.z - (w.z0 + w.z1) / 2) : Math.sign(p.x - (w.x0 + w.x1) / 2);
        tests++; if (now !== side) crossed++;
      }
    }
    rep.wallPush = { wallSegments: walls.length, pushTests: tests, framesPerTest: 90, wallsCrossed: crossed, maxPenetration_m: +maxPen.toFixed(4) }; }

  // 3. door traversal: steer through each doorway and confirm arrival in the next room
  { const doors = [['foyer', 'plenary', [5, 9], [0, 1.2], [0, -2]], ['foyer', 'posters', [-26, 1.2], [-26, -2]], ['foyer', 'promenade', [26, 1.2], [26, -2]], ['foyer', 'hallA', [-28.6, 21], [-32, 21]], ['foyer', 'hallB', [-28.6, 6], [-32, 6]],
      ['posters', 'hallC', [-28.6, -15], [-32, -15]], ['posters', 'workshop', [-28.6, -35], [-32, -35]], ['posters', 'plenary', [-23.6, -10.5], [-20.5, -10.5]], ['plenary', 'promenade', [20.4, -10.5], [23.6, -10.5]],
      ['promenade', 'expo', [28.6, -10], [31.8, -10]], ['foyer', 'expo', [28.6, 15], [32, 15]], ['lounge', 'expo', [38, -21.6], [38, -18.2]], ['promenade', 'lounge', [26, -18.5], [26, -22.5]]];
    const res = [];
    for (const d of doors) { const a = d[0], b = d[1], wps = d.slice(2);
      E.teleport(a); E.cam.yaw = 0; let ok = false, frames = 0;
      for (const wp of wps) { for (let k = 0; k < 900; k++) { const p = P(), dx = wp[0] - p.x, dz = wp[1] - p.z, d = Math.hypot(dx, dz); if (d < 0.35) break; E.sim(1, { x: dx / d, y: -dz / d, run: d > 2 }); frames++; } }
      ok = zoneOf(P().x, P().z) === b; res.push({ from: a, to: b, ok, frames });
    }
    rep.doors = { tested: res.length, passed: res.filter(r => r.ok).length, failed: res.filter(r => !r.ok).map(r => r.from + '→' + r.to) }; }

  // 4. stage steps, jump height, booth floor step-up
  { E.place(12.5, -31.5, Math.PI); E.cam.yaw = 0; for (let k = 0; k < 120; k++) E.sim(1, { x: 0, y: 1 }); const onStage = P().y;
    E.place(0, 26, 0); let top = 0; E.sim(1, { jump: true }); for (let k = 0; k < 90; k++) { E.sim(1, {}); top = Math.max(top, P().y); } const landed = P().y;
    E.place(38, 16, 0); E.cam.yaw = 0; for (let k = 0; k < 90; k++) E.sim(1, { x: 0, y: -1 }); const booth = P().y;
    E.place(0, -25, Math.PI); E.cam.yaw = 0; for (let k = 0; k < 120; k++) E.sim(1, { x: 1, y: 0 }); const blockedBySeats = P().x < 2.6 + 0.5;
    rep.verticals = { stageTop_m: +onStage.toFixed(3), expectedStage_m: 0.9, jumpApex_m: +top.toFixed(3), landedAt_m: +landed.toFixed(3), boothFloor_m: +booth.toFixed(3), seatRowsBlockSideways: blockedBySeats }; }

  // 5. camera spring-arm: random poses never put the lens inside geometry
  { let poses = 0, inside = 0, outside = 0, aboveCeil = 0;
    while (poses < 600) {
      const q = Z[Math.floor(rnd() * Z.length)], r = q.rect, x = r[0] + 0.5 + rnd() * (r[2] - r[0] - 1), z = r[1] + 0.5 + rnd() * (r[3] - r[1] - 1);
      if (CW.inside(x, 1, z, 0.4)) continue;
      E.place(x, z, rnd() * 6.28); E.setView(rnd() * 6.283, -0.25 + rnd() * 1.4, 2 + rnd() * 7);
      const c = E.cam.pos; poses++;
      if (CW.inside(c[0], c[1], c[2], 0)) inside++;
      const zq = Z.find(qq => qq.id === zoneOf(c[0], c[2])); if (!zq) outside++; else if (c[1] > zq.ceil) aboveCeil++;
    }
    rep.camera = { poses, lensInsideGeometry: inside, lensOutsideVenue: outside, lensAboveCeiling: aboveCeil }; }

  // 6. physics balls
  { const B = E.W.balls, b = B[0], start = [...b.p];
    E.place(b.p[0], b.p[2] + 3, Math.PI); E.cam.yaw = 0;
    for (let k = 0; k < 80; k++) E.sim(1, { x: 0, y: 1, run: true });
    for (let k = 0; k < 600; k++) E.sim(1, {});
    const moved = Math.hypot(b.p[0] - start[0], b.p[2] - start[2]);
    const inExpo = B.every(q => zoneOf(q.p[0], q.p[2]) === 'expo'), aboveFloor = B.every(q => q.p[1] >= q.r - 0.01);
    const settled = B.every(q => Math.hypot(...q.v) < 0.3);
    rep.balls = { count: B.length, kickedBallMoved_m: +moved.toFixed(2), allStillInExhibition: inExpo, noneThroughFloor: aboveFloor, settledAfter10s: settled }; }

  // scene stats
  rep.scene = { staticTriangles: E.W.stats.tris, staticVertices: E.W.stats.verts, colliders: CW.cols.length, lights: E.W.lights.length, people: E.W.people.length, crowdTotal: E.crowdCount(), atlasUsedPct: Math.round(E.W.stats.atlasUsed * 100) };
  E.teleport('foyer');
  return JSON.stringify(rep);
})()
