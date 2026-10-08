// ---------- Stage 3: benchmarks, reality checks, planning numbers, layout sketch, starter packs ----------
// Every figure below carries the source it came from. Thresholds are planning guides: the venue licence and the
// local fire authority set the legal capacity of a room.
const SRC = {
  reventals: ['Reventals: how much event space you need', 'https://www.reventals.com/blog/how-much-event-space-do-you-need/'],
  mity: ['MityLite: calculating venue capacity', 'https://mitylite.com/blog/calculating-venue-capacity'],
  calcimator: ['Calcimator: venue capacity by layout', 'https://calcimator.com/calculators/travel/event-venue-capacity'],
  still: ['G. Keith Still: standing crowd density', 'https://www.gkstill.com/Support/crowd-density/CrowdDensity-1.html'],
  venuesight: ['VenueSight: trade show floor plan design', 'https://venuesight.com/blog/trade-show-floor-plan-design'],
  shell: ['Orange Fairs: shell scheme booth sizes', 'https://www.orangefairs.com/blogs/shell-scheme-booth-sizes/'],
  on24: ['ON24 Webinar Benchmarks 2025', 'https://www.on24.com/blog/key-takeaways-from-the-2025-webinar-benchmarks-report/'],
  bizzabo: ['Bizzabo: check-in staffing formulas', 'https://www.bizzabo.com/blog/onsite-event-check-in-staffing-formulas'],
  staff: ['Reventals: event staff and food', 'https://www.reventals.com/blog/calculate-event-staff-food/'],
  lead: ['GreatEvent: venue booking lead times', 'https://www.greatevent.com/how-far-in-advance-to-book-a-conference-venue/'],
  timeline: ['Fourwaves: conference planning timeline', 'https://fourwaves.com/blog/conference-planning-timeline/'],
};
const SQFT = 0.092903; // m² per square foot
// ok = comfortable planning space per person (m²); tight = the least space the sources accept; empty = feels empty above this
const LAYOUTS = [
  { k: 'theatre', n: 'Theatre', d: 'rows of chairs facing a stage', ok: 9 * SQFT, tight: 7 * SQFT, src: ['reventals', 'calcimator'], aspect: 1.25, seated: 1 },
  { k: 'classroom', n: 'Classroom', d: 'tables facing the front', ok: 17.5 * SQFT, tight: 14.5 * SQFT, src: ['reventals'], aspect: 1.25, seated: 1 },
  { k: 'banquet', n: 'Banquet rounds', d: 'round tables of 10 for meals', ok: 12 * SQFT, tight: 11 * SQFT, src: ['reventals', 'mity'], aspect: 1.35, seated: 1 },
  { k: 'cabaret', n: 'Cabaret', d: 'part-filled rounds facing a stage', ok: 18 * SQFT, tight: 16.5 * SQFT, src: ['reventals'], derived: 'Estimate: cabaret seats about two-thirds of each round, so it needs about 1.5 times banquet space.', aspect: 1.35, seated: 1 },
  { k: 'reception', n: 'Standing reception', d: 'drinks, canapés, mingling', ok: 9.5 * SQFT, tight: 5 * SQFT, src: ['reventals', 'calcimator'], aspect: 1.4 },
  { k: 'boardroom', n: 'Boardroom', d: 'one table', ok: 40 * SQFT, tight: 25 * SQFT, src: ['reventals', 'calcimator'], aspect: 2, seated: 1 },
  { k: 'ushape', n: 'U-shape', d: 'tables in a U', ok: 35 * SQFT, src: ['reventals'], aspect: 1.4, seated: 1 },
  { k: 'expo', n: 'Exhibition stands', d: 'stands and visitors', ok: 15 * SQFT, tight: 10 * SQFT, empty: 40 * SQFT, src: ['venuesight'], aspect: 1.6 },
  { k: 'crowd', n: 'Standing crowd', d: 'concert or festival audience', ok: 0.5, tight: 0.2, src: ['still'], aspect: 1.3 },
  { k: 'open', n: 'Open or mixed', d: 'no fixed layout', aspect: 1.4 },
  { k: 'online', n: 'Online only', d: 'no physical room', aspect: 1.4 },
];
const LAYOUT_NAMES = LAYOUTS.map(l => l.n);
const layoutOf = (name) => LAYOUTS.find(l => l.n === name || l.k === name) || null;
const m2 = (v) => v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v));
const nf = (v) => Math.round(v).toLocaleString('en-GB');

// ----- parsing helpers (free-text answers stay free text; we say how we read them)
function parseNum(t) {
  t = String(t).toLowerCase().replace(/(\d)[   ](?=\d{3}\b)/g, '$1').replace(/(\d),(?=\d{3})/g, '$1'); // 20 000 and 20,000
  const tables = t.match(/(\d+)\s*tables?\s*(?:of|x|×)\s*(\d+)/); if (tables) return +tables[1] * +tables[2];
  // ignore numbers that count days, hours, editions, years and the like
  const re = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*(k\b|thousand|m\b|million)?(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)(?![\d.])\s*(k\b|thousand|m\b|million)?)?(?!\s*(?:days?|nights?|hours?|hrs?|weeks?|months?|years?|editions?|sessions?|tracks?|halls?|rooms?|stages?|tables?|%|am|pm|th|st|nd|rd)\b)/g;
  const mul = (u) => !u ? 1 : /^(k|thousand)$/.test(u) ? 1e3 : 1e6;
  let m, best = null;
  while ((m = re.exec(t))) { if (/^20[1-4]\d$/.test(m[1]) && !m[2] && /(?:\b(?:in|by|of|year|since|from|edition|class|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*|spring|summer|autumn|fall|winter|q[1-4])\s*)$/.test(t.slice(0, m.index))) continue; /* a year, not a headcount */ const a = parseFloat(m[1]) * mul(m[2] || m[4]), b = m[3] ? parseFloat(m[3]) * mul(m[4] || m[2]) : null; const v = Math.round(b && b > a ? b : a); if (v > 0 && (best == null || v > best)) best = v; }
  return best;
}
function parseAttendance(str, format) {
  const out = { inPerson: null, online: null }; const t = String(str || '').toLowerCase(); if (!t.trim()) return out;
  const allOnline = format === 'Virtual' || format === 'Online world only';
  for (const part of t.split(/\+|;|\/|,(?!\d{3})|\band\b|\bplus\b/)) {
    const n = parseNum(part); if (n == null) continue;
    if (/online|virtual|stream|remote|viewer|digital|watch/.test(part) || allOnline) out.online = (out.online || 0) + n;
    else if (out.inPerson == null) out.inPerson = n; else out.inPerson += n;
  }
  return out;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/g;
// Reads a date or a window. Day-first for numbers (12/03/2027 = 12 March). Returns null when there is no year.
function parseWhen(str) {
  const t = String(str || '').trim().toLowerCase(); if (!t) return null;
  const mk = (y, m, d, approx, label) => { const dt = new Date(y, m, d, 12); return isNaN(dt) || dt.getMonth() !== m ? { invalid: true } : { date: dt, approx, label }; };
  let m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/); if (m) return mk(+m[1], +m[2] - 1, +m[3], false);
  m = t.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/);
  if (m) { let d = +m[1], mo = +m[2]; if (mo > 12 && d <= 12) [d, mo] = [mo, d]; return mk(+m[3], mo - 1, d, false); }
  const years = [...t.matchAll(/\b(20\d{2})\b/g)]; if (!years.length) return null;
  // a month word counts only when it sits right next to a year (so "we may hold it in 2027" is not read as May)
  for (const ym of years) {
    const y = +ym[1], before = t.slice(Math.max(0, ym.index - 22), ym.index), after = t.slice(ym.index + 4, ym.index + 20);
    let mm = [...before.matchAll(MONTH_RE)].pop();
    if (mm && /^[\s,.\-]*(\d{1,2}(st|nd|rd|th)?[\s,.\-]*)?$/.test(before.slice(mm.index + mm[0].length))) {
      const mi = MONTHS.indexOf(mm[1].slice(0, 3)), dm = before.slice(0, mm.index).match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:-|–|to)\s*\d{1,2}(?:st|nd|rd|th)?)?\s*(?:of\s*)?$/) || before.slice(mm.index + mm[0].length).match(/^\s*(\d{1,2})(?:st|nd|rd|th)?/);
      const d = dm && +dm[1] >= 1 && +dm[1] <= 31 ? +dm[1] : null;
      return mk(y, mi, d || 15, !d);
    }
    const sea = before.match(/\b(spring|summer|autumn|fall|winter|early|mid|late|end of|q[1-4]|h[12])\s*$/);
    if (sea) {
      const k = sea[1], map = { spring: [3, 'spring'], summer: [6, 'summer'], autumn: [9, 'autumn'], fall: [9, 'autumn'], winter: [11, 'winter'], early: [1, 'early'], mid: [5, 'mid'], late: [10, 'late'], 'end of': [11, 'the end of'], q1: [1, 'Q1'], q2: [4, 'Q2'], q3: [7, 'Q3'], q4: [10, 'Q4'], h1: [2, 'H1'], h2: [8, 'H2'] }[k];
      return mk(y, map[0], 15, true, map[1]);
    }
  }
  return { date: new Date(+years[0][1], 6, 1, 12), approx: true, yearOnly: true };
}
function describeWhen(str) {
  const w = parseWhen(str); if (!String(str || '').trim()) return '';
  if (!w) return 'Add a year (for example “March 2027”) so we can check the timing.';
  if (w.invalid) return 'That date doesn’t exist. Check the day and month (we read numbers day first: 12/03/2027 is 12 March).';
  if (w.yearOnly) return `We read this as sometime in ${w.date.getFullYear()}. Add a month for timing checks.`;
  const f = w.approx ? { month: 'long', year: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  return w.label ? `We read this as ${w.label} ${w.date.getFullYear()} (we plan around ${w.date.toLocaleDateString('en-GB', f)}).` : `We read this as ${w.date.toLocaleDateString('en-GB', f)}.`;
}
const monthsBetween = (a, b) => (b - a) / (30.44 * 864e5);

// venue booking lead times, months (GreatEvent)
function leadTime(n, type) {
  if (n == null) return null;
  if (n < 100) return { min: 2, max: 6, band: 'under 100 guests' };
  if (n <= 500) return { min: 6, max: 12, band: '100 to 500 guests' };
  if (n <= 2000) return { min: 12, max: 18, band: '500 to 2,000 guests' };
  return type === 'expo' ? { min: 24, max: 36, band: 'large trade shows' } : { min: 18, max: 24, band: 'over 2,000 guests' };
}
const BIG_MOMENT = /keynote|opening|plenary|ceremony|award|gala|dinner|reveal|launch|headlin|closing|welcome address|kick-?off|finale|vows|toast/i;
const EXHIBITING = (p) => p.name.trim() && !/^(Media|Supporter)$/.test(p.tier || '');
const BUILD_WEEKS = 3; // the build team's own working estimate for a walkable venue, not an industry figure

function roomKeys(list) { const seen = {}; return list.map(r => { const b = r.name.trim().toLowerCase(); seen[b] = (seen[b] || 0) + 1; return seen[b] > 1 ? b + ' #' + seen[b] : b; }); }

// ----- reality checks: { id, sec, lvl: 'risk'|'watch'|'info', title, detail, fix, src }
function _realityChecks(s, now = Date.now()) {
  const out = [], add = (o) => out.push(o);
  const att = parseAttendance(s.basics.attendance, s.format), N = att.inPerson;
  const sp = s.spaces.filter(r => r.name.trim()), keys = roomKeys(sp), SK = new Map(sketchModel(s).rooms.map(r => [r.key, r]));
  const dupes = [...new Set(keys.filter(k => / #\d+$/.test(k)).map(k => k.replace(/ #\d+$/, '')))];
  for (const d of dupes) { const nm = sp.find(r => r.name.trim().toLowerCase() === d).name.trim(); add({ id: 'dupe:' + d, sec: 'spaces', lvl: 'watch', title: `Two or more spaces are called “${nm}”`, detail: 'The programme, signage and the online venue need a unique name for each space.', fix: 'Rename them, for example “' + nm + ' 1” and “' + nm + ' 2”.', src: [] }); }
  // 1. space per person by layout
  sp.forEach((r, i) => {
    const L = layoutOf(r.layout), cap = parseFloat(r.cap) || 0, area = parseFloat(r.area) || 0;
    if (!L || !L.ok || !cap || !area) return;
    const per = area / cap, rk = keys[i], key = 'density:' + rk, skr = SK.get(rk), nm = r.name.trim();
    const comfy = Math.floor(area / L.ok), drawn = L.seated && skr && skr.fits != null ? skr.fits : null;
    const best = drawn != null ? Math.min(comfy, drawn) : comfy; // one number to plan with
    const why = drawn != null && drawn < comfy ? `once the ${skr.items.some(x => x.t === 'stage') ? 'stage, ' : ''}aisles and ${L.k === 'theatre' ? 'seat rows' : L.k === 'classroom' ? 'tables' : 'round tables'} are drawn to scale` : `at about ${m2(L.ok)} m² per person for ${L.n.toLowerCase()}`;
    const basis = `${nf(cap)} people in ${nf(area)} m² is ${m2(per)} m² each; a ${L.n.toLowerCase()} layout usually needs about ${m2(L.ok)} m² per person` + (L.tight ? ` (${m2(L.tight)} m² at the very tightest)` : '') + '.' + (L.derived ? ' ' + L.derived : '');
    const fix = `Plan for about ${nf(best)} people here (${why}), or find about ${nf(cap * L.ok)} m². Check the venue’s capacity chart for this layout.`;
    if ((L.tight && per < L.tight) || (drawn != null && drawn < cap * 0.85)) add({ id: key, sec: 'spaces', lvl: 'risk', title: best < 5 ? `${nm} is far too small for ${nf(cap)} people` : `${nm}: about ${nf(best)} fit, not ${nf(cap)}`, detail: basis, fix, src: L.src });
    else if (per < L.ok || (drawn != null && drawn < cap)) add({ id: key, sec: 'spaces', lvl: 'watch', title: `${nm} will be tight: about ${nf(best)} fit comfortably, you have ${nf(cap)}`, detail: basis, fix, src: L.src });
    else if (L.empty && per > L.empty) add({ id: key, sec: 'spaces', lvl: 'watch', title: `${nm} may feel empty`, detail: `${m2(per)} m² per person. Above about ${m2(L.empty)} m² a show floor starts to feel empty.`, fix: 'Use part of the hall, add a feature area or seminar stage, or plan for more visitors.', src: L.src });
  });
  // 2. the biggest room vs the in-person crowd
  if (N && sp.length) {
    const seated = sp.filter(r => { const L = layoutOf(r.layout); return !L || L.k !== 'online'; });
    const big = seated.reduce((a, r) => (parseFloat(r.cap) || 0) > (parseFloat(a && a.cap) || 0) ? r : a, null);
    const bc = big ? parseFloat(big.cap) || 0 : 0;
    if (bc && bc < N * 0.9 && !['expo', 'festival', 'exhibition', 'community', 'sports'].includes(s.type)) add({ id: 'bigroom', sec: 'spaces', lvl: 'watch', title: `Your largest space holds ${nf(bc)}, but you expect ${nf(N)} in person`, detail: `If everyone gathers for one moment (an opening, a meal, a ceremony), ${big.name} is too small.`, fix: 'Add a larger space, plan an overflow room with a live feed, or split the moment into two sittings.', src: [] });
  }
  // 3. programme sanity
  const names = new Map(sp.map(r => [r.name.trim().toLowerCase(), r]));
  const seen = new Map();
  for (const p of s.programme.rows.filter(r => r.title.trim())) {
    const k = (p.space || '').trim().toLowerCase();
    if (k && !names.has(k)) add({ id: 'progspace:' + k, sec: 'programme', lvl: 'watch', title: `“${p.title}” is in ${p.space}, which isn’t on your list of spaces`, detail: 'The online venue is built from the spaces list, so this item would have nowhere to happen.', fix: 'Add the space, or pick one of the listed spaces for this item.', src: [] });
    const tk = (p.time || '').trim() + '|' + k;
    if (k && (p.time || '').trim()) { if (seen.has(tk)) add({ id: 'clash:' + tk, sec: 'programme', lvl: 'watch', title: `Two items at ${p.time} in ${p.space}`, detail: `“${seen.get(tk)}” and “${p.title}” are in the same space at the same time.`, fix: 'Move one to another space or time.', src: [] }); else seen.set(tk, p.title); }
    const r = names.get(k), cap = r ? parseFloat(r.cap) || 0 : 0;
    if (N && cap && cap < N * 0.9 && BIG_MOMENT.test(p.title)) add({ id: 'moment:' + p.title.toLowerCase(), sec: 'programme', lvl: 'watch', title: `“${p.title}” is in ${r.name} (${nf(cap)}), but ${nf(N)} are coming in person`, detail: 'Big shared moments usually need everyone in one room.', fix: 'Move it to your largest space, or plan an overflow with a live feed.', src: [] });
  }
  // 4. lead time to the event
  const when0 = parseWhen(s.basics.when), when = when0 && !when0.yearOnly && !when0.invalid ? when0 : null, fr = s.path === 'new' || s.path === 'both';
  if (when) {
    const mo = monthsBetween(now, when.date), lt = leadTime(N, s.type);
    if (mo < 0 && fr) add({ id: 'past', sec: 'basics', lvl: 'risk', title: 'The event date is in the past', detail: `We read “${s.basics.when}” as ${when.date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}.`, fix: 'Check the date.', src: [] });
    else if (fr && lt && mo >= 0 && mo < lt.min) add({ id: 'lead', sec: 'basics', lvl: mo < lt.min / 2 ? 'risk' : 'watch', title: `${mo < 1 ? 'Under a month' : Math.floor(mo) + ' month' + (Math.floor(mo) === 1 ? '' : 's')} to go is short for ${lt.band}`, detail: `Venues for ${lt.band} are usually booked ${lt.min} to ${lt.max} months ahead${when.approx ? ` (we read “${s.basics.when}” as about ${when.date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})` : ''}.`, fix: s.look.venueKind === 'real' && s.look.venueName.trim() ? 'If the venue is already confirmed, you are fine on venue; speakers, partners and production still need the time.' : 'Confirm the venue first, consider a later date, or a smaller format.', src: ['lead'] });
  }
  // 5. go-live deadline
  const dl = s.delivery.deadline ? new Date(s.delivery.deadline + 'T12:00:00') : null;
  if (dl && !isNaN(dl)) {
    const wk = (dl - now) / (7 * 864e5);
    if (wk < 0) add({ id: 'deadline-past', sec: 'delivery', lvl: 'risk', title: 'The go-live deadline has passed', detail: `It was ${dl.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`, fix: 'Set a new deadline.', src: [] });
    else if (wk < BUILD_WEEKS && s.online.features.includes('Walk the venue in 3D')) add({ id: 'deadline-short', sec: 'delivery', lvl: 'watch', title: `${Math.max(0, Math.round(wk * 7))} days until go-live`, detail: `The build team plans at least ${BUILD_WEEKS} weeks from complete files to a reviewed preview for a walkable venue. This is the team’s own working estimate, not an industry figure.`, fix: 'Move the deadline, or launch with fewer spaces first and add the rest later.', src: [] });
    if (when && dl > when.date && fr && s.format !== 'Virtual' && s.format !== 'Online world only') add({ id: 'deadline-after', sec: 'delivery', lvl: 'watch', title: 'The online version goes live after the event', detail: 'Fine for a recorded edition; not if guests should join online on the day.', fix: 'If online guests join live, set the deadline at least a week before the event.', src: [] });
  }
  // 6. stands vs exhibition space
  const stands = s.partners.has === 'yes' ? s.partners.list.filter(EXHIBITING).length : 0;
  const expo = sp.filter(r => (layoutOf(r.layout) || {}).k === 'expo');
  if (stands && expo.length) {
    const fit = expo.reduce((a, r) => a + (parseFloat(r.area) ? expoFit(Math.sqrt(parseFloat(r.area) * 1.6), parseFloat(r.area) / Math.sqrt(parseFloat(r.area) * 1.6)) : 0), 0);
    if (fit && fit < stands) add({ id: 'stands', sec: 'partners', lvl: 'watch', title: `${stands} stands, but the exhibition space fits about ${fit}`, detail: 'Counting 3 × 3 m stands (the most common size) in back-to-back rows with 3 m (10 ft) aisles.', fix: `Add about ${nf((stands - fit) * 9 * 2.2)} m² of floor, use smaller stands for some partners, or move some to a second hall.`, src: ['shell', 'venuesight'] });
  } else if (stands >= 3 && !expo.length && sp.length) add({ id: 'stands-nospace', sec: 'partners', lvl: 'watch', title: `${stands} partners, but no space is set up for stands`, detail: 'Partners usually expect a stand or a branded spot that guests walk past.', fix: 'Set one space’s layout to “Exhibition stands”, or note how partners appear (screens, sponsored areas).', src: [] });
  // 7. online turnout
  if (att.online && ['Free registration', 'Paid ticket', 'Invite only', 'Company or member login'].includes(s.online.access)) {
    add({ id: 'online-turnout', sec: 'online', lvl: 'info', title: `Of ${nf(att.online)} online registrations, expect about ${nf(att.online * 0.57)} to attend`, detail: 'The average registration-to-attendance rate for webinars in 2024 was 57%, and about 45% of viewing happened on demand.', fix: s.online.features.includes('On-demand library') || s.online.features.includes('Watch live or recorded sessions') ? 'Recordings are already planned, which catches the on-demand viewers.' : 'Add recordings or an on-demand library so the people who can’t join live still watch.', src: ['on24'] });
  }
  // 8. audience mix totals
  const segs = s.people.segments.filter(r => r.label.trim()), tot = segs.reduce((a, r) => a + (parseFloat(r.pct) || 0), 0);
  if (segs.length >= 2 && tot && Math.abs(tot - 100) > 2) add({ id: 'segs', sec: 'people', lvl: 'watch', title: `The audience mix adds up to ${tot}%`, detail: 'The AI crowd is built from these shares, so they need to total 100%.', fix: 'Adjust the percentages.', src: [] });
  // 9. what the sketch can physically fit (stage, aisles and tables drawn), for rooms not already flagged
  const flagged = new Set(out.filter(c => c.id.startsWith('density:')).map(c => c.id.slice(8)));
  for (const r of SK.values()) if (r.short && !r.assumed && !flagged.has(r.key) && !(r.standsWanted && r.standsFit < r.standsWanted)) add({ id: 'fit:' + r.key, sec: 'spaces', lvl: 'watch', title: `${r.name}: the sketch fits about ${nf(r.fits)} of ${nf(r.cap)}`, detail: `Once the ${r.items.some(i => i.t === 'stage') ? 'stage, ' : ''}aisles and ${r.L.k === 'theatre' ? 'rows' : r.L.k === 'banquet' || r.L.k === 'cabaret' ? 'round tables' : 'furniture'} are drawn in ${nf(r.w * r.d)} m², fewer people fit than the average figures suggest.`, fix: 'Try rotating or reshaping the room in the sketch, use the venue’s own capacity chart, or lower the number.', src: r.L.src || [] });
  const seenId = new Set(); return out.filter(c => seenId.has(c.id) ? false : seenId.add(c.id)).map(c => ({ ...c, sig: c.lvl + '|' + c.title }));
}

// ----- numbers to plan with
function _planNumbers(s) {
  const att = parseAttendance(s.basics.attendance, s.format), N = att.inPerson, out = [], food = s.basics.food || [];
  if (N) {
    out.push({ k: 'checkin', label: 'Check-in staff at the peak', value: String(Math.max(1, Math.ceil(N * 0.5 / 120))), note: `Assuming half of ${nf(N)} guests arrive in the busiest hour (our assumption; adjust to your doors-open plan), at about 120 check-ins per person per hour. Aim for under 5 minutes in the queue; QR check-in can halve the time per guest.`, src: ['bizzabo'] });
    if (food.includes('Seated (plated) meals')) out.push({ k: 'servers', label: 'Servers for a plated meal', value: String(Math.ceil(N / 25)), note: 'About one server per 25 seated guests.', src: ['staff'] });
    if (food.includes('Buffet meals')) out.push({ k: 'buffet', label: 'Servers for a buffet', value: String(Math.ceil(N / 40)), note: 'About one server per 40 guests.', src: ['staff'] });
    if (food.includes('Bar service')) out.push({ k: 'bar', label: 'Bartenders', value: String(Math.ceil(N / 50)), note: 'About one per 50 guests for standard service; one per 40 for cocktails.', src: ['staff'] });
    const lt = leadTime(N, s.type); if (lt) out.push({ k: 'lead', label: 'Typical venue booking lead time', value: `${lt.min}–${lt.max} months`, note: `For ${lt.band}.`, src: ['lead'] });
  }
  if (att.online) out.push({ k: 'live', label: 'Online guests likely to join', value: nf(att.online * 0.57), note: `57% of ${nf(att.online)} registrations (2024 webinar average). Plan recordings: about 45% of viewing is on demand.`, src: ['on24'] });
  for (const r of s.spaces.filter(r => r.name.trim())) {
    const L = layoutOf(r.layout), cap = parseFloat(r.cap) || 0;
    if (L && L.ok && cap && !(parseFloat(r.area) > 0)) out.push({ k: 'area:' + r.name, label: `Floor area for ${r.name}`, value: `about ${nf(cap * L.ok)} m²`, note: `${nf(cap)} people, ${L.n.toLowerCase()}, before stage, bars and buffets.${L.derived ? ' ' + L.derived : ''}`, src: L.src });
  }
  return { att, list: out };
}

// ----- layout sketch geometry (metres). Returns what physically fits each room.
function expoFit(w, d) { const per = Math.max(0, Math.floor((w - 6) / 3)), strips = Math.max(0, Math.floor((d - 3) / 9)); return per * strips * 2; }
function roomContent(L, w, d, cap, extra) {
  const items = [], k = L ? L.k : 'open'; let fits = null;
  const stageD = Math.min(5, d * 0.18);
  if (['theatre', 'classroom', 'cabaret', 'banquet', 'crowd'].includes(k) && d > 8 && w > 6 && (k === 'crowd' || cap > 120)) items.push({ t: 'stage', x: w * 0.2, y: 0.6, w: w * 0.6, h: stageD - 0.6 });
  const top = items.length ? stageD + 1.5 : (k === 'theatre' || k === 'classroom' ? 2.2 : 1.2); // presenter area when there is no stage
  if (k === 'theatre') {
    const ca = w > 14 ? 1.2 : 0, usable = w - 2 - ca, per = Math.floor(usable / 0.5), rows = Math.max(0, Math.floor((d - top - 1) / 0.9)); // 0.5 m seats, 0.9 m rows
    for (let i = 0; i < rows; i++) { const y = top + i * 0.9; if (ca) { items.push({ t: 'row', x: 1, y, w: usable / 2 }); items.push({ t: 'row', x: 1 + usable / 2 + ca, y, w: usable / 2 }); } else items.push({ t: 'row', x: 1, y, w: usable }); }
    fits = per * rows;
  } else if (k === 'classroom') {
    const ca = w > 14 ? 1.2 : 0, per = Math.floor((w - 2 - ca) / 1.83), rows = Math.max(0, Math.floor((d - top - 0.8) / 1.4)); // 1.83 m tables of 3, 1.4 m rows
    for (let i = 0; i < rows; i++) for (let j = 0; j < per; j++) { const half = Math.ceil(per / 2), x = 1 + j * 1.83 + (ca && j >= half ? ca : 0); items.push({ t: 'table', x, y: top + i * 1.4, w: 1.8, h: 0.45 }); }
    fits = per * rows * 3;
  } else if (k === 'banquet' || k === 'cabaret') {
    const cols = Math.floor((w - 1) / 3), rows = Math.floor((d - top - 0.5) / 3), seats = k === 'banquet' ? 10 : 7;
    const need = cap ? Math.ceil(cap / seats) : cols * rows; let n = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { if (n >= Math.min(need, cols * rows)) break; items.push({ t: 'round', x: 0.5 + j * 3 + 1.5, y: top + i * 3 + 1.5, r: 0.9, half: k === 'cabaret' }); n++; }
    fits = cols * rows * seats;
  } else if (k === 'reception') {
    items.push({ t: 'bar', x: w * 0.25, y: d - 1.6, w: w * 0.5, h: 0.8 });
    const n = cap ? Math.min(Math.ceil(cap / 8), 400) : 10; const cols = Math.max(1, Math.floor(w / 3)), rows = Math.max(1, Math.floor((d - 3) / 3));
    for (let i = 0, c = 0; i < rows && c < n; i++) for (let j = 0; j < cols && c < n; j++, c++) items.push({ t: 'cocktail', x: 1.5 + j * 3 + (i % 2) * 1.2, y: 1.5 + i * 3, r: 0.3 });
    fits = Math.floor(w * d / L.ok);
  } else if (k === 'boardroom') {
    const tl = Math.max(2, w - 2.4), tw = Math.min(1.4, d - 2.4); items.push({ t: 'table', x: 1.2, y: (d - tw) / 2, w: tl, h: tw }); fits = 2 * Math.floor(tl / 0.7) + 2;
  } else if (k === 'ushape') {
    const tl = Math.max(2, w - 2.4), arm = Math.max(2, d - 2.6); items.push({ t: 'table', x: 1.2, y: 1.2, w: 0.6, h: arm }, { t: 'table', x: w - 1.8, y: 1.2, w: 0.6, h: arm }, { t: 'table', x: 1.2, y: 1.2 + arm - 0.6, w: tl, h: 0.6 }); fits = 2 * Math.floor(arm / 0.7) + Math.floor(tl / 0.7);
  } else if (k === 'expo') {
    const per = Math.max(0, Math.floor((w - 6) / 3)), strips = Math.max(0, Math.floor((d - 3) / 9)), want = extra.stands || per * strips * 2; let n = 0;
    for (let st = 0; st < strips; st++) for (let side = 0; side < 2; side++) for (let j = 0; j < per; j++) { if (n >= want) break; items.push({ t: 'stand', x: 3 + j * 3, y: 3 + st * 9 + side * 3, w: 3, h: 3, label: extra.standNames ? extra.standNames[n] : '' }); n++; }
    fits = Math.floor(w * d / L.ok); extra.standsFit = per * strips * 2;
  } else if (k === 'crowd') {
    items.push({ t: 'crowd', x: 1, y: top, w: w - 2, h: Math.max(0, d - top - 1) }); fits = Math.floor((w - 2) * Math.max(0, d - top - 1) / L.ok);
  }
  return { items, fits };
}
function _sketchModel(s) {
  const fin = (v, lo, hi) => { const n = typeof v === 'number' ? v : NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const sp = s.spaces.filter(r => r.name.trim()), saved = (s.sketch && s.sketch.rooms) || {};
  const stands = s.partners.has === 'yes' ? s.partners.list.filter(EXHIBITING) : [];
  const rkeys = roomKeys(sp);
  const rooms = sp.map((r, i) => {
    const L = layoutOf(r.layout), cap = parseFloat(r.cap) || 0, given = parseFloat(r.area) || 0, key = rkeys[i];
    const per = L && L.ok ? L.ok : layoutOf('reception').ok, area = given || (cap && !(L && L.k === 'online') ? cap * per : 80), raw = saved[key] && typeof saved[key] === 'object' ? saved[key] : {};
    const sv = { x: fin(raw.x, 0, 5000), y: fin(raw.y, 0, 5000), aspect: fin(raw.aspect, 0.2, 5), rot: raw.rot === true }; // numbers only: saved data never reaches the SVG as text
    const aspect = sv.aspect || (L ? L.aspect : 1.4); let w = Math.sqrt(area * aspect), d = area / w;
    if (sv.rot) [w, d] = [d, w];
    w = Math.max(4, Math.round(w * 2) / 2); d = Math.max(4, Math.round(d * 2) / 2);
    return { i, key, name: r.name.trim(), L, cap, area, assumed: !given, w, d, sv, online: L && L.k === 'online' };
  });
  let si = 0;
  for (const r of rooms) {
    const extra = {}; if (r.L && r.L.k === 'expo') { const share = rooms.filter(q => q.L && q.L.k === 'expo').length; const n = Math.ceil(stands.length / share); extra.stands = stands.length ? n : 0; extra.standNames = stands.slice(si, si + n).map(p => p.name); si += n; }
    let c = r.online ? { items: [], fits: null } : roomContent(r.L, r.w, r.d, r.cap, extra);
    // rooms without a real area are drawn big enough for their numbers, stage and aisles included
    for (let g = 0; r.assumed && !r.online && r.cap && c.fits != null && c.fits < r.cap && g < 14; g++) { r.w = Math.round(r.w * 1.05 * 2) / 2 + 0.5; r.d = Math.round(r.d * 1.05 * 2) / 2 + 0.5; c = roomContent(r.L, r.w, r.d, r.cap, extra); }
    r.items = c.items; r.fits = c.fits; r.standsWanted = extra.stands || 0; r.standsFit = extra.standsFit;
    r.short = !r.online && ((r.cap && r.fits != null && r.fits < r.cap) || (r.standsWanted && r.standsFit < r.standsWanted));
  }
  // auto placement after sizing: shelves in guest order with 3 m corridors; saved positions win
  const tot = rooms.reduce((a, r) => a + r.w * r.d, 0) || 100, maxW = Math.max(Math.sqrt(tot) * 1.7, ...rooms.map(r => r.w));
  const placed = rooms.filter(r => r.sv.x != null && r.sv.y != null).map(r => { r.x = r.sv.x; r.y = r.sv.y; return r; });
  const hits = (x, y, w, d) => placed.some(q => x < q.x + q.w + 1.5 && q.x < x + w + 1.5 && y < q.y + q.d + 1.5 && q.y < y + d + 1.5);
  let x = 0, y = 0, rowH = 0;
  for (const r of rooms) { if (r.sv.x != null && r.sv.y != null) continue; let guard = 0;
    while (guard++ < 400) { if (x > 0 && x + r.w > maxW) { x = 0; y += rowH + 3; rowH = 0; } if (!hits(x, y, r.w, r.d)) break; x += 1.5; } // flow around rooms you placed yourself
    r.x = r.ax = x; r.y = r.ay = y; x += r.w + 3; rowH = Math.max(rowH, r.d); placed.push(r); }
  const bx = Math.max(10, ...rooms.map(r => r.x + r.w)), by = Math.max(10, ...rooms.map(r => r.y + r.d));
  return { rooms, W: bx, H: by };
}
function freeSpot(model, room, x, y) { // nearest position where a dropped room doesn't overlap another
  const others = model.rooms.filter(q => q !== room), clash = (px, py) => others.some(q => px < q.x + q.w + 0.5 && q.x < px + room.w + 0.5 && py < q.y + q.d + 0.5 && q.y < py + room.d + 0.5);
  if (!clash(x, y)) return [x, y];
  for (let r = 1; r < 120; r++) for (let a = 0; a < 16; a++) { const px = Math.max(0, Math.round((x + Math.cos(a / 16 * 6.283) * r) * 2) / 2), py = Math.max(0, Math.round((y + Math.sin(a / 16 * 6.283) * r) * 2) / 2); if (!clash(px, py)) return [px, py]; }
  return [x, y];
}
function roomStatus(r) {
  const st = r.online ? 'online only' : r.short ? (r.standsWanted && r.standsFit < r.standsWanted ? `fits ${r.standsFit} of ${r.standsWanted} stands` : `fits about ${nf(r.fits)} of ${nf(r.cap)}`) : r.cap ? `${nf(r.cap)} people` : '';
  return `${r.L ? r.L.n : 'No layout'} · ${nf(r.w * r.d)} m²${r.assumed && !r.online ? ' (estimated)' : ''}${st ? ' · ' + st : ''}`;
}
const xesc = (t) => String(t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sketchSVG(model, opts = {}) {
  const pad = 4, W = model.W + pad * 2, H = model.H + pad * 2 + 4, sel = opts.selected;
  const col = opts.print ? { bg: '#ffffff', room: '#f3f7f9', ink: '#1b2a33', muted: '#677884', line: '#c5d3db', accent: '#007fa8', soft: '#e5f6fc', bad: '#b42318' } : { bg: 'var(--surface)', room: 'var(--surface-2)', ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--line-2)', accent: 'var(--accent)', soft: 'var(--accent-soft)', bad: 'var(--bad)' };
  const fs = (r) => Math.max(0.9, Math.min(2.2, Math.min(r.w, r.d) / 7));
  let g = '';
  for (const r of model.rooms) {
    const f = fs(r), on = sel === r.key;
    let inner = '';
    for (const it of r.items) {
      if (it.t === 'stage') inner += `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="${col.soft}" stroke="${col.accent}" stroke-width="0.12"/>`;
      else if (it.t === 'row') inner += `<line x1="${it.x}" y1="${it.y}" x2="${it.x + it.w}" y2="${it.y}" stroke="${col.muted}" stroke-width="0.45" stroke-dasharray="0.42 0.13"/>`;
      else if (it.t === 'table' || it.t === 'bar') inner += `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="none" stroke="${col.muted}" stroke-width="0.1"/>`;
      else if (it.t === 'round') inner += it.half ? `<path d="M ${it.x - it.r} ${it.y} A ${it.r} ${it.r} 0 0 0 ${it.x + it.r} ${it.y} Z" fill="none" stroke="${col.muted}" stroke-width="0.1"/><circle cx="${it.x}" cy="${it.y}" r="${it.r}" fill="none" stroke="${col.line}" stroke-width="0.06"/>` : `<circle cx="${it.x}" cy="${it.y}" r="${it.r}" fill="none" stroke="${col.muted}" stroke-width="0.1"/>`;
      else if (it.t === 'cocktail') inner += `<circle cx="${it.x}" cy="${it.y}" r="${it.r}" fill="${col.muted}" opacity=".5"/>`;
      else if (it.t === 'stand') inner += `<rect x="${it.x + 0.08}" y="${it.y + 0.08}" width="${it.w - 0.16}" height="${it.h - 0.16}" fill="${col.soft}" stroke="${col.accent}" stroke-width="0.08"/>` + (it.label ? `<text x="${it.x + it.w / 2}" y="${it.y + it.h / 2 + 0.25}" font-size="0.7" text-anchor="middle" fill="${col.ink}">${xesc(it.label.slice(0, 7))}</text>` : '');
      else if (it.t === 'crowd') inner += `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="url(#hatch)" stroke="none"/>`;
    }
    const label = r.name, sub = roomStatus(r), lf = Math.max(0.55, Math.min(f, (r.w - 1.2) / (label.length * 0.56)));
    g += `<g class="room${on ? ' on' : ''}" data-room="${xesc(r.key)}" transform="translate(${r.x + pad} ${r.y + pad})" tabindex="0" role="button" aria-label="${xesc(label + ', ' + sub)}">`
      + `<rect width="${r.w}" height="${r.d}" fill="${col.room}" stroke="${r.short ? col.bad : on ? col.accent : col.ink}" stroke-width="${on ? 0.32 : 0.18}"${r.online ? ' stroke-dasharray="0.8 0.5"' : ''}/>`
      + inner
      + `<rect x="0.3" y="${r.d - lf * 1.55 - 0.3}" width="${Math.min(r.w - 0.6, label.length * lf * 0.56 + 0.8)}" height="${lf * 1.55}" fill="${col.bg}" opacity=".9"/>`
      + `<text x="0.7" y="${r.d - lf * 0.45 - 0.3}" font-size="${lf}" font-weight="600" fill="${r.short ? col.bad : col.ink}" textLength="${Math.min(label.length * lf * 0.56, r.w - 1.4)}" lengthAdjust="spacingAndGlyphs">${xesc(label)}</text></g>`;
  }
  const sb = 10, sy = H - 2.2;
  const scale = `<g transform="translate(${pad} ${sy})"><line x1="0" y1="0" x2="${sb}" y2="0" stroke="${col.ink}" stroke-width="0.2"/><line x1="0" y1="-0.5" x2="0" y2="0.5" stroke="${col.ink}" stroke-width="0.2"/><line x1="${sb}" y1="-0.5" x2="${sb}" y2="0.5" stroke="${col.ink}" stroke-width="0.2"/><text x="${sb + 0.8}" y="0.45" font-size="1.2" fill="${col.muted}">10 m · sketch, not a measured plan</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${opts.px ? W * opts.px : '100%'}" ${opts.px ? `height="${H * opts.px}"` : ''} font-family="Geist, Segoe UI, sans-serif" role="img" aria-label="Layout sketch of ${model.rooms.length} spaces"><defs><pattern id="hatch" width="1" height="1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="${col.muted}" stroke-width="0.25" opacity=".55"/></pattern></defs><rect width="${W}" height="${H}" fill="${col.bg}"/>${g}${scale}</svg>`;
}

// ----- starter packs: layouts for the template spaces, food service and planning notes per type
const PACKS = {
  summit: { layouts: ['Standing reception', 'Theatre', 'Classroom', 'Classroom', 'Exhibition stands', 'Standing reception'], food: ['Coffee breaks', 'Buffet meals', 'Bar service'] },
  launch: { layouts: ['Open or mixed', 'Theatre', 'Open or mixed', 'Boardroom', 'Standing reception'], food: ['Standing reception', 'Bar service'] },
  expo: { layouts: ['Open or mixed', 'Exhibition stands', 'Exhibition stands', 'Theatre', 'Open or mixed', 'Open or mixed'], food: ['Coffee breaks', 'Buffet meals'] },
  gala: { layouts: ['Open or mixed', 'Standing reception', 'Banquet rounds', 'Open or mixed', 'Standing reception'], food: ['Standing reception', 'Seated (plated) meals', 'Bar service'] },
  training: { layouts: ['Standing reception', 'Classroom', 'Boardroom', 'Open or mixed'], food: ['Coffee breaks', 'Buffet meals'] },
  webinar: { layouts: ['Online only', 'Online only', 'Online only', 'Online only'], food: ['No catering'] },
  festival: { layouts: ['Open or mixed', 'Standing crowd', 'Standing crowd', 'Open or mixed', 'Open or mixed', 'Standing reception'], food: ['Bar service'] },
  sports: { layouts: ['Open or mixed', 'Open or mixed', 'Standing reception', 'Theatre'], food: ['Buffet meals', 'Bar service'] },
  community: { layouts: ['Open or mixed', 'Theatre', 'Open or mixed', 'Open or mixed', 'Open or mixed'], food: ['Buffet meals'] },
  private: { layouts: ['Standing reception', 'Theatre', 'Banquet rounds', 'Standing reception'], food: ['Standing reception', 'Seated (plated) meals'] },
  exhibition: { layouts: ['Open or mixed', 'Open or mixed', 'Open or mixed', 'Open or mixed', 'Open or mixed'], food: ['Coffee breaks'] },
  hackathon: { layouts: ['Open or mixed', 'Classroom', 'Boardroom', 'Theatre', 'Open or mixed'], food: ['Coffee breaks', 'Buffet meals'] },
  congress: { layouts: ['Open or mixed', 'Theatre', 'Theatre', 'Theatre', 'Classroom', 'Open or mixed', 'Exhibition stands', 'Standing reception'], food: ['Coffee breaks', 'Buffet meals'] },
  other: { layouts: ['Open or mixed', 'Open or mixed', 'Standing reception'], food: [] },
};
const FOOD = ['Coffee breaks', 'Buffet meals', 'Seated (plated) meals', 'Standing reception', 'Bar service', 'No catering'];

// ----- memo: typing re-runs the checks only when an input they read has changed
const spaceSig = (s) => (s.spaces || []).map(r => [r.name, r.layout, r.cap, r.area]);
function sketchSigOf(s) { return JSON.stringify([spaceSig(s), s.partners && s.partners.has === 'yes' ? s.partners.list.map(p => [p.name, p.tier]) : 0, s.sketch]); }
function benchSig(s) { return JSON.stringify([s.path, s.type, s.format, s.basics, spaceSig(s), s.programme && s.programme.rows, s.people && s.people.segments, s.partners, s.online && [s.online.access, s.online.features], s.delivery && s.delivery.deadline, s.look && [s.look.venueKind, s.look.venueName], s.sketch]); }
const _memo = {};
function memoBench(name, fn, withDay, sigFn = benchSig) { return (s, now) => { const day = withDay ? Math.floor((now || Date.now()) / 864e5) : 0, k = sigFn(s) + '|' + day; const m = _memo[name]; if (m && m.k === k) return m.v; const v = fn(s, withDay ? (now || Date.now()) : undefined); _memo[name] = { k, v }; return v; }; }
const realityChecks = memoBench('rc', _realityChecks, true), planNumbers = memoBench('pn', _planNumbers), sketchModel = memoBench('sk', _sketchModel, false, sketchSigOf);
