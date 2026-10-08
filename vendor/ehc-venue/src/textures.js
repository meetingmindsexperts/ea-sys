// ---------- Procedural textures (all generated on canvas, no image files) ----------
const FONT_DISPLAY = '"Instrument Serif", "Cormorant Garamond", Georgia, serif';
const FONT_BODY = '"Hanken Grotesk", "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, monospace';

function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h || w; return c; }
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }

const TEX = {
  marble() { // 2x2 tiles, ivory with soft veins
    const c = mkCanvas(1024), x = c.getContext('2d'), r = rng(7);
    x.fillStyle = '#e9e2d6'; x.fillRect(0, 0, 1024, 1024);
    for (let t = 0; t < 4; t++) {
      const ox = (t % 2) * 512, oy = Math.floor(t / 2) * 512;
      x.save(); x.beginPath(); x.rect(ox, oy, 512, 512); x.clip();
      const g = x.createLinearGradient(ox, oy, ox + 512, oy + 512); g.addColorStop(0, t % 3 ? '#ece6db' : '#e4dccf'); g.addColorStop(1, t % 2 ? '#e0d7c8' : '#efe9df');
      x.fillStyle = g; x.fillRect(ox, oy, 512, 512);
      for (let v = 0; v < 7; v++) {
        x.beginPath(); let px = ox + r() * 512, py = oy - 20; x.moveTo(px, py);
        while (py < oy + 540) { px += (r() - 0.5) * 60; py += 20 + r() * 30; x.lineTo(px, py); }
        x.strokeStyle = `rgba(${120 + r() * 40},${105 + r() * 30},${95 + r() * 20},${0.08 + r() * 0.16})`; x.lineWidth = 0.6 + r() * 2.4; x.stroke();
      }
      x.restore();
    }
    x.strokeStyle = 'rgba(90,75,60,.35)'; x.lineWidth = 2; x.strokeRect(1, 1, 510, 510); x.strokeRect(513, 1, 510, 510); x.strokeRect(1, 513, 510, 510); x.strokeRect(513, 513, 510, 510);
    return c;
  },
  carpetGarnet() { // ballroom: garnet with brass eight-point star lattice
    const c = mkCanvas(512), x = c.getContext('2d');
    x.fillStyle = '#6d1624'; x.fillRect(0, 0, 512, 512);
    const r = rng(3); for (let i = 0; i < 9000; i++) { x.fillStyle = `rgba(${r() < .5 ? '30,0,8' : '150,50,60'},${r() * .18})`; x.fillRect(r() * 512, r() * 512, 2, 2); }
    x.strokeStyle = 'rgba(206,164,98,.55)'; x.lineWidth = 3;
    const star = (cx, cy, R) => { x.beginPath(); for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, rr = k % 2 ? R * 0.62 : R; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } x.closePath(); x.stroke(); };
    for (const [cx, cy] of [[0, 0], [512, 0], [0, 512], [512, 512], [256, 256]]) { star(cx, cy, 110); star(cx, cy, 60); }
    x.strokeStyle = 'rgba(206,164,98,.25)'; x.lineWidth = 2;
    for (const [cx, cy] of [[256, 0], [0, 256], [512, 256], [256, 512]]) { x.beginPath(); x.arc(cx, cy, 40, 0, 7); x.stroke(); }
    return c;
  },
  carpetGrey() { // neutral, tinted per hall via vertex colour
    const c = mkCanvas(512), x = c.getContext('2d'), r = rng(11);
    x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 14000; i++) { const v = 110 + r() * 80; x.fillStyle = `rgba(${v},${v},${v},.35)`; x.fillRect(r() * 512, r() * 512, 2, 1); }
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 2;
    for (let k = 0; k < 512; k += 64) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k + 512, 512); x.stroke(); x.beginPath(); x.moveTo(k - 512, 0); x.lineTo(k, 512); x.stroke(); }
    return c;
  },
  wood() {
    const c = mkCanvas(512), x = c.getContext('2d'), r = rng(5);
    for (let p = 0; p < 8; p++) {
      const y = p * 64, base = 70 + r() * 25;
      x.fillStyle = `rgb(${base + 40},${base + 8},${base - 20})`; x.fillRect(0, y, 512, 64);
      for (let g = 0; g < 40; g++) { x.strokeStyle = `rgba(40,20,10,${r() * .2})`; x.lineWidth = 1 + r() * 2; x.beginPath(); const yy = y + r() * 64; x.moveTo(0, yy); x.bezierCurveTo(170, yy + (r() - .5) * 10, 340, yy + (r() - .5) * 10, 512, yy); x.stroke(); }
      x.fillStyle = 'rgba(20,10,5,.5)'; x.fillRect(0, y, 512, 2);
      const off = r() * 512; x.fillRect(off, y, 2, 64);
    }
    return c;
  },
  fabric() {
    const c = mkCanvas(256), x = c.getContext('2d'), r = rng(9);
    x.fillStyle = '#d9d0c4'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 256; i += 2) { x.fillStyle = `rgba(120,100,80,${r() * .08})`; x.fillRect(i, 0, 1, 256); }
    for (let i = 0; i < 4000; i++) { x.fillStyle = `rgba(255,255,255,${r() * .12})`; x.fillRect(r() * 256, r() * 256, 1, 2); }
    return c;
  },
  ceiling() { // 3m coffers
    const c = mkCanvas(256), x = c.getContext('2d');
    x.fillStyle = '#efebe4'; x.fillRect(0, 0, 256, 256);
    const g = x.createRadialGradient(128, 128, 20, 128, 128, 150); g.addColorStop(0, 'rgba(255,255,255,.4)'); g.addColorStop(1, 'rgba(160,150,135,.35)');
    x.fillStyle = g; x.fillRect(14, 14, 228, 228);
    x.strokeStyle = 'rgba(120,105,90,.4)'; x.lineWidth = 6; x.strokeRect(14, 14, 228, 228);
    return c;
  },
  blob() {
    const c = mkCanvas(128), x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(.6, 'rgba(0,0,0,.22)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); return c;
  },
  skyline() { // Sheikh Zayed Road at dusk, seen from the hotel
    const c = mkCanvas(2048, 512), x = c.getContext('2d'), r = rng(21);
    const g = x.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#0e1630'); g.addColorStop(.45, '#2b2a4f'); g.addColorStop(.72, '#a2546a'); g.addColorStop(.86, '#e39a6a'); g.addColorStop(1, '#f2c48b');
    x.fillStyle = g; x.fillRect(0, 0, 2048, 512);
    for (let i = 0; i < 120; i++) { x.fillStyle = `rgba(255,255,255,${r() * .6})`; x.fillRect(r() * 2048, r() * 180, 1.5, 1.5); }
    const tower = (tx, w, h, col) => {
      x.fillStyle = col; x.fillRect(tx, 512 - h, w, h);
      for (let yy = 512 - h + 8; yy < 505; yy += 9) for (let xx = tx + 3; xx < tx + w - 3; xx += 6) if (r() < .42) { x.fillStyle = `rgba(255,${200 + r() * 40},${130 + r() * 60},${.35 + r() * .5})`; x.fillRect(xx, yy, 3, 4); }
    };
    for (let i = 0; i < 70; i++) tower(r() * 2048, 18 + r() * 40, 40 + r() * 120, '#1b1830');
    for (let i = 0; i < 38; i++) tower(r() * 2048, 24 + r() * 46, 110 + r() * 200, '#141226');
    // tall stepped spire, centre-left
    x.fillStyle = '#100e1e'; const sx = 760;
    [[60, 210], [46, 290], [34, 360], [22, 420], [12, 470], [4, 505]].forEach(([w, h]) => x.fillRect(sx - w / 2, 512 - h, w, h));
    x.fillStyle = 'rgba(255,90,90,.9)'; x.fillRect(sx - 1, 6, 3, 3);
    const hg = x.createLinearGradient(0, 430, 0, 512); hg.addColorStop(0, 'rgba(255,190,120,0)'); hg.addColorStop(1, 'rgba(255,190,120,.35)'); x.fillStyle = hg; x.fillRect(0, 430, 2048, 82);
    return c;
  },
};

// ---------- Text atlas for signage, posters and booth graphics ----------
class Atlas {
  constructor(size = 2048, height = 3072) { this.c = mkCanvas(size, height); this.x = this.c.getContext('2d'); this.size = size; this.H = height; this.cx = 0; this.cy = 0; this.rowH = 0; this.x.fillStyle = '#fff'; this.x.fillRect(0, 0, size, height); }
  alloc(w, h) {
    this.shelves = this.shelves || [];
    let sh = this.shelves.filter(s => s.h >= h && s.x + w <= this.size).sort((p, q) => p.h - q.h)[0];
    if (!sh) { const y = this.shelves.reduce((m, s) => Math.max(m, s.y + s.h + 4), 0); if (y + h > this.H) throw new Error('atlas full ' + w + 'x' + h + ' ' + JSON.stringify(this.shelves.map(s => [s.y, s.h, s.x]))); sh = { y, h, x: 0 }; this.shelves.push(sh); }
    const r = { x: sh.x, y: sh.y, w, h }; sh.x += w + 4; this.cy = Math.max(this.cy, sh.y); this.rowH = sh.h;
    const S = this.size, H = this.H; r.uv = [r.x / S, 1 - (r.y + h) / H, (r.x + w) / S, 1 - r.y / H]; return r;
  }
}

function wrapText(x, text, maxW) {
  const words = text.split(' '), lines = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line); return lines;
}

const DRAW = {
  sign(A, w, h, { title, sub, kicker, bg = '#1a1214', fg = '#f3ece4', accent = '#c8a46a', align = 'center', arrow }) {
    const r = A.alloc(w, h), x = A.x; x.save(); x.translate(r.x, r.y);
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.fillStyle = accent; x.fillRect(0, h - Math.max(4, h * .04), w, Math.max(4, h * .04));
    x.textAlign = align; x.textBaseline = 'middle'; const ax = align === 'center' ? w / 2 : h * .22;
    let y = h * (sub ? .42 : .5); if (kicker) y += h * .06;
    if (kicker) { x.fillStyle = accent; x.font = `600 ${h * .12}px ${FONT_BODY}`; x.letterSpacing = '3px'; x.fillText(kicker.toUpperCase(), ax, h * .2); x.letterSpacing = '0px'; }
    x.fillStyle = fg; x.font = `400 ${h * (sub ? .34 : .42)}px ${FONT_DISPLAY}`; x.fillText(title, ax, y, w * .92);
    if (sub) { x.globalAlpha = .75; x.font = `500 ${h * .13}px ${FONT_BODY}`; x.fillText(sub, ax, h * .74, w * .92); x.globalAlpha = 1; }
    if (arrow) { x.fillStyle = accent; x.font = `600 ${h * .4}px ${FONT_BODY}`; x.textAlign = 'right'; x.fillText(arrow, w - h * .2, h * .5); }
    x.restore(); return r;
  },
  directory(A, w, h, rows) {
    const r = A.alloc(w, h), x = A.x; x.save(); x.translate(r.x, r.y);
    x.fillStyle = '#16100f'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#c8a46a'; x.font = `600 ${w * .045}px ${FONT_BODY}`; x.textBaseline = 'middle'; x.letterSpacing = '4px'; x.fillText('VENUE DIRECTORY', w * .08, h * .07); x.letterSpacing = '0px';
    rows.forEach(([name, dir], i) => {
      const y = h * .16 + i * h * .085;
      x.fillStyle = 'rgba(243,236,228,.12)'; x.fillRect(w * .08, y + h * .04, w * .84, 2);
      x.fillStyle = '#f3ece4'; x.font = `400 ${w * .085}px ${FONT_DISPLAY}`; x.fillText(name, w * .08, y);
      x.fillStyle = '#c8a46a'; x.font = `600 ${w * .07}px ${FONT_BODY}`; x.textAlign = 'right'; x.fillText(dir, w * .92, y); x.textAlign = 'left';
    });
    x.restore(); return r;
  },
  poster(A, w, h, id, seed) { // deliberately unreadable layout: a placeholder until real abstracts are supplied
    const r = A.alloc(w, h), x = A.x, R = rng(seed); x.save(); x.translate(r.x, r.y);
    x.fillStyle = '#fbf8f3'; x.fillRect(0, 0, w, h);
    const hue = ['#6d1624', '#1f4a5a', '#3b2d5c', '#5a4a1f'][seed % 4];
    x.fillStyle = hue; x.fillRect(0, 0, w, h * .14);
    x.fillStyle = '#fff'; x.font = `700 ${h * .045}px ${FONT_MONO}`; x.textBaseline = 'middle'; x.fillText(id, w * .05, h * .07);
    x.fillStyle = 'rgba(255,255,255,.7)'; x.fillRect(w * .32, h * .05, w * .6, h * .022); x.fillRect(w * .32, h * .085, w * .4, h * .018);
    const cols = 3, cw = (w * .9 - (cols - 1) * w * .03) / cols;
    for (let c = 0; c < cols; c++) {
      let y = h * .18; const cx = w * .05 + c * (cw + w * .03);
      while (y < h * .95) {
        if (R() < .28) { const fh = h * (.1 + R() * .12); x.fillStyle = '#e8e2d8'; x.fillRect(cx, y, cw, fh);
          x.strokeStyle = hue; x.lineWidth = 2; x.beginPath(); for (let k = 0; k <= 12; k++) { const px = cx + cw * k / 12, py = y + fh * (.85 - .6 * R()); k ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); y += fh + h * .02; }
        else { x.fillStyle = hue; x.globalAlpha = .7; x.fillRect(cx, y, cw * .6, h * .012); x.globalAlpha = 1; y += h * .022;
          const n = 3 + Math.floor(R() * 5); x.fillStyle = '#b9b2a8'; for (let k = 0; k < n; k++) { x.fillRect(cx, y, cw * (.75 + R() * .25), h * .007); y += h * .014; } y += h * .016; }
      }
    }
    x.restore(); return r;
  },
  boothGraphic(A, w, h, { tier, label, color }) {
    const r = A.alloc(w, h), x = A.x; x.save(); x.translate(r.x, r.y);
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, color); g.addColorStop(1, '#120d0e'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(255,255,255,.12)'; x.lineWidth = 2;
    for (let k = 0; k < 9; k++) { x.beginPath(); x.arc(w * .85, h * .9, 40 + k * 46, 0, 7); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,.6)'; x.font = `600 ${h * .07}px ${FONT_BODY}`; x.letterSpacing = '4px'; x.textBaseline = 'middle'; x.fillText(tier.toUpperCase(), w * .07, h * .16); x.letterSpacing = '0px';
    x.fillStyle = '#fff'; x.font = `400 ${h * .16}px ${FONT_DISPLAY}`; wrapText(x, label, w * .8).forEach((l, i) => x.fillText(l, w * .07, h * .36 + i * h * .17));
    x.fillStyle = 'rgba(255,255,255,.55)'; x.font = `500 ${h * .055}px ${FONT_BODY}`; x.fillText('Sponsor artwork to be supplied', w * .07, h * .86);
    x.restore(); return r;
  },
};

// ---------- Live screen canvases ----------
function drawScreen(c, t, s) {
  const x = c.getContext('2d'), w = c.width, h = c.height;
  const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#1b0a10'); g.addColorStop(1, s.plenary ? '#3a0f1c' : '#14202a'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  // slow flowing ribbons
  x.lineWidth = h * .004;
  for (let k = 0; k < 14; k++) {
    x.strokeStyle = `rgba(${s.plenary ? '200,164,106' : '150,190,200'},${.06 + k * .012})`; x.beginPath();
    for (let i = 0; i <= 40; i++) { const px = i / 40 * w, py = h * (.62 + .1 * Math.sin(i * .25 + t * .4 + k * .35) + .03 * Math.sin(i * .9 - t * .7 + k)); i ? x.lineTo(px, py) : x.moveTo(px, py); }
    x.stroke();
  }
  x.fillStyle = '#c8a46a'; x.font = `600 ${h * .045}px ${FONT_BODY}`; x.letterSpacing = '6px'; x.textBaseline = 'middle';
  x.fillText(s.kicker.toUpperCase(), w * .06, h * .14); x.letterSpacing = '0px';
  x.fillStyle = '#f3ece4'; x.font = `400 ${h * (s.plenary ? .14 : .12)}px ${FONT_DISPLAY}`;
  wrapText(x, s.title, w * .86).forEach((l, i) => x.fillText(l, w * .06, h * .3 + i * h * .14));
  x.fillStyle = 'rgba(243,236,228,.7)'; x.font = `500 ${h * .045}px ${FONT_BODY}`; x.fillText(s.sub, w * .06, h * .86);
  // status pill
  const pw = w * .26, ph = h * .07, px = w * .68, py = h * .82;
  x.fillStyle = 'rgba(243,236,228,.1)'; x.fillRect(px, py, pw, ph);
  x.fillStyle = (Math.floor(t * 1.2) % 2) ? '#c8a46a' : '#8e1b2c'; x.beginPath(); x.arc(px + ph * .5, py + ph * .5, ph * .16, 0, 7); x.fill();
  x.fillStyle = '#f3ece4'; x.font = `600 ${h * .032}px ${FONT_MONO}`; x.fillText('RECORDING SLOT · NOT LINKED', px + ph * .9, py + ph * .52, pw - ph);
}
