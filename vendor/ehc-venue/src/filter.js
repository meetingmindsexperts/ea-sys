// ---------- Language filter: masks or hides offensive words in live chat between attendees ----------
// English and Arabic (script and Latin "Arabizi"), with disguised spellings caught: f.u.c.k, f u c k, sh1t, fuuuck, f*ck.
// Whole words only, so innocent words that merely contain a bad one (Scunthorpe, cocktail, assess) pass.
class LangFilter {
  constructor() {
    this.cfg = { on: true, mode: 'mask', extra: [], allow: [] };
    // strong words: caught anywhere inside a word
    this.inside = ['fuck', 'cunt', 'motherf', 'nigger', 'nigga', 'faggot', 'shit', 'bitch'];
    // stems: caught at the start of a word (shitty, bitches, wanker)
    this.stems = ['bastard', 'wank', 'slut', 'whore', 'piss', 'dickhead', 'jackass', 'dumbass', 'douche', 'retard', 'tranny',
      'شرموط', 'عرص', 'منيوك', 'قحب', 'يلعن', 'كسم', 'sharmoot', 'sharmout', 'manyak', 'manyook', 'kosomak', 'kosomk', 'ya3n'];
    // exact words only
    this.exact = ['ass', 'arse', 'asshole', 'arsehole', 'dick', 'dicks', 'cock', 'cocks', 'twat', 'twats', 'prick', 'pricks', 'bollocks', 'pussy', 'fag', 'fags', 'spic', 'chink', 'kike', 'crap',
      'كس', 'زب', 'طيز', 'خول', 'متناك', 'kos', 'kuss', 'zeb', 'zib', 'teez', 'tiz', 'khawal', 'a7a', 'ars'];
    this.phrases = ['ابن الكلب', 'ابن كلب', 'ابن الحرام', 'كس امك', 'كس اختك', 'ibn el kalb', 'ibn kalb', 'son of a bitch'];
    this.allowBase = ['scunthorpe', 'shiitake', 'shitake', 'cocktail', 'cockpit', 'dickens', 'assess', 'assassin', 'bass', 'class', 'pass', 'grass', 'arsenal', 'cockerel', 'peacock', 'hancock', 'kosher', 'kosovo'];
    this.leet = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's', '5': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };
    this.build();
  }
  setConfig(c) {
    if (!c || typeof c !== 'object') return;
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]+/) : []).map(x => String(x).trim().toLowerCase()).filter(x => x && x.length <= 40).slice(0, 300);
    this.cfg = { on: c.on !== false, mode: c.mode === 'hide' ? 'hide' : 'mask', extra: list(c.extra), allow: list(c.allow) };
    this.build();
  }
  norm(s) { // lower case, unify letter forms, drop Arabic marks and tatweel
    return String(s).normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  }
  unleet(s) { return s.replace(/[01!|3457@$+89]/g, c => /[a-z\u0600-\u06ff]/.test(s.replace(/[^a-z\u0600-\u06ff]/g, '')) ? this.leet[c] || c : c); }
  squash(s) { return s.replace(/(.)\1+/g, '$1'); }
  build() {
    const n = (w) => this.norm(w), ex = this.cfg.extra;
    this.sInside = this.inside.map(n); this.sStems = this.stems.map(n).concat(ex.filter(w => w.length >= 4).map(n)); this.sExact = new Set(this.exact.map(n).concat(ex.map(n)));
    this.sPhrases = this.phrases.map(n); this.sAllow = new Set(this.allowBase.concat(this.cfg.allow).map(n));
  }
  bad(tok) { // tok: normalised word
    if (!tok || this.sAllow.has(tok)) return false;
    if (this.sExact.has(tok)) return true; // as typed, before number-for-letter swaps (a7a)
    const t = this.unleet(tok), sq = this.squash(t);
    if (this.sAllow.has(t)) return false;
    if (tok.includes('*') || tok.includes('#')) { const re = new RegExp('^' + t.replace(/[.?+^${}()|[\]\\]/g, '\\$&').replace(/[*#]/g, '[a-z]') + '$'); if ([...this.sExact, ...this.sStems, ...this.sInside].some(w => w.length === t.length && re.test(w))) return true; }
    if (this.sExact.has(t) || (sq.length < t.length && [...this.sExact].some(w => this.squash(w) === sq && w.length < t.length + 1))) return true;
    if (this.sStems.some(w => t.startsWith(w) || sq.startsWith(this.squash(w)))) return true;
    if (this.sInside.some(w => t.includes(w) || sq.includes(this.squash(w)))) return true;
    return false;
  }
  // returns { hit, text } where text has offending words replaced with dots
  check(text) {
    text = String(text || ''); if (!this.cfg.on || !text.trim()) return { hit: false, text };
    const N = this.norm(text), spans = [];
    // words, with their positions in the original text (NFKC can change lengths, so match on the original)
    const words = [...text.matchAll(/[\p{L}\p{M}\p{N}@$*#!|+]+/gu)].map(m => ({ s: m.index, e: m.index + m[0].length, w: this.norm(m[0]) }));
    for (const w of words) if (this.bad(w.w)) spans.push([w.s, w.e]);
    // letters spelled out one by one: "f u c k", "f.u.c.k", "s-h-i-t"
    for (let i = 0; i < words.length;) {
      let j = i; while (j < words.length && words[j].w.length === 1 && (j === i || words[j].s - words[j - 1].e <= 2)) j++;
      if (j - i >= 3) { const joined = words.slice(i, j).map(x => x.w).join(''); for (let a = 0; a < joined.length; a++) for (let b = joined.length; b >= a + 3; b--) if (this.bad(joined.slice(a, b))) { spans.push([words[i + a].s, words[i + b - 1].e]); a = b - 1; break; } i = j; } else i++;
    }
    // phrases
    for (const p of this.sPhrases) { let k = N.indexOf(p); while (k >= 0) { if (N.length === text.length) spans.push([k, k + p.length]); k = N.indexOf(p, k + 1); } }
    if (!spans.length) return { hit: false, text };
    spans.sort((a, b) => a[0] - b[0]); let out = '', at = 0;
    for (const [s, e] of spans) { if (s < at) { if (e > at) { out += '•'.repeat(Math.min(6, e - at)); at = e; } continue; } out += text.slice(at, s) + '•'.repeat(Math.max(3, Math.min(6, e - s))); at = e; }
    return { hit: true, text: out + text.slice(at) };
  }
}
