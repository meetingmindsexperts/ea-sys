// ---------- Game loop, input, camera, HUD ----------
(function () {
  const $ = (id) => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) document.body.classList.add('is-touch');
  const lowEnd = isTouch || (navigator.hardwareConcurrency || 8) <= 4;
  const Q = { level: lowEnd ? 'balanced' : 'high' };
  const applyQ = () => { Q.crowd = Q.level === 'high' ? 1 : 0.55; Q.lights = Q.level === 'high' ? 12 : 8; Q.dprMax = Q.level === 'high' ? 2 : 1.5; };
  try { const s = localStorage.getItem('ehc-q'); if (s === 'high' || s === 'balanced') Q.level = s; } catch (e) { }
  applyQ();

  const canvas = $('gl');
  let team = null, lowFpsT = 0, autoLight = false;
  let R, W, CW, crowd, player, I = {}, audio = new VenueAudio(), social = null, abil = null, lastVP = null, nearP = null;
  const cam = { yaw: 0, pitch: 0.32, dist: 4.4, wantDist: 4.4, arm: 4.4, pos: [0, 2, 0], tgt: [0, 1.5, 0] };
  // camera views: eye (first person, your avatar hidden), close (over the shoulder), behind (default), wide
  const VIEWS = [
    { id: 'behind', n: 'Behind view', dist: 4.4, pitch: 0.32 },
    { id: 'eye', n: 'Eye view', pitch: 0.04 },
    { id: 'close', n: 'Close view', dist: 2.1, pitch: 0.16, side: 0.45 },
    { id: 'wide', n: 'Wide view', dist: 8.5, pitch: 0.6 },
  ];
  let camView = 'behind'; try { const v = localStorage.getItem('ehc-view'); if (VIEWS.some(x => x.id === v)) camView = v; } catch (e) { }
  const viewOf = () => VIEWS.find(v => v.id === camView);
  const pitchRange = () => camView === 'eye' ? [-1.15, 1.2] : [-0.25, 1.15];
  function setCamView(id, quiet) {
    const V = VIEWS.find(v => v.id === id); if (!V) return; camView = id;
    if (V.dist) { cam.wantDist = V.dist; cam.dist = Math.min(cam.dist, V.dist + 1); }
    cam.pitch = V.pitch; try { localStorage.setItem('ehc-view', id); } catch (e) { }
    const b = document.getElementById('bView'); if (b) b.textContent = V.n;
    if (!quiet && typeof toast3 === 'function') toast3(V.n + (id === 'eye' ? ': you see through your own eyes' : ''));
  }
  const nextView = () => setCamView(VIEWS[(VIEWS.findIndex(v => v.id === camView) + 1) % VIEWS.length].id);
  const input = { x: 0, y: 0, run: false, jump: false, touch: false, keys: new Set() };
  const stats = { frames: 0, fps: 0, ft: [], simMs: 0, drawMs: 0, start: performance.now(), readyAt: 0, scale: 1 };
  let zone = null, near = null, paused = false, started = false, time = 0, lastT = 0, acc = 0, ry = 0;
  const hot = window.claude && window.claude.hot;

  // ----- boot
  async function boot() {
    const fontWait = Promise.all(['400 40px "Instrument Serif"', '600 20px "Hanken Grotesk"', '700 20px "JetBrains Mono"'].map(f => document.fonts ? document.fonts.load(f).catch(() => { }) : 0));
    await Promise.race([fontWait, new Promise(r => setTimeout(r, 2500))]);
    try { R = new Renderer(canvas, { preserve: !!window.__EHC_TEST }); }
    catch (e) { $('loading').textContent = 'This device does not support WebGL2, which the venue needs.'; return; }
    W = buildWorld(R, Q);
    CW = new CollisionWorld(W.colliders);
    rebuildCrowd();
    const ballCv = mkCanvas(256, 128), bx = ballCv.getContext('2d');
    for (let k = 0; k < 8; k++) { bx.fillStyle = k % 2 ? '#ffffff' : '#d8d0c6'; bx.fillRect(k * 32, 0, 32, 128); } bx.fillStyle = 'rgba(0,0,0,.25)'; bx.fillRect(0, 60, 256, 8);
    I.box = R.instMesh(MESH.box, null, { spec: 0.2, shin: 24 });
    I.sph = R.instMesh(MESH.sphereLo, null, { spec: 0.35, shin: 30 });
    I.sphHi = R.instMesh(MESH.sphere, null, { spec: 0.35, shin: 30 });
    I.cyl = R.instMesh(MESH.cyl, null, { spec: 0.22, shin: 24 });
    I.cylLo = R.instMesh(MESH.cylLo, null, { spec: 0.22, shin: 24 });
    I.shadow = R.instMesh(MESH.plane, W.T.blob, { unlit: 1, blend: true });
    I.halo = R.instMesh(MESH.sphere, null, { spec: 1.6, shin: 90 });
    I.ball = R.instMesh(MESH.sphere, R.texFromCanvas(ballCv), { spec: 0.9, shin: 60 });
    const Z0 = ZONES[0], d = hot && hot.data;
    player = new Player(d && d.x != null ? d.x : Z0.spawn[0], d && d.z != null ? d.z : Z0.spawn[1], d && d.yaw != null ? d.yaw : Z0.spawn[2]);
    player.look = { outfit: 'suit', g: 'm', role: 'delegate', skin: SKIN[1], hair: HAIR[0], top: [0.5, 0.1, 0.17], legs: [0.1, 0.1, 0.12], shirt: [0.96, 0.96, 0.96], tie: [0.12, 0.2, 0.42], tieOn: true, h: 1, seed: 1.3, hairStyle: 'short', beard: false, bottom: 'trousers', lanyard: ROLE_LANYARD.delegate };
    cam.yaw = d && d.camYaw != null ? d.camYaw : player.yaw - Math.PI;
    ry = player.y;
    if (hot && hot.snapshot) hot.snapshot(() => ({ x: player.x, z: player.z, yaw: player.yaw, camYaw: cam.yaw, started }));
    stats.readyAt = performance.now() - stats.start;
    $('loading').textContent = `Ready · ${(stats.readyAt / 1000).toFixed(1)} s`;
    $('enter').disabled = false;
    if (!isTouch) $('enter').focus();
    resize(); setZone(zoneAt(player.x, player.z));
    requestAnimationFrame(loop);
    social = new Social({ player: () => player, crowd: () => crowd, zone: () => zone, time: () => time, teleport: (id) => teleport(id), isTouch, toast: (m) => toast3(m), nearPerson: () => nearP, onChat: (on) => { input.keys.clear(); input.x = input.y = 0; if (!on && !isTouch) canvas.focus(); } });
    abil = new Abilities({ camView: () => camView, player: () => player, crowd: () => crowd, W, CW, zone: () => zone, time: () => time, input, cam, canvas, render, social, audio, toast: toast3, onSheet: (on) => { paused = on; }, downloads: () => (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null) });
    const dls = () => (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
    team = new EventTeam({ W, social, player: () => player, zone: () => zone, started: () => started, pause: (on) => { paused = on; if (on) input.keys.clear(); else if (!isTouch) canvas.focus(); }, teleport: (id) => teleport(id, true),
      measure: (ms) => window.__EHC.measure(ms), where: () => ({ x: player.x, z: player.z, yaw: player.yaw, cy: cam.yaw, cp: cam.pitch }), restore: (w) => { player.x = w.x; player.z = w.z; player.y = 0; ry = 0; player.yaw = w.yaw; cam.yaw = w.cy; cam.pitch = w.cp; setZone(zoneAt(w.x, w.z)); },
      quality: () => Q.level, setQuality: (l) => { Q.level = l; try { localStorage.setItem('ehc-q', l); } catch (e) { } applyQ(); stats.scale = 1; qLabel(); rebuildCrowd(); resize(); }, toast: (m) => toast3(m), downloads: dls });
    social.onEvent = abil.ctx.onEvent = (k, x) => team.event(k, x);
    exposeTestAPI();
    if (d && d.started) enter();
  }
  function rebuildCrowd() { crowd = new Crowd(W, Q); if (abil) { abil.stop(); abil.queues = abil.makeQueues(); abil.blockQueues(); abil.occupied = new Set(crowd.list.filter(p => p.pose === 'sit').map(p => p.x.toFixed(2) + ',' + p.z.toFixed(2))); } }

  // ----- sizing
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, Q.dprMax) * stats.scale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  addEventListener('resize', resize);

  // ----- input: keyboard
  const keyMap = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test(e.target.type)))) return;
    if (document.querySelector('#people:not([hidden]), #report:not([hidden]), #team:not([hidden]), #check:not([hidden])')) return; // a panel is open
    if (!started) { if (e.code === 'Enter' && !$('enter').disabled) enter(); return; }
    if (!$('info').hidden || !$('agenda').hidden) { if (e.code === 'Escape' || e.code === 'KeyE' && !$('info').hidden) closeSheets(); return; }
    if (keyMap[e.code]) { input.keys.add(keyMap[e.code]); e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.run = true;
    if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
    if (e.code === 'KeyE' && near) near.ref ? social.open(near) : openInfo(near);
    if ((e.code === 'Enter' || e.code === 'KeyT') && social) { e.preventDefault(); social.open(nearP); }
    if (e.code === 'KeyV') nextView();
    if (abil) { const gk = { Digit1: 'wave', Digit2: 'heart', Digit3: 'clap', Digit4: 'raise' }[e.code]; if (gk) abil.gesture(gk); if (e.code === 'Digit5') abil.photo(); if (e.code === 'KeyF') abil.mode === 'sit' ? abil.stand() : abil.sit(); if (e.code === 'KeyC' && abil.ctxAction) abil.ctxAction.fn(); }
    if (e.code === 'Escape' && social && social.target) social.close();
    if (e.code === 'KeyG' || e.code === 'KeyM') openAgenda();
  });
  addEventListener('keyup', (e) => { if (keyMap[e.code]) input.keys.delete(keyMap[e.code]); if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.run = false; });
  addEventListener('blur', () => { input.keys.clear(); input.run = false; });

  // ----- input: pointer (mouse drag look / touch stick + look)
  const ptr = new Map(); let stickId = null, stickO = [0, 0];
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptr.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptr.size === 2 && e.pointerType === 'touch') return;
    const k = e.pointerType === 'touch' ? 0.0065 : 0.0045;
    cam.yaw -= dx * k; const [lo, hi] = pitchRange(); cam.pitch = Math.max(lo, Math.min(hi, cam.pitch + dy * k));
  });
  const up = (e) => ptr.delete(e.pointerId);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const out = e.deltaY > 0; if (camView === 'eye') { if (out) setCamView('close'); return; } if (!out && cam.wantDist <= 1.85) { setCamView('eye'); return; } cam.wantDist = Math.max(1.8, Math.min(12, cam.wantDist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false }); // zoom all the way in for eye view
  const stick = $('stick'), base = $('stickBase'), knob = $('knob');
  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId; stick.setPointerCapture(e.pointerId);
    const r = stick.getBoundingClientRect(); stickO = [e.clientX, e.clientY]; base.style.left = (e.clientX - r.left) + 'px'; base.style.top = (e.clientY - r.top) + 'px';
    input.touch = true; e.preventDefault();
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - stickO[0], dy = e.clientY - stickO[1]; const m = Math.hypot(dx, dy), mx = 50; if (m > mx) { dx *= mx / m; dy *= mx / m; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`; input.x = dx / mx; input.y = -dy / mx;
  });
  const stickUp = (e) => { if (e.pointerId !== stickId) return; stickId = null; input.x = input.y = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', stickUp); stick.addEventListener('pointercancel', stickUp);
  $('tJump').addEventListener('pointerdown', (e) => { input.jump = true; e.preventDefault(); });
  $('tRun').addEventListener('click', () => { input.run = !input.run; $('tRun').setAttribute('aria-pressed', input.run); });

  // ----- HUD wiring
  $('enter').addEventListener('click', enter);
  function enter() {
    started = true; $('start').hidden = true; $('hud').hidden = false; audio.start(); audio.setMuted(false); $('bSound').textContent = 'Sound on'; $('bSound').setAttribute('aria-pressed', 'true');
    if (!isTouch) canvas.focus();
  }
  $('bSound').addEventListener('click', () => { audio.start(); audio.setMuted(!audio.muted); $('bSound').textContent = audio.muted ? 'Sound off' : 'Sound on'; $('bSound').setAttribute('aria-pressed', String(!audio.muted)); });
  const qLabel = () => { $('bQual').textContent = Q.level === 'high' ? 'High' : 'Balanced'; };
  qLabel();
  $('bQual').addEventListener('click', () => { Q.level = Q.level === 'high' ? 'balanced' : 'high'; try { localStorage.setItem('ehc-q', Q.level); } catch (e) { } applyQ(); stats.scale = 1; qLabel(); rebuildCrowd(); resize(); });
  $('bAgenda').addEventListener('click', openAgenda);
  $('bView').addEventListener('click', () => { nextView(); if (!isTouch) canvas.focus(); }); setCamView(camView, true);
  $('prompt').addEventListener('click', () => near && (near.ref ? social.open(near) : openInfo(near)));
  $('modeStop').addEventListener('click', () => abil && abil.stop());
  let t3; function toast3(m) { const el = $('toast3'); el.textContent = m; el.hidden = false; clearTimeout(t3); t3 = setTimeout(() => { el.hidden = true; }, 2800); }
  $('iclose').addEventListener('click', closeSheets); $('aclose').addEventListener('click', closeSheets);
  for (const id of ['info', 'agenda']) $(id).addEventListener('pointerdown', (e) => { if (e.target.id === id) closeSheets(); });
  function closeSheets() { $('info').hidden = true; $('agenda').hidden = true; paused = false; if (!isTouch) canvas.focus(); }
  function openInfo(h) {
    audio.ui();
    $('ik').textContent = (zone ? zone.name : '') + ' · ' + EVENT.venue; $('it').textContent = h.title; $('ib').textContent = h.body;
    const tags = h.kind === 'screen' ? [['Recording · to link', 1], ['Track · from agenda', 1], ['Spatial audio · ready', 0]] : /booth|platinum/.test(h.id) && !/Society/.test(h.title) ? [['Sponsor · to link', 1], ['Artwork · to supply', 1]] : /poster/.test(h.id) ? [['Abstracts · to link', 1]] : [];
    $('itags').innerHTML = ''; for (const [t, w] of tags) { const s = document.createElement('span'); s.className = 'tag' + (w ? ' warn' : ''); s.textContent = t; $('itags').appendChild(s); }
    if (team) { team.event('open', h.id); const si = team.screenForHotspot(h); let sb = $('isound'); if (sb) sb.remove(); if (si >= 0) { sb = document.createElement('button'); sb.id = 'isound'; sb.className = 'ghost'; const lab = () => { const cfg = team.videoFor(si), v = cfg && team.videos[cfg.url]; sb.textContent = v && v.sound ? 'Mute the recording' : 'Play with sound'; }; lab(); sb.addEventListener('click', () => { team.toggleSound(si); lab(); }); $('iclose').before(sb); } }
    $('info').hidden = false; paused = true; input.keys.clear(); $('iclose').focus();
  }
  function openAgenda() {
    const L = $('alist'); L.innerHTML = '';
    const status = { foyer: 'Registration and information desks', plenary: 'Main stage · recordings to link', posters: '34 poster slots · abstracts to link', hallA: 'Parallel track · name and recordings to link', hallB: 'Parallel track · name and recordings to link', hallC: 'Parallel track · name and recordings to link', workshop: 'Hands-on sessions · titles to link', promenade: 'Corridor to the lounge and exhibition', lounge: 'Coffee bar and meeting seats', expo: 'Host society booth · 7 partner stands to link' };
    for (const Z of ZONES) {
      const row = document.createElement('div'); row.className = 'arow' + (zone && zone.id === Z.id ? ' cur' : '');
      row.innerHTML = `<div><div class="t"></div><div class="d"></div></div><button class="go">Go</button>`;
      row.querySelector('.t').textContent = Z.name; row.querySelector('.d').textContent = status[Z.id];
      row.querySelector('.go').addEventListener('click', () => { closeSheets(); teleport(Z.id); });
      if (abil) { const wb = document.createElement('button'); wb.className = 'go walk'; wb.textContent = 'Walk'; wb.addEventListener('click', () => { closeSheets(); if (!abil.walkToZone(Z)) teleport(Z.id); }); row.querySelector('.go').before(wb); }
      L.appendChild(row);
    }
    $('agenda').hidden = false; paused = true; input.keys.clear(); audio.ui();
  }
  function teleport(id, instant) {
    const Z = ZONES.find(z => z.id === id); if (!Z) return;
    const go = () => { player.x = Z.spawn[0]; player.z = Z.spawn[1]; player.y = 0; ry = 0; player.vx = player.vz = player.vy = 0; player.yaw = Z.spawn[2]; cam.yaw = Z.spawn[2] - Math.PI; cam.pitch = camView === 'eye' ? 0.04 : 0.28; setZone(Z); };
    if (instant) return go();
    $('fade').classList.add('on'); setTimeout(() => { go(); $('fade').classList.remove('on'); }, 360);
  }
  $('map').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect(), [bx0, bz0, bx1, bz1] = WORLD_BOUNDS, pad = 6;
    const mx = (e.clientX - r.left) / r.width * 464, my = (e.clientY - r.top) / r.height * 272;
    const x = bx0 + (mx - pad) / ((464 - 2 * pad) / (bx1 - bx0)), z = bz0 + (my - pad) / ((272 - 2 * pad) / (bz1 - bz0));
    const Z = zoneAt(x, z); if (Z) teleport(Z.id);
  });
  function setZone(Z) { if (!Z || Z === zone) return; zone = Z; $('zname').textContent = Z.name; $('zsub').textContent = Z.sub; }

  // ----- minimap
  const mctx = $('map').getContext('2d');
  function drawMap() {
    const c = mctx, w = 464, h = 272, pad = 6, [bx0, bz0, bx1, bz1] = WORLD_BOUNDS;
    const sx = (w - 2 * pad) / (bx1 - bx0), sz = (h - 2 * pad) / (bz1 - bz0), X = (x) => pad + (x - bx0) * sx, Y = (z) => pad + (z - bz0) * sz;
    c.clearRect(0, 0, w, h);
    for (const Z of ZONES) {
      const [x0, z0, x1, z1] = Z.rect; c.fillStyle = zone === Z ? 'rgba(163,37,58,.55)' : 'rgba(243,236,228,.08)'; c.fillRect(X(x0) + 1, Y(z0) + 1, (x1 - x0) * sx - 2, (z1 - z0) * sz - 2);
      c.strokeStyle = 'rgba(243,236,228,.28)'; c.lineWidth = 1.5; c.strokeRect(X(x0) + 1, Y(z0) + 1, (x1 - x0) * sx - 2, (z1 - z0) * sz - 2);
      if ((x1 - x0) * sx > 60) { c.fillStyle = 'rgba(243,236,228,.75)'; c.font = '600 15px ' + FONT_BODY; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(Z.name.replace('Networking ', '').replace('Exhibition', 'Expo').replace('Grand ', ''), X((x0 + x1) / 2), Y((z0 + z1) / 2), (x1 - x0) * sx - 8); }
    }
    c.fillStyle = 'rgba(200,164,106,.85)'; for (const p of crowd.walkers) { c.fillRect(X(p.x) - 2, Y(p.z) - 2, 4, 4); }
    if (social) for (const P of social.peers.values()) { c.fillStyle = P.col || '#7fb3a6'; c.beginPath(); c.arc(X(P.x), Y(P.z), 6, 0, 7); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); }
    c.save(); c.translate(X(player.x), Y(player.z)); c.rotate(-player.yaw + Math.PI);
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(0, -11); c.lineTo(7, 8); c.lineTo(0, 4); c.lineTo(-7, 8); c.closePath(); c.fill(); c.restore();
  }

  // ----- simulation step (fixed 60 Hz)
  const DT = 1 / 60;
  function simStep() {
    const k = input.keys; if (!input.touch || k.size) { input.x = (k.has('r') ? 1 : 0) - (k.has('l') ? 1 : 0); input.y = (k.has('f') ? 1 : 0) - (k.has('b') ? 1 : 0); }
    const pre = player.stepEvt;
    const manual = input.keys.size > 0 || stickId !== null || input.jump;
    if (abil && abil.mode && abil.mode !== 'photo' && manual) abil.cancelByUser();
    const skip = abil ? abil.preStep(DT, input) : false;
    if (!skip) player.step(DT, input, cam.yaw, CW, social && social.peers.size ? crowd.list.concat(social.bodies()) : crowd.list, W.balls);
    if (camView === 'eye' && abil && abil.mode !== 'sit') {
      if (abil.mode === 'walk' || abil.mode === 'follow' || abil.mode === 'queue') { if (player.speed > 0.3) { const ty = player.yaw - Math.PI; let d = ty - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); cam.yaw += d * Math.min(1, DT * 4); } } // look where you are being walked
      else player.yaw = cam.yaw + Math.PI; // your body faces where you look, so others see you facing them
    }
    stepBalls(W.balls, DT, CW);
    if (player.stepEvt !== pre && zone) audio.step(zone.floor === 'carpetG' ? 'carpet' : zone.floor);
    if (player.landed) { audio.land(player.landed); player.landed = 0; }
    if (player.jumped) { audio.thump(500, 0.12, 0.06); player.jumped = false; }
    for (const b of W.balls) if (b.hit) { if (b.hit > 1.2) audio.bounce(b.hit); b.hit = 0; }
  }

  // ----- render
  const lightBuf = { lp: new Float32Array(48), lc: new Float32Array(48) };
  function frameUniforms() {
    const asp = canvas.width / canvas.height, fov = asp < 1 ? 1.2 : 1.05;
    const proj = M4.persp(fov, asp, 0.08, 420), view = M4.lookAt(cam.pos, cam.tgt, [0, 1, 0]);
    const ls = W.lights.map(l => ({ l, d: Math.hypot(l.p[0] - cam.tgt[0], l.p[2] - cam.tgt[2]) - l.r * 0.35 })).sort((a, b) => a.d - b.d).slice(0, Q.lights);
    lightBuf.lp.fill(0); lightBuf.lc.fill(0);
    ls.forEach(({ l }, i) => { lightBuf.lp.set([l.p[0], l.p[1], l.p[2], l.r], i * 4); lightBuf.lc.set([l.c[0], l.c[1], l.c[2], l.i], i * 4); });
    const inBall = zone && zone.id === 'plenary';
    lastVP = M4.mul(proj, view);
    return { vp: lastVP, cam: cam.pos, sky: inBall ? [0.3, 0.24, 0.24] : [0.38, 0.35, 0.33], gnd: [0.13, 0.1, 0.09], keyDir: [-0.3, -0.9, -0.3], keyCol: [0.2, 0.18, 0.16], nl: ls.length, lp: lightBuf.lp, lc: lightBuf.lc, fog: [0.12, 0.09, 0.09], fogD: 0.006, expo: 1.05 };
  }
  function render() {
    const t0 = performance.now();
    resize(); const gl = R.gl; gl.viewport(0, 0, canvas.width, canvas.height);
    gl.depthMask(true); gl.clearColor(0.06, 0.045, 0.05, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    R.setFrame(frameUniforms());
    const skip = window.__EHC_SKIP || null;
    for (const d of W.draws) if (!skip || !skip.includes(d.name)) R.draw(d);
    for (const d of W.screenDraws) R.draw(d);
    // people
    const cx = cam.pos[0], cz = cam.pos[2], far2 = (Q.level === 'high' ? 70 : 48) ** 2;
    const lodOf = (d2) => d2 < 100 ? 0 : d2 < (Q.level === 'high' ? 900 : 400) ? 1 : 2;
    for (const p of crowd.list) { const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz; if (d2 < far2) drawPerson(R, I, p, lodOf(d2)); }
    if (player.item && time > (player.itemUntil || 0)) player.item = null;
    if (camView !== 'eye' || (abil && abil.camOverride) || window.__EHC_CAM) drawPerson(R, I, { x: player.x, y: ry, z: player.z, yaw: player.yaw, item: player.item, pose: abil && abil.mode === 'sit' ? 'sit' : !player.ground ? 'walk' : player.speed > 0.3 ? 'walk' : 'stand', phase: player.ground ? player.phase : 0.9, speed: player.speed, look: player.look, t: time, gesture: player.gesture, gT: player.gT, speaking: player.speaking });
    if (social) for (const P of social.peers.values()) { const dx = P.x - cx, dz = P.z - cz; drawPerson(R, I, P, lodOf(dx * dx + dz * dz)); }
    // halo discs
    for (const h of W.halo) { const a = h.a + time * (0.05 + h.ring * 0.015) * (h.ring % 2 ? -1 : 1); const m = M4.ident(); M4.t(m, Math.cos(a) * h.rr, h.y + Math.sin(time * 0.6 + h.a * 2) * 0.05, 14 + Math.sin(a) * h.rr); M4.ry(m, -a); M4.rz(m, h.tilt); M4.s(m, 0.62, 0.13, 0.62); R.push(I.halo, m, h.ring === 1 ? [0.62, 0.1, 0.18, 0.05] : [0.85, 0.68, 0.42, 0.04]); }
    for (const b of W.balls) { const m = M4.ident(); M4.t(m, b.p[0], b.p[1], b.p[2]); M4.ry(m, b.dir || 0); M4.rx(m, b.rot || 0); M4.s(m, b.r * 2, b.r * 2, b.r * 2); R.push(I.ball, m, [...b.col, 0]);
      const s = M4.ident(); M4.t(s, b.p[0], 0.02, b.p[2]); M4.rx(s, -Math.PI / 2); const k = Math.max(0.3, 1 - b.p[1] / 4); M4.s(s, b.r * 2.6 * k, b.r * 2.6 * k, 1); R.push(I.shadow, s, [0, 0, 0, 0]); }
    R.drawInst(I.box); R.drawInst(I.sph); R.drawInst(I.sphHi); R.drawInst(I.cyl); R.drawInst(I.cylLo); R.drawInst(I.halo); R.drawInst(I.ball);
    for (const d of W.late) if (!skip || !skip.includes(d.name)) R.draw(d);
    R.drawInst(I.shadow);
    stats.drawMs = performance.now() - t0;
  }

  // ----- screens (low-rate canvas refresh)
  let scrT = 0;
  function updateScreens(dt) {
    scrT += dt; if (scrT < 0.12) return; scrT = 0;
    for (const s of W.screens) {
      const d = Math.hypot(s.pos[0] - player.x, s.pos[2] - player.z); if (d > 45) continue;
      const i = W.screens.indexOf(s); if (!(team && team.drawVideoScreen(s, i, d < 32))) drawScreen(s.cv, time, s.spec); R.updateTex(s.tex, s.cv);
    }
  }

  // ----- camera
  function updateCamera(dt) {
    ry += (player.y - ry) * Math.min(1, dt * 14);
    const portrait = canvas.clientWidth < canvas.clientHeight, want = cam.wantDist * (portrait ? 1.45 : 1);
    cam.dist += (want - cam.dist) * Math.min(1, dt * 6);
    const sit = abil && abil.mode === 'sit', dx = Math.sin(cam.yaw) * Math.cos(cam.pitch), dy = Math.sin(cam.pitch), dz = Math.cos(cam.yaw) * Math.cos(cam.pitch);
    if (camView === 'eye') { // eyes at head height, a hand's width in front of the face so your own head never shows
      const bob = player.ground && player.speed > 0.3 && !sit ? Math.sin(player.phase * 2) * 0.025 * Math.min(1, player.speed / 3) : 0;
      const ex = player.x - Math.sin(cam.yaw) * 0.14, ey = ry + (sit ? 1.26 : 1.62) + bob, ez = player.z - Math.cos(cam.yaw) * 0.14;
      cam.arm = cam.dist = 0; cam.pos = [ex, ey, ez]; cam.tgt = [ex - dx, ey - dy, ez - dz];
      const ov = window.__EHC_CAM || (abil && abil.camOverride); if (ov) { cam.pos = ov.pos; cam.tgt = ov.tgt; }
      return;
    }
    const V = viewOf(), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
    let tx = player.x, ty = ry + (sit ? 1.4 : 1.55), tz = player.z;
    if (V.side) { const sx = tx + rx * V.side, sz = tz + rz * V.side; if (!CW.inside(sx, ty, sz, 0.2)) { tx = sx; tz = sz; } }
    const safe = armLength(CW, tx, ty, tz, dx, dy, dz, cam.dist);
    cam.arm = safe < cam.arm ? safe : cam.arm + (safe - cam.arm) * Math.min(1, dt * 3);
    cam.tgt = [tx, ty, tz]; cam.pos = [tx + dx * cam.arm, ty + dy * cam.arm, tz + dz * cam.arm];
    const ov = window.__EHC_CAM || (abil && abil.camOverride); if (ov) { cam.pos = ov.pos; cam.tgt = ov.tgt; }
  }

  function updateNear() {
    let best = null, bd = 1e9; for (const h of W.interact) { const d = Math.hypot(h.x - player.x, h.z - player.z); if (d < h.r && d < bd) { bd = d; best = h; } }
    nearP = social && started ? social.nearestPerson() : null;
    if (abil && started) abil.updateContext(nearP);
    if (nearP && (!best || (nearP.d < Math.min(2.3, bd) && !nearP.ref.queued))) best = nearP; // whichever is closer: the person or the stand you are standing at
    const key = best ? (best.ref || best) : null, label = best ? (best.ref ? best.label : best.prompt) : '';
    if (key !== (near && (near.ref || near)) || (best && $('ptext').textContent !== label)) { near = best; $('prompt').hidden = !near || !started; if (near) $('ptext').textContent = label; $('prompt').querySelector('kbd').textContent = isTouch ? 'TAP' : 'E'; }
    else near = best;
  }
  // ----- main loop
  let mapT = 0, statT = 0, adaptT = 0, adaptN = 0, adaptSum = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (window.__EHC_HOLD) return;
    const raw = lastT ? now - lastT : 16.7, dt = Math.min(0.1, raw / 1000); lastT = now; time += dt;
    const s0 = performance.now();
    if (!paused && started) { acc += dt; let n = 0; while (acc >= DT && n < 5) { simStep(); acc -= DT; n++; } if (n === 5) acc = 0; }
    if (abil) abil.stepQueues(dt);
    crowd.update(dt, time, player);
    if (social) social.update(dt, time);
    if (team && started && !paused) team.tick(dt);
    if (team) team.sweepVideos(paused);
    updateCamera(dt);
    setZone(zoneAt(player.x, player.z));
    // nearest interactable
    updateNear();
    let crowdNear = 0; for (const p of crowd.walkers) if (Math.hypot(p.x - player.x, p.z - player.z) < 10) crowdNear++;
    audio.update(dt, zone ? zone.id : 'foyer', Math.min(1, crowdNear / 6));
    updateScreens(dt);
    stats.simMs = performance.now() - s0;
    render();
    if (social && lastVP) social.layout(lastVP, canvas.clientWidth, canvas.clientHeight);
    stats.frames++; stats.ft.push(raw); if (stats.ft.length > 600) stats.ft.shift();
    mapT += dt; if (mapT > 0.1 && started) { mapT = 0; drawMap(); }
    statT += dt; if (statT > 0.5) { statT = 0; const a = stats.ft.slice(-30), avg = a.reduce((p, q) => p + q, 0) / a.length; stats.fps = 1000 / avg; $('stats').textContent = `${stats.fps.toFixed(0)} fps · ${R.stats.draws} draws · ${(R.stats.tris / 1000).toFixed(0)}k tris · ${canvas.width}×${canvas.height}`; }
    // adaptive resolution
    adaptT += dt; adaptSum += dt; adaptN++;
    if (adaptT > 2 && !window.__EHC_TEST) { const fps = adaptN / adaptSum; if (fps < 42 && stats.scale > 0.6) { stats.scale = Math.max(0.6, stats.scale - 0.1); } else if (fps < 24 && stats.scale <= 0.6 && Q.level === 'high' && !autoLight && started) { autoLight = true; Q.level = 'balanced'; applyQ(); qLabel(); rebuildCrowd(); resize(); toast3('Switched to Balanced quality so movement stays smooth on this device.'); } else if (fps > 57 && stats.scale < 1) stats.scale = Math.min(1, stats.scale + 0.05); adaptT = adaptSum = adaptN = 0; }
  }

  // ----- verification hooks (used by the automated test bot)
  function exposeTestAPI() {
    window.__EHC = {
      ready: true, ZONES, W, CW, cam, input, stats, Q, get player() { return player; }, get zone() { return zone && zone.id; },
      teleport: (id) => teleport(id, true), enter, render, setView(yaw, pitch, dist) { cam.yaw = yaw; cam.pitch = pitch; cam.wantDist = cam.dist = cam.arm = dist; updateCamera(1); },
      get R() { return R; }, I, get abil() { return abil; }, get team() { return team; }, setCamView, get camView() { return camView; }, VIEWS, crowdCount: () => crowd.list.length, closeSheets: () => closeSheets(), get social() { return social; }, get nearP() { updateNear(); return nearP; },
      openNear() { updateNear(); if (near) openInfo(near); return near && near.id; },
      nearId() { updateNear(); return near && near.id; },
      measure(ms) { return new Promise(res => { const ts = []; let last = performance.now(); const t0 = last; const f = (t) => { ts.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(f); else { ts.shift(); const s = ts.slice().sort((a, b) => a - b), mean = ts.reduce((a, b) => a + b, 0) / ts.length; res({ frames: ts.length, fps: 1000 / mean, p99: 1000 / s[Math.max(0, Math.ceil(s.length * 0.99) - 1)], simMs: stats.simMs, drawMs: stats.drawMs, draws: R.stats.draws, tris: R.stats.tris, px: canvas.width + 'x' + canvas.height }); } }; requestAnimationFrame(f); }); },
      place(x, z, yaw) { player.x = x; player.z = z; player.y = 0; ry = 0; player.vx = player.vz = player.vy = 0; if (yaw != null) player.yaw = yaw; },
      sim(n, inp) { Object.assign(input, { touch: true, ...inp }); for (let i = 0; i < n; i++) simStep(); input.touch = false; input.x = input.y = 0; input.run = false; updateCamera(1); return { x: player.x, y: player.y, z: player.z }; },
      tick(n) { for (let i = 0; i < n; i++) { time += DT; simStep(); if (abil) abil.stepQueues(DT); crowd.update(DT, time, player); setZone(zoneAt(player.x, player.z)); if (team && started) team.tick(DT); } updateCamera(1); return { x: player.x, z: player.z, mode: abil && abil.mode }; },
      get time() { return time; },
      penetration() { let worst = 0; for (const c of CW.near(player.x, player.z, 1)) { if (c.y1 <= player.y + PH.STEP || c.y0 >= player.y + PH.H) continue; const p = CW.pen(c, player.x, player.z, PH.R); if (p) worst = Math.max(worst, p[0]); } return worst; },
      camInside() { return CW.inside(cam.pos[0], cam.pos[1], cam.pos[2], 0.0); },
    };
  }

  boot().catch((e) => { console.error(e); $('loading').textContent = 'Could not start: ' + e.message; });
})();
