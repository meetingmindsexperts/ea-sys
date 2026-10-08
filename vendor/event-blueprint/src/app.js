// ---------- Event Blueprint app ----------
(function () {
  const $ = (id) => document.getElementById(id);
  const rid = () => 'bp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k]; if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const blank = () => ({
    v: 2, id: rid(), path: null, type: null, typeOther: '', format: null,
    basics: { title: '', host: '', purpose: '', when: '', duration: '', location: '', attendance: '', audience: '', languages: [], budget: '', success: '', food: [] },
    concept: { goals: [], bigIdea: '', feeling: '', signature: '', mood: [], mustHave: '', avoid: '', refs: '', options: null, chosen: null },
    spaces: [], programme: { rows: [], agendaLink: '' },
    people: { hosts: [], segments: [], staff: '' },
    avatars: { style: '', dress: [], mix: '', mixNote: '', lanyards: [], own: '', likeness: '', abilities: [], prefilled: false },
    partners: { has: null, regulated: '', list: [], artwork: null },
    look: { brand: null, brandLink: '', style: [], palette: '', venueKind: null, venueName: '', plans: null, photos: null, dims: '', setting: '', scale: '' },
    online: { features: [], access: '', devices: [], a11y: [], extra: '' },
    delivery: { deadline: '', owner: '', approver: '', registration: '', video: '', privacy: '', notes: '' },
    files: { drive: '', have: [], recordings: '', rights: null, uploads: [] },
    sketch: { rooms: {} }, checkAck: {}, packApplied: null, owners: {},
    notes: '',
    status: 'draft', ref: '', submissions: [], statusLog: [], approvals: { plan: null, preview: null }, baseline: null,
    created: Date.now(), updated: Date.now(),
  });
  const STATUSES = [
    ['draft', 'Draft', 'Being filled in. Nothing has been sent yet.'],
    ['submitted', 'Submitted', 'Received. Waiting for the build team to pick it up.'],
    ['in_review', 'In review', 'The build team is checking it and will list anything missing in one message.'],
    ['plan_ready', 'Plan ready', 'A plan is ready and needs your approval before anything is built.'],
    ['building', 'Building', 'Your plan is approved and the build is under way.'],
    ['preview', 'Preview', 'A private preview is ready for you to walk through and approve.'],
    ['live', 'Live', 'Published.'],
  ];
  const stIdx = (s) => STATUSES.findIndex(x => x[0] === s);

  let S = null, step = 0, ackView = null, aiOff = false;
  const get = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), S);
  const setQuiet = (p, v) => { const ks = p.split('.'), last = ks.pop(); const o = ks.reduce((o, k) => o[k], S); o[last] = v; };
  const set = (p, v) => { setQuiet(p, v); changed(); };
  const typeOf = () => TYPES.find(t => t.id === S.type) || null;
  const ex = (k) => 'e.g. ' + ((EXAMPLES[S && S.type] || EXAMPLES._)[k] || EXAMPLES._[k]);
  const twin = () => S.path === 'twin' || S.path === 'both', fresh = () => S.path === 'new' || S.path === 'both';
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });


  // ---------- sanitising: everything loaded (saved blueprints, templates, hot reload) and every AI answer
  // passes through these, so a wrong type can never reach the page or the SVG sketch.
  const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = 4000) => (typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
  const num = (v, lo = -1e6, hi = 1e6) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const digits = (v) => str(v, 40).replace(/(\d),(?=\d{3})/g, '$1').replace(/[^\d.]/g, '').replace(/^(\d*\.?\d*).*$/, '$1');
  const strs = (v, allowed, max = 200) => Array.isArray(v) ? [...new Set(v.map(x => str(x, max)).filter(x => x && (!allowed || allowed.includes(x))))] : [];
  const rowsOf = (v, mk, limit = 500) => Array.isArray(v) ? v.filter(plain).slice(0, limit).map(mk) : [];
  const ROW = {
    space: (r) => ({ name: str(r.name, 120), purpose: str(r.purpose, 300), layout: LAYOUT_NAMES.includes(r.layout) ? r.layout : '', cap: digits(r.cap), area: digits(r.area) }),
    prog: (r) => ({ time: str(r.time, 40), title: str(r.title, 200), space: str(r.space, 120), who: str(r.who, 200) }),
    seg: (r) => ({ label: str(r.label, 120), pct: digits(r.pct) }),
    host: (r) => ({ name: str(r.name, 120), role: str(r.role, 120), consent: str(r.consent, 40) }),
    lanyard: (r) => ({ role: str(r.role, 80), colour: str(r.colour, 30) }),
    partner: (r) => ({ name: str(r.name, 120), tier: str(r.tier, 40), notes: str(r.notes, 300) }),
    upload: (r) => ({ id: str(r.id, 80).replace(/[^\w-]/g, ''), name: str(r.name, 120), size: num(r.size, 0, 1e10) || 0, type: str(r.type, 100), cat: UPLOAD_CATS.includes(r.cat) ? r.cat : 'Other', at: num(r.at, 0, 1e14) || 0 }),
    concept: (c) => ({ name: str(c.name, 120), bigIdea: str(c.bigIdea, 800), feeling: str(c.feeling, 200), signature: str(c.signature, 300), online: str(c.online, 600), mood: strs(c.mood, null, 40).slice(0, 8),
      spaces: rowsOf(c.spaces, ROW.space, 20), programme: rowsOf(c.programme, ROW.prog, 30) }),
  };
  const scalar = (v) => (typeof v === 'string' ? str(v, 200) : typeof v === 'number' && isFinite(v) ? v : typeof v === 'boolean' ? v : null);
  function sanitise(bp) {
    const b = blank(), x = plain(bp) ? bp : {};
    const sec = (k) => plain(x[k]) ? x[k] : {};
    const flat = (tmpl, src) => { const o = {}; for (const k in tmpl) { const t = tmpl[k], v = src[k]; o[k] = Array.isArray(t) ? strs(v) : typeof t === 'string' ? str(v) : typeof t === 'boolean' ? !!v : t === null ? scalar(v) : t; } return o; };
    const s = { ...b };
    s.v = 2; s.id = str(x.id, 60).replace(/[^\w-]/g, '') || b.id;
    for (const k of ['path', 'type', 'format', 'packApplied']) s[k] = scalar(x[k]) == null ? null : str(x[k], 60);
    s.typeOther = str(x.typeOther, 200); s.notes = str(x.notes, 20000); s.ref = str(x.ref, 40);
    s.status = STATUSES.some(st => st[0] === x.status) ? x.status : 'draft';
    s.created = num(x.created, 0, 1e14) || Date.now(); s.updated = num(x.updated, 0, 1e14) || Date.now();
    s.basics = flat(b.basics, sec('basics')); s.basics.food = strs(sec('basics').food, FOOD);
    const c = sec('concept'); s.concept = flat(b.concept, c); s.concept.options = Array.isArray(c.options) ? rowsOf(c.options, ROW.concept, 3) : null; s.concept.chosen = num(c.chosen, 0, 2);
    if (s.concept.options && !s.concept.options.length) s.concept.options = null;
    s.spaces = rowsOf(x.spaces, ROW.space, 200);
    const pr = sec('programme'); s.programme = { rows: rowsOf(pr.rows, ROW.prog, 300), agendaLink: str(pr.agendaLink, 600) };
    const pe = sec('people'); s.people = { hosts: rowsOf(pe.hosts, ROW.host), segments: rowsOf(pe.segments, ROW.seg, 30), staff: str(pe.staff) };
    const av = sec('avatars'); s.avatars = flat(b.avatars, av); s.avatars.lanyards = rowsOf(av.lanyards, ROW.lanyard, 30);
    const pa = sec('partners'); s.partners = flat(b.partners, pa); s.partners.list = rowsOf(pa.list, ROW.partner, 1000);
    s.look = flat(b.look, sec('look')); s.online = flat(b.online, sec('online')); s.delivery = flat(b.delivery, sec('delivery'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.delivery.deadline)) s.delivery.deadline = '';
    const fi = sec('files'); s.files = flat(b.files, fi); s.files.uploads = rowsOf(fi.uploads, ROW.upload, 200);
    const sk = plain(x.sketch) && plain(x.sketch.rooms) ? x.sketch.rooms : {}; s.sketch = { rooms: {} };
    for (const k of Object.keys(sk).slice(0, 300)) { const r = sk[k]; if (!plain(r)) continue; const o = {}; const xx = num(r.x, 0, 5000), yy = num(r.y, 0, 5000), as = num(r.aspect, 0.2, 5); if (xx != null) o.x = xx; if (yy != null) o.y = yy; if (as != null) o.aspect = as; if (r.rot === true) o.rot = true; s.sketch.rooms[str(k, 140)] = o; }
    const ack = plain(x.checkAck) ? x.checkAck : {}; s.checkAck = {};
    for (const k of Object.keys(ack).slice(0, 300)) { const a = ack[k]; s.checkAck[str(k, 200)] = plain(a) ? { at: num(a.at, 0, 1e14) || 0, lvl: str(a.lvl, 10), sig: str(a.sig, 200) } : { at: num(a, 0, 1e14) || 0, lvl: '', sig: '' }; }
    const ow = plain(x.owners) ? x.owners : {}; s.owners = {};
    for (const sc of SECTIONS) { const o = ow[sc.id]; if (!plain(o)) continue; const name = str(o.name, 80).trim(), email = str(o.email, 120).trim(); if (name || email) s.owners[sc.id] = { name, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '' }; }
    const ap = sec('approvals'); s.approvals = { plan: num(ap.plan, 0, 1e14), preview: num(ap.preview, 0, 1e14) };
    s.submissions = rowsOf(x.submissions, (r) => ({ kind: r.kind === 'update' ? 'update' : 'submission', n: num(r.n, 0, 1e4) || 0, at: num(r.at, 0, 1e14) || 0, readiness: num(r.readiness, 0, 100), count: num(r.count, 0, 1e4), open: strs(r.open), changes: strs(r.changes, null, 400) }), 200);
    s.statusLog = rowsOf(x.statusLog, (r) => ({ status: str(r.status, 40), at: num(r.at, 0, 1e14) || 0 }), 400);
    s.baseline = plain(x.baseline) ? (() => { const bl = sanitise({ ...x.baseline, baseline: null }); delete bl.baseline; delete bl.submissions; delete bl.statusLog; delete bl.approvals; delete bl.status; delete bl.ref; return bl; })() : null;
    return s;
  }

  // ---------- readiness ----------
  function checks(s) {
    const tw = s.path === 'twin' || s.path === 'both', fr = s.path === 'new' || s.path === 'both', c = [];
    const add = (sec, label, ok, lvl = 'block') => c.push({ sec, label, ok: !!ok, lvl });
    add('start', 'Choose a path', s.path); add('start', 'Choose an event type', s.type && (s.type !== 'other' || s.typeOther.trim())); add('start', 'Choose a format', s.format);
    const b = s.basics;
    add('basics', 'Working title', b.title.trim()); add('basics', 'Purpose in one sentence', b.purpose.trim().length >= 12); add('basics', 'Who it is for', b.audience.trim());
    add('basics', 'When it happens', b.when.trim(), tw ? 'block' : 'nice'); add('basics', 'Expected attendance', b.attendance.trim());
    add('basics', 'Where', b.location.trim(), tw ? 'block' : 'nice'); add('basics', 'Languages', b.languages.length, 'nice'); add('basics', 'Budget range', b.budget.trim(), 'nice'); add('basics', 'How success is measured', b.success.trim(), 'nice');
    const k = s.concept;
    add('concept', 'At least one goal', k.goals.length, fr ? 'block' : 'nice'); add('concept', 'The big idea', k.bigIdea.trim().length >= 15, fr ? 'block' : 'nice');
    add('concept', 'Mood (two or more words)', k.mood.length >= 2, fr ? 'block' : 'nice'); add('concept', 'Signature moment', k.signature.trim(), 'nice');
    add('concept', 'Must-haves', k.mustHave.trim(), 'nice'); add('concept', 'Things to avoid', k.avoid.trim(), 'nice');
    const sp = s.spaces.filter(r => r.name.trim());
    add('spaces', 'At least three spaces', sp.length >= 3); add('spaces', 'Capacity for each space', sp.length && sp.every(r => String(r.cap).trim()), 'nice');
    add('programme', 'Programme: three or more items, or an agenda link', s.programme.rows.filter(r => r.title.trim()).length >= 3 || /^https?:\/\//.test(s.programme.agendaLink.trim()));
    add('people', 'Audience mix (two or more groups)', s.people.segments.filter(r => r.label.trim()).length >= 2, 'nice');
    add('people', 'Consent recorded for every named person', s.people.hosts.filter(r => r.name.trim()).every(r => r.consent && r.consent !== 'Not yet'));
    const av = s.avatars, needAv = s.format === 'Online world only' || s.online.features.some(f => ['Walk the venue in 3D', 'Meet real attendees as avatars', 'Talk to AI attendees'].includes(f)) ? 'block' : 'nice';
    add('avatars', 'Avatar style', av.style, needAv); add('avatars', 'How guests get their avatar', av.own, needAv); add('avatars', 'Rule for showing real people', av.likeness, needAv);
    add('avatars', 'What avatars can do (three or more)', av.abilities.length >= 3, needAv); add('avatars', 'Dress code', av.dress.length, 'nice'); add('avatars', 'Badge colours by role', av.lanyards.filter(r => r.role.trim()).length, 'nice');
    add('partners', 'Partners: yes or no', s.partners.has);
    if (s.partners.has === 'yes') { add('partners', 'Partner list with tiers', s.partners.list.filter(r => r.name.trim()).length); add('partners', 'Regulated industry checked', s.partners.regulated); add('partners', 'Artwork status', s.partners.artwork, 'nice'); }
    const L = s.look, brandUp = s.files.uploads.some(u => u.cat === 'Brand');
    add('look', 'Brand guidelines, or a chosen style', L.brand === 'yes' ? /^https?:\/\//.test(L.brandLink.trim()) || s.files.have.includes('06_Brand') || brandUp : L.style.length >= 2);
    add('look', 'Venue: real or imagined', L.venueKind);
    const venueUp = s.files.uploads.some(u => u.cat === 'Venue');
    if (L.venueKind === 'real') { add('look', 'Venue name', L.venueName.trim()); add('look', 'Floor plans available', L.plans === 'yes', tw ? 'block' : 'nice'); add('look', 'Photos of the spaces', L.photos === 'yes' || venueUp, tw ? 'block' : 'nice'); }
    if (L.venueKind === 'imagined') { add('look', 'Setting', L.setting); add('look', 'Scale', L.scale, 'nice'); }
    const o = s.online;
    add('online', 'What people can do online (two or more)', o.features.length >= 2); add('online', 'How people get in', o.access);
    add('online', 'Devices', o.devices.length, 'nice'); add('online', 'Accessibility needs', o.a11y.length, 'nice');
    const d = s.delivery;
    add('delivery', 'Deadline', d.deadline.trim()); add('delivery', 'Owner on your side', d.owner.trim()); add('delivery', 'Who approves', d.approver.trim(), 'nice'); add('delivery', 'Privacy and consent approach', d.privacy, 'nice');
    const f = s.files;
    add('files', 'Shared folder link or uploaded files', /^https?:\/\//.test(f.drive.trim()) || f.uploads.length >= 1, tw ? 'block' : 'nice');
    if (tw) { add('files', 'Recordings status', f.recordings); add('files', 'Rights to use recordings and music', f.rights === 'yes', f.recordings && f.recordings !== 'None' && f.recordings !== 'Not applicable' ? 'block' : 'nice'); }
    return c;
  }
  function score(s) {
    const c = checks(s); let tot = 0, got = 0; const sec = {};
    for (const x of c) { const w = x.lvl === 'block' ? 3 : 1; tot += w; if (x.ok) got += w; const st = sec[x.sec] || (sec[x.sec] = 'g'); if (!x.ok) sec[x.sec] = x.lvl === 'block' ? 'r' : (st === 'r' ? 'r' : 'a'); }
    return { pct: Math.round(got / Math.max(tot, 1) * 100), sec, c, blocking: c.filter(x => !x.ok && x.lvl === 'block'), nice: c.filter(x => !x.ok && x.lvl === 'nice') };
  }

  // ---------- changes since the last submission ----------
  const FIELDS = [['start', 'path', 'Starting point'], ['start', 'type', 'Event type'], ['start', 'typeOther', 'Event type description'], ['start', 'format', 'Format'],
    ...['title:Title', 'host:Host', 'purpose:Purpose', 'when:When', 'duration:Duration', 'location:Where', 'attendance:Attendance', 'audience:Audience', 'languages:Languages', 'budget:Budget', 'success:Success measures', 'food:Food and drink'].map(x => ['basics', 'basics.' + x.split(':')[0], x.split(':')[1]]),
    ...['goals:Goals', 'bigIdea:Big idea', 'feeling:Feeling', 'signature:Signature moment', 'mood:Mood', 'mustHave:Must-haves', 'avoid:Things to avoid', 'refs:References'].map(x => ['concept', 'concept.' + x.split(':')[0], x.split(':')[1]]),
    ['programme', 'programme.agendaLink', 'Agenda link'], ['people', 'people.staff', 'Staff'],
    ...['style:Avatar style', 'dress:Dress code', 'mix:Crowd mix', 'mixNote:Crowd notes', 'own:Guest avatars', 'likeness:Showing real people', 'abilities:Avatar abilities'].map(x => ['avatars', 'avatars.' + x.split(':')[0], x.split(':')[1]]),
    ['partners', 'partners.has', 'Partners'], ['partners', 'partners.regulated', 'Regulated industry'], ['partners', 'partners.artwork', 'Artwork status'],
    ...['brand:Brand guidelines', 'brandLink:Brand files', 'style:Style', 'palette:Colours', 'venueKind:Venue type', 'venueName:Venue', 'plans:Floor plans', 'photos:Photos', 'dims:Dimensions', 'setting:Setting', 'scale:Scale'].map(x => ['look', 'look.' + x.split(':')[0], x.split(':')[1]]),
    ...['features:Online features', 'access:Access', 'devices:Devices', 'a11y:Accessibility', 'extra:Online notes'].map(x => ['online', 'online.' + x.split(':')[0], x.split(':')[1]]),
    ...['deadline:Deadline', 'owner:Owner', 'approver:Approver', 'registration:Registration system', 'video:Video host', 'privacy:Privacy', 'notes:Notes for the build team'].map(x => ['delivery', 'delivery.' + x.split(':')[0], x.split(':')[1]]),
    ['files', 'files.drive', 'Shared folder'], ['files', 'files.have', 'Folders ready'], ['files', 'files.recordings', 'Recordings'], ['files', 'files.rights', 'Rights'], ['start', 'notes', 'Notes in your own words']];
  const ROWSETS = [['spaces', 'spaces', 'space', r => r.name, r => [r.purpose, r.layout, r.cap && r.cap + ' people', r.area && r.area + ' m²'].filter(Boolean).join(', ')], ['programme', 'programme.rows', 'programme item', r => [r.time, r.title].filter(Boolean).join(' '), r => [r.space, r.who].filter(Boolean).join(', ')],
    ['people', 'people.hosts', 'named person', r => r.name, r => [r.role, r.consent].filter(Boolean).join(', ')], ['people', 'people.segments', 'audience group', r => r.label, r => r.pct ? r.pct + '%' : ''],
    ['avatars', 'avatars.lanyards', 'badge colour', r => r.role, r => r.colour], ['partners', 'partners.list', 'partner', r => r.name, r => [r.tier, r.notes].filter(Boolean).join(', ')], ['files', 'files.uploads', 'file', r => r.name, r => r.cat]];
  const show = (v) => Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  const cut = (v, n = 60) => { v = show(v).replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
  function diffStates(a, b) {
    const out = [], pick = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
    for (const [sec, p, label] of FIELDS) { const va = pick(a, p), vb = pick(b, p);
      if (Array.isArray(va) || Array.isArray(vb)) { const A = Array.isArray(va) ? va : [], B = Array.isArray(vb) ? vb : [], add = B.filter(v => !A.includes(v)), rem = A.filter(v => !B.includes(v)); if (add.length || rem.length) out.push({ sec, text: `${label}: ` + [add.length ? 'added ' + add.join(', ') : '', rem.length ? 'removed ' + rem.join(', ') : ''].filter(Boolean).join('; ') }); continue; }
      const x = show(va), y = show(vb); if (x.trim() !== y.trim()) out.push({ sec, text: !x.trim() ? `${label}: added “${cut(y)}”` : !y.trim() ? `${label}: removed` : `${label}: “${cut(x, 40)}” → “${cut(y, 40)}”` }); }
    for (const sc of SECTIONS) { const oa = (a.owners || {})[sc.id], ob = (b.owners || {})[sc.id], na = oa ? oa.name || oa.email : '', nb = ob ? ob.name || ob.email : '', ea = oa ? oa.email || '' : '', eb = ob ? ob.email || '' : '';
      if (na !== nb) out.push({ sec: sc.id, text: !na ? `Owner of ${sc.n}: ${nb}` : !nb ? `Owner of ${sc.n}: removed (was ${na})` : `Owner of ${sc.n}: ${na} → ${nb}` });
      else if (na && ea !== eb) out.push({ sec: sc.id, text: `Owner of ${sc.n}: email ${!ea ? 'added, ' + eb : !eb ? 'removed' : ea + ' → ' + eb}` }); }
    for (const [sec, p, noun, key, desc] of ROWSETS) {
      const A = (pick(a, p) || []).filter(r => key(r)), B = (pick(b, p) || []).filter(r => key(r));
      const ma = new Map(A.map(r => [key(r).trim().toLowerCase(), r])), mb = new Map(B.map(r => [key(r).trim().toLowerCase(), r]));
      for (const [k, r] of mb) { if (!ma.has(k)) out.push({ sec, text: `Added ${noun}: ${cut(key(r))}${desc(r) ? ' (' + cut(desc(r), 40) + ')' : ''}` }); else if (desc(ma.get(k)) !== desc(r)) out.push({ sec, text: `Changed ${noun} ${cut(key(r), 30)}: ${cut(desc(ma.get(k)), 30) || 'blank'} → ${cut(desc(r), 30) || 'blank'}` }); }
      for (const [k, r] of ma) if (!mb.has(k)) out.push({ sec, text: `Removed ${noun}: ${cut(key(r))}` });
    }
    return out;
  }
  const snapshot = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.baseline; delete c.submissions; delete c.statusLog; delete c.approvals; delete c.status; delete c.ref; c.concept.options = null; return c; };
  const pending = () => S && S.baseline ? diffStates(S.baseline, S) : [];

  // ---------- persistence ----------
  let saveT = null, saving = false, dirty = false, saveState = '';
  function changed() { S.updated = Date.now(); dirty = true; localSave(); clearTimeout(saveT); saveT = setTimeout(remoteSave, 1000); setSave(Platform.mode === 'local' || !Platform.canWrite ? 'Saved on this device' : 'Saving…'); updateChrome(); refreshLive(); }
  function localSave() {
    try {
      localStorage.setItem('eb-cur', S.id); localStorage.setItem('eb-' + S.id, JSON.stringify(S));
      const list = JSON.parse(localStorage.getItem('eb-list') || '[]').filter(x => x.id !== S.id);
      list.unshift({ id: S.id, title: S.basics.title, type: S.type, updated: S.updated, status: S.status, readiness: score(S).pct }); localStorage.setItem('eb-list', JSON.stringify(list.slice(0, 50)));
    } catch (e) { }
  }
  async function remoteSave() {
    if (!S || !dirty || Platform.mode === 'local' || !Platform.canWrite) return;
    if (saving) { saveT = setTimeout(remoteSave, 700); return; }
    saving = true; dirty = false;
    const sc = score(S);
    try { await Platform.save({ ...JSON.parse(JSON.stringify(S)), ownerId: Platform.userId, title: S.basics.title || 'Untitled event', readiness: sc.pct, blocking: sc.blocking.length, pendingChanges: pending().length }); setSave('Saved'); }
    catch (e) { if (e && (e.code === 'invalid_argument' || e.code === 'local_only' || e.code === 'not_granted')) { Platform.canWrite = false; setSave('Saved on this device'); } else { dirty = true; setSave('Not saved yet. Retrying'); saveT = setTimeout(remoteSave, 4000); } }
    finally { saving = false; }
  }
  function setSave(t) { saveState = t; if (S) $('subTitle').textContent = (S.basics.title || 'Untitled event') + (t ? ' · ' + t : ''); $('subTitle').dataset.state = /Not saved/.test(t) ? 'bad' : 'ok'; }

  // ---------- chrome ----------
  function updateChrome() {
    if (!S) return;
    const sc = score(S), chg = new Set(pending().map(x => x.sec));
    $('ring').hidden = false; $('ringPct').textContent = sc.pct + '%'; $('ringArc').setAttribute('stroke-dashoffset', String(113.1 * (1 - sc.pct / 100)));
    $('subTitle').textContent = (S.basics.title || 'Untitled event') + (saveState ? ' · ' + saveState : '');
    for (const el of document.querySelectorAll('[data-dot]')) { const id = el.dataset.dot, s = sc.sec[id]; el.className = 'dot ' + (id === 'review' ? (sc.blocking.length ? 'r' : sc.nice.length ? 'a' : 'g') : (s || 'g')) + (chg.has(id) ? ' chg' : ''); }
    renderStatusBar(); renderSide(sc);
  }
  function renderNav() {
    const st = $('steps'), rail = $('rail'); st.innerHTML = ''; rail.innerHTML = '';
    SECTIONS.forEach((s, i) => {
      const go = () => goto(i), cur = i === step && !ackView ? 'step' : null;
      const o = ownerOf(s.id), badge = o ? h('span', { class: 'oav', title: 'Owner: ' + (o.name || o.email), text: initials(o.name || o.email) }) : null;
      st.append(h('button', { class: 'step', 'aria-current': cur, onclick: go, 'aria-label': s.n + (o ? ', owner ' + (o.name || o.email) : '') }, h('span', { class: 'dot', 'data-dot': s.id }), s.n, badge));
      rail.append(h('button', { 'aria-current': cur, onclick: go, 'aria-label': s.n + (o ? ', owner ' + (o.name || o.email) : '') }, h('span', { class: 'n', text: String(i + 1).padStart(2, '0') }), h('span', { class: 'dot', 'data-dot': s.id }), s.n, o ? h('span', { class: 'oav', text: initials(o.name || o.email) }) : null));
    });
    const cur = st.children[step]; if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    $('where').textContent = `${step + 1} of ${SECTIONS.length}`;
    $('prevBtn').style.visibility = step === 0 ? 'hidden' : 'visible';
    $('nextBtn').textContent = step === SECTIONS.length - 2 ? 'Review and submit' : step === SECTIONS.length - 1 ? 'All blueprints' : 'Next';
  }
  function renderStatusBar() {
    const bar = $('statusBar'); if (!S || S.status === 'draft' && !S.baseline) { bar.hidden = true; return; }
    const st = STATUSES[Math.max(0, stIdx(S.status))], n = pending().length;
    bar.hidden = false; bar.innerHTML = '';
    bar.append(h('button', { class: 'sbar', onclick: () => goto(SECTIONS.length - 1) },
      h('span', { class: 'pill s-' + S.status, text: st[1] }), h('span', { class: 'mono', text: S.ref }),
      h('span', { class: 'sbtext', text: n ? `${n} change${n > 1 ? 's' : ''} not sent yet` : st[2] }),
      n ? h('span', { class: 'tag a', text: 'send update' }) : null));
  }
  function renderSide(sc) {
    const side = $('side'); side.innerHTML = ''; if (SECTIONS[step].id === 'review' || ackView) return;
    const top = sc.blocking.slice(0, 6), n = pending().length;
    side.append(h('div', { class: 'ready' },
      h('div', { class: 'eyebrow', text: 'Readiness' }), h('div', { class: 'big', text: sc.pct + '%' }), h('div', { class: 'bar' }, h('i', { style: `width:${sc.pct}%` })),
      h('div', { class: 'note', text: sc.blocking.length ? `${sc.blocking.length} item${sc.blocking.length > 1 ? 's' : ''} needed before building` : sc.nice.length ? 'Ready to submit. Optional items would add detail.' : 'Complete. Ready to submit.' }),
      top.length ? h('ul', { class: 'missing' }, top.map(x => h('li', null, h('span', { class: 'tag r', text: 'need' }), h('button', { onclick: () => goto(SECTIONS.findIndex(s => s.id === x.sec)), text: x.label })))) : null,
      n ? h('button', { class: 'secondary', text: `Send ${n} change${n > 1 ? 's' : ''}`, onclick: () => goto(SECTIONS.length - 1) }) : null,
      (() => { const rc = realityChecks(S).filter(c => c.lvl !== 'info' && !isAck(S, c)); return rc.length ? h('div', { class: 'sidechk' }, h('div', { class: 'eyebrow', text: 'Reality checks' }), h('ul', { class: 'missing' }, rc.slice(0, 4).map(c => h('li', null, h('span', { class: 'tag ' + LVL[c.lvl][1], text: LVL[c.lvl][0] }), h('button', { onclick: () => goto(SECTIONS.findIndex(s => s.id === c.sec)), text: c.title }))))) : null; })()));
  }

  // ---------- controls ----------
  let fieldN = 0;
  const linkLabel = (ctrl, id) => { if (!ctrl || !ctrl.nodeType) return; const single = ctrl.matches('input,textarea,select') ? ctrl : ctrl.matches('.rows') && ctrl.querySelectorAll('input,textarea,select').length === 1 ? ctrl.querySelector('input,textarea,select') : null; if (single) single.setAttribute('aria-labelledby', id); else if (ctrl.matches('.chips,.types,.cards,.rows,.sketch,div')) { if (!ctrl.getAttribute('role')) ctrl.setAttribute('role', 'group'); ctrl.setAttribute('aria-labelledby', id); } };
  const field = (label, ctrl, o = {}) => { const id = 'lab' + (++fieldN); linkLabel(ctrl, id); return h('div', { class: 'f' }, h('div', { class: 'lab', id }, label, o.need ? h('span', { class: 'req need', text: 'Needed' }) : o.opt ? h('span', { class: 'req', text: 'Optional' }) : null), o.help ? h('div', { class: 'help', text: o.help }) : null, ctrl); };
  const text = (p, ph, type = 'text') => { const el = h('input', { type, value: get(p) || '', placeholder: ph || '', id: 'f_' + p.replace(/\./g, '_') }); el.addEventListener('input', () => set(p, el.value)); return el; };
  const area = (p, ph, rows = 3) => { const el = h('textarea', { rows, placeholder: ph || '', id: 'f_' + p.replace(/\./g, '_') }); el.value = get(p) || ''; el.addEventListener('input', () => set(p, el.value)); return el; };
  function chips(p, opts, multi, after) {
    const wrap = h('div', { class: 'chips', role: multi ? 'group' : 'radiogroup' });
    const draw = () => { wrap.innerHTML = ''; const v = get(p); for (const o of opts) { const [val, lab] = Array.isArray(o) ? o : [o, o]; const on = multi ? v.includes(val) : v === val;
      wrap.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onclick: () => { const cur = get(p); if (multi) set(p, on ? cur.filter(x => x !== val) : [...cur, val]); else set(p, on ? (typeof cur === 'string' ? '' : null) : val); draw(); after && after(); } }, lab)); } };
    draw(); return wrap;
  }
  const tri = (p, after) => chips(p, [['yes', 'Yes'], ['no', 'No'], ['notyet', 'Not yet']], false, after);
  function rows(p, cols, addLabel, mk) {
    const wrap = h('div', { class: 'rows' }), tmpl = cols.map(c => c.w || '1fr').join(' ') + ' 42px';
    const draw = () => {
      wrap.innerHTML = '';
      const list = get(p);
      if (list.length) wrap.append(h('div', { class: 'rowhead', style: `--cols:${tmpl}` }, cols.map(c => h('span', { text: c.label })), h('span')));
      list.forEach((r, i) => {
        const row = h('div', { class: 'row', style: `--cols:${tmpl}` });
        for (const c of cols) {
          let el;
          if (c.opts) { el = h('select', { 'aria-label': c.label }); for (const o of (typeof c.opts === 'function' ? c.opts() : c.opts)) el.append(h('option', { value: o, text: o || c.ph || 'Choose' })); if (r[c.k] && ![...el.options].some(o => o.value === r[c.k])) el.append(h('option', { value: r[c.k], text: r[c.k] })); el.value = r[c.k] || ''; el.addEventListener('change', () => { r[c.k] = el.value; changed(); }); }
          else { el = h('input', { type: c.type || 'text', value: r[c.k] ?? '', placeholder: c.ph || c.label, 'aria-label': c.label, inputmode: c.num ? 'numeric' : null }); el.addEventListener('input', () => { r[c.k] = c.num ? el.value.replace(/[^\d.]/g, '') : el.value; changed(); if (c.onInput) c.onInput(); }); }
          row.append(el);
        }
        row.append(h('button', { type: 'button', class: 'del', 'aria-label': 'Remove row', text: '×', onclick: () => { list.splice(i, 1); changed(); draw(); } }));
        wrap.append(row);
      });
      wrap.append(h('button', { type: 'button', class: 'addrow', text: '+ ' + addLabel, onclick: () => { list.push(mk()); changed(); draw(); const ins = wrap.querySelectorAll('.row'); const last = ins[ins.length - 1]; last && last.querySelector('input,select').focus(); } }));
    };
    draw(); return wrap;
  }

  // ---------- AI ----------
  function aiNote(el, e) {
    const code = e && e.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) { aiOff = true; el.textContent = 'AI suggestions are switched off here. The templates still work.'; }
    else if (code === 'rate_limited') el.textContent = 'The AI is busy right now. Try again in a minute.';
    else if (code === 'cancelled') el.textContent = '';
    else if (code === 'invalid_json') el.textContent = 'The answer came back in the wrong shape. Try again.';
    else el.textContent = 'That didn’t work. Try again.';
    el.classList.add('err');
  }
  const aiOn = () => Platform.aiReady && !aiOff;
  const briefObj = () => JSON.parse(briefFor());
  const briefFor = () => JSON.stringify({ path: S.path, type: (typeOf() || {}).n || S.typeOther, typeOther: S.typeOther, format: S.format, basics: S.basics, concept: { goals: S.concept.goals, bigIdea: S.concept.bigIdea, feeling: S.concept.feeling, mood: S.concept.mood, mustHave: S.concept.mustHave, avoid: S.concept.avoid, signature: S.concept.signature }, spaces: S.spaces, venue: { kind: S.look.venueKind, name: S.look.venueName, setting: S.look.setting, scale: S.look.scale }, notes: S.notes.slice(-1500) }).slice(0, 7000);
  const RULES = 'Use roles ("keynote speaker", "headline act", "host") instead of names. Never invent real people, sponsors, brands or venues. Keep it feasible for the format, budget and audience given, and true to this kind of event.';
  // EA-SYS: `req` is { task, input, prompt }; see Platform.aiJSON.
  async function ask(req, note, btn, tier = 'quick') {
    if (!aiOn()) return null;
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Thinking…'; note.textContent = ''; note.classList.remove('err');
    try { return await Platform.aiJSON(req, { tier }); }
    catch (e) { aiNote(note, e); return null; }
    finally { btn.disabled = false; btn.textContent = old; }
  }
  const aiBtn = (label, fn) => aiOn() ? h('button', { type: 'button', class: 'assist', text: label, onclick: fn }) : null;


  // ---------- Stage 3: reality checks, planning numbers, layout sketch, starter packs ----------
  const LVL = { risk: ['Unrealistic', 'r'], watch: ['Check', 'a'], info: ['Plan for', 'i'] };
  // an acceptance holds only while the check says exactly what you accepted; if the numbers change it asks again
  const isAck = (s, c) => { const a = s.checkAck[c.id]; return !!a && a.sig === c.sig; };
  const LIVE_SECS = ['basics', 'spaces', 'programme', 'people', 'partners', 'online', 'delivery'];
  function srcLinks(keys) { return keys && keys.length ? h('div', { class: 'src' }, 'Source: ', keys.map((k, i) => [i ? '; ' : '', h('a', { href: SRC[k][1], target: '_blank', rel: 'noopener', text: SRC[k][0] })])) : null; }
  function checkItem(c, acked) {
    const secIdx = SECTIONS.findIndex(x => x.id === c.sec), here = SECTIONS[step] && SECTIONS[step].id === c.sec;
    return h('div', { class: 'rc ' + c.lvl + (acked ? ' acked' : ''), 'data-check': c.id },
      h('div', { class: 'rct' }, h('span', { class: 'tag ' + LVL[c.lvl][1], text: LVL[c.lvl][0] }), h('span', { class: 'st', text: c.title })),
      !acked && S.checkAck[c.id] && c.lvl !== 'info' ? h('div', { class: 'sm reopen', text: 'Asked again: this changed since you accepted it.' }) : null,
      h('div', { class: 'sm', text: c.detail }),
      c.fix ? h('div', { class: 'fix' }, h('b', { text: 'Suggestion: ' }), c.fix) : null,
      srcLinks(c.src),
      h('div', { class: 'rca' },
        c.lvl !== 'info' ? (acked ? h('button', { type: 'button', class: 'ghostbtn', text: 'Undo', onclick: () => { delete S.checkAck[c.id]; changed(); refreshLive(true); } })
          : h('button', { type: 'button', class: 'ghostbtn', text: 'Accept as is', onclick: () => { S.checkAck[c.id] = { at: Date.now(), lvl: c.lvl, sig: c.sig }; changed(); refreshLive(true); } })) : null,
        !here && secIdx >= 0 ? h('button', { type: 'button', class: 'ghostbtn', text: 'Go to ' + SECTIONS[secIdx].n, onclick: () => goto(secIdx) }) : null));
  }
  function realityBox(secs, empty) {
    const list = realityChecks(S).filter(c => !secs || secs.includes(c.sec)), box = h('div', { class: 'reality' });
    if (!list.length) { if (empty) box.append(h('p', { class: 'note', text: empty })); else box.hidden = true; return box; }
    const open = list.filter(c => c.lvl === 'info' || !isAck(S, c)), done = list.filter(c => c.lvl !== 'info' && isAck(S, c));
    const nOpen = open.filter(c => c.lvl !== 'info').length;
    box.append(h('div', { class: 'rhead' }, h('span', { class: 'eyebrow', text: 'Reality check' }), h('span', { class: 'note', text: nOpen ? `${nOpen} to look at · you decide` : open.length ? 'For your planning' : 'All accepted' })));
    for (const c of open) box.append(checkItem(c, false));
    if (done.length) box.append(h('details', { class: 'accepted' }, h('summary', { text: `${done.length} accepted as is` }), done.map(c => checkItem(c, true))));
    return box;
  }
  function planBox(filter) {
    const pn = planNumbers(S), list = pn.list.filter(n => !filter || filter(n)), box = h('div', { class: 'plannums' });
    if (!list.length) { box.append(h('p', { class: 'note', text: 'Add expected attendance, spaces with a layout, and food service to see numbers here.' })); return box; }
    for (const n of list) box.append(h('div', { class: 'pn' }, h('div', { class: 'pv mono', text: n.value }), h('div', null, h('div', { class: 'st', text: n.label }), h('div', { class: 'sm', text: n.note }), srcLinks(n.src))));
    return box;
  }
  function attReadback() {
    const a = parseAttendance(S.basics.attendance, S.format), parts = [];
    if (a.inPerson) parts.push(`${a.inPerson.toLocaleString('en-GB')} in person`); if (a.online) parts.push(`${a.online.toLocaleString('en-GB')} online`);
    return parts.length ? `We read this as ${parts.join(' and ')}.` : S.basics.attendance.trim() ? 'Add a number so we can check rooms and staffing, e.g. 400 + 3,000 online.' : '';
  }
  let liveT = null;
  function refreshLive(now) {
    clearTimeout(liveT);
    const run = () => {
      for (const el of document.querySelectorAll('[data-live]')) {
        const k = el.dataset.live;
        if (k.startsWith('reality:')) { el.classList.add('reality'); const secs = k.slice(8) === '*' ? null : k.slice(8).split(','); const sig = JSON.stringify([realityChecks(S).filter(c => !secs || secs.includes(c.sec)), S.checkAck, step]); if (sketchSig.get(el) === sig) continue; sketchSig.set(el, sig); const nb = realityBox(secs, el.dataset.empty || ''); el.replaceChildren(...nb.childNodes); el.hidden = nb.hidden; }
        else if (k === 'plan') { const sig = JSON.stringify(planNumbers(S).list); if (sketchSig.get(el) === sig) continue; sketchSig.set(el, sig); el.classList.add('plannums'); el.replaceChildren(...planBox().childNodes); }
        else if (k === 'plan:spaces') { el.classList.add('plannums'); const nb = planBox(n => n.k.startsWith('area:')); el.hidden = !nb.querySelector('.pn'); el.replaceChildren(...nb.childNodes); }
        else if (k === 'att') el.textContent = attReadback();
        else if (k === 'when') el.textContent = describeWhen(S.basics.when);
        else if (k === 'sketch' && !dragging) { if (now) sketchNow(el); else sketchLater(el); }
      }
    };
    if (now) run(); else liveT = setTimeout(run, 250);
  }
  // The sketch can hold thousands of shapes (a big expo), so while someone types it redraws only after a pause,
  // and only when it is on screen; an off-screen sketch catches up the moment it scrolls into view.
  let skT = null; const skIO = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { for (const e of es) { const t = e.target; if (!t.isConnected) { skIO.unobserve(t); continue; } if (!t._skFirst) { t._skFirst = true; continue; } if (e.isIntersecting) sketchNow(t); } }) : null;
  function sketchNow(el) { if (dragging || !el.isConnected) return; const sig = sketchSigOf(S) + skSel + arrange; if (sketchSig.get(el) !== sig) { sketchSig.set(el, sig); drawSketch(el); sketchDraws++; } }
  function sketchLater(el) {
    clearTimeout(skT); if (skIO && !el._skObs) { skIO.observe(el); el._skObs = true; }
    skT = setTimeout(() => { const r = el.getBoundingClientRect(); if (r.bottom > -200 && r.top < innerHeight + 200) sketchNow(el); }, 800);
  }
  let sketchDraws = 0;
  const live = (k, extra = {}) => { const el = h('div', { 'data-live': k, ...extra }); return el; };
  // ----- sketch
  let skSel = null, arrange = false, dragging = false; const sketchSig = new WeakMap();
  function drawSketch(wrap) {
    wrap.innerHTML = '';
    if (!S.spaces.some(r => r.name.trim())) { wrap.append(h('p', { class: 'note', text: 'Add spaces and the sketch draws itself, to scale.' })); return; }
    const model = sketchModel(S), holder = h('div', { class: 'skwrap' + (arrange ? ' arranging' : '') });
    holder.innerHTML = sketchSVG(model, { selected: skSel }); wrap.append(holder);
    const r = model.rooms.find(x => x.key === skSel), b = (t, fn, cls = 'ghostbtn') => h('button', { type: 'button', class: cls, text: t, onclick: fn });
    const save = (room, patch) => { S.sketch.rooms[room.key] = { ...(S.sketch.rooms[room.key] || {}), ...patch }; changed(); drawSketch(wrap); };
    const aspectOf = (room) => room.sv.aspect || (room.L ? room.L.aspect : 1.4);
    const shorts = model.rooms.filter(x => x.short);
    wrap.append(h('div', { class: 'sktools' },
      r ? h('div', { class: 'skrow' }, h('span', { class: 'st', text: r.name }), b('Rotate', () => save(r, { rot: !r.sv.rot })), b('Wider', () => save(r, { aspect: Math.min(4, aspectOf(r) * 1.25) })), b('Deeper', () => save(r, { aspect: Math.max(0.25, aspectOf(r) / 1.25) })), b('Reset room', () => { delete S.sketch.rooms[r.key]; changed(); drawSketch(wrap); }), b('Done', () => { skSel = null; drawSketch(wrap); }))
        : h('div', { class: 'sm', text: arrange ? 'Drag rooms into place. Tap a room to rotate or reshape it.' : 'Tap a room to rotate or reshape it. Use “Arrange rooms” to drag them on a phone.' }),
      h('div', { class: 'skrow' }, b(arrange ? 'Done arranging' : 'Arrange rooms', () => { arrange = !arrange; drawSketch(wrap); }, arrange ? 'secondary' : 'ghostbtn'),
        b('Tidy up', () => { S.sketch.rooms = {}; skSel = null; changed(); drawSketch(wrap); }),
        Platform.canDownload() ? b('Download PNG', () => downloadSketch(model)) : null),
      h('ul', { class: 'sklegend' }, model.rooms.map(x => h('li', { class: x.short ? 'bad' : null }, h('button', { type: 'button', class: 'linkish', 'aria-pressed': String(skSel === x.key), onclick: () => { skSel = skSel === x.key ? null : x.key; drawSketch(wrap); } }, h('span', { class: 'st', text: x.name }), h('span', { class: 'sm', text: roomStatus(x) }))))),
      shorts.length ? h('div', { class: 'sm bad', text: `Outlined in red: ${shorts.map(x => x.name).join(', ')} can’t fit ${shorts.length > 1 ? 'their' : 'its'} numbers at this size.` }) : null,
      model.rooms.some(x => x.assumed && !x.online) ? h('div', { class: 'sm', text: 'Rooms without an area are drawn at the comfortable size for their capacity and layout. Add the real area for a true picture.' }) : null));
    const svg = holder.querySelector('svg');
    const pt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    let st = null;
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('g.room'); if (!g) return;
      const room = model.rooms.find(x => x.key === g.dataset.room); if (!room) return;
      const canDrag = e.pointerType === 'mouse' || arrange;
      st = { g, room, p0: pt(e), moved: false, canDrag, id: e.pointerId };
      if (canDrag) { svg.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!st || !st.canDrag || e.pointerId !== st.id) return; const p = pt(e), dx = p.x - st.p0.x, dy = p.y - st.p0.y;
      if (!st.moved && Math.hypot(dx, dy) < 0.4) return; st.moved = true; dragging = true;
      st.nx = Math.max(0, Math.round((st.room.x + dx) * 2) / 2); st.ny = Math.max(0, Math.round((st.room.y + dy) * 2) / 2);
      st.g.setAttribute('transform', `translate(${st.nx + 4} ${st.ny + 4})`);
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return; const s0 = st; st = null; dragging = false;
      if (s0.moved) { skSel = s0.room.key; const [fx, fy] = freeSpot(model, s0.room, s0.nx, s0.ny); if (fx !== s0.nx || fy !== s0.ny) toast('Moved next to the other room so they don’t overlap.'); save(s0.room, { x: fx, y: fy }); }
      else { skSel = skSel === s0.room.key ? null : s0.room.key; drawSketch(wrap); }
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', (e) => { if (st && e.pointerId === st.id) { st = null; dragging = false; drawSketch(wrap); } });
    svg.addEventListener('keydown', (e) => {
      const g = e.target.closest && e.target.closest('g.room'); if (!g) return; const room = model.rooms.find(x => x.key === g.dataset.room);
      const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (mv) { e.preventDefault(); skSel = room.key; save(room, { x: Math.max(0, room.x + mv[0]), y: Math.max(0, room.y + mv[1]) }); const ng = wrap.querySelector(`g.room[data-room="${CSS.escape(room.key)}"]`); ng && ng.focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); skSel = skSel === room.key ? null : room.key; drawSketch(wrap); const ng = wrap.querySelector(`g.room[data-room="${CSS.escape(room.key)}"]`); ng && ng.focus(); }
    });
  }
  async function downloadSketch(model) {
    const pad = 8, scale = Math.min(14, 4096 / Math.max(model.W + pad, model.H + pad + 4)); // phones can’t draw images much bigger than 4,096 px
    const svgText = sketchSVG(model, { print: true, px: scale }), name = (S.basics.title || 'event').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').toLowerCase() + '-layout-sketch';
    try {
      const img = new Image(), url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await Platform.download(name + '.png', blob, 'image/png'); window.__EB_lastSketch = { bytes: blob.size, w: c.width, h: c.height };
    } catch (e) { if (!(e && e.code === 'cancelled')) { await Platform.download(name + '.svg', svgText, 'image/svg+xml').catch(() => { }); } }
  }
  const sketchField = () => field('Layout sketch', live('sketch', { class: 'sketch' }), { opt: 1, help: 'Drawn to scale from your spaces: seats, tables, stands and stages. It is a sketch to check the numbers, not a measured floor plan.' });
  // ----- starter packs
  function packSummary(t) {
    const P = PACKS[t.id] || PACKS.other, will = [], keep = [];
    (S.spaces.some(r => r.name.trim()) ? keep : will).push(`${t.spaces.length} spaces with layouts`);
    (S.programme.rows.some(r => r.title.trim()) ? keep : will).push(`a ${t.prog.length}-item programme`);
    (S.people.segments.some(r => r.label.trim()) ? keep : will).push('the audience mix');
    (S.online.features.length ? keep : will).push('online features');
    if (P.food.length) (S.basics.food.length ? keep : will).push('food and drink service');
    if (!S.avatars.prefilled) will.push('avatar dress, badges and abilities');
    return { will, keep };
  }
  function applyPack() {
    const t = typeOf(); if (!t) return; const P = PACKS[t.id] || PACKS.other, filled = [];
    if (!S.spaces.some(r => r.name.trim())) { S.spaces = t.spaces.map(([name, purpose, cap], i) => ({ name, purpose, cap, layout: P.layouts[i] || 'Open or mixed', area: '' })); filled.push('spaces'); }
    else for (const r of S.spaces) { const i = t.spaces.findIndex(x => x[0].toLowerCase() === r.name.trim().toLowerCase()); if (i >= 0 && !r.layout) r.layout = P.layouts[i] || ''; }
    if (!S.programme.rows.some(r => r.title.trim())) { S.programme.rows = t.prog.map(([time, title, space, who]) => ({ time, title, space, who })); filled.push('programme'); }
    if (!S.people.segments.some(r => r.label.trim())) { S.people.segments = t.segs.map(([label, pct]) => ({ label, pct: String(pct) })); filled.push('audience mix'); }
    if (!S.online.features.length) { S.online.features = [...t.feats]; filled.push('online features'); }
    if (!S.basics.food.length && P.food.length) { S.basics.food = [...P.food]; filled.push('food and drink'); }
    if (!S.avatars.prefilled) { prefillAvatars(); filled.push('avatars'); }
    S.packApplied = t.id; changed(); render();
    toast(filled.length ? 'Filled: ' + filled.join(', ') + '. Your own answers were kept.' : 'Nothing to fill: those sections already have your answers.');
  }
  function packCard() {
    const t = typeOf(); if (!t) return null; const { will, keep } = packSummary(t), done = S.packApplied === t.id;
    return h('div', { class: 'pack' },
      h('div', null, h('div', { class: 'eyebrow', text: 'Starter pack' }), h('div', { class: 'ct', text: t.id === 'other' ? 'A basic starting point' : 'A starting point for a ' + t.n.toLowerCase() }),
        h('div', { class: 'cd', text: will.length ? 'Fills in ' + will.join(', ') + '.' + (keep.length ? ' Keeps what you already wrote for ' + keep.join(', ') + '.' : '') : 'Every section it covers already has your answers.' }),
        h('div', { class: 'cd', text: 'Everything stays editable. Reality checks run on it straight away.' })),
      h('button', { type: 'button', class: done && !will.length ? 'secondary' : 'primary', disabled: !will.length ? true : null, text: done && !will.length ? 'Applied' : 'Apply starter pack', onclick: applyPack }));
  }

  // ---------- section owners ----------
  const initials = (n) => String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '•';
  const ownerOf = (id) => S && S.owners && S.owners[id];
  function ownerLine(sec) {
    const o = ownerOf(sec.id), wrap = h('div', { class: 'ownerline' });
    const show = () => { wrap.innerHTML = ''; const cur = ownerOf(sec.id);
      wrap.append(cur ? h('span', { class: 'owner' }, h('span', { class: 'av', 'aria-hidden': 'true', text: initials(cur.name || cur.email) }), h('span', null, 'Owner: ', h('b', { text: cur.name || cur.email }), cur.email && cur.name ? h('span', { class: 'muted', text: ' · ' + cur.email }) : null)) : h('span', { class: 'muted', text: 'No owner yet' }),
        h('button', { type: 'button', class: 'linkish', text: cur ? 'Change' : 'Assign an owner', onclick: edit })); };
    const back = () => { show(); const b = wrap.querySelector('.linkish'); if (b) b.focus(); }; // after saving or cancelling, focus returns to the owner button
    const edit = () => { wrap.innerHTML = ''; const cur = ownerOf(sec.id) || { name: '', email: '' };
      const nm = h('input', { type: 'text', value: cur.name, placeholder: 'Name, e.g. Lina', 'aria-label': 'Owner name', maxlength: '80' }), em = h('input', { type: 'email', value: cur.email, placeholder: 'Email (optional)', 'aria-label': 'Owner email', maxlength: '120' }), note = h('span', { class: 'note' });
      const save = () => { const name = nm.value.trim().slice(0, 80), email = em.value.trim().slice(0, 120); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { note.textContent = 'That email doesn’t look right.'; note.classList.add('err'); return; } if (name || email) S.owners[sec.id] = { name, email }; else delete S.owners[sec.id]; changed(); renderNav(); back(); };
      wrap.append(h('div', { class: 'inline-form owner-form' }, nm, em, h('button', { type: 'button', class: 'primary', text: 'Save', onclick: save }), cur.name || cur.email ? h('button', { type: 'button', class: 'ghostbtn', text: 'Remove', onclick: () => { delete S.owners[sec.id]; changed(); renderNav(); back(); } }) : null, h('button', { type: 'button', class: 'ghostbtn', text: 'Cancel', onclick: back }), note));
      nm.focus(); const keys = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); } };
      wrap.querySelector('.owner-form').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); } });
      nm.addEventListener('keydown', keys); em.addEventListener('keydown', keys); };
    show(); return wrap;
  }
  function ownersTable() {
    const rows = SECTIONS.filter(x => x.id !== 'review'), sc = score(S), okey = (o) => (o.name || '').toLowerCase() + '|' + (o.email || '').toLowerCase();
    const people = new Map(); for (const x of rows) { const o = ownerOf(x.id); if (o && !people.has(okey(o))) people.set(okey(o), o); }
    const clash = (o) => [...people.values()].filter(p => (p.name || p.email) === (o.name || o.email)).length > 1, label = (o) => o.name && o.email && clash(o) ? `${o.name} (${o.email})` : o.name || o.email, names = [...people.keys()];
    if (!names.length) return h('p', { class: 'note', text: 'No sections have an owner yet. Open any section and choose “Assign an owner” to share the work.' });
    return h('div', { class: 'rows' },
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'otable' }, h('thead', null, h('tr', null, h('th', { text: 'Section' }), h('th', { text: 'Owner' }), h('th', { text: 'Status' }))),
        h('tbody', null, rows.map(x => { const o = ownerOf(x.id), st = sc.sec[x.id] || 'g'; return h('tr', null, h('td', null, h('button', { class: 'linkish', text: x.n, onclick: () => goto(SECTIONS.indexOf(x)) })), h('td', { class: 'oname', text: o ? label(o) : '—' }), h('td', null, h('span', { class: 'dot ' + st }), ' ', st === 'g' ? 'Done' : st === 'a' ? 'Optional items left' : 'Needs answers')); })))),
      h('div', { class: 'tools' }, h('button', { type: 'button', class: 'tpl', text: 'Copy the list for the team', onclick: () => copy(names.map(n => `${label(people.get(n))}: ` + rows.filter(x => { const o = ownerOf(x.id); return o && okey(o) === n; }).map(x => `${x.n} (${(sc.sec[x.id] || 'g') === 'r' ? 'needs answers' : (sc.sec[x.id] || 'g') === 'a' ? 'optional items left' : 'done'})`).join(', ')).join('\n'), 'Owner list copied') })));
  }

  // ---------- sections ----------
  const R = {};
  R.start = () => {
    const pathCards = h('div', { class: 'cards c3' }, PATHS.map(p => h('button', { type: 'button', class: 'card', 'aria-pressed': String(S.path === p.id), onclick: () => { S.path = p.id; changed(); render(); } }, h('span', { class: 'ck', text: p.k }), h('span', { class: 'ct', text: p.t }), h('span', { class: 'cd', text: p.d }))));
    const typeGrid = h('div', { class: 'types' }, TYPES.map(t => h('button', { type: 'button', class: 'type', 'aria-pressed': String(S.type === t.id), onclick: () => { S.type = t.id; if (t.reg !== 'None' && !S.partners.regulated) S.partners.regulated = t.reg; if (!S.avatars.prefilled) prefillAvatars(); changed(); render(); } }, h('span', { class: 'tn', text: t.n }), h('span', { class: 'te', text: t.e }))));
    return [
      h('div', { class: 'qfcard' }, h('div', null, h('div', { class: 'ct', text: 'Rather talk than type?' }), h('div', { class: 'cd', text: 'Describe the event in your own words, or add an agenda, brochure or floor plan. Everything is shown to you before anything is filled in.' })), h('button', { type: 'button', class: 'primary', text: 'Talk it through', onclick: openQF })),
      field('Where are you starting from?', pathCards, { need: !S.path }),
      field('What kind of event is it?', typeGrid, { need: !S.type, help: 'This sets the examples and starting templates. You can change everything later.' }),
      S.type === 'other' ? field('Describe the event type', text('typeOther', 'e.g. A charity run with a finish-line festival'), { need: !S.typeOther.trim() }) : null,
      S.type ? packCard() : null,
      field('Format', chips('format', FORMATS, false), { need: !S.format, help: '"Online world only" means the event exists only as a walkable online place.' }),
    ];
  };
  R.basics = () => [
    h('div', { class: 'two' }, field('Working title', text('basics.title', ex('title')), { need: !S.basics.title.trim() }), field('Host or organiser', text('basics.host', ex('host')), { opt: 1 })),
    field('Purpose in one sentence', area('basics.purpose', ex('purpose'), 2), { need: S.basics.purpose.trim().length < 12, help: 'Say the outcome, not the activity: what changes because this event happened?' }),
    field('Who it is for', area('basics.audience', ex('audience'), 2), { need: !S.basics.audience.trim() }),
    h('div', { class: 'two' },
      field('When', h('div', { class: 'rows' }, text('basics.when', twin() ? 'Date and time' : 'Date, or a target window like "spring 2027"'), live('when', { class: 'note' })), { need: twin() && !S.basics.when.trim(), opt: !twin() }),
      field('Duration', text('basics.duration', 'e.g. One evening, 19:00 to 23:00'), { opt: 1 })),
    h('div', { class: 'two' },
      field('Where', text('basics.location', twin() ? ex('venue') : 'City, venue, or "to decide"'), { need: twin() && !S.basics.location.trim(), opt: !twin() }),
      field('Expected attendance', h('div', { class: 'rows' }, text('basics.attendance', 'In person and online, e.g. 400 + 3,000 online'), live('att', { class: 'note' })), { need: !S.basics.attendance.trim() })),
    field('Food and drink', chips('basics.food', FOOD, true, () => refreshLive()), { opt: 1, help: 'Used to work out serving and bar staff.' }),
    field('Languages', chips('basics.languages', LANGS, true), { opt: 1 }),
    h('div', { class: 'two' }, field('Budget range', text('basics.budget', 'e.g. AED 150k to 250k, or "to propose"'), { opt: 1 }), field('How you will measure success', text('basics.success', ex('success')), { opt: 1 })),
  ];
  R.concept = () => {
    const fr = fresh(), studio = h('div', { class: 'studio' });
    let studioErr = '';
    const drawStudio = () => {
      studio.innerHTML = '';
      const note = h('div', { class: 'note' + (studioErr ? ' err' : ''), text: studioErr });
      const holder = h('div', { class: 'concepts' });
      const gen = aiBtn(S.concept.options ? 'Generate 3 new concepts' : 'Generate 3 concepts', async () => {
        if (!S.basics.purpose.trim() && !S.basics.title.trim() && !S.type) { note.textContent = 'Add a type, title or purpose first.'; return; }
        holder.innerHTML = ''; holder.append(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
        const res = await ask({ task: 'concepts', input: { brief: briefObj() }, prompt: `You are a senior event creative director and producer who works across every kind of event: launches, galas, festivals, conferences, weddings, exhibitions and more. Propose 3 clearly different concepts for the event in this brief. Ground them in the brief, honour must-haves and things to avoid, and fit the format and budget. ${RULES}\n\nBrief (JSON): ${briefFor()}\n\nReply with only JSON: {"concepts":[{"name":"short concept name","bigIdea":"two sentences","feeling":"one line: how people feel when they leave","signature":"the one moment people will remember","mood":["word","word","word"],"spaces":[{"name":"","purpose":"","layout":"","cap":"","area":""}],"programme":[{"time":"","title":"","space":"","who":"role"}],"online":"one sentence: what makes the online version special"}]}\nEach concept: 4 to 7 spaces and 5 to 9 programme items. Spaces in the programme must match the space names. Mood words, where they fit, should come from: ${MOODS.join(', ')}.` }, note, gen, 'default');
        const cs = res && Array.isArray(res.concepts) ? rowsOf(res.concepts, ROW.concept, 3).filter(c => c.name || c.bigIdea) : [];
        if (cs.length) { S.concept.options = cs; S.concept.chosen = null; studioErr = ''; changed(); }
        else studioErr = note.textContent || 'No concepts came back. Try again.';
        drawStudio();
      });
      studio.append(h('div', { class: 'eyebrow', text: 'Concept studio' }), h('h3', { text: fr ? 'Not sure yet? Get three directions.' : 'What could the online version add?' }),
        h('div', { class: 'note', text: aiOn() ? 'AI reads everything filled in so far and proposes three concepts. Pick one to fill in the idea, spaces and programme.' : 'AI suggestions aren’t available here. The type templates in the next steps give you a solid start.' }),
        h('div', { class: 'tools' }, gen), note, holder);
      for (const [i, c] of (S.concept.options || []).entries()) {
        const chosen = S.concept.chosen === i;
        holder.append(h('div', { class: 'concept', 'aria-current': chosen ? 'true' : null },
          h('div', { class: 'cn', text: c.name || 'Concept ' + (i + 1) }), h('p', { text: c.bigIdea || '' }),
          h('div', { class: 'lbl', text: 'Signature moment' }), h('p', { text: c.signature || '' }),
          h('div', { class: 'lbl', text: 'Online' }), h('p', { text: c.online || '' }),
          h('div', { class: 'lbl', text: 'Spaces' }), h('p', { text: (c.spaces || []).map(s => s.name).join(' · ') }),
          h('button', { type: 'button', class: chosen ? 'secondary use' : 'primary use', text: chosen ? 'Using this concept' : 'Use this concept', onclick: () => useConcept(i) })));
      }
    };
    drawStudio();
    return [
      studio,
      field('Goals', chips('concept.goals', GOALS, true), { need: fr && !S.concept.goals.length, opt: !fr }),
      field('The big idea', area('concept.bigIdea', 'In two sentences: what is this event, and why will people care?', 3), { need: fr && S.concept.bigIdea.trim().length < 15, opt: !fr }),
      h('div', { class: 'two' },
        field('When people leave, they should feel…', text('concept.feeling', ex('feeling')), { opt: 1 }),
        field('Signature moment', text('concept.signature', 'The one moment everyone talks about afterwards'), { opt: 1 })),
      field('Mood', chips('concept.mood', MOODS, true), { need: fr && S.concept.mood.length < 2, opt: !fr, help: 'Pick two to four.' }),
      h('div', { class: 'two' }, field('Must-haves', area('concept.mustHave', 'Things that must happen or appear', 2), { opt: 1 }), field('Things to avoid', area('concept.avoid', 'Clichés, sensitivities, past mistakes', 2), { opt: 1 })),
      field('References', area('concept.refs', 'Links to events, films, places or brands you admire', 2), { opt: 1 }),
    ];
  };
  function useConcept(i) {
    const c = S.concept.options[i]; if (!c) return;
    S.concept.chosen = i; S.concept.bigIdea = c.bigIdea || S.concept.bigIdea; S.concept.feeling = c.feeling || S.concept.feeling; S.concept.signature = c.signature || S.concept.signature;
    if (Array.isArray(c.mood)) S.concept.mood = [...new Set([...S.concept.mood, ...c.mood.map(m => MOODS.find(x => x.toLowerCase() === String(m).toLowerCase())).filter(Boolean)])];
    const hadSpaces = S.spaces.some(r => r.name.trim()), hadProg = S.programme.rows.some(r => r.title.trim());
    if (!hadSpaces && c.spaces.length) S.spaces = rowsOf(c.spaces, ROW.space);
    if (!hadProg && c.programme.length) S.programme.rows = rowsOf(c.programme, ROW.prog);
    changed(); render();
    toast(hadSpaces || hadProg ? 'Concept applied. Your existing spaces and programme were kept.' : 'Concept applied to idea, spaces and programme.');
  }
  function replaceConfirm(kind, apply) {
    const box = h('div', { class: 'inline-confirm' }, h('span', { text: `Replace your current ${kind}?` }),
      h('button', { type: 'button', class: 'secondary', text: 'Replace', onclick: () => { apply(); render(); } }), h('button', { type: 'button', class: 'ghostbtn', text: 'Keep mine', onclick: () => box.remove() }));
    return box;
  }
  R.spaces = () => {
    const t = typeOf(), note = h('div', { class: 'note' }), conf = h('div');
    const ed = rows('spaces', [{ k: 'name', label: 'Space', ph: 'e.g. Main stage', w: '1.1fr' }, { k: 'purpose', label: 'What happens there', ph: 'Purpose', w: '1.3fr' }, { k: 'layout', label: 'Layout', ph: 'Layout', w: '1fr', opts: ['', ...LAYOUT_NAMES], onInput: () => refreshLive() }, { k: 'cap', label: 'People', ph: 'Capacity', w: '90px', num: 1 }, { k: 'area', label: 'Area m²', ph: 'Area in m² (optional)', w: '96px', num: 1 }], 'Add a space', () => ({ name: '', purpose: '', layout: '', cap: '', area: '' }));
    const applyTpl = () => { const P = PACKS[t.id] || PACKS.other; S.spaces = t.spaces.map(([name, purpose, cap], i) => ({ name, purpose, cap, layout: P.layouts[i] || '', area: '' })); changed(); };
    const tplBtn = t ? h('button', { type: 'button', class: 'tpl', text: t.id === 'other' ? 'Start from a basic template' : 'Start from the ' + t.n.toLowerCase() + ' template', onclick: () => { if (S.spaces.some(r => r.name.trim())) { conf.innerHTML = ''; conf.append(replaceConfirm('spaces', applyTpl)); } else { applyTpl(); render(); } } }) : null;
    const sug = aiBtn('Suggest spaces', async () => {
      const res = await ask({ task: 'spaces', input: { brief: briefObj() }, prompt: `You are an experienced event producer and spatial designer. Suggest the spaces (rooms or zones) this event needs, in the order a guest meets them. ${RULES}\n\nBrief (JSON): ${briefFor()}\n\nReply with only JSON: {"spaces":[{"name":"","purpose":"one line","layout":"one of: ${LAYOUT_NAMES.join(' | ')}","cap":"number of people"}]} with 4 to 9 spaces.` }, note, sug);
      const got = res ? rowsOf(res.spaces, ROW.space, 30).filter(r => r.name) : []; if (!got.length && res) { note.textContent = 'The answer came back in the wrong shape. Try again.'; note.classList.add('err'); }
      if (got.length) { const apply = () => { S.spaces = got; changed(); }; if (S.spaces.some(r => r.name.trim())) { conf.innerHTML = ''; conf.append(replaceConfirm('spaces', apply)); } else { apply(); render(); } }
    });
    return [h('div', { class: 'tools' }, tplBtn, sug), note, conf, field('Spaces', ed, { need: S.spaces.filter(r => r.name.trim()).length < 3, help: (twin() ? 'List the real spaces as named on the floor plan, so content and signage map to them.' : 'Every place a guest can go: arrival, main moments, social areas, quiet corners.') + ' Layout and area let us check the numbers.' }), live('plan:spaces', { class: 'plannums-wrap' }), sketchField()];
  };
  R.programme = () => {
    const t = typeOf(), note = h('div', { class: 'note' }), conf = h('div');
    const spaceOpts = () => ['', ...S.spaces.map(s => s.name).filter(Boolean)];
    const ed = rows('programme.rows', [{ k: 'time', label: 'When', ph: '19:00', w: '100px' }, { k: 'title', label: 'What', ph: 'Moment or session', w: '1.6fr' }, { k: 'space', label: 'Where', ph: 'Space', w: '1fr', opts: spaceOpts }, { k: 'who', label: 'Who', ph: 'Role or name', w: '1fr' }], 'Add an item', () => ({ time: '', title: '', space: '', who: '' }));
    const applyTpl = () => { S.programme.rows = t.prog.map(([time, title, space, who]) => ({ time, title, space, who })); changed(); };
    const tplBtn = t ? h('button', { type: 'button', class: 'tpl', text: 'Start from the template', onclick: () => { if (S.programme.rows.some(r => r.title.trim())) { conf.innerHTML = ''; conf.append(replaceConfirm('programme', applyTpl)); } else { applyTpl(); render(); } } }) : null;
    const sug = aiBtn('Draft a run of show', async () => {
      const res = await ask({ task: 'programme', input: { brief: briefObj(), spaceNames: S.spaces.map(s => s.name).filter(Boolean) }, prompt: `You are an experienced show caller and event producer. Draft a realistic run of show for this event, using only these spaces: ${JSON.stringify(S.spaces.map(s => s.name).filter(Boolean))}. ${RULES}\n\nBrief (JSON): ${briefFor()}\n\nReply with only JSON: {"programme":[{"time":"HH:MM","title":"","space":"one of the spaces","who":"role"}]} with 6 to 12 items in time order.` }, note, sug);
      const got = res ? rowsOf(res.programme, ROW.prog, 40).filter(r => r.title) : []; if (!got.length && res) { note.textContent = 'The answer came back in the wrong shape. Try again.'; note.classList.add('err'); }
      if (got.length) { const apply = () => { S.programme.rows = got; changed(); }; if (S.programme.rows.some(r => r.title.trim())) { conf.innerHTML = ''; conf.append(replaceConfirm('programme', apply)); } else { apply(); render(); } }
    });
    return [h('div', { class: 'tools' }, tplBtn, sug), note, conf,
      field('Programme or run of show', ed, { need: !score(S).c.find(x => x.sec === 'programme').ok, help: twin() ? 'For an existing event, link the official programme below and add the key moments here.' : 'The moments in order. Times can be rough.' }),
      field('Programme link', text('programme.agendaLink', 'https://… (PDF, document or website)', 'url'), { opt: 1, help: 'If the full programme exists elsewhere, link it here.' })];
  };
  R.people = () => {
    const t = typeOf(), note = h('div', { class: 'note' }), sum = h('div', { class: 'sumline' });
    const upd = () => { const tot = S.people.segments.reduce((a, r) => a + (parseFloat(r.pct) || 0), 0); sum.textContent = `Total ${tot}%` + (tot && tot !== 100 ? ' (aim for 100%)' : ''); };
    const seg = rows('people.segments', [{ k: 'label', label: 'Group', ph: 'e.g. Customers', w: '1.6fr' }, { k: 'pct', label: '% of audience', ph: '%', w: '110px', num: 1, onInput: () => upd() }], 'Add a group', () => ({ label: '', pct: '' }));
    upd();
    const tpl = t ? h('button', { type: 'button', class: 'tpl', text: 'Use the template mix', onclick: () => { S.people.segments = t.segs.map(([label, pct]) => ({ label, pct: String(pct) })); changed(); render(); } }) : null;
    const sug = aiBtn('Suggest the audience mix', async () => {
      const res = await ask({ task: 'segments', input: { brief: briefObj() }, prompt: `Estimate the audience mix for this event as 3 to 6 groups that add up to 100%. ${RULES}\n\nBrief (JSON): ${briefFor()}\n\nReply with only JSON: {"segments":[{"label":"","pct":0}]}` }, note, sug);
      const got = res ? rowsOf(res.segments, ROW.seg, 10).filter(r => r.label) : []; if (got.length) { S.people.segments = got; changed(); render(); } else if (res) { note.textContent = 'The answer came back in the wrong shape. Try again.'; note.classList.add('err'); }
    });
    const hosts = rows('people.hosts', [{ k: 'name', label: 'Name', ph: 'Full name', w: '1.2fr' }, { k: 'role', label: 'Role', ph: 'e.g. Host, performer, speaker', w: '1.2fr' }, { k: 'consent', label: 'Can we show them?', ph: 'Consent', w: '1fr', opts: ['', 'Name and likeness', 'Name only', 'Not yet'] }], 'Add a person', () => ({ name: '', role: '', consent: '' }));
    return [
      field('Audience mix', h('div', { class: 'rows' }, h('div', { class: 'tools' }, tpl, sug), note, seg, sum), { opt: 1, help: 'Used to make the crowd, and any AI attendees, feel like your real audience.' }),
      field('Named people: hosts, performers, speakers, VIPs', hosts, { need: !score(S).c.find(x => x.label.startsWith('Consent')).ok, help: 'Only people who agreed are shown by name or likeness. Others appear as their role.' }),
      field('Staff and roles on the day', area('people.staff', 'e.g. Welcome team of 6, 2 hosts, technical crew, ushers', 2), { opt: 1 }),
    ];
  };
  function prefillAvatars() {
    const A = S.avatars, t = S.type || '_';
    A.abilities = [...(ABILITY_DEFAULTS[t] || ABILITY_DEFAULTS.other)];
    A.dress = [...(DRESS_DEFAULTS[t] || DRESS_DEFAULTS._)];
    A.lanyards = (LANYARDS[t] || LANYARDS._).map(([role, colour]) => ({ role, colour }));
    A.prefilled = true;
  }
  R.avatars = () => {
    const A = S.avatars, t = typeOf();
    if (!A.prefilled && S.type) { prefillAvatars(); changed(); }
    const styleCards = h('div', { class: 'cards c2' }, AV_STYLES.map(([id, tt, d]) => h('button', { type: 'button', class: 'card', 'aria-pressed': String(A.style === id), onclick: () => { set('avatars.style', A.style === id ? '' : id); render(); } }, h('span', { class: 'ct', text: tt }), h('span', { class: 'cd', text: d }))));
    const consentNote = h('div', { class: 'note' }); const updCons = () => { const n = A.abilities.filter(a => NEEDS_CONSENT.includes(a)); consentNote.textContent = n.length ? `${n.join(', ')} need guests’ consent. The build adds a consent step for these.` : ''; }; updCons();
    const groups = h('div', { class: 'agroups' }, ABILITIES.map(([g, list]) => h('div', { class: 'agroup' }, h('div', { class: 'aglabel', text: g }), chips('avatars.abilities', list, true, updCons))));
    return [
      t && A.prefilled ? h('div', { class: 'note', text: `Dress code, badge colours and abilities are pre-set for ${t.id === 'other' ? 'this kind of event' : 'a ' + t.n.toLowerCase()}. Change anything that doesn’t fit.` }) : null,
      field('Avatar style', styleCards, { need: score(S).c.find(x => x.label === 'Avatar style').lvl === 'block' && !A.style, opt: !(score(S).c.find(x => x.label === 'Avatar style').lvl === 'block') }),
      field('Dress code', chips('avatars.dress', AV_DRESS, true), { opt: 1 }),
      field('Who should the crowd look like?', h('div', { class: 'rows' }, chips('avatars.mix', AV_MIX, false), text('avatars.mixNote', 'e.g. Half local, half international; mostly 25 to 45')), { opt: 1, help: 'The crowd follows your audience mix from the People step.' }),
      field('Badge colours by role', rows('avatars.lanyards', [{ k: 'role', label: 'Role', ph: 'e.g. VIP', w: '1.4fr' }, { k: 'colour', label: 'Badge colour', ph: 'Colour', w: '1fr', opts: ['', ...LANYARD_COLOURS] }], 'Add a role', () => ({ role: '', colour: '' })), { opt: 1, help: 'People recognise roles at a glance, just as at a real event.' }),
      field('How do guests get their avatar?', chips('avatars.own', AV_OWN, false, () => render()), { need: !A.own && score(S).c.find(x => x.label.startsWith('How guests')).lvl === 'block', opt: score(S).c.find(x => x.label.startsWith('How guests')).lvl !== 'block', help: A.own === 'Create from a photo' ? 'Photo avatars are made in a separate step and added to the event; the event page itself can’t send photos to outside services.' : null }),
      field('Showing real people', chips('avatars.likeness', AV_LIKENESS, false), { need: !A.likeness && score(S).c.find(x => x.label.startsWith('Rule for')).lvl === 'block', opt: score(S).c.find(x => x.label.startsWith('Rule for')).lvl !== 'block', help: 'Covers hosts, performers, speakers and VIPs. Consent is recorded on the People step.' }),
      field('What can avatars do?', h('div', { class: 'rows' }, h('div', { class: 'tools' }, h('button', { type: 'button', class: 'tpl', text: 'Reset to the usual for this type', onclick: () => { S.avatars.abilities = [...(ABILITY_DEFAULTS[S.type || 'other'] || ABILITY_DEFAULTS.other)]; changed(); render(); } })), groups, consentNote), { need: A.abilities.length < 3 && score(S).c.find(x => x.label.startsWith('What avatars')).lvl === 'block', help: 'Untick anything you don’t want. Each ability becomes a button or gesture in the online event.' }),
    ];
  };
  R.partners = () => [
    field('Are there partners, sponsors or exhibitors?', chips('partners.has', [['yes', 'Yes'], ['no', 'No']], false, () => render()), { need: !S.partners.has }),
    S.partners.has === 'yes' ? field('Partner list', rows('partners.list', [{ k: 'name', label: 'Partner', ph: 'Company name', w: '1.4fr' }, { k: 'tier', label: 'Tier', ph: 'Tier', w: '1fr', opts: ['', 'Title', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Exhibitor', 'Media', 'Supporter'] }, { k: 'notes', label: 'Notes', ph: 'Stand size, deliverables', w: '1.4fr' }], 'Add a partner', () => ({ name: '', tier: '', notes: '' })), { need: !S.partners.list.some(r => r.name.trim()) }) : null,
    S.partners.has === 'yes' ? field('Regulated industry?', chips('partners.regulated', REGULATED, false), { need: !S.partners.regulated, help: 'Pharma, alcohol, finance and gaming have advertising rules. Regulated partners get branding only, with no product claims, unless approved.' }) : null,
    S.partners.has === 'yes' ? field('Artwork status', chips('partners.artwork', ['Approved and in the folder', 'In progress', 'Not started'], false), { opt: 1 }) : null,
  ];
  R.look = () => {
    const L = S.look;
    return [
      field('Do you have brand guidelines?', chips('look.brand', [['yes', 'Yes'], ['partial', 'Partly'], ['no', 'No']], false, () => render()), { need: !score(S).c.find(x => x.label.startsWith('Brand')).ok }),
      L.brand === 'yes' ? field('Link to the brand files', text('look.brandLink', 'https://… or upload them in Files', 'url'), { opt: 1 }) : null,
      field(L.brand === 'yes' ? 'Style notes' : 'Choose a style', chips('look.style', LOOKS, true), { need: L.brand !== 'yes' && L.style.length < 2, opt: L.brand === 'yes' }),
      field('Colours you love or must use', text('look.palette', 'e.g. Midnight blue, copper, warm white. Hex codes welcome'), { opt: 1 }),
      field('Is the venue real or imagined?', chips('look.venueKind', [['real', 'A real venue'], ['imagined', 'Imagined'], ['undecided', 'Not decided yet']], false, () => render()), { need: !L.venueKind }),
      L.venueKind === 'real' ? h('div', { class: 'fields' },
        field('Venue name and city', text('look.venueName', ex('venue')), { need: !L.venueName.trim() }),
        h('div', { class: 'two' }, field('Floor plans with dimensions?', tri('look.plans'), { need: twin() && L.plans !== 'yes', opt: !twin(), help: 'Upload them in Files or put them in 02_Venue. This is what makes the online venue match the real one.' }), field('Photos or 360s of each space?', tri('look.photos'), { need: twin() && L.photos !== 'yes', opt: !twin() })),
        field('Key dimensions or notes', area('look.dims', 'Ceiling heights, stage size, screen sizes, views', 2), { opt: 1 })) : null,
      L.venueKind === 'imagined' ? h('div', { class: 'fields' },
        field('Setting', chips('look.setting', SETTINGS, false), { need: !L.setting }),
        field('Scale', chips('look.scale', SCALES, false), { opt: 1 })) : null,
    ];
  };
  R.online = () => {
    const t = typeOf();
    return [
      field('What can people do online?', h('div', { class: 'rows' }, t ? h('div', { class: 'tools' }, h('button', { type: 'button', class: 'tpl', text: 'Pick the usual for this type', onclick: () => { S.online.features = [...new Set([...S.online.features, ...t.feats])]; changed(); render(); } })) : null, chips('online.features', FEATURES, true)), { need: S.online.features.length < 2 }),
      field('How do people get in?', chips('online.access', ACCESS, false), { need: !S.online.access }),
      h('div', { class: 'two' }, field('Devices', chips('online.devices', DEVICES, true), { opt: 1 }), field('Accessibility', chips('online.a11y', A11Y, true), { opt: 1 })),
      field('Anything else for the online version?', area('online.extra', 'e.g. Partners want visit reports. Open each room only when its moment starts.', 2), { opt: 1 }),
    ];
  };
  R.delivery = () => [
    h('div', { class: 'two' }, field('Deadline to go live', text('delivery.deadline', '', 'date'), { need: !S.delivery.deadline.trim() }), field('Owner on your side', text('delivery.owner', 'Name and role'), { need: !S.delivery.owner.trim() })),
    h('div', { class: 'two' }, field('Who approves', text('delivery.approver', 'Name and role'), { opt: 1 }), field('Registration or ticketing system', text('delivery.registration', 'e.g. Eventbrite, your own system, none'), { opt: 1 })),
    field('Where videos or streams are hosted', text('delivery.video', 'e.g. Vimeo, YouTube, files only'), { opt: 1 }),
    field('Privacy and consent', chips('delivery.privacy', ['Consent at registration', 'Consent banner online', 'Both', 'Not decided'], false), { opt: 1, help: 'For recordings, photos and guest data (for example UAE PDPL or GDPR).' }),
    field('Notes for the build team', area('delivery.notes', 'Anything we should know', 3), { opt: 1 }),
  ];
  R.files = () => {
    const tw = twin();
    const checklist = h('div', { class: 'rows' }, FOLDERS.map(([f, d]) => { const on = S.files.have.includes(f);
      return h('button', { type: 'button', class: 'sv', 'aria-pressed': String(on), onclick: () => { S.files.have = on ? S.files.have.filter(x => x !== f) : [...S.files.have, f]; changed(); render(); } },
        h('div', null, h('div', { class: 'st mono', text: f }), h('div', { class: 'sm', text: d })), h('span', { class: 'tag ' + (on ? 'g' : 'a'), text: on ? 'added' : 'to add' })); }));
    const names = FOLDERS.map(f => f[0]).join('\n');
    return [
      field('Upload files', uploader(), { opt: 1, help: 'Floor plans, photos, logos, programmes, brochures. Up to 10 MB each. Large videos go in the shared folder.' }),
      field('Shared folder link', text('files.drive', 'https://drive.google.com/drive/folders/…', 'url'), { need: tw && !score(S).c.find(x => x.label.startsWith('Shared folder')).ok, opt: !tw, help: 'Share the folder itself, not a short link (shortened links often can’t be opened). Give view access to the build team.' }),
      field('Folder structure', h('div', { class: 'rows' }, h('div', { class: 'tools' }, h('button', { type: 'button', class: 'tpl', text: 'Copy folder names', onclick: () => copy(names, 'Folder names copied') })), checklist), { opt: 1, help: 'Create these folders and tick each one once its files are in. Fixed names let the build team find everything without asking.' }),
      tw ? field('Recordings', chips('files.recordings', ['All sessions', 'Some sessions', 'None', 'Not applicable'], false, () => render()), { need: !S.files.recordings, help: 'Name each file by space and moment, e.g. MainStage_Opening.mp4, so it plays in the right place.' }) : null,
      tw ? field('Do you have the rights to use the recordings and music?', tri('files.rights'), { need: S.files.recordings && !['None', 'Not applicable'].includes(S.files.recordings) && S.files.rights !== 'yes', opt: !(S.files.recordings && !['None', 'Not applicable'].includes(S.files.recordings)) }) : null,
    ];
  };
  // ----- uploads
  const TEXT_TYPES = { csv: 'text/csv', md: 'text/markdown', json: 'application/json', txt: 'text/plain' };
  const typeFor = (f) => { const e = (f.name.split('.').pop() || '').toLowerCase(); if (TEXT_TYPES[e]) return TEXT_TYPES[e]; if (e === 'svg') return 'image/svg+xml'; if (e === 'pdf') return 'application/pdf'; return f.type || undefined; };
  const fmtSize = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  async function uploadFile(file, cat) {
    const lim = /svg/.test(file.type) ? 2e6 : 10e6; // EA-SYS: 10 MB, the server's limit
    if (file.size > lim) throw { code: 'too_big', message: `${file.name} is ${fmtSize(file.size)}. The limit is ${fmtSize(lim)}; put it in the shared folder instead.` };
    const r = await Platform.upload(file, typeFor(file));
    const item = { id: r.id, name: file.name.slice(0, 120), size: r.sizeBytes || file.size, type: r.contentType || file.type, cat, at: Date.now() };
    S.files.uploads.push(item); changed(); return item;
  }
  function uploader() {
    const wrap = h('div', { class: 'rows' }), note = h('div', { class: 'note' });
    if (!Platform.filesReady) { wrap.append(h('div', { class: 'note', text: Platform.mode === 'local' ? 'Uploading needs the online version of this page. Here, put your files in a shared folder and paste the link below.' : Platform.mode === 'api' ? 'Uploading isn’t switched on for this site yet. Use the shared folder below.' : 'Uploading isn’t available with your access to this page. Use the shared folder below, or ask the owner for edit access.' })); }
    else {
      const cat = h('select', { 'aria-label': 'File type' }, UPLOAD_CATS.map(c => h('option', { value: c, text: c })));
      const input = h('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf,.pdf,.svg,.csv,.md,.txt,.json,video/*', class: 'sr', id: 'upInput' });
      input.addEventListener('change', async () => {
        const files = [...input.files]; input.value = ''; if (!files.length) return; note.classList.remove('err');
        for (const f of files) { note.textContent = `Uploading ${f.name}…`; try { await uploadFile(f, cat.value); note.textContent = `Uploaded ${f.name}.`; } catch (e) { note.textContent = e.message && e.code === 'too_big' ? e.message : `Couldn’t upload ${f.name}. Try again.`; note.classList.add('err'); } }
        drawList();
      });
      wrap.append(h('div', { class: 'tools upl' }, h('label', { class: 'lab2', text: 'This is a' }), cat, h('label', { class: 'tpl', for: 'upInput', role: 'button', tabindex: '0', text: 'Choose files', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } }), input), note);
    }
    const list = h('div', { class: 'uplist' }); wrap.append(list);
    const drawList = () => {
      list.innerHTML = '';
      for (const u of S.files.uploads) {
        const isImg = /^image\//.test(u.type), url = Platform.fileUrl(u.id);
        const confirmBox = h('div');
        list.append(h('div', { class: 'upitem' },
          isImg ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'ftype mono', text: (u.name.split('.').pop() || 'file').slice(0, 4).toUpperCase() }),
          h('div', { style: 'min-width:0' }, h('a', { href: url, target: '_blank', rel: 'noopener', class: 'st', text: u.name }), h('div', { class: 'sm', text: `${u.cat} · ${fmtSize(u.size)}` }), confirmBox),
          Platform.filesReady ? h('button', { type: 'button', class: 'del', 'aria-label': 'Remove ' + u.name, text: '×', onclick: () => {
            confirmBox.innerHTML = ''; confirmBox.append(h('div', { class: 'inline-confirm' }, h('span', { text: 'Remove this file?' }), h('button', { type: 'button', class: 'secondary', text: 'Remove', onclick: async () => { try { await Platform.removeFile(u.id); } catch (e) { } S.files.uploads = S.files.uploads.filter(x => x.id !== u.id); changed(); drawList(); } }), h('button', { type: 'button', class: 'ghostbtn', text: 'Keep', onclick: () => { confirmBox.innerHTML = ''; } })));
          } }) : null));
      }
    };
    drawList(); return wrap;
  }

  // ---------- review, submit, track ----------
  R.review = () => {
    const sc = score(S), chg = pending(), submitted = S.status !== 'draft';
    const head = h('div', { class: 'ready' }, h('div', { class: 'eyebrow', text: sc.blocking.length ? 'Not ready yet' : 'Ready to submit' }), h('div', { class: 'big', text: sc.pct + '%' }), h('div', { class: 'bar' }, h('i', { style: `width:${sc.pct}%` })),
      h('div', { class: 'secstat' }, SECTIONS.filter(s => s.id !== 'review').map(s => h('div', null, h('span', { class: 'dot ' + (sc.sec[s.id] || 'g') }), h('button', { style: 'background:none;border:0;padding:0;text-align:left;color:inherit', onclick: () => goto(SECTIONS.indexOf(s)), text: s.n })))));
    const miss = (sc.blocking.length || sc.nice.length) ? field('What is missing', h('ul', { class: 'missing' },
      sc.blocking.map(x => h('li', null, h('span', { class: 'tag r', text: 'needed' }), h('button', { text: x.label, onclick: () => goto(SECTIONS.findIndex(s => s.id === x.sec)) }))),
      sc.nice.map(x => h('li', null, h('span', { class: 'tag a', text: 'optional' }), h('button', { text: x.label, onclick: () => goto(SECTIONS.findIndex(s => s.id === x.sec)) }))))) : null;
    const act = h('div', { class: 'actions' }), note = h('div', { class: 'note' });
    let submitBlock;
    if (!submitted) {
      const go = h('button', { class: 'primary', text: 'Submit blueprint', onclick: () => doSubmit(false) });
      submitBlock = field('Submit', h('div', { class: 'rows' },
        h('p', { class: 'help', style: 'margin:0', text: sc.blocking.length ? `${sc.blocking.length} needed item${sc.blocking.length > 1 ? 's are' : ' is'} still open. You can submit now and the build team will ask for them in one message, or fill them in first.` : 'Everything needed is here. Submitting sends it to the build team and gives you a reference number to track it.' }),
        h('div', { class: 'actions' }, go), note));
    } else {
      submitBlock = h('div', { class: 'fields' }, tracker(), chg.length ? field(`Changes since your last submission (${chg.length})`, h('div', { class: 'rows' }, h('ul', { class: 'chglist' }, chg.slice(0, 40).map(c => h('li', null, h('span', { class: 'tag a', text: SECTIONS.find(s => s.id === c.sec).n }), h('span', { text: c.text })))), chg.length > 40 ? h('div', { class: 'note', text: `…and ${chg.length - 40} more.` }) : null, h('div', { class: 'actions' }, h('button', { class: 'primary', text: `Send update (${chg.length} change${chg.length > 1 ? 's' : ''})`, onclick: () => doSubmit(true) }))), { help: 'Edits after submitting are collected here. Nothing reaches the build team until you send them.' }) : null);
    }
    act.append(h('button', { class: 'secondary', text: 'Copy brief', onclick: () => copy(toMarkdown(S), 'Brief copied') }));
    const fname = (S.basics.title || 'event').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').toLowerCase() + '-blueprint';
    if (Platform.canDownload()) act.append(h('button', { class: 'secondary', text: 'Download brief', onclick: () => Platform.download(fname + '.md', toMarkdown(S), 'text/markdown').catch(() => { }) }));
    act.append(h('button', { class: 'secondary', text: 'Duplicate', onclick: duplicateCurrent }), h('button', { class: 'secondary', text: 'Save as template', onclick: () => { tplBox.hidden = !tplBox.hidden; if (!tplBox.hidden) tplBox.querySelector('input').focus(); } }));
    const tplName = h('input', { type: 'text', placeholder: 'Template name, e.g. Annual awards night', value: S.basics.title ? S.basics.title.replace(/\s*\d{4}\s*$/, '') + ' format' : '' });
    const tplBox = h('div', { class: 'inline-form', hidden: true }, tplName, h('button', { class: 'primary', text: 'Save template', onclick: async () => { await saveTemplate(tplName.value.trim() || 'Untitled template'); tplBox.hidden = true; } }), h('div', { class: 'help', text: 'Templates keep the concept, spaces, programme, look and avatar settings. Dates, people, partners and files are cleared.' }));
    return [submitBlock, head, miss, field('Who owns what', ownersTable(), { opt: 1, help: 'Give each section to a person so the work is shared. Owners show in the steps list and in the brief.' }), field('Reality checks', live('reality:*', { 'data-empty': 'Nothing unrealistic in what is filled in so far. Checks cover room sizes, programme, timing, stands and online turnout.' }), { opt: 1, help: 'Advice only: nothing here blocks your submission, and you decide on each one.' }), field('Numbers to plan with', live('plan'), { opt: 1 }), S.spaces.some(r => r.name.trim()) ? sketchField() : null, field('More', h('div', { class: 'rows' }, act, tplBox, note)), field('The brief', renderBrief(S))];
  };
  function tracker() {
    const cur = Math.max(0, stIdx(S.status));
    const wrap = h('div', { class: 'tracker' });
    wrap.append(h('div', { class: 'trhead' }, h('div', null, h('div', { class: 'eyebrow', text: 'Progress' }), h('div', { class: 'mono', text: S.ref })), h('span', { class: 'pill s-' + S.status, text: STATUSES[cur][1] })));
    const ol = h('ol', { class: 'steps-v' });
    STATUSES.slice(1).forEach(([id, label, desc], i) => {
      const idx = i + 1, state = idx < cur ? 'done' : idx === cur ? 'now' : 'next';
      const when = S.statusLog.filter(x => x.status === id).pop();
      ol.append(h('li', { class: state }, h('span', { class: 'bul', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'tl', text: label }), h('div', { class: 'td', text: state === 'now' ? desc : when ? fmtDate(when.at) : '' }))));
    });
    wrap.append(ol);
    // approvals belong to the owner (a person), never to automation
    if (Platform.mode !== 'api' && S.status === 'plan_ready' && !S.approvals.plan) wrap.append(h('div', { class: 'approve' }, h('div', { text: 'The plan is ready. Read it, then approve it here so the build can start.' }), h('button', { class: 'primary', text: 'Approve the plan', onclick: () => approve('plan') })));
    if (Platform.mode !== 'api' && S.status === 'preview' && !S.approvals.preview) wrap.append(h('div', { class: 'approve' }, h('div', { text: 'Walk through the preview, then approve it for publishing.' }), h('button', { class: 'primary', text: 'Approve the preview', onclick: () => approve('preview') })));
    if (S.approvals.plan) wrap.append(h('div', { class: 'note', text: 'Plan approved by you on ' + fmtDate(S.approvals.plan) + '.' }));
    if (S.approvals.preview) wrap.append(h('div', { class: 'note', text: 'Preview approved by you on ' + fmtDate(S.approvals.preview) + '.' }));
    const hist = h('details', { class: 'hist' }, h('summary', { text: `Submission history (${S.submissions.length})` }), h('ul', null, S.submissions.map(x => h('li', null, h('b', { text: x.kind === 'update' ? `Update ${x.n}` : 'First submission' }), ` · ${fmtDate(x.at)} · ${x.kind === 'update' ? x.count + ' changes' : 'readiness ' + x.readiness + '%'}`))));
    wrap.append(hist);
    if (Platform.isEditor) {
      const sel = h('select', { 'aria-label': 'Set status' }, STATUSES.map(([id, l]) => h('option', { value: id, text: l })));
      sel.value = S.status;
      wrap.append(h('div', { class: 'teamctl' }, h('span', { class: 'help', text: 'Build team: update the stage' }), sel, h('button', { class: 'secondary', text: 'Update', onclick: async () => { if (sel.value === S.status) return;
        if (Platform.mode === 'api') { try { applyServer(await Platform.stage(S.id, sel.value)); render(); toast('Stage updated'); } catch (e) { toast((e && e.message) || 'The stage could not be changed.'); sel.value = S.status; } return; } // EA-SYS: the server moves stages
        S.status = sel.value; S.statusLog.push({ status: sel.value, at: Date.now() }); changed(); render(); toast('Stage updated'); } })));
    }
    return wrap;
  }
  function approve(which) {
    S.approvals[which] = Date.now(); S.statusLog.push({ status: which === 'plan' ? 'plan_approved' : 'preview_approved', at: Date.now() });
    if (which === 'plan' && S.status === 'plan_ready') { S.status = 'building'; S.statusLog.push({ status: 'building', at: Date.now() }); }
    changed(); remoteSave(); Platform.notify({ type: 'approval', which, blueprintId: S.id, ref: S.ref }); render(); toast(which === 'plan' ? 'Plan approved. The build can start.' : 'Preview approved.');
  }
  const makeRef = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `EB-${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`; };
  // EA-SYS: the server's status, reference and history replace the page's own copies.
  function applyServer(v) { if (!plain(v)) return; S.status = v.status || S.status; S.ref = v.ref || S.ref; if (Array.isArray(v.statusLog)) S.statusLog = v.statusLog; if (Array.isArray(v.submissions)) S.submissions = v.submissions; if (plain(v.approvals)) S.approvals = v.approvals; }
  async function doSubmit(isUpdate) {
    if (Platform.mode === 'api') return doSubmitApi(isUpdate);
    const sc = score(S), chg = pending(), now = Date.now();
    if (!isUpdate) { S.ref = S.ref || makeRef(); S.status = 'submitted'; S.statusLog.push({ status: 'submitted', at: now }); S.submissions.push({ kind: 'submission', n: 0, at: now, readiness: sc.pct, open: sc.blocking.map(x => x.label) }); }
    else { const n = S.submissions.filter(x => x.kind === 'update').length + 1; S.submissions.push({ kind: 'update', n, at: now, count: chg.length, changes: chg.slice(0, 80).map(c => c.text) }); S.statusLog.push({ status: 'update_' + n, at: now }); }
    S.baseline = snapshot(S);
    changed(); clearTimeout(saveT); if (Platform.mode !== 'local' && Platform.canWrite) { setSave('Saving…'); await remoteSave(); } else setSave('Saved on this device');
    Platform.notify({ type: isUpdate ? 'update' : 'submitted', blueprintId: S.id, ref: S.ref, title: S.basics.title, readiness: sc.pct });
    ackView = { kind: isUpdate ? 'update' : 'submission', at: now, count: chg.length, readiness: sc.pct, open: sc.blocking.length, saved: saveState };
    render(); window.scrollTo({ top: 0 });
  }
  // EA-SYS: save the latest edits, then the server submits (or records the update), mints the
  // reference and emails the build team. Nothing changes on the page unless the server agrees.
  async function doSubmitApi(isUpdate) {
    const sc = score(S), chg = pending(), now = Date.now();
    clearTimeout(saveT); while (saving) await new Promise(r => setTimeout(r, 150));
    dirty = true; setSave('Saving…'); await remoteSave();
    if (dirty) { toast('Couldn’t save the latest changes, so nothing was sent. Try again.'); return; }
    try { applyServer(await Platform.submit(S.id, { readiness: sc.pct, open: sc.blocking.map(x => x.label).slice(0, 100), count: chg.length, changes: chg.slice(0, 80).map(c => c.text) })); }
    catch (e) { toast((e && e.message) || 'Couldn’t send it. Try again.'); return; }
    S.baseline = snapshot(S); changed(); clearTimeout(saveT); await remoteSave();
    ackView = { kind: isUpdate ? 'update' : 'submission', at: now, count: chg.length, readiness: sc.pct, open: sc.blocking.length, saved: saveState };
    render(); window.scrollTo({ top: 0 });
  }
  function renderAck() {
    const a = ackView, saved = /^Saved$/.test(saveState) || Platform.mode === 'api', main = $('main');
    const where = saved ? 'It is saved and visible to the build team.' : 'It is saved on this device. Copy the brief and share it, because the build team can’t see device-only blueprints.';
    main.innerHTML = '';
    main.append(h('section', { class: 'panel ack', 'aria-live': 'polite' },
      h('div', { class: 'tick', 'aria-hidden': 'true', text: '✓' }),
      h('div', { class: 'eyebrow', text: a.kind === 'update' ? 'Update received' : 'Blueprint received' }),
      h('h2', { text: S.basics.title || 'Untitled event' }),
      h('dl', { class: 'ackdl' }, h('dt', { text: 'Reference' }), h('dd', { class: 'mono', text: S.ref }), h('dt', { text: a.kind === 'update' ? 'Update sent' : 'Submitted' }), h('dd', { text: fmtDate(a.at) }), a.kind === 'update' ? [h('dt', { text: 'Changes' }), h('dd', { text: String(a.count) })] : [h('dt', { text: 'Readiness' }), h('dd', { text: a.readiness + '%' + (a.open ? ` · ${a.open} item${a.open > 1 ? 's' : ''} still open` : '') })]),
      h('p', { text: where }),
      h('h3', { text: 'What happens next' }),
      h('ol', { class: 'next' }, [
        ['Review', a.open ? 'The build team checks your blueprint and sends one message listing what is still missing.' : 'The build team checks your blueprint and files.'],
        ['Plan', 'You receive a plan: the spaces, the guest journey and the look. Nothing is built until you approve it here.'],
        ['Build and preview', 'The event is built and you get a private preview to walk through and approve.'],
        ['Live', 'It is published. Changes you make later are collected and sent as numbered updates.'],
      ].map(([t, d]) => h('li', null, h('b', { text: t }), h('span', { text: d })))),
      h('p', { class: 'help', text: 'You can follow progress on this blueprint and in your list of blueprints. Keep editing any time; changes wait until you send them.' }),
      h('div', { class: 'actions' }, h('button', { class: 'primary', text: 'See progress', onclick: () => { ackView = null; goto(SECTIONS.length - 1); } }), h('button', { class: 'secondary', text: 'Copy reference', onclick: () => copy(S.ref, 'Reference copied') }), h('button', { class: 'secondary', text: 'All blueprints', onclick: () => { ackView = null; showHome(); } }))));
    renderNav(); updateChrome();
  }

  // ---------- duplicate and templates ----------
  function cloneState(src, asTemplate) {
    const c = Object.assign(blank(), JSON.parse(JSON.stringify(src)));
    c.id = rid(); c.created = c.updated = Date.now(); c.status = 'draft'; c.ref = ''; c.submissions = []; c.statusLog = []; c.approvals = { plan: null, preview: null }; c.baseline = null;
    c.concept.options = null; c.concept.chosen = null; c.checkAck = {}; if (asTemplate) c.owners = {}; delete c.ownerId; delete c.readiness; delete c.blocking; delete c.pendingChanges; delete c.title;
    if (asTemplate) { c.basics.when = ''; c.delivery.deadline = ''; c.files.drive = ''; c.files.have = []; c.files.recordings = ''; c.files.rights = null; c.files.uploads = []; c.people.hosts = []; c.partners.list = []; c.partners.artwork = null; c.notes = ''; c.basics.title = ''; }
    return c;
  }
  function duplicateCurrent() { const c = cloneState(S, false); c.basics.title = (S.basics.title || 'Untitled event') + ' (copy)'; openBlueprint(c); step = 0; localSave(); dirty = true; remoteSave(); render(); toast('Duplicated. You are now editing the copy.'); }
  async function saveTemplate(name) {
    const t = { id: 'tp_' + Date.now().toString(36), name: name.slice(0, 80), type: S.type, ownerId: Platform.userId, created: Date.now(), state: cloneState(S, true) };
    try { await Platform.saveTemplate(t); toast('Template saved'); } catch (e) { toast('Couldn’t save the template. Try again.'); }
  }

  // ---------- quick fill: talk it through, or read a document ----------
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.2.108/';
  let pdfLib = null;
  async function pdfText(file) {
    if (!pdfLib) pdfLib = import(PDFJS + 'pdf.min.mjs').then(m => {
      try { const w = new Worker(URL.createObjectURL(new Blob([`import "${PDFJS}pdf.worker.min.mjs";`], { type: 'text/javascript' })), { type: 'module' }); m.GlobalWorkerOptions.workerPort = w; } catch (e) { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; }
      return m;
    });
    const lib = await pdfLib, doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let out = '';
    for (let i = 1; i <= Math.min(doc.numPages, 40) && out.length < 60000; i++) { const pg = await doc.getPage(i); const tc = await pg.getTextContent(); out += tc.items.map(x => x.str).join(' ').replace(/\s+/g, ' ') + '\n'; }
    return out.trim();
  }
  let qf = { file: null, keep: true, items: null };
  function openQF() { qf = { file: null, keep: true, items: null }; $('qf').hidden = false; drawQF(); setTimeout(() => { const t = $('qfText'); t && t.focus(); }, 30); }
  function closeQF() { $('qf').hidden = true; }
  $('qfClose').addEventListener('click', closeQF);
  $('qf').addEventListener('pointerdown', (e) => { if (e.target.id === 'qf') closeQF(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('qf').hidden) closeQF(); });
  function drawQF() {
    const body = $('qfBody'); body.innerHTML = '';
    if (qf.items) return drawReview(body);
    const ta = h('textarea', { id: 'qfText', rows: 8, placeholder: 'e.g. ' + qfExample() }); ta.value = qf.text || ''; ta.addEventListener('input', () => { qf.text = ta.value; });
    const fileIn = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf,.txt,.md,.csv', class: 'sr', id: 'qfFile' });
    const chip = h('div', { class: 'note' });
    const drawChip = () => { chip.innerHTML = ''; if (qf.file) chip.append(h('span', { class: 'tag g', text: 'added' }), ' ' + qf.file.name + ' (' + fmtSize(qf.file.size) + ') ', h('button', { type: 'button', class: 'linkbtn', text: 'Remove', onclick: () => { qf.file = null; drawChip(); } })); };
    fileIn.addEventListener('change', () => { qf.file = fileIn.files[0] || null; drawChip(); }); drawChip();
    const keep = Platform.filesReady ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: qf.keep ? true : null, onchange: (e) => { qf.keep = e.target.checked; } }), 'Also keep the document in this blueprint') : null;
    const status = h('div', { class: 'note', id: 'qfStatus', 'aria-live': 'polite' });
    const go = h('button', { class: 'primary', text: aiOn() ? 'Fill the blueprint' : 'Save as notes', onclick: () => runQF(go, status) });
    body.append(
      h('p', { class: 'help', text: 'Describe the event in your own words. On a phone, tap the microphone on your keyboard and just talk: what it is, who it’s for, when and where, the feel, the programme, partners. You can also add a programme, brochure, sponsor list or floor plan.' }),
      ta, h('div', { class: 'tools' }, h('label', { class: 'tpl', for: 'qfFile', role: 'button', tabindex: '0', text: 'Add a document', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } } }), fileIn), chip, keep,
      h('div', { class: 'note', text: aiOn() ? 'Nothing changes until you review what was found.' : 'AI filling isn’t available here, so your words are saved as notes for the build team.' }),
      status, h('div', { class: 'actions' }, go, h('button', { class: 'secondary', text: 'Cancel', onclick: closeQF })));
  }
  const qfExample = () => ({ gala: 'A one-night awards dinner for about 400 guests in Dubai next March. Black-tie, warm and proud. Red carpet, dinner, ceremony, then a party…', launch: 'We are revealing our new product to 300 guests and press in the spring, with a live countdown and demo areas…', festival: 'Three nights of music in the desert for 10,000 fans, two stages, food market, VIP deck…', private: 'Our wedding in a garden venue, about 250 guests, with family joining online from abroad…' }[S.type] || 'It’s a one-day event for about 500 people next spring. We want it to feel bold and premium. There’s a main stage, three smaller rooms and a networking lounge…');
  async function runQF(btn, status) {
    const words = (qf.text || '').trim();
    if (!words && !qf.file) { status.textContent = 'Say something or add a document first.'; return; }
    btn.disabled = true; status.classList.remove('err');
    try {
      if (words) { S.notes = (S.notes ? S.notes + '\n\n' : '') + `[${fmtDate(Date.now())}] ` + words; changed(); }
      let docText = '', images = [];
      if (qf.file) {
        const f = qf.file, ext = (f.name.split('.').pop() || '').toLowerCase();
        if (qf.keep && Platform.filesReady) { status.textContent = 'Keeping a copy of the document…'; try { await uploadFile(f, /plan|floor/i.test(f.name) ? 'Venue' : 'Other'); } catch (e) { } }
        if (/^image\//.test(f.type)) { const lim = await Platform.aiLimits(); if (!lim || !lim.images) throw { code: 'no_images', message: 'Pictures can’t be read here. Paste the text instead, or use a PDF.' }; images = [f]; }
        else if (ext === 'pdf' || f.type === 'application/pdf') { status.textContent = 'Reading the PDF…'; try { docText = await pdfText(f); } catch (e) { throw { code: 'pdf', message: 'This PDF couldn’t be read here. Screenshot the pages and add them as pictures, or paste the text.' }; } if (!docText) throw { code: 'pdf', message: 'This PDF has no readable text (it may be scanned). Add a screenshot of each page instead.' }; }
        else docText = (await f.text()).slice(0, 60000);
      }
      if (!aiOn()) { closeQF(); render(); toast('Saved as notes for the build team.'); return; }
      status.textContent = 'Reading and sorting…';
      const res = await Platform.aiJSON({ task: 'quickfill', input: { words: words.slice(0, 20000), docText: docText.slice(0, 60000), fileName: (qf.file && qf.file.name) || '' }, prompt: qfPrompt(words, docText, qf.file && qf.file.name, images.length) }, { tier: (words.length + docText.length) > 4000 || images.length ? 'default' : 'quick', images });
      qf.items = buildProposals(res || {});
      if (!qf.items.length) { status.textContent = 'Nothing new was found to fill in. Your words were saved as notes.'; btn.disabled = false; return; }
      drawQF();
    } catch (e) {
      status.classList.add('err');
      if (e && e.message && ['no_images', 'pdf'].includes(e.code)) status.textContent = e.message; else aiNote(status, e);
      btn.disabled = false;
    }
  }
  function qfPrompt(words, docText, fileName, hasImage) {
    return `You are filling in an event planning form from the organiser's own words and documents. The event can be of any kind. Extract only what the text states or clearly implies. Never invent names, dates, numbers, venues or sponsors. Leave out anything not covered. For fields with fixed options, copy one option exactly or leave the field out.

Fixed options:
type: ${TYPES.map(t => t.id + ' (' + t.n + ')').join('; ')}
path: twin (an event that exists or already happened), new (a new idea), both (a new event, in person and online)
format: ${FORMATS.join(' | ')}
goals: ${GOALS.join(' | ')}
mood: ${MOODS.join(' | ')}
languages: ${LANGS.join(' | ')}
look.style: ${LOOKS.join(' | ')}
look.setting: ${SETTINGS.join(' | ')}
online.features: ${FEATURES.join(' | ')}
online.access: ${ACCESS.join(' | ')}
partners.regulated: ${REGULATED.join(' | ')}
partner tier: Title | Platinum | Gold | Silver | Bronze | Exhibitor | Media | Supporter

Reply with only JSON in this shape, omitting unknown keys:
{"type":"","path":"","format":"","basics":{"title":"","host":"","purpose":"","when":"","duration":"","location":"","attendance":"","audience":"","languages":[],"budget":"","success":""},"concept":{"goals":[],"bigIdea":"","feeling":"","signature":"","mood":[],"mustHave":"","avoid":""},"spaces":[{"name":"","purpose":"","cap":""}],"programme":[{"time":"","title":"","space":"","who":""}],"people":{"hosts":[{"name":"","role":""}],"segments":[{"label":"","pct":0}],"staff":""},"partners":{"has":"yes|no","regulated":"","list":[{"name":"","tier":"","notes":""}]},"look":{"style":[],"palette":"","venueKind":"real|imagined","venueName":"","dims":"","setting":""},"online":{"features":[],"access":""},"delivery":{"deadline":"YYYY-MM-DD","owner":"","approver":""}}

For a floor plan, list each room or zone as a space, with its size in "purpose" (for example "24 x 18 m, ceiling 6 m"), its floor area in square metres in "area" when known, and its layout in "layout" (one of: ${LAYOUT_NAMES.join(' | ')}); put overall notes in look.dims.
${words ? `\nThe organiser's own words:\n"""${words.slice(0, 20000)}"""` : ''}${docText ? `\n\nText of the document "${fileName}":\n"""${docText.slice(0, 60000)}"""` : ''}${hasImage ? `\n\nThe attached picture "${fileName}" is from the organiser: a programme, brochure, list or floor plan. Read it.` : ''}`;
  }
  function buildProposals(r) {
    if (!plain(r)) r = {};
    const out = [], pick = (v, list) => list.find(x => x.toLowerCase() === String(v ?? '').trim().toLowerCase());
    const s200 = (v) => str(v, 600).trim(), sub = (o) => plain(o) ? o : {};
    const txt = (p, label, v) => { v = s200(v); if (!v) return; const cur = String(get(p) ?? '').trim(); if (cur === v) return; out.push({ label, now: v, old: cur, on: !cur, apply: () => setQuiet(p, v) }); };
    const one = (p, label, v, list, disp) => { const val = pick(v, list); if (!val) return; const cur = get(p); if (cur === val) return; out.push({ label, now: disp ? disp(val) : val, old: cur ? (disp ? disp(cur) : cur) : '', on: !cur, apply: () => setQuiet(p, val) }); };
    const multi = (p, label, arr, list) => { if (!Array.isArray(arr)) return; const vals = [...new Set(arr.map(x => pick(x, list)).filter(Boolean))], cur = get(p), add = vals.filter(x => !cur.includes(x)); if (!add.length) return; out.push({ label, now: 'Add ' + add.join(', '), old: '', on: true, apply: () => setQuiet(p, [...get(p), ...add]) }); };
    const rowset = (p, label, noun, arr, mk, prev) => { if (!Array.isArray(arr)) return; const rws = arr.map(mk).filter(Boolean).slice(0, 40); if (!rws.length) return; const cur = get(p).filter(prev); out.push({ label, now: `${rws.length} ${noun}: ` + rws.slice(0, 6).map(prev).join(' · ') + (rws.length > 6 ? ' …' : ''), old: cur.length ? `your ${cur.length} current ${noun}` : '', on: !cur.length, apply: () => setQuiet(p, rws) }); };
    one('type', 'Event type', r.type, TYPES.map(t => t.id), (v) => (TYPES.find(t => t.id === v) || {}).n || v);
    one('path', 'Starting point', r.path, PATHS.map(p => p.id), (v) => (PATHS.find(p => p.id === v) || {}).t || v);
    one('format', 'Format', r.format, FORMATS);
    const b = sub(r.basics);
    [['title', 'Title'], ['host', 'Host'], ['purpose', 'Purpose'], ['when', 'When'], ['duration', 'Duration'], ['location', 'Where'], ['attendance', 'Attendance'], ['audience', 'Audience'], ['budget', 'Budget'], ['success', 'Success measures']].forEach(([k, l]) => txt('basics.' + k, l, b[k]));
    multi('basics.languages', 'Languages', b.languages, LANGS);
    const k = sub(r.concept);
    multi('concept.goals', 'Goals', k.goals, GOALS); multi('concept.mood', 'Mood', k.mood, MOODS);
    [['bigIdea', 'Big idea'], ['feeling', 'Feeling'], ['signature', 'Signature moment'], ['mustHave', 'Must-haves'], ['avoid', 'Things to avoid']].forEach(([x, l]) => txt('concept.' + x, l, k[x]));
    rowset('spaces', 'Spaces', 'spaces', r.spaces, s => plain(s) && str(s.name) ? ROW.space(s) : null, s => s.name);
    rowset('programme.rows', 'Programme', 'items', r.programme, x => plain(x) && str(x.title) ? ROW.prog(x) : null, x => [x.time, x.title].filter(Boolean).join(' '));
    const pe = sub(r.people);
    rowset('people.hosts', 'Named people', 'people', pe.hosts, x => plain(x) && str(x.name) ? { ...ROW.host(x), consent: '' } : null, x => x.name);
    rowset('people.segments', 'Audience mix', 'groups', pe.segments, x => plain(x) && str(x.label) ? ROW.seg(x) : null, x => x.label);
    txt('people.staff', 'Staff', pe.staff);
    const pa = sub(r.partners);
    one('partners.has', 'Partners', pa.has, ['yes', 'no'], v => v === 'yes' ? 'Yes' : 'No');
    one('partners.regulated', 'Regulated industry', pa.regulated, REGULATED);
    rowset('partners.list', 'Partner list', 'partners', pa.list, x => plain(x) && str(x.name) ? { name: s200(x.name), tier: pick(x.tier, ['Title', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Exhibitor', 'Media', 'Supporter']) || '', notes: s200(x.notes) } : null, x => x.name);
    const lo = sub(r.look);
    multi('look.style', 'Style', lo.style, LOOKS); txt('look.palette', 'Colours', lo.palette);
    one('look.venueKind', 'Venue', lo.venueKind, ['real', 'imagined'], v => v === 'real' ? 'A real venue' : 'Imagined');
    txt('look.venueName', 'Venue name', lo.venueName); txt('look.dims', 'Dimensions and notes', lo.dims); one('look.setting', 'Setting', lo.setting, SETTINGS);
    const on = sub(r.online);
    multi('online.features', 'Online features', on.features, FEATURES); one('online.access', 'Access', on.access, ACCESS);
    const de = sub(r.delivery);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(de.deadline || ''))) txt('delivery.deadline', 'Deadline', de.deadline);
    txt('delivery.owner', 'Owner', de.owner); txt('delivery.approver', 'Approver', de.approver);
    return out;
  }
  function drawReview(body) {
    const items = qf.items, count = h('span');
    const upd = () => { const n = items.filter(i => i.on).length; count.textContent = String(n); apply.disabled = !n; };
    const apply = h('button', { class: 'primary', onclick: () => { const sel = items.filter(i => i.on); for (const i of sel) i.apply(); if (sel.some(i => i.label === 'Event type') && !S.avatars.prefilled) prefillAvatars(); changed(); closeQF(); render(); toast(`${sel.length} item${sel.length > 1 ? 's' : ''} filled in`); } }, 'Fill in ', count);
    body.append(h('p', { class: 'help', text: `Found ${items.length} thing${items.length > 1 ? 's' : ''}. Untick anything you don’t want. Items that would replace something you already wrote start unticked.` }),
      h('ul', { class: 'qlist' }, items.map(i => { const cb = h('input', { type: 'checkbox', checked: i.on ? true : null, onchange: (e) => { i.on = e.target.checked; upd(); } });
        return h('li', null, h('label', null, cb, h('div', null, h('div', { class: 'ql', text: i.label }), h('div', { class: 'qv', text: i.now }), i.old ? h('div', { class: 'qo', text: 'Replaces: ' + cut(i.old, 90) }) : null))); })),
      h('div', { class: 'actions' }, apply, h('button', { class: 'secondary', text: 'Back', onclick: () => { qf.items = null; drawQF(); } })));
    upd();
  }

  // ---------- brief ----------
  function briefModel(s) {
    const t = TYPES.find(x => x.id === s.type), P = PATHS.find(p => p.id === s.path), YN = { yes: 'Yes', no: 'No', notyet: 'Not yet', partial: 'Partly' };
    const kv = (o) => o.filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]);
    return [
      ['Status', kv([['Reference', s.ref], ['Stage', s.status !== 'draft' ? (STATUSES.find(x => x[0] === s.status) || [])[1] : ''], ['Submitted', s.submissions.length ? fmtDate(s.submissions[0].at) : ''], ['Updates sent', s.submissions.filter(x => x.kind === 'update').length || '']])],
      ['Overview', kv([['Title', s.basics.title], ['Type', t ? (t.id === 'other' ? s.typeOther : t.n) : ''], ['Starting point', P && P.t], ['Format', s.format], ['Host', s.basics.host], ['Purpose', s.basics.purpose], ['Audience', s.basics.audience], ['When', s.basics.when], ['Duration', s.basics.duration], ['Where', s.basics.location], ['Attendance', s.basics.attendance], ['Food and drink', s.basics.food], ['Languages', s.basics.languages], ['Budget', s.basics.budget], ['Success', s.basics.success]])],
      ['Concept', kv([['Goals', s.concept.goals], ['Big idea', s.concept.bigIdea], ['Feeling', s.concept.feeling], ['Signature moment', s.concept.signature], ['Mood', s.concept.mood], ['Must-haves', s.concept.mustHave], ['Avoid', s.concept.avoid], ['References', s.concept.refs]])],
      ['Spaces', null, ['Space', 'Purpose', 'Layout', 'Capacity', 'Area m²'], s.spaces.filter(r => r.name.trim()).map(r => [r.name, r.purpose, r.layout, r.cap, r.area])],
      ['Reality checks', null, ['Level', 'Check', 'Suggested fix', 'Your decision'], realityChecks(s).map(c => [LVL[c.lvl][0], c.title + '. ' + c.detail, c.fix, isAck(s, c) ? 'Accepted as is' : c.lvl === 'info' ? '' : 'Open'])],
      ['Numbers to plan with', null, ['What', 'Number', 'Basis'], planNumbers(s).list.map(n => [n.label, n.value, n.note + (n.src.length ? ' Source: ' + n.src.map(k => SRC[k][0]).join('; ') + '.' : '')])],
      ['Programme', kv([['Programme link', s.programme.agendaLink]]), ['When', 'What', 'Where', 'Who'], s.programme.rows.filter(r => r.title.trim()).map(r => [r.time, r.title, r.space, r.who])],
      ['People', kv([['Staff', s.people.staff]]), ['Group', '%'], s.people.segments.filter(r => r.label.trim()).map(r => [r.label, r.pct])],
      ['Named people', null, ['Name', 'Role', 'Consent'], s.people.hosts.filter(r => r.name.trim()).map(r => [r.name, r.role, r.consent || 'Not recorded'])],
      ['Avatars', kv([['Style', (AV_STYLES.find(a => a[0] === s.avatars.style) || [])[1]], ['Dress code', s.avatars.dress], ['Crowd', [s.avatars.mix, s.avatars.mixNote].filter(Boolean).join('. ')], ['Guest avatars', s.avatars.own], ['Real people', s.avatars.likeness], ['Abilities', s.avatars.abilities]]), ['Role', 'Badge colour'], s.avatars.lanyards.filter(r => r.role.trim()).map(r => [r.role, r.colour])],
      ['Partners', kv([['Partners', YN[s.partners.has]], ['Regulated', s.partners.regulated], ['Artwork', s.partners.artwork]]), ['Partner', 'Tier', 'Notes'], s.partners.has === 'yes' ? s.partners.list.filter(r => r.name.trim()).map(r => [r.name, r.tier, r.notes]) : []],
      ['Venue and look', kv([['Brand guidelines', YN[s.look.brand]], ['Brand files', s.look.brandLink], ['Style', s.look.style], ['Colours', s.look.palette], ['Venue', { real: 'Real venue', imagined: 'Imagined', undecided: 'Not decided' }[s.look.venueKind]], ['Venue name', s.look.venueName], ['Floor plans', YN[s.look.plans]], ['Photos', YN[s.look.photos]], ['Dimensions', s.look.dims], ['Setting', s.look.setting], ['Scale', s.look.scale]])],
      ['Online', kv([['Features', s.online.features], ['Access', s.online.access], ['Devices', s.online.devices], ['Accessibility', s.online.a11y], ['Notes', s.online.extra]])],
      ['Delivery', kv([['Deadline', s.delivery.deadline], ['Owner', s.delivery.owner], ['Approver', s.delivery.approver], ['Registration', s.delivery.registration], ['Video host', s.delivery.video], ['Privacy', s.delivery.privacy], ['Notes', s.delivery.notes]])],
      ['Files', kv([['Folder', s.files.drive], ['Folders ready', s.files.have], ['Recordings', s.files.recordings], ['Rights', YN[s.files.rights]]]), ['File', 'Type', 'Size'], s.files.uploads.map(u => [u.name, u.cat, fmtSize(u.size)])],
      ['Section owners', null, ['Section', 'Owner', 'Email'], SECTIONS.filter(x => s.owners && s.owners[x.id]).map(x => [x.n, s.owners[x.id].name, s.owners[x.id].email])],
      ['In your own words', kv([['Notes', s.notes]])],
    ];
  }
  function renderBrief(s) {
    const box = h('div', { class: 'brief' });
    for (const [title, kv, head, rowsData] of briefModel(s)) {
      const hasKV = kv && kv.length, hasRows = rowsData && rowsData.length;
      if (!hasKV && !hasRows) continue;
      box.append(h('h3', { text: title }));
      if (hasKV) box.append(h('dl', null, kv.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
      if (hasRows) box.append(h('div', { style: 'overflow-x:auto' }, h('table', null, h('thead', null, h('tr', null, head.map(x => h('th', { text: x })))), h('tbody', null, rowsData.map(r => h('tr', null, r.map(c => h('td', { text: c || '' }))))))));
    }
    if (!box.children.length) box.append(h('p', { class: 'muted', text: 'Nothing filled in yet.' }));
    return box;
  }
  function toMarkdown(s) {
    const sc = score(s), out = [`# ${s.basics.title || 'Untitled event'} — Event Blueprint`, '', `Readiness: ${sc.pct}% · ${sc.blocking.length} needed · ${sc.nice.length} optional · Blueprint ID: ${s.id}${s.ref ? ' · Reference: ' + s.ref : ''}`, ''];
    for (const [title, kv, head, rowsData] of briefModel(s)) {
      if (!(kv && kv.length) && !(rowsData && rowsData.length)) continue;
      out.push(`## ${title}`, '');
      for (const [k, v] of kv || []) out.push(`- **${k}:** ${v.replace(/\n+/g, ' ')}`);
      if (rowsData && rowsData.length) { if (kv && kv.length) out.push(''); out.push('| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'); for (const r of rowsData) out.push('| ' + r.map(c => String(c || '').replace(/\|/g, '/').replace(/\n+/g, ' ')).join(' | ') + ' |'); }
      out.push('');
    }
    const chg = s.baseline ? diffStates(s.baseline, s) : [];
    if (chg.length) { out.push('## Changes not sent yet', ''); for (const c of chg) out.push('- ' + c.text); out.push(''); }
    if (sc.blocking.length || sc.nice.length) { out.push('## Still missing', ''); for (const x of sc.blocking) out.push(`- [needed] ${x.label}`); for (const x of sc.nice) out.push(`- [optional] ${x.label}`); }
    return out.join('\n');
  }

  // ---------- render ----------
  const INTRO = {
    start: 'Three choices set everything else up. Pick what fits best; you can change it later.',
    basics: 'The facts anyone on the team would need in the first meeting.',
    concept: '', spaces: 'Every room or zone, in the order a guest meets them.', programme: 'What happens, when and where.',
    people: 'Who is there, and who may be shown by name.', avatars: 'How people look in the online event, and what they can do there.',
    partners: 'Who supports the event, and what they are allowed to show.', look: 'How it should look, and where it takes place.',
    online: 'What a guest can do in the online version.', delivery: 'Dates, owners and the systems involved.',
    files: 'Upload files here, or keep them in one shared folder with a fixed structure.', review: '',
  };
  function render() {
    if (ackView) return renderAck();
    const sec = SECTIONS[step], main = $('main'), y = window.scrollY;
    main.innerHTML = '';
    const intro = sec.id === 'concept' ? (fresh() ? 'Shape the idea before the logistics. Use the studio for three directions, or write your own.' : 'For an existing event, say what the online version should add. Goals and mood help the build team match the feel.')
      : sec.id === 'review' ? (S.status === 'draft' ? 'Check it over, then submit. You get a reference number and can follow progress here.' : 'Track progress, approve the plan and preview, and send any changes.') : INTRO[sec.id];
    const title = sec.id === 'review' ? (S.status === 'draft' ? 'Review and submit' : 'Progress') : sec.t;
    const qfBtn = sec.id !== 'review' && sec.id !== 'start' ? h('button', { type: 'button', class: 'ghostbtn qfbtn', text: 'Talk it through', onclick: openQF }) : null;
    main.append(h('section', { class: 'panel', 'aria-labelledby': 'secTitle' }, h('div', { class: 'phead' }, h('div', { class: 'phrow' }, h('div', { class: 'eyebrow', text: `Step ${step + 1} · ${sec.n}` }), qfBtn), h('h2', { id: 'secTitle', text: title }), intro ? h('p', { text: intro }) : null, sec.id !== 'review' ? ownerLine(sec) : null), h('div', { class: 'fields' }, R[sec.id](), LIVE_SECS.includes(sec.id) ? live('reality:' + sec.id) : null)));
    renderNav(); updateChrome(); refreshLive(true);
    window.scrollTo(0, y);
  }
  function goto(i) { ackView = null; step = Math.max(0, Math.min(SECTIONS.length - 1, i)); render(); window.scrollTo({ top: 0 }); try { localStorage.setItem('eb-step-' + S.id, String(step)); } catch (e) { } }
  $('prevBtn').addEventListener('click', () => goto(step - 1));
  $('nextBtn').addEventListener('click', () => { if (step === SECTIONS.length - 1) { remoteSave(); showHome(); } else goto(step + 1); });
  $('homeBtn').addEventListener('click', () => { remoteSave(); showHome(); });

  function normalise(bp) { return sanitise(bp); }
  function openBlueprint(bp) {
    S = normalise(bp); ackView = null;
    try { step = parseInt(localStorage.getItem('eb-step-' + S.id) || '0', 10) || 0; } catch (e) { step = 0; }
    $('home').hidden = true; $('studio').hidden = false; $('nav').hidden = false; $('steps').hidden = false; $('homeBtn').hidden = false;
    try { localStorage.setItem('eb-cur', S.id); } catch (e) { }
    setSave(Platform.mode === 'local' || !Platform.canWrite ? 'Saved on this device' : 'Saved');
    render(); window.scrollTo({ top: 0 });
  }
  function newBlueprint(from) { const b = from ? cloneState(sanitise(from), true) : blank(); openBlueprint(b); localSave(); dirty = true; remoteSave(); }

  // ---------- home ----------
  async function showHome() {
    S = null; ackView = null; $('home').hidden = false; $('studio').hidden = true; $('nav').hidden = true; $('steps').hidden = true; $('homeBtn').hidden = true; $('ring').hidden = true; $('statusBar').hidden = true; $('subTitle').textContent = 'Plan any event, then build it'; saveState = '';
    try { localStorage.removeItem('eb-cur'); } catch (e) { }
    const home = $('home'); home.innerHTML = '';
    home.append(h('div', { class: 'hero' }, h('div', { class: 'eyebrow', text: 'Event Blueprint' }), h('h1', { text: 'From an idea, or a real event, to a ready-to-build brief.' }),
      h('p', { text: 'Launches, galas, festivals, conferences, weddings, exhibitions: answer guided questions once, or just talk it through. The page shows what is missing, helps shape the concept, and tracks your blueprint from submission to live.' }),
      h('div', { class: 'actions' }, h('button', { class: 'primary', text: 'Start a new blueprint', onclick: () => newBlueprint() }), h('button', { class: 'secondary', text: 'Start by talking it through', onclick: () => { newBlueprint(); openQF(); } }))));
    home.append(h('div', { class: 'flow' }, [['Describe', 'Talk it through, add documents, or fill in guided steps.'], ['Shape', 'Concept, spaces, programme, people, avatars and look, with templates and AI help.'], ['Submit', 'Get a reference number and a clear list of what happens next.'], ['Track', 'Follow each stage, approve the plan and preview, and send changes as updates.']].map(([b, t]) => h('div', null, h('b', { text: b }), t))));
    const list = h('div', { class: 'saved' }); home.append(h('div', { class: 'f' }, h('h2', { style: 'font-size:28px', text: 'Your blueprints' }), list));
    const tlist = h('div', { class: 'saved' }), tsec = h('div', { class: 'f', hidden: true }, h('h2', { style: 'font-size:28px', text: 'Templates' }), h('div', { class: 'help', text: 'Saved formats to start the next edition from.' }), tlist); home.append(tsec);
    list.append(h('p', { class: 'muted', text: 'Loading…' }));
    const items = await listBlueprints(); list.innerHTML = '';
    if (!items.length) list.append(h('p', { class: 'muted', text: 'Nothing yet. Your blueprints appear here with their progress.' }));
    for (const it of items) {
      const st = STATUSES.find(x => x[0] === (it.status || 'draft')) || STATUSES[0];
      list.append(h('div', { class: 'svrow' },
        h('button', { class: 'sv', onclick: () => loadAndOpen(it.id) },
          h('div', { style: 'min-width:0' }, h('div', { class: 'st', text: it.title || 'Untitled event' }), h('div', { class: 'sm', text: [(TYPES.find(t => t.id === it.type) || {}).n, it.ref, it.updated ? 'Edited ' + new Date(it.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(' · ') })),
          h('div', { class: 'svmeta' }, h('span', { class: 'pill s-' + st[0], text: st[1] }), it.pendingChanges ? h('span', { class: 'tag a', text: it.pendingChanges + ' unsent' }) : it.readiness != null && st[0] === 'draft' ? h('span', { class: 'mono sm', text: it.readiness + '%' }) : null)),
        h('button', { class: 'ghostbtn', text: 'Duplicate', 'aria-label': 'Duplicate ' + (it.title || 'blueprint'), onclick: async () => { const bp = await fetchBP(it.id); if (bp) { const c = cloneState(bp, false); c.basics.title = (bp.basics && bp.basics.title || 'Untitled event') + ' (copy)'; openBlueprint(c); localSave(); dirty = true; remoteSave(); toast('Duplicated. You are now editing the copy.'); } } })));
    }
    const tps = (await Platform.listTemplates().catch(() => []) || []).filter(t => plain(t) && plain(t.state) && (Platform.mode !== 'artifact' || !Platform.userId || t.ownerId === Platform.userId)).map(t => ({ ...t, name: str(t.name, 80) || 'Untitled template', type: str(t.type, 40), created: num(t.created, 0, 1e14) || Date.now() }));
    if (tps && tps.length) { tsec.hidden = false; for (const t of tps) tlist.append(h('div', { class: 'svrow' }, h('div', { class: 'sv', style: 'cursor:default' }, h('div', { style: 'min-width:0' }, h('div', { class: 'st', text: t.name }), h('div', { class: 'sm', text: [(TYPES.find(x => x.id === t.type) || {}).n, new Date(t.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })].filter(Boolean).join(' · ') }))), h('button', { class: 'secondary', text: 'Use', onclick: () => { newBlueprint(t.state); toast('Started from “' + t.name + '”'); } }))); }
  }
  async function listBlueprints() {
    let local = []; try { local = JSON.parse(localStorage.getItem('eb-list') || '[]'); } catch (e) { }
    try { const remote = (await Platform.list()).map(v => ({ id: v.id, title: v.title || (v.basics && v.basics.title), type: v.type, updated: v.updated, readiness: v.readiness, status: v.status, ref: v.ref, pendingChanges: v.pendingChanges }));
      const ids = new Set(remote.map(r => r.id)); return [...remote, ...local.filter(l => !ids.has(l.id))].sort((a, b) => (b.updated || 0) - (a.updated || 0)); } catch (e) { return local; }
  }
  async function fetchBP(id) {
    let bp = null; try { bp = JSON.parse(localStorage.getItem('eb-' + id) || 'null'); } catch (e) { }
    try { const v = await Platform.load(id); if (v && (!bp || (v.updated || 0) >= (bp.updated || 0))) bp = v; }
    catch (e) { if (Platform.mode === 'api' && e && e.status === 404) { forgetLocal(id); return null; } } // EA-SYS: gone on the server, so never revive the device copy
    return bp;
  }
  function forgetLocal(id) {
    try { localStorage.removeItem('eb-' + id); if (localStorage.getItem('eb-cur') === id) localStorage.removeItem('eb-cur');
      localStorage.setItem('eb-list', JSON.stringify(JSON.parse(localStorage.getItem('eb-list') || '[]').filter(x => x.id !== id))); } catch (e) { }
  }
  async function loadAndOpen(id) { const bp = await fetchBP(id); if (bp) openBlueprint(bp); else toast('Couldn’t open that blueprint.'); }

  // ---------- utils ----------
  let toastT; function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }
  function copy(text, ok) { try { navigator.clipboard.writeText(text).then(() => toast(ok), () => fallbackCopy(text, ok)); } catch (e) { fallbackCopy(text, ok); } }
  function fallbackCopy(text, ok) { const ta = h('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Select and copy it manually.'); } ta.remove(); }

  // ---------- boot ----------
  const hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(() => ({ S, step }));
  async function boot() {
    await Platform.init();
    const hd = hot && hot.data;
    let cur = null; try { cur = localStorage.getItem('eb-cur'); } catch (e) { }
    if (hd && hd.S) { openBlueprint(hd.S); step = hd.step || 0; render(); }
    else if (cur) { const bp = await fetchBP(cur); if (bp) openBlueprint(bp); else showHome(); }
    else showHome();
  }
  boot();
  window.__EB = { get sketchDraws() { return sketchDraws; }, realityChecks: () => realityChecks(S), planNumbers: () => planNumbers(S), sketch: () => sketchModel(S), applyPack, get S() { return S; }, score: () => score(S), toMarkdown: () => toMarkdown(S), goto, Platform, newBlueprint, openBlueprint, pending, openQF };
})();
