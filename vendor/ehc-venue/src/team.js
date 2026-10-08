// ---------- Event team layer: safety (people list, report), activity for sponsors, device check, screen recordings ----------
// Everything here is optional: each feature lights up only when the hosting gives it what it needs, and says so when not.
class EventTeam {
  constructor(ctx) {
    this.ctx = ctx; this.$ = (id) => document.getElementById(id);
    this.db = null; this.user = null; this.uid = null; this.owner = false; this.myName = '';
    this.shareName = false; try { this.shareName = localStorage.getItem('ehc-share-name') === 'yes'; } catch (e) { }
    this.act = this.blankActivity(); this.dirty = false; this.saveT = 0; this.canWrite = null;
    this.standNow = null; this.standT = 0; this.zoneNow = null;
    this.screenIds = ctx.W.screens.map((s, i) => this.screenId(s, i));
    this.videos = {}; // screen id -> { el, url, sound }
    this.wire(); this.connect();
  }
  screenId(s, i) {
    const Z = zoneAt(s.pos[0], s.pos[2]), zid = Z ? Z.id : 'screen';
    const same = this.ctx.W.screens.filter((q, j) => j < i && (zoneAt(q.pos[0], q.pos[2]) || {}).id === zid).length;
    return zid === 'plenary' ? ['plenary-main', 'plenary-left', 'plenary-right'][same] || 'plenary-' + same : zid + (same ? '-' + (same + 1) : '');
  }
  async connect() {
    const use = (n) => (window.claude && typeof window.claude.use === 'function') ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
    const [db, user] = await Promise.all([use('db'), use('user')]);
    this.db = db; this.user = user;
    if (user) {
      try { this.uid = typeof user.id === 'function' ? await user.id() : null; } catch (e) { }
      try { const me = await user.me(); this.myName = me && me.name || ''; if (!this.uid && me) this.uid = me.id; } catch (e) { }
      try { this.owner = typeof user.isOwner === 'function' ? !!(await user.isOwner()) : false; } catch (e) { }
    }
    this.$('bTeam').hidden = !this.owner;
    // totals are kept on the device too, so nothing depends on reading back what was saved
    if (this.uid) { try { this.mergeSaved(JSON.parse(localStorage.getItem('ehc-act-' + this.uid) || 'null')); } catch (e) { } }
    if (this.db && this.uid) { try { const d = await this.db.doc('analytics/' + this.uid).get(); if (d.exists) this.mergeSaved(d.data()); } catch (e) { } }
    this.act.sessions++; this.dirty = true;
    this.loadScreens(); this.loadFilter();
  }
  async loadFilter() {
    let c = window.EHC_FILTER && typeof window.EHC_FILTER === 'object' ? window.EHC_FILTER : null;
    if (!c && this.db) { try { const d = await this.db.doc('config/filter').get(); if (d.exists) c = d.data(); } catch (e) { } }
    if (c) this.ctx.social.filter.setConfig(c);
  }

  // ===== safety: people list and reports =====
  wire() {
    const $ = this.$;
    $('here').addEventListener('click', () => this.openPeople());
    $('peopleClose').addEventListener('click', () => this.closeSheet('people'));
    $('reportCancel').addEventListener('click', () => this.closeSheet('report'));
    $('reportSend').addEventListener('click', () => this.sendReport());
    $('reportCopy').addEventListener('click', () => this.copyReport());
    $('bTeam').addEventListener('click', () => this.openTeam());
    $('teamClose').addEventListener('click', () => this.closeSheet('team'));
    for (const b of document.querySelectorAll('[data-tteam]')) b.addEventListener('click', () => this.teamTab(b.dataset.tteam));
    for (const id of ['shareName', 'shareName2']) { const cb = $(id); if (!cb) continue; cb.checked = this.shareName;
      cb.addEventListener('change', (e) => { this.shareName = e.target.checked; for (const o of ['shareName', 'shareName2']) if ($(o)) $(o).checked = this.shareName; try { localStorage.setItem('ehc-share-name', this.shareName ? 'yes' : 'no'); } catch (er) { } this.dirty = true; this.saveSoon(true); if (this.ctx.started()) this.ctx.toast(this.shareName ? 'Your name will be shared with sponsors whose stands you visit' : 'Your name is no longer shared with sponsors'); }); }
    for (const id of ['bCheck', 'bCheck2']) { const b = $(id); if (b) b.addEventListener('click', () => this.deviceCheck()); }
    $('checkClose').addEventListener('click', () => { if (this.checking) this.checkAbort = true; else this.closeSheet('check'); });
    $('checkCopy').addEventListener('click', () => this.copyCheck());
    $('checkSave').addEventListener('click', () => this.saveCheck());
    this.ctx.social.onReport = (P) => this.openReport(P);
    this.ctx.social.onPeopleChange = () => { if (!$('people').hidden) this.drawPeople(); };
    for (const id of ['people', 'team']) $(id).addEventListener('pointerdown', (e) => { if (e.target.id === id) this.closeSheet(id); }); // tap outside the card to close
    this.panelKeys();
    addEventListener('pagehide', () => this.saveNow());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveNow(); });
  }
  // Panels behave like proper dialogs: focus moves in when one opens and back when it closes, Tab stays inside, Escape closes the top one.
  panelKeys() {
    const close = { photoSheet: 'photoClose', info: 'iclose', people: 'peopleClose', report: 'reportCancel', team: 'teamClose', check: 'checkClose', agenda: 'aclose' };
    const sheets = Object.keys(close).map(id => this.$(id)).filter(Boolean), top = () => { let t = null; for (const s of document.querySelectorAll('.sheet')) if (!s.hidden && close[s.id]) t = s; return t; };
    const focusables = (root) => [...root.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(e => !e.disabled && e.offsetParent !== null);
    const ret = new Map();
    for (const s of sheets) { const card = s.querySelector('.card'); if (card) { card.setAttribute('aria-modal', 'true'); if (!card.hasAttribute('tabindex')) card.tabIndex = -1; } }
    new MutationObserver((recs) => {
      for (const r of recs) { const s = r.target; if (!s.hidden || !ret.has(s)) continue; const back = ret.get(s); ret.delete(s); if (back && back.isConnected && back.offsetParent !== null && !back.closest('.sheet[hidden]') && document.activeElement && (document.activeElement === document.body || s.contains(document.activeElement) || document.activeElement.closest('.sheet[hidden]'))) back.focus(); }
      for (const r of recs) { const s = r.target; if (s.hidden || ret.has(s)) continue; const a = document.activeElement; ret.set(s, a && !s.contains(a) ? a : null); if (!s.contains(document.activeElement)) { const card = s.querySelector('.card'); if (card) card.focus({ preventScroll: true }); } }
    }).observe(document.getElementById('app'), { attributes: true, attributeFilter: ['hidden'], subtree: true });
    addEventListener('keydown', (e) => {
      const s = top(); if (!s) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = this.$(close[s.id]); if (b) b.click(); return; }
      if (e.key === 'Tab') { const f = focusables(s); if (!f.length) { e.preventDefault(); return; } const i = f.indexOf(document.activeElement); if (e.shiftKey ? i <= 0 : i === f.length - 1 || i < 0) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); } }
    }, true);
  }
  openSheet(id) { this.$(id).hidden = false; this.ctx.pause(true); }
  closeSheet(id) { this.$(id).hidden = true; if (!document.querySelector('.sheet:not([hidden]):not(#start)')) this.ctx.pause(false); }
  openPeople() { this.drawPeople(); this.openSheet('people'); }
  drawPeople() {
    const S = this.ctx.social, list = this.$('peopleList'), el = (t, a = {}, ...k) => { const e = document.createElement(t); for (const x in a) x === 'text' ? e.textContent = a[x] : x === 'class' ? e.className = a[x] : e.setAttribute(x, a[x]); for (const c of k) if (c) e.appendChild(c); return e; };
    list.innerHTML = '';
    const peers = [...S.peers.values()];
    if (!peers.length) list.appendChild(el('p', { class: 'small', text: 'No colleagues are in the venue right now.' }));
    for (const P of peers) {
      const m = S.muted.has(S.modKey(P)), row = el('div', { class: 'prow' });
      const who = el('div', { class: 'pwho' }, el('div', { class: 'pn', text: P.name || 'Colleague' }), el('div', { class: 'small', text: [P.guest ? 'Guest' : 'Colleague', P.zone ? (ZONES.find(z => z.id === P.zone) || {}).name : '', m ? 'muted' : '', P.flagged ? `${P.flagged} filtered message${P.flagged > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') }));
      const mute = el('button', { class: 'chip', 'aria-pressed': String(m), text: m ? 'Unmute' : 'Mute' }); mute.addEventListener('click', () => { S.setMuted(P, !m); this.drawPeople(); });
      const block = el('button', { class: 'chip', text: 'Block' }); block.addEventListener('click', () => { S.setBlocked(P, true); this.drawPeople(); });
      const rep = el('button', { class: 'chip warn', text: 'Report' }); rep.addEventListener('click', () => { this.closeSheet('people'); this.openReport(P); });
      row.append(who, el('div', { class: 'pact' }, mute, block, rep)); list.appendChild(row);
    }
    const bl = this.$('blockedBox'); bl.innerHTML = '';
    if (S.blocked.size) {
      const names = Object.entries(S.blockedNames || {}).filter(([k]) => S.blocked.has(k)).map(([, n]) => n);
      bl.appendChild(el('p', { class: 'small', text: `Blocked: ${S.blocked.size}${names.length ? ' (' + names.join(', ') + (S.blocked.size > names.length ? ', and others from earlier visits' : '') + ')' : ''}. They’re hidden for you on this device.` }));
      const ub = el('button', { class: 'ghost', text: 'Unblock everyone' }); ub.addEventListener('click', () => { S.unblockAll(); this.drawPeople(); }); bl.appendChild(ub);
    }
  }
  openReport(P) {
    clearTimeout(this.repT); this.reportFor = P; this.$('reportWho').textContent = P.name || 'this person';
    for (const r of document.querySelectorAll('input[name=rreason]')) r.checked = false; this.$('reportNote').value = ''; this.$('reportMsg').textContent = '';
    this.$('reportSend').disabled = false; this.$('reportCopy').hidden = true; this.openSheet('report');
  }
  async sendReport() {
    const P = this.reportFor, S = this.ctx.social, msg = this.$('reportMsg'); if (!P) return;
    const reason = (document.querySelector('input[name=rreason]:checked') || {}).value;
    if (!reason) { msg.textContent = 'Choose a reason first.'; return; }
    const item = { at: Date.now(), reason, note: this.$('reportNote').value.trim().slice(0, 600), who: { id: P.id || null, peer: P.id ? null : P.peer, name: (P.name || '').slice(0, 80), guest: !!P.guest }, said: (P.said || []).slice(-5), zone: P.zone || '', by: this.uid || null };
    S.setMuted(P, true); // reporting someone also mutes them for you
    this.$('reportSend').disabled = true; msg.textContent = 'Sending…';
    let ok = false;
    // each report is its own record, so sending never needs to read anything back
    if (this.db && this.uid) { try { const rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); await this.db.doc('reports/' + this.uid + '/items/' + rid).set(item); await this.db.doc('reports/' + this.uid).set({ uid: this.uid, updated: Date.now() }); ok = true; } catch (e) { } }
    if (ok) { msg.textContent = 'Report sent to the event team. We’ve also muted them for you.'; clearTimeout(this.repT); this.repT = setTimeout(() => this.closeSheet('report'), 1600); }
    else {
      const c = typeof window.EHC_CONTACT === 'string' && window.EHC_CONTACT.trim() ? window.EHC_CONTACT.trim().slice(0, 120) : '';
      msg.textContent = `We couldn’t send this report from here, but they’re muted for you. Please tell the event team${c ? ' at ' + c : ' using the contact details in your registration email'}. Use Copy report to paste it into your message.`;
      this.$('reportSend').disabled = false; this.$('reportCopy').hidden = false;
    }
    this.reportsSent = (this.reportsSent || 0) + (ok ? 1 : 0); this.lastReport = { ok, item };
  }

  reportText() { const r = this.lastReport && this.lastReport.item; if (!r) return ''; return [`Report from the ${EVENT.short} online venue · ${new Date(r.at).toLocaleString('en-GB')}`, `About: ${r.who.name || 'unknown'}${r.who.guest ? ' (guest)' : ''}`, `Reason: ${r.reason}`, r.note ? `Note: ${r.note}` : '', r.said.length ? 'What they said:\n' + r.said.map(x => '· ' + x.text).join('\n') : ''].filter(Boolean).join('\n'); }
  copyReport() { const t = this.reportText(), m = this.$('reportMsg'); try { navigator.clipboard.writeText(t).then(() => { m.textContent = 'Report copied. Paste it into your message to the event team.'; }, () => { this.download('ehc-report.txt', t, 'text/plain'); }); } catch (e) { this.download('ehc-report.txt', t, 'text/plain'); } }

  // ===== activity for organisers and sponsors =====
  blankActivity() { return { v: 1, sessions: 0, first: Date.now(), last: Date.now(), zones: {}, stands: {}, questions: {}, speakerQs: 0, chats: 0, photos: 0 }; }
  mergeSaved(d) {
    if (!d || typeof d !== 'object') return; const a = this.act, n = (v) => typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(v, 1e7) : 0;
    const M = Math.max, own = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
    a.sessions = M(a.sessions, n(d.sessions)); if (n(d.first)) a.first = Math.min(a.first, n(d.first)); a.speakerQs = M(a.speakerQs, n(d.speakerQs)); a.chats = M(a.chats, n(d.chats)); a.photos = M(a.photos, n(d.photos));
    for (const z of ZONES) { if (own(d.zones, z.id)) a.zones[z.id] = M(a.zones[z.id] || 0, n(d.zones[z.id])); if (own(d.questions, z.id)) a.questions[z.id] = M(a.questions[z.id] || 0, n(d.questions[z.id])); }
    for (const h of this.ctx.W.interact) { const v = own(d.stands, h.id) ? d.stands[h.id] : null; if (v && typeof v === 'object') { const s = this.stand(h.id); s.visits = M(s.visits, n(v.visits)); s.sec = M(s.sec, n(v.sec)); s.opens = M(s.opens, n(v.opens)); } }
  }
  stand(id) { return this.act.stands[id] || (this.act.stands[id] = { visits: 0, sec: 0, opens: 0 }); }
  tick(dt) {
    if (!this.ctx.started() || this.checking) return; // the device check moves you around; that isn't a visit
    const pl = this.ctx.player(), Z = this.ctx.zone(), a = this.act;
    if (Z) { a.zones[Z.id] = (a.zones[Z.id] || 0) + dt; }
    // a stand visit counts after 4 seconds within its area
    let here = null; for (const h of this.ctx.W.interact) if (Math.hypot(h.x - pl.x, h.z - pl.z) < h.r) { here = h.id; break; }
    if (here !== this.standNow) { this.standNow = here; this.standT = 0; this.counted = false; }
    if (here) { this.standT += dt; this.stand(here).sec += dt; if (!this.counted && this.standT > 4) { this.stand(here).visits++; this.counted = true; } }
    this.dirty = true; this.saveT += dt; if (this.saveT > 30) this.saveNow();

  }
  event(kind, data) {
    const a = this.act, Z = this.ctx.zone();
    if (kind === 'open' && data) this.stand(data).opens++;
    else if (kind === 'question' && Z) a.questions[Z.id] = (a.questions[Z.id] || 0) + 1;
    else if (kind === 'speakerQ') a.speakerQs++;
    else if (kind === 'chat') a.chats++;
    else if (kind === 'photo') a.photos++;
    this.dirty = true;
  }
  saveSoon(now) { if (now) this.saveNow(); }
  async saveNow() {
    this.saveT = 0; if (!this.dirty || !this.uid) return;
    const a = this.act, r = (v) => Math.round(v);
    const doc = { v: 1, uid: this.uid, named: !!this.shareName, name: this.shareName ? this.myName.slice(0, 80) : '', sessions: a.sessions, first: a.first, last: Date.now(), speakerQs: a.speakerQs, chats: a.chats, photos: a.photos,
      zones: Object.fromEntries(Object.entries(a.zones).map(([k, v]) => [k, r(v)])), questions: a.questions,
      stands: Object.fromEntries(Object.entries(a.stands).map(([k, v]) => [k, { visits: v.visits, sec: r(v.sec), opens: v.opens }])) };
    try { localStorage.setItem('ehc-act-' + this.uid, JSON.stringify(doc)); } catch (e) { }
    this.dirty = false; if (!this.db || this.canWrite === false) return;
    try { await this.db.doc('analytics/' + this.uid).set(doc); this.canWrite = true; this.saved = (this.saved || 0) + 1; }
    catch (e) { if (e && (e.code === 'permission_denied' || e.code === 'not_granted' || e.code === 'forbidden')) this.canWrite = false; }
  }
  // owner report
  openTeam() { this.openSheet('team'); this.teamTab('activity'); }
  teamTab(t) {
    for (const b of document.querySelectorAll('[data-tteam]')) b.setAttribute('aria-pressed', String(b.dataset.tteam === t));
    for (const p of document.querySelectorAll('[data-tpane]')) p.hidden = p.dataset.tpane !== t;
    if (t === 'activity') this.drawActivity(); else if (t === 'reports') this.drawReports(); else if (t === 'screens') this.drawScreens(); else if (t === 'language') this.drawLanguage();
  }
  async fetchAll(col) { if (!this.db) return null; try { const s = await this.db.collection(col).limit(2000).get(); return s.docs.map(d => d.data()).filter(x => x && typeof x === 'object'); } catch (e) { return null; } }
  standName(id) { const h = this.ctx.W.interact.find(x => x.id === id); return h ? h.title : id; }
  async drawActivity() {
    const box = this.$('tActivity'); box.textContent = 'Loading…';
    const docs = await this.fetchAll('analytics'); box.innerHTML = '';
    const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
    if (!docs) { box.appendChild(el('p', 'Activity can’t be read in this view.', 'small')); return; }
    const n = (v) => typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(v, 1e7) : 0, people = docs.length, named = docs.filter(d => d.named && typeof d.name === 'string' && d.name.trim());
    const stands = {}, zones = {}, qs = {};
    for (const d of docs) {
      // only known stands and areas are read, each through its own property, so an odd record can't break the report
      const own = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k), nm = d.named && typeof d.name === 'string' && d.name.trim() ? d.name.slice(0, 80) : '';
      for (const h of this.ctx.W.interact) { const v = own(d.stands, h.id) ? d.stands[h.id] : null; if (!v || typeof v !== 'object') continue; const s = stands[h.id] || (stands[h.id] = { people: 0, visits: 0, sec: 0, opens: 0, named: [] }); if (n(v.visits) || n(v.opens)) { s.people++; if (nm) s.named.push(nm); } s.visits += n(v.visits); s.sec += n(v.sec); s.opens += n(v.opens); }
      for (const z of ZONES) { if (own(d.zones, z.id)) { const zz = zones[z.id] || (zones[z.id] = { people: 0, sec: 0 }); if (n(d.zones[z.id]) > 5) zz.people++; zz.sec += n(d.zones[z.id]); } if (own(d.questions, z.id)) qs[z.id] = (qs[z.id] || 0) + n(d.questions[z.id]); }
    }
    this.report = { people, named: named.length, stands, zones, qs, docs };
    box.appendChild(el('p', `${people} attendee${people === 1 ? '' : 's'} recorded · ${named.length} agreed to share their name with sponsors. Counts cover signed-in attendees who can save data on this hosting; on your own server everyone is counted.`, 'small'));
    const tbl = (head, rows) => { const t = el('table', null, 'rtable'), tr = el('tr'); head.forEach(h => tr.appendChild(el('th', h))); const th = el('thead'); th.appendChild(tr); t.appendChild(th); const tb = el('tbody'); for (const r of rows) { const row = el('tr'); r.forEach(c => row.appendChild(el('td', String(c)))); tb.appendChild(row); } t.appendChild(tb); const w = el('div', null, 'rwrap'); w.appendChild(t); return w; };
    const mins = (s) => s < 60 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min';
    const sRows = Object.entries(stands).filter(([, s]) => s.visits || s.opens).sort((a, b) => b[1].people - a[1].people).map(([k, s]) => [this.standName(k), s.people, s.visits, mins(s.visits ? s.sec / s.visits : 0), s.opens, s.named.length]);
    box.appendChild(el('h3', 'Stands and points of interest'));
    box.appendChild(sRows.length ? tbl(['Stand', 'People', 'Visits', 'Avg time', 'Info opened', 'Named'], sRows) : el('p', 'No stand visits yet.', 'small'));
    const zRows = ZONES.filter(z => zones[z.id] && zones[z.id].sec > 0).map(z => [z.name, zones[z.id].people, mins(zones[z.id].sec), mins(zones[z.id].people ? zones[z.id].sec / zones[z.id].people : 0), qs[z.id] || 0]);
    box.appendChild(el('h3', 'Areas')); box.appendChild(zRows.length ? tbl(['Area', 'People', 'Total time', 'Avg per person', 'Questions asked'], zRows) : el('p', 'No visits yet.', 'small'));
    const act = el('div', null, 'actions'), b1 = el('button', 'Download stands (CSV)', 'ghost'), b2 = el('button', 'Download named visitors (CSV)', 'ghost');
    b1.addEventListener('click', () => this.download('ehc-2026-stand-activity.csv', this.csv(['Stand', 'People', 'Visits', 'Average seconds per visit', 'Info opened', 'Named visitors'], Object.entries(stands).map(([k, s]) => [this.standName(k), s.people, s.visits, Math.round(s.visits ? s.sec / s.visits : 0), s.opens, s.named.length]))));
    b2.addEventListener('click', () => this.download('ehc-2026-named-visitors.csv', this.csv(['Name', 'Stand', 'Visits', 'Seconds', 'Info opened'], named.flatMap(d => Object.entries(d.stands || {}).filter(([, v]) => n(v.visits) || n(v.opens)).map(([k, v]) => [String(d.name).slice(0, 80), this.standName(k), n(v.visits), Math.round(n(v.sec)), n(v.opens)])))));
    act.append(b1, b2); box.appendChild(act);
  }
  csv(head, rows) { const q = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; return [head, ...rows].map(r => r.map(q).join(',')).join('\r\n'); }
  async download(name, text, type = 'text/csv') {
    const blob = new Blob([text], { type }), dl = await this.ctx.downloads();
    if (dl) { try { await dl.save({ filename: name, data: blob }); } catch (e) { } this.lastDownload = { name, size: blob.size }; return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); this.lastDownload = { name, size: blob.size };
  }
  async drawReports() {
    const box = this.$('tReports'); box.textContent = 'Loading…';
    const docs = await this.fetchAll('reports'); box.innerHTML = '';
    const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
    if (!docs) { box.appendChild(el('p', 'Reports can’t be read in this view.', 'small')); return; }
    let items = docs.flatMap(d => Array.isArray(d.items) ? d.items : []);
    for (const d of docs) { if (typeof d.uid !== 'string' || !/^[\w-]{1,80}$/.test(d.uid)) continue; const sub = await this.fetchAll('reports/' + d.uid + '/items'); if (sub) items = items.concat(sub); }
    items = items.filter(i => i && typeof i === 'object').sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!items.length) { box.appendChild(el('p', 'No reports. Attendees can mute, block or report anyone from the people list or the conversation panel.', 'small')); return; }
    for (const i of items.slice(0, 200)) {
      const c = el('div', null, 'rcard');
      c.appendChild(el('div', `${String(i.reason || 'Report').slice(0, 40)} · ${new Date(i.at || 0).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, 'pn'));
      c.appendChild(el('div', `About: ${String((i.who && i.who.name) || 'unknown').slice(0, 80)}${i.who && i.who.guest ? ' (guest)' : ''}${i.zone ? ' · in ' + ((ZONES.find(z => z.id === i.zone) || {}).name || '') : ''}`, 'small'));
      if (i.note) c.appendChild(el('div', '“' + String(i.note).slice(0, 600) + '”', 'small'));
      const said = Array.isArray(i.said) ? i.said.filter(x => x && typeof x.text === 'string').slice(-5) : [];
      if (said.length) { c.appendChild(el('div', 'What they said:', 'small')); for (const s of said) c.appendChild(el('div', '· ' + s.text.slice(0, 280), 'small said')); }
      box.appendChild(c);
    }
  }

  // ===== language filter settings (owner) =====
  drawLanguage() {
    const box = this.$('tLanguage'), F = this.ctx.social.filter, c = F.cfg; box.innerHTML = '';
    const el = (t, a = {}, ...k) => { const e = document.createElement(t); for (const x in a) x === 'text' ? e.textContent = a[x] : x === 'class' ? e.className = a[x] : e.setAttribute(x, a[x]); for (const y of k) if (y) e.appendChild(y); return e; };
    const on = el('input', { type: 'checkbox', id: 'lfOn' }); on.checked = c.on;
    const mMask = el('input', { type: 'radio', name: 'lfMode', value: 'mask' }), mHide = el('input', { type: 'radio', name: 'lfMode', value: 'hide' }); (c.mode === 'hide' ? mHide : mMask).checked = true;
    const extra = el('textarea', { id: 'lfExtra', rows: '3', maxlength: '4000', placeholder: 'One word per line or separated by commas' }); extra.value = c.extra.join(', ');
    const allow = el('textarea', { id: 'lfAllow', rows: '2', maxlength: '4000', placeholder: 'Words the filter should never touch' }); allow.value = c.allow.join(', ');
    const msg = el('p', { class: 'small', role: 'status' }), save = el('button', { class: 'primary', text: 'Save for everyone' });
    const test = el('input', { type: 'text', placeholder: 'Try a sentence to see what attendees would see', maxlength: '240', class: 'lfTest' }), out = el('p', { class: 'small' });
    test.addEventListener('input', () => { const tmp = new LangFilter(); tmp.setConfig({ on: true, mode: 'mask', extra: extra.value, allow: allow.value }); const r = tmp.check(test.value); out.textContent = test.value ? (r.hit ? 'Attendees see: ' + r.text : 'Nothing filtered.') : ''; });
    save.addEventListener('click', async () => {
      const cfg = { on: on.checked, mode: mHide.checked ? 'hide' : 'mask', extra: extra.value, allow: allow.value }; F.setConfig(cfg);
      const stored = { on: F.cfg.on, mode: F.cfg.mode, extra: F.cfg.extra, allow: F.cfg.allow, updated: Date.now() };
      msg.textContent = 'Saving…'; try { if (!this.db) throw 0; await this.db.doc('config/filter').set(stored); msg.textContent = 'Saved. Attendees get these settings next time they open the venue.'; } catch (e) { msg.textContent = 'Saved for this device only: settings can’t be shared from this view.'; }
    });
    box.append(el('p', { class: 'small', text: 'Filters offensive words in live chat between attendees: common English and Arabic swear words and slurs, including disguised spellings (f.u.c.k, sh1t). AI attendees already keep clean. Messages people type are filtered before they’re sent and again before they’re shown.' }),
      el('label', { class: 'optin' }, on, document.createTextNode(' Language filter on')),
      el('fieldset', { class: 'reasons' }, el('legend', { class: 'small', text: 'When a message has a filtered word' }), el('label', null, mMask, document.createTextNode(' Replace the word with •••• (the rest of the message shows)')), el('label', null, mHide, document.createTextNode(' Hide the whole message'))),
      el('label', { class: 'small', for: 'lfExtra', text: 'Extra words to filter (also catches words that start with them)' }), extra,
      el('label', { class: 'small', for: 'lfAllow', text: 'Never filter these words' }), allow,
      el('div', { class: 'actions' }, save), msg, test, out,
      el('p', { class: 'small', text: `Filtered so far on this device: ${this.ctx.social.filteredOut} message${this.ctx.social.filteredOut === 1 ? '' : 's'}.` }));
  }

  // ===== recordings on screens =====
  // Sources, in order: window.EHC_SCREENS (your server), screens.json published beside the page, the db doc config/screens.
  async loadScreens() {
    let map = null;
    if (window.EHC_SCREENS && typeof window.EHC_SCREENS === 'object') map = window.EHC_SCREENS;
    if (!map) { try { const r = await fetch('screens.json', { cache: 'no-store' }); if (r.ok) map = await r.json(); } catch (e) { } }
    if (!map && this.db) { try { const d = await this.db.doc('config/screens').get(); if (d.exists) map = d.data().map; } catch (e) { } }
    this.screenMap = {}; if (!map || typeof map !== 'object') return;
    for (const id of this.screenIds) { const v = map[id] || (id.startsWith('plenary-') && id !== 'plenary-main' ? map['plenary-main'] : null); const url = v && (typeof v === 'string' ? v : v.url); if (typeof url === 'string' && this.safeUrl(url)) this.screenMap[id] = { url, title: v.title ? String(v.title).slice(0, 120) : '' }; }
  }
  safeUrl(u) { try { const x = new URL(u, location.href); return (x.protocol === 'https:' || x.protocol === 'blob:' || x.origin === location.origin) && /\.(mp4|webm|m4v|mov)(\?|$)/i.test(x.pathname) || x.protocol === 'blob:'; } catch (e) { return false; } }
  videoFor(i) { return this.screenMap && this.screenMap[this.screenIds[i]]; }
  sweepVideos(paused) { const now = performance.now(), gap = this.lastSweep ? Math.min(5000, now - this.lastSweep) : 16; this.lastSweep = now; this.frameMs = this.frameMs ? this.frameMs * 0.8 + gap * 0.2 : gap; for (const k in this.videos) { const v = this.videos[k]; if (paused) v.seen = now; else this.stepVideo(k); } } // a panel open counts as still watching
  stepVideo(url) { // pause and mute a recording once no screen showing it has been near for a moment
    const v = this.videos[url]; if (!v) return; if (performance.now() - (v.seen || 0) > Math.max(900, (this.frameMs || 16) * 6)) { /* about a second, longer on very slow devices */ if (!v.el.paused) v.el.pause(); if (v.sound) { v.sound = false; v.el.muted = true; } }
  }
  // called by the render loop for each screen near the player: returns true when it drew a video frame
  drawVideoScreen(s, i, near) {
    const id = this.screenIds[i], cfg = this.screenMap && this.screenMap[id]; if (!cfg) return false;
    let v = this.videos[cfg.url];
    if (!v && near) { const el = document.createElement('video'); el.src = cfg.url; el.muted = true; el.loop = true; el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto'; el.crossOrigin = 'anonymous'; v = this.videos[cfg.url] = { el, url: cfg.url, sound: false, ok: true }; el.addEventListener('error', () => { v.ok = false; }); }
    if (!v || !v.ok) return false;
    if (!near) return false; // pausing is decided once for all screens that share this video (stepVideo)
    v.seen = performance.now(); if (v.el.paused) v.el.play().catch(() => { });
    if (v.el.readyState < 2) return false;
    const c = s.cv, x = c.getContext('2d'), vw = v.el.videoWidth || 16, vh = v.el.videoHeight || 9, k = Math.min(c.width / vw, c.height / vh);
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); x.drawImage(v.el, (c.width - vw * k) / 2, (c.height - vh * k) / 2, vw * k, vh * k);
    if (v.sound) { const pl = this.ctx.player(), d = Math.hypot(s.pos[0] - pl.x, s.pos[2] - pl.z); v.el.volume = Math.max(0, Math.min(1, 1.2 - d / 25)); }
    this.framesDrawn = (this.framesDrawn || 0) + 1;
    return true;
  }
  screenForHotspot(h) { // info panel of a screen: offer sound on/off when it has a recording
    const pl = this.ctx.player(); let best = -1, bd = 1e9; this.ctx.W.screens.forEach((s, i) => { const d = Math.hypot(s.pos[0] - h.x, s.pos[2] - h.z); if (d < bd) { bd = d; best = i; } });
    return best >= 0 && this.videoFor(best) ? best : -1;
  }
  toggleSound(i) { const cfg = this.videoFor(i); if (!cfg) return false; const v = this.videos[cfg.url]; if (!v) return false; v.sound = !v.sound; v.el.muted = !v.sound; v.seen = performance.now(); if (v.sound) v.el.play().catch(() => { }); return v.sound; }
  drawScreens() {
    const box = this.$('tScreens'); box.innerHTML = '';
    const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
    box.appendChild(el('p', 'Recordings play on a screen when an attendee walks up to it, muted until they tap “Play with sound” on the screen’s panel. To add a recording, send the clip to the build team: on this hosting each clip must be under 15 MB; full-length recordings can stream from your own server later.', 'small'));
    const names = { 'plenary-main': 'Plenary main screen', 'plenary-left': 'Plenary left relay', 'plenary-right': 'Plenary right relay', hallA: 'Hall A screen', hallB: 'Hall B screen', hallC: 'Hall C screen', workshop: 'Workshop screen' };
    for (const id of this.screenIds) { const c = this.screenMap && this.screenMap[id]; const r = el('div', null, 'prow'); r.append(el('div', names[id] || id, 'pn'), el('div', c ? 'Recording linked' + (c.title ? ': ' + c.title : '') : 'Animated title (no recording yet)', 'small')); box.appendChild(r); }
  }

  // ===== device check =====
  async deviceCheck() {
    const $ = this.$, out = $('checkOut'), bar = $('checkBar'); this.closeSheet('agenda');
    $('checkCopy').disabled = $('checkSave').disabled = true; out.textContent = ''; $('checkTitle').textContent = 'Checking this device…'; this.openSheet('check');
    const gl = document.createElement('canvas').getContext('webgl2'), dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'No WebGL 2';
    const info = { when: new Date().toISOString(), browser: navigator.userAgent, screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`, cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null, gpu: String(gpu).slice(0, 120), quality: this.ctx.quality() };
    const stops = ['foyer', 'plenary', 'expo', 'lounge', 'hallA'], res = [], back = this.ctx.where();
    this.checking = true; this.checkAbort = false; $('checkClose').textContent = 'Cancel';
    this.ctx.pause(false); $('check').classList.add('peek'); $('checkClose').focus({ preventScroll: true });
    const wait = (ms) => new Promise(r => { const t0 = performance.now(), f = () => (this.checkAbort || performance.now() - t0 >= ms) ? r() : setTimeout(f, 50); f(); });
    for (let i = 0; i < stops.length && !this.checkAbort; i++) {
      bar.style.width = (i / stops.length * 100) + '%'; $('checkTitle').textContent = `Checking this device… ${ZONES.find(z => z.id === stops[i]).name}`;
      this.ctx.teleport(stops[i]); await wait(500); if (this.checkAbort) break;
      const m = await this.measure(1800, () => this.checkAbort); if (!this.checkAbort) res.push({ area: stops[i], fps: m.fps, slowest: m.p99 });
    }
    $('check').classList.remove('peek'); this.ctx.restore(back); this.checking = false; $('checkClose').textContent = 'Close';
    if (this.checkAbort || !res.length) { this.checkAbort = false; bar.style.width = '0'; this.closeSheet('check'); this.ctx.toast('Device check cancelled'); this.lastCheck = null; return null; }
    bar.style.width = '100%'; this.ctx.pause(true);
    const avg = res.reduce((a, r) => a + r.fps, 0) / res.length, worst = Math.min(...res.map(r => r.fps));
    const verdict = avg >= 45 && worst >= 30 ? 'good' : avg >= 28 ? 'ok' : 'weak';
    let action = '';
    if (verdict === 'weak' && this.ctx.quality() !== 'balanced') { this.ctx.setQuality('balanced'); action = 'Switched to Balanced quality for smoother movement.'; }
    else if (verdict === 'good') action = 'High quality works well here.';
    else action = this.ctx.quality() === 'balanced' ? 'Balanced quality is the right setting here.' : 'If movement feels uneven, choose Balanced at the top right.';
    this.lastCheck = { ...info, results: res, averageFps: Math.round(avg), worstFps: worst, verdict, action };
    $('checkTitle').textContent = verdict === 'good' ? 'This device runs the venue smoothly' : verdict === 'ok' ? 'This device runs the venue acceptably' : 'This device struggles with the venue';
    out.innerHTML = ''; const p = (t, cls) => { const e = document.createElement('p'); e.textContent = t; if (cls) e.className = cls; out.appendChild(e); };
    p(`Average ${Math.round(avg)} frames per second, slowest area ${worst}. ${action}`);
    const ul = document.createElement('ul'); ul.className = 'checklist'; for (const r of res) { const li = document.createElement('li'); li.textContent = `${ZONES.find(z => z.id === r.area).name}: ${r.fps} fps`; ul.appendChild(li); } out.appendChild(ul);
    p(`${info.gpu} · ${info.screen}${info.cores ? ' · ' + info.cores + ' cores' : ''}${info.memoryGB ? ' · ' + info.memoryGB + ' GB memory' : ''}`, 'small');
    p('30 frames per second or more feels smooth; under 20 feels jerky. Send the result to the build team if anything looks wrong.', 'small');
    $('checkCopy').disabled = $('checkSave').disabled = false;
    return this.lastCheck;
  }
  measure(ms, stop) { // frames actually drawn in the window; robust on very slow devices
    return new Promise(res => { const t0 = performance.now(); let n = 0, last = t0; const gaps = []; const f = (t) => { n++; gaps.push(t - last); last = t; if (t - t0 < ms && !(stop && stop())) requestAnimationFrame(f); else { const el = (t - t0) / 1000, s = gaps.slice(1).sort((a, b) => a - b), worst = s.length ? s[Math.max(0, Math.ceil(s.length * 0.99) - 1)] : el * 1000; res({ fps: Math.round(n / Math.max(el, 0.001)), p99: Math.round(1000 / Math.max(worst, 1)) }); } }; requestAnimationFrame(f); });
  }
  checkText() { const c = this.lastCheck; if (!c) return ''; return [`EHC venue device check · ${c.when}`, `Verdict: ${c.verdict} (average ${c.averageFps} fps, slowest ${c.worstFps} fps)`, ...c.results.map(r => `${r.area}: ${r.fps} fps (99th percentile ${r.slowest} fps)`), `GPU: ${c.gpu}`, `Screen: ${c.screen}`, `Cores: ${c.cores || 'unknown'} · Memory: ${c.memoryGB || 'unknown'} GB`, `Quality: ${c.quality}`, `Browser: ${c.browser}`, `Action: ${c.action}`].join('\n'); }
  copyCheck() { const t = this.checkText(); try { navigator.clipboard.writeText(t).then(() => this.ctx.toast('Result copied'), () => this.ctx.toast('Couldn’t copy; use Download instead')); } catch (e) { this.ctx.toast('Couldn’t copy; use Download instead'); } }
  saveCheck() { this.download('ehc-device-check.txt', this.checkText(), 'text/plain'); }
}
