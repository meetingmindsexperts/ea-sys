// ---------- Social layer: talk to AI attendees (Claude), meet real people (room), voices (speech synthesis) ----------
const PEOPLE_NAMES = {
  f: [['Layla', 'Haddad'], ['Mariam', 'Al Mansoori'], ['Fatima', 'Al Suwaidi'], ['Noor', 'Khalil'], ['Aisha', 'Rahman'], ['Priya', 'Menon'], ['Anjali', 'Nair'], ['Sarah', 'Whelan'], ['Elena', 'Rossi'], ['Maria', 'Santos'], ['Hana', 'Yousef'], ['Reem', 'Al Hashimi'], ['Dina', 'Mansour'], ['Grace', 'Okafor'], ['Salma', 'Barakat'], ['Meera', 'Kapoor']],
  m: [['Omar', 'Al Falasi'], ['Khalid', 'Al Nuaimi'], ['Ahmed', 'Farouk'], ['Yousef', 'Saleh'], ['Rashid', 'Al Ketbi'], ['Arjun', 'Pillai'], ['Rahul', 'Iyer'], ['James', 'Whitfield'], ['Daniel', 'Becker'], ['Marco', 'Bianchi'], ['Hassan', 'Qureshi'], ['Tariq', 'Aziz'], ['Samir', 'Haddad'], ['Joseph', 'Mensah'], ['Carlos', 'Reyes'], ['Faisal', 'Al Zaabi']],
};
const DELEGATE_TITLES = [['Consultant haematologist', 1], ['Haematology fellow', 1], ['Clinical haematology specialist', 1], ['Transfusion medicine physician', 1], ['Paediatric haematologist', 1], ['Haematology laboratory scientist', 0], ['Haemato-oncology nurse specialist', 0], ['Oncology clinical pharmacist', 0], ['Internal medicine resident', 1], ['Final-year medical student', 0]];
const CITIES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Al Ain', 'Ras Al Khaimah', 'Fujairah', 'Riyadh', 'Muscat', 'Doha', 'Kuwait City', 'Manama', 'Cairo', 'Amman'];
const PLACES = ['a teaching hospital', 'a tertiary hospital', 'a children’s hospital', 'a cancer centre', 'a private hospital group', 'a university medical school'];
const TRAITS = ['warm and talkative', 'dry sense of humour', 'thoughtful and precise', 'enthusiastic about new research', 'relaxed, a little jet-lagged', 'curious, asks questions back', 'busy but friendly', 'quietly confident'];
const INTERESTS = ['sickle cell disease', 'thalassaemia care', 'iron deficiency in pregnancy', 'haemophilia management', 'cellular therapy', 'myeloma', 'lymphoma', 'transfusion safety', 'bone marrow transplantation', 'venous thrombosis', 'paediatric leukaemia', 'laboratory automation', 'anticoagulation clinics', 'blood donor programmes'];
const ZONE_NAMES = { foyer: 'Grand Foyer', plenary: 'Plenary Ballroom', posters: 'Poster Gallery', hallA: 'Hall A', hallB: 'Hall B', hallC: 'Hall C', workshop: 'Workshop Room', promenade: 'East Promenade', lounge: 'Networking Lounge', expo: 'Exhibition Hall' };
const AMBIENT = ['The coffee here is really good.', 'Are you staying for the plenary?', 'How is the fellowship going?', 'I saw a great case series last month.', 'We should catch up after the sessions.', 'Is this your first time at this conference?', 'Our lab just went fully digital.', 'The foyer looks amazing this year.', 'Did you register for the workshop?', 'Let’s grab a seat before it fills up.'];
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

function makePersona(p, idx) {
  const r = rng(1000 + idx * 7919), pick = (a) => a[Math.floor(r() * a.length)];
  const g = p.look.g || (p.look.outfit === 'abaya' ? 'f' : p.look.outfit === 'kandura' ? 'm' : (r() < 0.5 ? 'f' : 'm'));
  const ARAB = /^Al |Haddad|Khalil|Rahman|Yousef|Mansour|Barakat|Farouk|Saleh|Aziz|Qureshi|Falasi|Nuaimi|Ketbi|Zaabi|Suwaidi|Mansoori|Hashimi/;
  const pool = (p.look.outfit === 'kandura' || p.look.outfit === 'abaya') ? PEOPLE_NAMES[g].filter(n => ARAB.test(n[1])) : PEOPLE_NAMES[g];
  const [first, last] = pick(pool);
  let title, dr = false, org, kind = 'delegate';
  const role = p.role || 'guest';
  if (role === 'staff') { title = 'Registration and information team'; org = 'the conference organising team'; kind = 'staff'; }
  else if (role === 'barista') { title = 'Barista'; org = 'the hotel catering team'; kind = 'staff'; }
  else if (role === 'tech') { title = 'AV technician'; org = 'the event production crew'; kind = 'staff'; }
  else if (role === 'exhibitor') {
    if (p.x > 59 && p.z > 4 && p.z < 13) { title = 'Society volunteer'; org = 'the Emirates Society of Haematology booth'; kind = 'society'; }
    else { title = 'Partner stand representative'; org = 'a partner company (name not yet confirmed in this preview)'; kind = 'exhibitor'; }
  } else if (role === 'speaker') { const t = pick(DELEGATE_TITLES.filter(d => d[1])); title = t[0] + ' and invited speaker'; dr = true; org = pick(PLACES) + ' in ' + pick(CITIES); kind = 'speaker'; }
  else { const t = pick(DELEGATE_TITLES); title = t[0]; dr = !!t[1]; org = pick(PLACES) + ' in ' + pick(CITIES); }
  if (role === 'panel') kind = 'speaker';
  return { first, last, name: (dr ? 'Dr ' : '') + first + ' ' + last, short: (dr ? 'Dr ' + last : first), g, title, org, kind, trait: pick(TRAITS), interest: pick(INTERESTS), arabic: /^Al |Haddad|Khalil|Rahman|Yousef|Mansour|Barakat|Farouk|Saleh|Aziz|Qureshi/.test(last) };
}

class Social {
  constructor(ctx) {
    this.ctx = ctx; this.$ = (id) => document.getElementById(id);
    this.sample = null; this.room = null; this.user = null; this.aiState = 'loading';
    this.peers = new Map(); this.profiles = {}; this.myId = null; this.myColor = '#a3253a';
    this.target = null; this.bubbles = []; this.voicesOn = true; this.voices = [];
    this.sayN = 0; this.gestN = 0; this.lastPres = 0; this.presKey = '';
    this.ambT = 4; this.greetT = 3; this.ctl = null; this.busy = false;
    try { const v = localStorage.getItem('ehc-voices'); if (v === 'off') this.voicesOn = false; } catch (e) { }
    // moderation: kept on this device only. Muted people can't be heard or read; blocked people also disappear for you.
    this.muted = new Set(); this.blocked = new Set();
    try { for (const k of JSON.parse(localStorage.getItem('ehc-muted') || '[]')) if (typeof k === 'string') this.muted.add(k); for (const k of JSON.parse(localStorage.getItem('ehc-blocked') || '[]')) if (typeof k === 'string') this.blocked.add(k); } catch (e) { }
    this.onReport = null; this.onPeopleChange = null;
    this.filter = new LangFilter(); this.filteredOut = 0;
    this.tts = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    if (this.tts) { const load = () => { this.voices = speechSynthesis.getVoices() || []; }; load(); speechSynthesis.onvoiceschanged = load; }
    this.layer = this.$('bubbles');
    this.wireUI();
    this.connect();
  }

  // ----- capabilities (all optional; the page works without them)
  async connect() {
    const use = (n) => (window.claude && typeof window.claude.use === 'function') ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
    const [sample, room, user] = await Promise.all([use('sample'), use('room'), use('user')]);
    this.sample = sample; this.aiState = sample ? 'ready' : 'offline';
    this.user = user;
    if (user) { try { const me = await user.me(); this.myId = me.id; this.myColor = me.color || this.myColor; this.myName = me.name || ''; } catch (e) { } }
    if (room) {
      this.room = room;
      room.onPeers((ch) => this.onPeers(ch.peers), () => { this.room = null; this.peers.clear(); this.renderHere(); });
    }
    this.renderNote();
  }
  modKey(P) { return P.id ? 'u:' + P.id : 'p:' + P.peer; }
  saveMod() { try { localStorage.setItem('ehc-muted', JSON.stringify([...this.muted].slice(-500))); localStorage.setItem('ehc-blocked', JSON.stringify([...this.blocked].slice(-500))); } catch (e) { } }
  isMuted(P) { const k = this.modKey(P); return this.muted.has(k) || this.blocked.has(k); }
  setMuted(P, on) { const k = this.modKey(P); on ? this.muted.add(k) : this.muted.delete(k); this.saveMod(); for (const b of this.bubbles) if (b.who === P && on) b.until = 0; this.renderHere(); this.onPeopleChange && this.onPeopleChange(); }
  setBlocked(P, on) { const k = this.modKey(P); if (on) { this.blocked.add(k); if (this.target && this.target.ref === P) this.close(); this.peers.delete(P.peer); this.blockedNames = { ...(this.blockedNames || {}), [k]: P.name || 'Someone' }; } else this.blocked.delete(k); this.saveMod(); this.renderHere(); this.onPeopleChange && this.onPeopleChange(); }
  unblockAll() { this.blocked.clear(); this.saveMod(); this.renderHere(); this.onPeopleChange && this.onPeopleChange(); }
  async onPeers(list) {
    const seen = new Set();
    for (const pr of list) {
      if (pr.sameTab || pr.kind !== 'viewer') continue;
      if (this.blocked.has(pr.by ? 'u:' + pr.by : 'p:' + pr.peer)) continue;
      seen.add(pr.peer);
      const ps = pr.presence || {}; let P = this.peers.get(pr.peer);
      const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : d;
      const x = num(ps.x, -56, 70, 0), z = num(ps.z, -44, 30, 26), y = num(ps.y, 0, 3, 0), yaw = num(ps.yaw, -10, 10, 0);
      if (!P) {
        const h = hashStr(pr.peer);
        P = { peer: pr.peer, x, z, y, yaw, tx: x, tz: z, ty: y, tyaw: yaw, phase: 0, speed: 0, pose: 'stand', t: 0, isPeer: true, isMe: pr.isMe, guest: pr.guest, look: makeLook(rng(1 + (h % 100000)), 'delegate') };
        if (P.look.outfit === 'staff') P.look.outfit = 'suit';
        this.peers.set(pr.peer, P);
      }
      P.tx = x; P.tz = z; P.ty = y; P.tyaw = yaw; P.mv = num(ps.mv, 0, 10, 0); P.id = typeof pr.by === 'string' && pr.by ? pr.by : null; /* identity only from the platform, never from what a visitor says about themselves */ P.zone = typeof ps.zn === 'string' ? ps.zn.slice(0, 20) : '';
      if (typeof ps.col === 'string' && /^#[0-9a-f]{6}$/i.test(ps.col)) P.col = ps.col;
      if (typeof ps.gt === 'number' && ps.gt !== P.gt) { P.gt = ps.gt; if (P.seenG && GEST_DUR[ps.g]) { P.gesture = ps.g; P.gT = this.ctx.time(); } P.seenG = true; }
      if (typeof ps.sn === 'number' && ps.sn !== P.sn) { const first = P.sn == null; P.sn = ps.sn; if (!first && typeof ps.say === 'string' && ps.say.trim()) { const said = ps.say.slice(0, 280); P.said = [...(P.said || []), { t: Date.now(), text: said }].slice(-6); if (!this.isMuted(P)) this.heardPeer(P, said); } }
    }
    for (const k of [...this.peers.keys()]) if (!seen.has(k)) { const P = this.peers.get(k); if (this.target && this.target.ref === P) this.close(); this.peers.delete(k); }
    if (this.user) { const ids = [...this.peers.values()].map(p => p.id).filter(Boolean); if (ids.length) { try { this.profiles = await this.user.profiles(ids); } catch (e) { } } }
    for (const P of this.peers.values()) {
      const pf = P.id && this.profiles[P.id]; P.name = (pf && pf.name) || (P.isMe ? 'You (other tab)' : P.guest || !P.id ? 'Guest' : 'Colleague');
      const col = (pf && pf.color) || P.col; if (col) { const n = parseInt(col.slice(1), 16); if (!isNaN(n)) { const c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; P.look.top = c.map(v => v * 0.8); P.look.lanyard = c; } }
    }
    this.renderHere();
  }
  renderHere() { const n = this.peers.size, el = this.$('here'); if (!el) return; el.hidden = !n && !this.blocked.size; el.textContent = (n === 1 ? '1 colleague here' : n + ' colleagues here') + (this.muted.size || this.blocked.size ? ' · manage' : ''); }

  // ----- presence (my avatar for other viewers)
  publish(force) {
    if (!this.room) return; const pl = this.ctx.player(), now = performance.now();
    if (!force && now - this.lastPres < 100) return; this.lastPres = now;
    const r2 = (v) => Math.round(v * 100) / 100;
    const st = { v: 1, x: r2(pl.x), z: r2(pl.z), y: r2(pl.y), yaw: r2(Math.atan2(Math.sin(pl.yaw), Math.cos(pl.yaw))), mv: r2(pl.speed), zn: (this.ctx.zone() || {}).id || '', col: this.myColor, g: this.myG || '', gt: this.gestN, sn: this.sayN, say: this.myLast || '' };
    const key = JSON.stringify(st); if (key === this.presKey && !force) return; this.presKey = key;
    this.room.presence(st).catch(() => { });
  }

  // ----- per-frame update
  update(dt, t) {
    const pl = this.ctx.player();
    for (const P of this.peers.values()) {
      const k = Math.min(1, dt * 10); const ox = P.x, oz = P.z;
      P.x += (P.tx - P.x) * k; P.z += (P.tz - P.z) * k; P.y += (P.ty - P.y) * k;
      let d = P.tyaw - P.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); P.yaw += d * k;
      const sp = Math.hypot(P.x - ox, P.z - oz) / Math.max(dt, 1e-3); P.speed += (sp - P.speed) * k;
      P.pose = P.speed > 0.3 ? 'walk' : 'stand'; P.phase += P.speed * dt * 5; P.t = t;
    }
    this.publish();
    // conversation upkeep: face each other, end when you walk away
    const T = this.target;
    if (T) {
      const o = T.ref, d = Math.hypot(o.x - pl.x, o.z - pl.z);
      if (d > 5 && !T.remote) this.close('You walked away.');
      else if (T.kind === 'npc' && o.pose !== 'sit' && o.pose !== 'present') { const fy = Math.atan2(pl.x - o.x, pl.z - o.z); if (o.route) o.faceYaw = fy; else { let dd = fy - o.yaw; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); o.yaw += dd * Math.min(1, dt * 6); } }
    }
    // a few ambient lines so the venue feels alive (never sent to Claude)
    this.ambT -= dt;
    if (this.ambT <= 0) {
      this.ambT = 5 + Math.random() * 5;
      const talkers = this.ctx.crowd().list.filter(p => (p.pose === 'talk' || p.pose === 'stand' && p.role === 'guest') && Math.hypot(p.x - pl.x, p.z - pl.z) < 13 && (!T || T.ref !== p));
      if (talkers.length) { const p = talkers[Math.floor(Math.random() * talkers.length)]; this.bubble(p, AMBIENT[Math.floor(Math.random() * AMBIENT.length)], { quiet: true, ms: 3200 }); }
    }
    // a passing hello
    this.greetT -= dt;
    if (this.greetT <= 0 && !T) {
      this.greetT = 2;
      for (const p of this.ctx.crowd().list) {
        if (p.pose === 'sit' || p.greeted || Math.hypot(p.x - pl.x, p.z - pl.z) > 2.6 || pl.speed < 0.4) continue;
        const per = this.persona(p); p.greeted = true; this.greetT = 9;
        this.bubble(p, per.arabic && Math.random() < 0.5 ? 'Ahlan! Welcome.' : ['Hello!', 'Good morning!', 'Hi there.', 'Nice to see you.'][Math.floor(Math.random() * 4)], { quiet: true, ms: 2600 });
        p.gesture = 'wave'; p.gT = t; break;
      }
    }
  }

  // ----- who can I talk to?
  persona(p) { if (!p.persona) { const i = this.ctx.crowd().list.indexOf(p); p.persona = makePersona(p, i < 0 ? 999 : i); } return p.persona; }
  nearestPerson() {
    const pl = this.ctx.player(); let best = null, bd = 1e9;
    const consider = (o, kind) => {
      const dx = o.x - pl.x, dz = o.z - pl.z, d = Math.hypot(dx, dz); if (d > 2.3 || Math.abs((o.y || 0) - pl.y) > 1.2) return;
      let ang = Math.atan2(dx, dz) - pl.yaw; ang = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
      const score = d + ang * 0.6; if ((d < 1.4 || ang < 1.4) && score < bd) { bd = score; best = { kind, ref: o, d }; }
    };
    for (const p of this.ctx.crowd().list) consider(p, 'npc');
    for (const P of this.peers.values()) consider(P, 'peer');
    if (best) best.label = best.kind === 'npc' ? 'Talk to ' + this.persona(best.ref).name : 'Talk to ' + best.ref.name;
    return best;
  }

  // ----- chat panel
  wireUI() {
    const $ = this.$;
    $('cForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('cInput').value.trim(); if (!v) return; $('cInput').value = ''; this.say(v); });
    $('cClose').addEventListener('click', () => this.close());
    $('cWave').addEventListener('click', () => this.gesture('wave'));
    $('cShake').addEventListener('click', () => this.gesture('shake'));
    $('cVoice').addEventListener('click', () => { this.voicesOn = !this.voicesOn; if (!this.voicesOn && this.tts) { speechSynthesis.cancel(); this.voiceQ = 0; } try { localStorage.setItem('ehc-voices', this.voicesOn ? 'on' : 'off'); } catch (e) { } this.renderVoice(); });
    $('cStop').addEventListener('click', () => { if (this.ctl) this.ctl.abort(); if (this.tts) { speechSynthesis.cancel(); this.voiceQ = 0; } });
    $('cInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.close(); } e.stopPropagation(); });
    $('cInput').addEventListener('keyup', (e) => e.stopPropagation());
    this.renderVoice();
    if (!this.tts) $('cVoice').hidden = true;
  }
  renderVoice() { const b = this.$('cVoice'); b.textContent = this.voicesOn ? 'Voices on' : 'Voices off'; b.setAttribute('aria-pressed', String(this.voicesOn)); }
  renderNote() {
    const T = this.target, n = this.$('cNote');
    if (!T) return;
    if (T.kind === 'peer') n.textContent = 'Live: what you say appears over your head for everyone nearby.';
    else if (this.aiState === 'ready') n.textContent = this.noted ? '' : 'Replies are written live by AI. Attendees are fictional.';
    else if (this.aiState === 'declined') n.textContent = 'Live AI replies are off here, so attendees use simple pre-written answers.';
    else if (this.aiState === 'offline') n.textContent = 'Live AI replies aren’t available here, so attendees use simple pre-written answers.';
    else n.textContent = '';
    const tip = this.voiceTip(); if (tip && T.kind !== 'peer' && !this.tipShown) { this.tipShown = true; n.textContent = (n.textContent ? n.textContent + ' ' : '') + tip; }
  }
  voiceTip() { // only when this device has basic voices: say how to get a more natural one
    if (!this.tts || !this.voicesOn || window.EHC_TTS || !this.voices.length || this.voiceTier().good) return '';
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'For a more natural voice: Settings › Accessibility › Spoken Content › Voices › English, download an “Enhanced” or “Premium” voice, then reopen this page.';
    if (/Android/.test(ua)) return 'For a more natural voice: Settings › Accessibility › Text-to-speech, choose Speech Services by Google and install a high-quality voice.';
    if (/Macintosh/.test(ua)) return 'For a more natural voice: System Settings › Accessibility › Spoken Content › System voice › Manage Voices, download a “Premium” voice.';
    return 'For more natural voices, open this page in Microsoft Edge, which includes natural-sounding voices.';
  }
  open(tg) {
    if (!tg) tg = this.nearestPerson();
    const $ = this.$;
    if (this.target && this.target.ref !== (tg && tg.ref)) this.close();
    this.target = tg || { kind: 'room', ref: this.ctx.player() };
    document.body.classList.add('chatting'); $('chat').hidden = false; $('cLog').innerHTML = '';
    const T = this.target;
    if (T.kind === 'npc') {
      const per = this.persona(T.ref); T.ref.hold = true; T.ref.baseYaw = T.ref.baseYaw ?? T.ref.yaw; T.turns = T.ref.turns || (T.ref.turns = []);
      $('cName').textContent = per.name; $('cTitle').textContent = per.title + ' · ' + per.org; $('cTag').textContent = 'AI attendee'; $('cDot').style.background = '#c8a46a';
      for (const m of T.turns) this.logLine(m.role === 'user' ? 'You' : per.short, m.shown || m.content, m.role === 'user' ? 'me' : 'them');
      if (!T.turns.length) {
        const pl = this.ctx.player();
        if (T.ref.pose !== 'sit' && !T.remote) { T.ref.gesture = 'shake'; T.ref.gT = this.ctx.time(); this.gesture('shake'); }
        const hi = T.greet || this.greeting(per);
        T.greeting = hi; this.npcSays(T.ref, hi, true);
      }
      this.quick(T.quick || ['What brings you here?', 'Where can I get a coffee?', 'What are you working on?', 'Any tips for the day?']);
    } else if (T.kind === 'peer') {
      $('cName').textContent = T.ref.name; $('cTitle').textContent = T.ref.guest ? 'Guest · here live' : 'Colleague · here live'; $('cTag').textContent = 'Real person'; $('cDot').style.background = T.ref.col || '#7fb3a6';
      this.gesture('wave'); this.quick(['Hi!', 'Shall we head to the plenary?', 'Coffee?', 'See you in the lounge.']); this.renderMod();
    } else {
      $('cName').textContent = 'Say something'; $('cTitle').textContent = this.peers.size ? 'Colleagues nearby will see it over your head' : 'No one is close enough to hear you yet'; $('cTag').textContent = 'Nearby'; $('cDot').style.background = '#7fb3a6';
      this.quick(['Hello everyone!', 'Anyone for coffee?', 'Heading to the plenary.']);
    }
    this.renderNote(); this.ctx.onChat(true);
    if (!this.ctx.isTouch) setTimeout(() => $('cInput').focus(), 30);
  }
  renderMod() {
    const box = this.$('cMod'), T = this.target; if (!box) return; box.innerHTML = ''; box.hidden = !T || T.kind !== 'peer'; if (box.hidden) return;
    const P = T.ref, m = this.muted.has(this.modKey(P)), btn = (t, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip ' + (cls || ''); b.textContent = t; b.addEventListener('click', fn); box.appendChild(b); return b; };
    btn(m ? 'Unmute' : 'Mute', () => { this.setMuted(P, !m); this.renderMod(); this.logLine('', m ? `${P.name} unmuted.` : `${P.name} muted: you won’t see or hear what they say.`, 'sys'); }).setAttribute('aria-pressed', String(m));
    btn('Block', () => { const nm = P.name; this.setBlocked(P, true); this.ctx.toast && this.ctx.toast(`${nm} blocked. They’re hidden for you; unblock any time from the people list.`); });
    btn('Report', () => this.onReport && this.onReport(P), 'warn');
  }
  close(reason) {
    const $ = this.$, T = this.target; if (!T) return;
    if (this.ctl) this.ctl.abort(); if (this.tts) { speechSynthesis.cancel(); this.voiceQ = 0; }
    if (T.kind === 'npc') { const o = T.ref; o.hold = false; o.faceYaw = null; o.speaking = false; const by = o.baseYaw; if (!o.route && by != null) setTimeout(() => { if (!o.hold) o.yaw = by; }, 1800); }
    this.target = null; this.busy = false; if ($('cMod')) $('cMod').hidden = true; $('chat').hidden = true; document.body.classList.remove('chatting'); $('cInput').blur(); this.ctx.onChat(false);
  }
  quick(list) {
    const q = this.$('cQuick'); q.innerHTML = '';
    for (const s of list) { const b = document.createElement('button'); b.type = 'button'; b.className = 'qchip'; b.textContent = s; b.addEventListener('click', () => this.say(s)); q.appendChild(b); }
  }
  logLine(who, text, cls, extra) {
    const L = this.$('cLog'), row = document.createElement('div'); row.className = 'msg ' + cls;
    const w = document.createElement('div'); w.className = 'mw'; w.textContent = who; const tx = document.createElement('div'); tx.className = 'mt'; tx.textContent = text;
    row.append(w, tx); if (extra) row.appendChild(extra); L.appendChild(row); L.scrollTop = L.scrollHeight; return tx;
  }
  greeting(per) {
    const hi = per.arabic ? 'Ahlan wa sahlan! ' : ['Hello! ', 'Hi there! ', 'Good morning! '][hashStr(per.name) % 3];
    if (per.kind === 'staff') return hi + `I’m ${per.first} from ${per.org}. How can I help you?`;
    if (per.kind === 'society') return hi + `I’m ${per.first}, volunteering at the society booth today. Are you a member?`;
    if (per.kind === 'exhibitor') return hi + `I’m ${per.first}, on one of the partner stands. Enjoying the conference so far?`;
    return hi + `I’m ${per.name}, ${per.title.toLowerCase()} at ${per.org}. Nice to meet you.`;
  }

  // ----- speaking
  gesture(g) {
    const pl = this.ctx.player(); pl.gesture = g; pl.gT = this.ctx.time(); this.myG = g; this.gestN++; this.publish(true);
  }
  say(text) {
    text = text.slice(0, 240);
    const f = this.filter.check(text);
    if (f.hit) {
      if (this.filter.cfg.mode === 'hide') { this.logLine('', 'Not sent: it contains words this event doesn’t allow.', 'sys'); return; }
      text = f.text; if (!this.toldFilter) { this.toldFilter = true; this.logLine('', 'Some words were hidden by the event’s language filter.', 'sys'); }
    }
    const T = this.target, pl = this.ctx.player();
    this.logLine('You', text, 'me');
    this.bubble(pl, text, { me: true }); this.speak(pl, text, true);
    this.myLast = text; this.sayN++; this.publish(true);
    if (T && T.kind === 'npc') { this.reply(T, text); this.onEvent && this.onEvent('question'); } else if (T && T.kind === 'peer') this.onEvent && this.onEvent('chat');
  }
  heardPeer(P, text) {
    const pl = this.ctx.player(), d = Math.hypot(P.x - pl.x, P.z - pl.z);
    if (d > 14) return;
    const f = this.filter.check(text);
    if (f.hit) { // the event's language filter: mask the words, or hide the message
      this.filteredOut++; P.flagged = (P.flagged || 0) + 1;
      if (P.flagged === 3) { this.ctx.toast && this.ctx.toast(`${P.name || 'Someone'} keeps using language this event filters. Tap “colleagues here” to mute or report them.`); if (this.target && this.target.ref === P) this.logLine('', `${P.name || 'This person'} keeps using filtered language. Mute or report them with the buttons above.`, 'sys'); }
      if (this.filter.cfg.mode === 'hide') { if (this.target && this.target.ref === P) this.logLine(P.name || 'Colleague', 'Message hidden by the event’s language filter.', 'them sys'); return; }
      text = f.text;
    }
    this.bubble(P, text, {}); if (d < 9) this.speak(P, text);
    if (this.target && (this.target.ref === P || this.target.kind === 'room' || d < 6)) this.logLine(P.name || 'Colleague', text, 'them');
  }
  async reply(T, text) {
    const npc = T.ref, per = this.persona(npc), $ = this.$;
    if (this.busy && this.ctl) this.ctl.abort();
    T.turns.push({ role: 'user', content: text });
    if (T.turns.length > 16) T.turns.splice(0, T.turns.length - 16);
    const row = this.logLine(per.short, '…', 'them thinking'), think = this.bubble(npc, '…', { thinking: true, ms: 60000 });
    npc.gesture = 'think'; npc.gT = this.ctx.time();
    let shown = '', spoken = 0, go = null, gest = null;
    const show = (raw, final) => {
      const tags = [...raw.matchAll(/\[(gesture|go)\s*:\s*([a-z_]+)\s*\]/gi)];
      for (const m of tags) { if (m[1].toLowerCase() === 'go') go = m[2]; else gest = m[2].toLowerCase(); }
      let clean = raw.replace(/\[(gesture|go)\s*:[^\]]*\]/gi, ''); const open = clean.lastIndexOf('['); if (!final && open >= 0) clean = clean.slice(0, open);
      clean = clean.replace(/\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      shown = clean; row.textContent = clean; row.parentNode.classList.remove('thinking'); think.text = clean; think.thinking = false; think.until = performance.now() + 2500 + clean.length * 70; think.el.querySelector('.bt').textContent = clean; think.el.classList.remove('thinking');
      // speak finished sentences as they arrive
      const upto = final ? clean.length : (() => { const m = [...clean.matchAll(/[.!?؟](\s|$)/g)]; return m.length ? m[m.length - 1].index + 1 : 0; })();
      if (upto > spoken) { this.speak(npc, clean.slice(spoken, upto)); spoken = upto; }
      $('cLog').scrollTop = $('cLog').scrollHeight;
    };
    let text2 = null;
    if (this.sample && this.aiState === 'ready') {
      this.busy = true; this.ctl = new AbortController(); $('cStop').hidden = false;
      const rules = this.rules(per, npc, T.greeting);
      try {
        const res = await this.sample([{ role: 'user', content: rules }, ...T.turns.map(m => ({ role: m.role, content: m.content }))], { modelTier: 'quick', cache: false, signal: this.ctl.signal, onText: ({ text }) => show(text, false) });
        text2 = res.text; this.noted = true; this.renderNote();
      } catch (e) {
        const code = e && e.code;
        if (code === 'cancelled') { text2 = e.text || ''; }
        else if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) { this.aiState = 'declined'; this.renderNote(); }
        else if (code === 'rate_limited') { this.$('cNote').textContent = 'The AI is busy right now. Try again in a moment.'; text2 = 'Sorry, give me a second, I lost my train of thought.'; }
        else if (code === 'refused') { text2 = 'Let’s talk about something else, shall we?'; }
        else { this.$('cNote').textContent = 'Couldn’t get a reply just now. Send again to retry.'; text2 = e && e.text ? e.text : 'Sorry, it’s noisy here. Could you say that again?'; }
      } finally { this.busy = false; this.ctl = null; $('cStop').hidden = true; }
    }
    if (text2 == null) { const s = this.scripted(per, npc, text); text2 = s.text; if (s.go) go = s.go; if (s.gesture) gest = s.gesture; await new Promise(r => setTimeout(r, 450)); }
    show(text2, true);
    if (!shown) { shown = '…'; row.textContent = shown; }
    T.turns.push({ role: 'assistant', content: text2.replace(/\[(gesture|go)\s*:[^\]]*\]/gi, '').trim() || '…' });
    if (gest && GEST_DUR[gest]) { npc.gesture = gest; npc.gT = this.ctx.time(); } else { npc.gesture = 'nod'; npc.gT = this.ctx.time(); }
    if (go && ZONE_NAMES[go]) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'gobtn'; b.textContent = 'Take me to ' + ZONE_NAMES[go];
      b.addEventListener('click', () => { this.close(); this.ctx.teleport(go); });
      row.parentNode.appendChild(b); $('cLog').scrollTop = $('cLog').scrollHeight;
      if (!gest) { npc.gesture = 'point'; npc.gT = this.ctx.time(); }
    }
  }
  rules(per, npc, greeting) {
    const Z = this.ctx.zone(), where = Z ? Z.name : 'the venue';
    const doing = npc.pose === 'sit' ? `seated in the ${where}` : npc.role === 'exhibitor' ? `standing at your stand in the ${where}` : npc.role === 'staff' ? `behind the desk in the ${where}` : npc.role === 'barista' ? `behind the coffee bar in the ${where}` : `standing in the ${where}`;
    return [
      `You are role-playing ONE fictional attendee inside a walkable 3D preview of the ${EVENT.name}, organised by the ${EVENT.organiser} on ${EVENT.date} at ${EVENT.venue}. Another attendee has walked up to you and is talking to you; their messages follow.`,
      `You are ${per.name}, ${per.title}, from ${per.org}. Personality: ${per.trait}. ${per.kind === 'delegate' || per.kind === 'speaker' ? `Your main professional interest is ${per.interest}.` : ''} Right now you are ${doing}. You already greeted them with: "${greeting || ''}"`,
      `Venue you know: Grand Foyer with registration and information desks and a hanging disc sculpture; Plenary Ballroom (main stage) north of the foyer; Halls A, B and C and the Workshop Room on the west side, reached from the foyer and the Poster Gallery; the East Promenade leads to the Networking Lounge (coffee bar, city views) and the Exhibition Hall (host society booth, partner stands, a coffee point).`,
      `Not published in this preview: the session programme, track names, speakers, sponsor names and poster titles. Never invent them. If asked, say naturally that you don't have the programme in front of you and suggest the Venue guide or the information desk.`,
      `Rules: stay in character. Speak like a real person at a coffee break: 1 to 3 short sentences, no lists, no markdown, no emojis, no stage directions. Reply in the language they use (English or Arabic). General, educational haematology conversation is fine; give no personal medical advice, promote no drug, device or company, and make no product claims. You are fictional: never claim to be a real named person or name real colleagues. If asked whether you are an AI, say you are an AI-played attendee in this preview. Keep it friendly and professional.`,
      `After your sentences, on a new line, add exactly one tag [gesture: X] where X is one of nod, wave, laugh, think, point, shake, none. If you suggest they go somewhere, also add [go: Y] where Y is one of foyer, plenary, posters, hallA, hallB, hallC, workshop, lounge, expo.`,
    ].join('\n\n');
  }
  scripted(per, npc, q) {
    const s = q.toLowerCase();
    if (/[؀-ۿ]/.test(q)) return { text: 'أهلاً وسهلاً! سعيد بلقائك في المؤتمر.', gesture: 'nod' };
    if (/coffee|tea|drink|قهوة/.test(s)) return { text: 'The coffee bar is in the Networking Lounge, through the East Promenade. There’s also a coffee point in the Exhibition Hall.', go: 'lounge', gesture: 'point' };
    if (/poster|abstract/.test(s)) return { text: 'The posters are in the gallery just off the foyer, on the left as you face the ballroom.', go: 'posters', gesture: 'point' };
    if (/exhib|booth|stand|sponsor|society/.test(s)) return { text: 'The Exhibition Hall is east of the foyer. The society has its own booth there.', go: 'expo', gesture: 'point' };
    if (/plenary|main stage|keynote|opening|ballroom/.test(s)) return { text: 'The Plenary Ballroom is straight ahead from the foyer, through the big doors.', go: 'plenary', gesture: 'point' };
    if (/workshop/.test(s)) return { text: 'The Workshop Room is at the far end of the Poster Gallery, on the west side.', go: 'workshop', gesture: 'point' };
    if (/programme|program|agenda|session|talk|track|speaker|hall/.test(s)) return { text: 'I don’t have the programme in front of me. Check the Venue guide or the information desk. Halls A to C run the parallel sessions.', go: 'foyer', gesture: 'think' };
    if (/regist|badge/.test(s)) return { text: 'Registration is the long desk on the left side of the foyer. The badge kiosks are just beside it.', go: 'foyer', gesture: 'point' };
    if (/who are you|your name|what do you do|working on|yourself/.test(s)) return { text: per.kind === 'delegate' || per.kind === 'speaker' ? `I’m ${per.name}, ${per.title.toLowerCase()} at ${per.org}. These days it’s mostly ${per.interest}.` : `I’m ${per.first}, with ${per.org}.`, gesture: 'nod' };
    if (/brings you|why are you here/.test(s)) return { text: per.kind === 'delegate' || per.kind === 'speaker' ? `Mostly to catch up on ${per.interest}, and to see old friends from the region.` : 'Work, mostly! It’s a busy day for us.', gesture: 'laugh' };
    if (/tip|recommend|advice/.test(s)) return { text: 'Get to the plenary early, the good seats go fast. And don’t skip the poster gallery.', gesture: 'nod' };
    if (/bye|thank|see you|later/.test(s)) return { text: 'Lovely to meet you. Enjoy the rest of the conference!', gesture: 'wave' };
    if (/hello|hi\b|hey|salam|ahlan|morning/.test(s)) return { text: 'Hello again! Is this your first time at the conference?', gesture: 'wave' };
    if (/ai|robot|real/.test(s)) return { text: 'I’m an attendee played by the venue preview, not a real person. Happy to chat, though!', gesture: 'laugh' };
    return { text: per.kind === 'delegate' || per.kind === 'speaker' ? `Interesting. For me the big topic this year is ${per.interest}. What about you?` : 'Good question. The information desk in the foyer will know for sure.', gesture: 'think' };
  }

  // ----- voices
  // Device voices vary a lot. Rank them so neural/natural/enhanced voices are used first, never the novelty or
  // robotic ones, and keep pitch at 1.0 (shifting pitch is what makes browser voices sound mechanical).
  voiceScore(v) {
    const n = v.name;
    if (/zarvox|trinoids|whisper|bells|bad news|good news|bahh|boing|bubbles|cellos|deranged|hysterical|jester|organ|superstar|albert|fred|junior|ralph|kathy|wobble|espeak|mbrola|pico/i.test(n)) return -100;
    let sc = 0;
    if (/natural|neural|wavenet|journey|studio/i.test(n)) sc += 60;       // Edge "Online (Natural)", cloud neural voices
    if (/premium/i.test(n)) sc += 55; if (/enhanced/i.test(n)) sc += 45;   // iPhone / Mac downloaded voices
    if (/siri/i.test(n)) sc += 50;
    if (/^google/i.test(n)) sc += 30;                                      // Chrome network voices
    if (/microsoft/i.test(n) && !/natural/i.test(n)) sc += 8;
    if (v.localService === false) sc += 10;
    if (/compact/i.test(n)) sc -= 20;
    if (/en-(GB|AU|IE|IN|ZA)/i.test(v.lang)) sc += 3; // a little variety in accents
    return sc;
  }
  rankedVoices(lang) {
    const k = lang + '|' + this.voices.length; if (this._rk && this._rk.k === k) return this._rk.v;
    let pool = this.voices.filter(v => lang === 'ar' ? /^ar/i.test(v.lang) : /^en/i.test(v.lang)); if (!pool.length) pool = this.voices.slice();
    pool = pool.map(v => ({ v, s: this.voiceScore(v) })).filter(x => x.s > -50).sort((a, b) => b.s - a.s);
    const top = pool.length ? pool[0].s : 0, good = pool.filter(x => x.s >= top - 15).map(x => x.v); // only the best tier on this device
    this._rk = { k, v: good.length ? good : pool.map(x => x.v) }; return this._rk.v;
  }
  voiceTier() { const v = this.rankedVoices('en')[0]; if (!v) return { name: '', good: false }; const s = this.voiceScore(v); return { name: v.name, good: s >= 30 }; }
  pickVoice(who, text) {
    if (!this.voices.length) return null;
    const ar = /[؀-ۿ]/.test(text), pool = this.rankedVoices(ar ? 'ar' : 'en');
    const fem = /female|samantha|victoria|karen|moira|tessa|fiona|serena|zira|susan|hazel|libby|sonia|natasha|aria|jenny|salli|joanna|kendra|kimberly|ivy|amy|emma|olivia|veena|isha|lekha|zuzana|ava|allison|nicky|laila|mariam|hoda|salma|amira|zariyah|zoe|nora|kate|stephanie|catherine|clara|ana|michelle|emily|sara|google uk english female|google us english/i;
    const g = who.g || (who.persona && who.persona.g);
    const gp = g ? pool.filter(v => g === 'f' ? fem.test(v.name) : !fem.test(v.name)) : pool;
    const P = gp.length ? gp : pool;
    return P[hashStr(who.name || (who.persona && who.persona.name) || who.peer || 'me') % P.length];
  }
  // Optional: a natural-voice service on your own server (e.g. a neural text-to-speech API). Set
  // window.EHC_TTS = { endpoint: 'https://your-server/tts' }; it receives {text, voice, gender, lang} and returns audio.
  async speakRemote(who, text, key) {
    const cfg = window.EHC_TTS; if (!cfg || !cfg.endpoint) return false;
    try {
      const r = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: key.name, gender: key.g || null, lang: /[؀-ۿ]/.test(text) ? 'ar' : 'en' }) });
      if (!r.ok) return false; const url = URL.createObjectURL(await r.blob()), a = new Audio(url);
      this.voiceQ = (this.voiceQ || 0) + 1; const done = () => { this.voiceQ = Math.max(0, this.voiceQ - 1); };
      (this._q = (this._q || Promise.resolve()).then(() => new Promise(res => { who.speaking = true; a.onended = a.onerror = () => { who.speaking = false; URL.revokeObjectURL(url); done(); res(); }; a.play().catch(() => { done(); res(); }); })));
      return true;
    } catch (e) { return false; }
  }
  speak(who, text, isMe) {
    if (!this.voicesOn || !text || !text.trim()) { this.mouth(who, text); return; }
    // only the person you're talking to (and you) may queue up; others are voiced only when the line is nearly free
    const T = this.target, mine = isMe || (T && T.ref === who);
    if (this.tts && !window.EHC_TTS && !speechSynthesis.speaking && !speechSynthesis.pending) this.voiceQ = 0; // re-sync if a browser skipped an end event
    if (!mine && (this.voiceQ || 0) >= 2) { this.voiceSkipped = (this.voiceSkipped || 0) + 1; this.mouth(who, text); return; }
    const per = who.persona || {}, voiceKey = isMe ? { name: 'me-' + (this.myName || 'you'), g: null } : { name: per.name || who.name || who.peer, g: per.g };
    if (window.EHC_TTS && window.EHC_TTS.endpoint) { this.speakRemote(who, text.trim(), voiceKey).then(ok => { if (!ok) this.speakLocal(who, text, isMe, voiceKey); }); return; }
    this.speakLocal(who, text, isMe, voiceKey);
  }
  speakLocal(who, text, isMe, voiceKey) {
    if (!this.tts) { this.mouth(who, text); return; }
    try {
      // natural phrasing: speak sentence by sentence, drop symbols that voices read out literally
      const clean = text.trim().replace(/[*_#~`>|]/g, '').replace(/\s*[–—]\s*/g, ', ').replace(/\s+/g, ' ');
      const parts = (clean.match(/[^.!?؟]+[.!?؟]+["”’)]*|[^.!?؟]+$/g) || [clean]).map(t => t.trim()).filter(Boolean), h = hashStr(voiceKey.name || 'x');
      if (!parts.length) return; const v = this.pickVoice(voiceKey, clean); this.voiceQ = (this.voiceQ || 0) + 1;
      parts.forEach((t, i) => {
        const u = new SpeechSynthesisUtterance(t);
        if (v) { u.voice = v; u.lang = v.lang; }
        u.pitch = 1; u.rate = isMe ? 1 : 0.97 + ((h >>> 4) % 5) * 0.015; u.volume = isMe ? 0.75 : 1;
        if (i === 0) u.onstart = () => { who.speaking = true; };
        const last = i === parts.length - 1; let fin = false;
        u.onend = u.onerror = () => { if (fin) return; fin = true; if (last) { who.speaking = false; this.voiceQ = Math.max(0, (this.voiceQ || 0) - 1); } };
        speechSynthesis.speak(u);
      });
      this.lastVoice = v ? v.name : '';
    } catch (e) { this.mouth(who, text); }
  }
  mouth(who, text) { who.speaking = true; clearTimeout(who._mt); who._mt = setTimeout(() => { who.speaking = false; }, Math.min(6000, 600 + (text || '').length * 55)); }
  npcSays(npc, text, log) { const per = this.persona(npc); if (log) this.logLine(per.short, text, 'them'); this.bubble(npc, text, {}); this.speak(npc, text); }

  // ----- speech bubbles (DOM, projected from 3D)
  bubble(who, text, o = {}) {
    let b = this.bubbles.find(q => q.who === who);
    if (!b) { const el = document.createElement('div'); el.className = 'bubble'; el.innerHTML = '<div class="bn"></div><div class="bt"></div>'; this.layer.appendChild(el); b = { who, el }; this.bubbles.push(b); }
    b.text = text; b.thinking = !!o.thinking; b.until = performance.now() + (o.ms || 2600 + text.length * 70);
    b.el.classList.toggle('thinking', !!o.thinking); b.el.classList.toggle('quiet', !!o.quiet); b.el.classList.toggle('me', !!o.me);
    const nm = o.me ? 'You' : who.isPeer ? (who.name || 'Colleague') : (who.persona ? who.persona.short : '');
    b.el.querySelector('.bn').textContent = nm; b.el.querySelector('.bt').textContent = o.thinking ? '' : text;
    b.w = 0; // size is measured once at the start of the next layout, not every frame
    return b;
  }
  layout(vp, w, h) {
    const now = performance.now(), pl = this.ctx.player();
    const T = this.target, MAXB = 8, show = (b, on) => { if (b.shown !== on) { b.shown = on; b.el.style.display = on ? '' : 'none'; } };
    // reads first (sizes of bubbles whose text changed), then writes, so the page lays out once per frame however many people talk
    for (const b of this.bubbles) if (!b.w && b.shown !== false) { b.w = b.el.offsetWidth || 200; b.h = b.el.offsetHeight || 60; }
    const vis = [];
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      if (now > b.until && !(b.thinking && T && T.ref === b.who)) { b.el.remove(); this.bubbles.splice(i, 1); continue; }
      const o = b.who, hy = (o.y || 0) + (o.pose === 'sit' ? 1.45 : 2.05) * (o.look ? o.look.h : 1);
      const d = Math.hypot(o.x - pl.x, o.z - pl.z);
      const cx = vp[0] * o.x + vp[4] * hy + vp[8] * o.z + vp[12], cy = vp[1] * o.x + vp[5] * hy + vp[9] * o.z + vp[13], cw = vp[3] * o.x + vp[7] * hy + vp[11] * o.z + vp[15];
      if (cw <= 0.1 || d > 22) { show(b, false); continue; }
      const sx = (cx / cw * 0.5 + 0.5) * w, sy = (1 - (cy / cw * 0.5 + 0.5)) * h;
      if (sx < -150 || sx > w + 150 || sy < -100 || sy > h + 50) { show(b, false); continue; }
      vis.push({ b, d, sx, sy, pri: (T && T.ref === o) || b.el.classList.contains('me') ? -1 : d });
    }
    vis.sort((a, b) => a.pri - b.pri); // the person you talk to and your own words first, then the nearest
    vis.forEach(({ b, d, sx, sy }, k) => {
      if (k >= MAXB) { show(b, false); return; }
      show(b, true); const sc = Math.max(0.7, Math.min(1, 6 / Math.max(d, 1)));
      const bw = (b.w || 200) * sc, bh = (b.h || 60) * sc;
      const cxp = Math.max(bw / 2 + 8, Math.min(w - bw / 2 - 8, sx)), cyp = Math.max(bh + 70, Math.min(h - 10, sy));
      const tf = `translate(${cxp.toFixed(1)}px, ${cyp.toFixed(1)}px) translate(-50%, -100%) scale(${sc.toFixed(2)})`, z = String(1000 - Math.round(d * 10));
      if (b.tf !== tf) { b.tf = tf; b.el.style.transform = tf; } if (b.z !== z) { b.z = z; b.el.style.zIndex = z; }
    });
    this.bubblesShown = Math.min(vis.length, MAXB);
    // name tag over the person you could talk to
    const tag = this.$('nameTag'), tg = this.ctx.nearPerson();
    if (tg && !this.target) {
      const o = tg.ref, hy = (o.y || 0) + (o.pose === 'sit' ? 1.35 : 1.95) * (o.look ? o.look.h : 1);
      const cx = vp[0] * o.x + vp[4] * hy + vp[8] * o.z + vp[12], cy = vp[1] * o.x + vp[5] * hy + vp[9] * o.z + vp[13], cw = vp[3] * o.x + vp[7] * hy + vp[11] * o.z + vp[15];
      if (cw > 0.1 && !this.bubbles.some(b => b.who === o)) {
        tag.hidden = false; const per = tg.kind === 'npc' ? this.persona(o) : null;
        tag.querySelector('.tn').textContent = per ? per.name : o.name; tag.querySelector('.tt').textContent = per ? per.title : 'Here live';
        tag.style.transform = `translate(${((cx / cw * 0.5 + 0.5) * w).toFixed(1)}px, ${((1 - (cy / cw * 0.5 + 0.5)) * h).toFixed(1)}px) translate(-50%, -100%)`;
      } else tag.hidden = true;
    } else tag.hidden = true;
  }

  // ----- drawing real people
  drawPeers(R, I) { for (const P of this.peers.values()) drawPerson(R, I, P); }
  bodies() { return this.peers.size ? [...this.peers.values()] : []; }
}
