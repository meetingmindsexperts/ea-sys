// ---------- Procedural venue audio (Web Audio, no files) ----------
class VenueAudio {
  constructor() { this.ok = false; this.muted = false; }
  start() {
    if (this.ok) return; const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.c = new AC(); this.ok = true;
    this.master = c.createGain(); this.master.gain.value = 0.9; this.master.connect(c.destination);
    // reverb from a generated impulse
    const len = c.sampleRate * 2.6, ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    this.verb = c.createConvolver(); this.verb.buffer = ir; this.verbGain = c.createGain(); this.verbGain.gain.value = 0.35; this.verb.connect(this.verbGain).connect(this.master);
    const nb = c.createBuffer(1, c.sampleRate * 3, c.sampleRate), nd = nb.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < nd.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; nd[i] = (b0 + b1 + b2 + w * 0.02) * 0.6; }
    this.noise = nb;
    const bed = (f, q, gain) => {
      const src = c.createBufferSource(); src.buffer = nb; src.loop = true; src.loopStart = Math.random();
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const am = c.createGain(); am.gain.value = gain; const g = c.createGain(); g.gain.value = 0;
      src.connect(bp).connect(am).connect(g); g.connect(this.master); g.connect(this.verb); src.start();
      return { g, am };
    };
    // chatter = several band-limited noise voices with syllable-rate wobble
    this.beds = {
      chatter: [bed(420, 1.4, 0.9), bed(760, 1.8, 0.6), bed(1150, 2.2, 0.35)],
      room: [bed(140, 0.7, 0.6)],
      hall: [bed(260, 1.0, 0.25), bed(900, 3, 0.08)],
    };
    this.levels = { chatter: 0, room: 0, hall: 0 };
    this.t = 0; this.nextNote = 0;
  }
  setMuted(m) { this.muted = m; if (this.ok) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.c.currentTime, 0.1); }
  update(dt, zoneId, crowdNear) {
    if (!this.ok) return; const c = this.c, now = c.currentTime; this.t += dt;
    const busy = { foyer: 0.55, expo: 0.6, lounge: 0.45, promenade: 0.25, posters: 0.18, plenary: 0.12, hallA: 0.08, hallB: 0.08, hallC: 0.08, workshop: 0.18 }[zoneId] ?? 0.2;
    const target = { chatter: busy * (0.6 + crowdNear * 0.4), room: 0.18, hall: /hall|plenary|workshop/.test(zoneId) ? 0.5 : 0.05 };
    for (const k in this.beds) for (const v of this.beds[k]) {
      v.g.gain.setTargetAtTime(target[k] * 0.22, now, 0.6);
      if (k === 'chatter') v.am.gain.setTargetAtTime(0.5 + 0.5 * Math.abs(Math.sin(this.t * (3 + Math.random() * 3))), now, 0.05);
    }
    // soft generative chimes in the foyer and lounge
    if ((zoneId === 'foyer' || zoneId === 'lounge') && this.t > this.nextNote) {
      const scale = [0, 3, 5, 7, 10, 12, 15]; const n = scale[Math.floor(Math.random() * scale.length)];
      this.tone(220 * Math.pow(2, n / 12) * (Math.random() < 0.3 ? 2 : 1), 0.035, 2.8, 'sine', true);
      this.nextNote = this.t + 0.9 + Math.random() * 2.2;
    }
  }
  tone(f, vol, dur, type = 'sine', wet = false) {
    if (!this.ok || this.muted) return; const c = this.c, o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, c.currentTime); g.gain.linearRampToValueAtTime(vol, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g); g.connect(this.master); if (wet) g.connect(this.verb); o.start(); o.stop(c.currentTime + dur + 0.05);
  }
  thump(f, vol, dur, q = 1) {
    if (!this.ok || this.muted) return; const c = this.c, s = c.createBufferSource(); s.buffer = this.noise; const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(vol, c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    s.connect(bp).connect(g); g.connect(this.master); g.connect(this.verb); s.start(0, Math.random() * 2); s.stop(c.currentTime + dur + 0.02);
  }
  applause(sec = 3, k = 1) {
    if (!this.ok || this.muted) return; const c = this.c, n = Math.round(sec * 45 * k);
    for (let i = 0; i < n; i++) { const t0 = c.currentTime + Math.random() * sec * (0.6 + 0.4 * Math.random()); const s = c.createBufferSource(); s.buffer = this.noise; const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200 + Math.random() * 1800; bp.Q.value = 1.2; const g = c.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.09 * (1 - t0 / (c.currentTime + sec + 1) * 0.4), t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05); s.connect(bp).connect(g); g.connect(this.master); g.connect(this.verb); s.start(t0, Math.random() * 2); s.stop(t0 + 0.07); }
  }
  shutter() { this.thump(3000, 0.25, 0.05, 2); setTimeout(() => this.thump(1800, 0.2, 0.06, 2), 90); }
  step(surface) { surface === 'marble' ? this.thump(2400, 0.32, 0.07, 2.5) : surface === 'wood' ? this.thump(900, 0.3, 0.09, 1.5) : this.thump(320, 0.22, 0.08, 0.9); }
  land(k) { this.thump(160, 0.4 * k + 0.1, 0.18, 0.8); }
  bounce(k) { this.thump(110, Math.min(0.7, k * 0.12), 0.22, 1.2); this.tone(70, Math.min(0.25, k * 0.05), 0.2); }
  ui() { this.tone(880, 0.05, 0.25, 'sine', true); }
}
