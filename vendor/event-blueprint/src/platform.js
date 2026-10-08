// ---------- Platform adapter ----------
// Everything the page needs from the outside world goes through this one object:
// storage, AI, file uploads, identity and hand-off. Today it runs on claude.ai artifact
// capabilities. To host the page on your own website, set window.EVENT_BLUEPRINT_BACKEND
// = { api: 'https://your-domain/api/blueprint' } before this script, and implement the
// endpoints listed under API MODE on your server (the server holds the Claude API key).
const Platform = (() => {
  const P = { mode: 'local', userId: null, canWrite: true, isEditor: true, aiReady: false, filesReady: false, handoff: null, _: {} };
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };

  P.init = async () => {
    const cfg = window.EVENT_BLUEPRINT_BACKEND;
    if (cfg && cfg.api) { // ---------- API MODE (your own server) ----------
      P.mode = 'api'; const base = cfg.api.replace(/\/$/, '');
      // EA-SYS: the server's error codes reach the page (rate_limited, invalid_json, ...) instead of one generic one.
      const call = async (method, path, body, raw) => { const r = await fetch(base + path, { method, credentials: 'include', headers: raw ? {} : { 'content-type': 'application/json' }, body: raw ? body : body ? JSON.stringify(body) : undefined }); if (!r.ok) { let b = null; try { b = await r.json(); } catch (e) { } const code = r.status === 401 ? 'not_granted' : r.status === 429 ? 'rate_limited' : (b && typeof b.code === 'string' ? b.code.toLowerCase() : 'upstream_error'); throw { code, status: r.status, message: (b && b.error) || 'HTTP ' + r.status }; } return r.status === 204 ? null : r.json(); };
      P._.call = call;
      try { const me = await call('GET', '/me'); P.userId = me.id || null; P.isEditor = !!me.isEditor; } catch (e) { }
      P.aiReady = !!cfg.ai; P.filesReady = !!cfg.files; return P;
    }
    const use = (n) => (window.claude && typeof window.claude.use === 'function') ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
    const [db, user, sample, room, downloads, assets] = await Promise.all([use('db'), use('user'), use('sample'), use('room'), use('downloads'), use('assets')]);
    Object.assign(P._, { db, user, sample, room, downloads, assets });
    if (db || user || sample) P.mode = 'artifact';
    if (user) { try { P.userId = await user.id(); } catch (e) { } try { const c = await user.can('data.write'); if (c === false) P.canWrite = false; } catch (e) { } try { P.isEditor = await user.canEdit(); } catch (e) { P.isEditor = false; } }
    P.aiReady = !!sample; P.filesReady = !!assets;
    return P;
  };

  // ----- storage
  P.save = async (bp) => {
    if (P.mode === 'api') return P._.call('PUT', '/blueprints/' + encodeURIComponent(bp.id), bp);
    if (P.mode === 'artifact' && P._.db && P.canWrite) return P._.db.doc('blueprints/' + bp.id).set(bp);
    throw { code: 'local_only' };
  };
  P.load = async (id) => {
    if (P.mode === 'api') return P._.call('GET', '/blueprints/' + encodeURIComponent(id));
    if (P._.db) { const d = await P._.db.doc('blueprints/' + id).get(); return d.exists ? d.data() : null; }
    return null;
  };
  P.list = async () => {
    if (P.mode === 'api') return P._.call('GET', '/blueprints');
    if (P._.db && P.userId) { const s = await P._.db.collection('blueprints').where('ownerId', '==', P.userId).orderBy('updated', 'desc').limit(50).get(); return s.docs.map(d => d.data()); }
    return [];
  };
  P.saveTemplate = async (t) => {
    if (P.mode === 'api') return P._.call('PUT', '/templates/' + encodeURIComponent(t.id), t);
    if (P._.db && P.canWrite) return P._.db.doc('templates/' + t.id).set(t);
    const all = ls.get('eb-templates', []).filter(x => x.id !== t.id); all.unshift(t); ls.set('eb-templates', all.slice(0, 30));
  };
  P.listTemplates = async () => {
    if (P.mode === 'api') return P._.call('GET', '/templates');
    if (P._.db) { if (!P.userId) return []; try { const s = await P._.db.collection('templates').where('ownerId', '==', P.userId).orderBy('created', 'desc').limit(50).get(); return s.docs.map(d => d.data()); } catch (e) { return []; } } // only your own templates: never load another person's saved state
    return ls.get('eb-templates', []);
  };

  // ----- AI (structured JSON answers)
  P.aiLimits = async () => {
    if (P.mode === 'api') return { images: (window.EVENT_BLUEPRINT_BACKEND || {}).images ? { mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } : null };
    if (!P._.sample || !P._.sample.limits) return {};
    try { return await P._.sample.limits(); } catch (e) { return {}; }
  };
  // EA-SYS: `req` is { task, input, prompt }. API mode sends only the task name and its data: the
  // server holds the prompts, so a browser can never send our AI key an instruction of its own.
  // The prompt is kept for the artifact mode, which the vendor's own test suites run.
  P.aiJSON = async (req, { tier = 'quick', images } = {}) => {
    const prompt = typeof req === 'string' ? req : req.prompt;
    if (P.mode === 'api') {
      let imgs; if (images && images.length) imgs = await Promise.all(images.map(f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ type: f.type, data: String(r.result).split(',')[1] }); r.onerror = rej; r.readAsDataURL(f); })));
      return P._.call('POST', '/ai/json', { task: req.task, input: req.input, images: imgs });
    }
    if (!P._.sample) throw { code: 'not_granted' };
    const o = { modelTier: tier, cache: false }; if (images && images.length) o.images = images;
    return P._.sample.json(prompt, o);
  };

  // ----- files
  P.upload = async (file, type) => {
    if (P.mode === 'api') { const fd = new FormData(); fd.append('file', file); return P._.call('POST', '/files', fd, true); }
    if (!P._.assets) throw { code: 'not_granted' };
    return P._.assets.upload(file, type ? { type } : undefined);
  };
  P.removeFile = async (id) => {
    if (P.mode === 'api') return P._.call('DELETE', '/files/' + encodeURIComponent(id));
    if (P._.assets) return P._.assets.delete(id);
  };
  P.fileUrl = (id) => P.mode === 'api' ? ((window.EVENT_BLUEPRINT_BACKEND.api.replace(/\/$/, '')) + '/files/' + encodeURIComponent(id)) : '/_blob/' + id;

  // ----- downloads
  P.canDownload = () => P.mode === 'api' || !!P._.downloads || P.mode === 'local';
  P.download = async (filename, data, type = 'text/plain') => {
    if (P._.downloads) return P._.downloads.save({ filename, data });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = filename; document.body.append(a); a.click(); a.remove();
  };

  // ----- notify the build team (optional): API mode posts to your server; on claude.ai the saved
  // blueprint itself is the hand-off (the team reads it from storage).
  P.notify = async (event) => { if (P.mode === 'api') { try { await P._.call('POST', '/events', event); } catch (e) { } } };
  return P;
})();
/* API MODE endpoints (JSON unless noted):
   GET  /me                      -> { id, isEditor }
   GET  /blueprints              -> [blueprint]            (the signed-in owner's)
   GET  /blueprints/:id          -> blueprint
   PUT  /blueprints/:id          <- blueprint
   GET  /templates               -> [template]
   PUT  /templates/:id           <- template
   POST /ai/json                 <- { task, input, images?:[{type,data(base64)}] } -> parsed JSON (EA-SYS: prompts live on the server)
   POST /files (multipart: file) -> { id, url, sizeBytes, contentType }
   GET/DELETE /files/:id
   POST /events                  <- { type: 'submitted'|'update'|'approval', blueprintId, ref, ... } (e.g. send confirmation emails) */
