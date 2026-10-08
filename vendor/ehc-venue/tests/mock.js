(() => {
  const cfg = window.__MOCKCFG || { sample: 'ok', room: true };
  window.__mock = { calls: [], presence: [], peersHandler: null };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function sample(input, opts = {}) {
    window.__mock.calls.push({ input, opts: { modelTier: opts.modelTier, cache: opts.cache } });
    if (cfg.sample === 'deny') throw { code: 'not_granted', message: 'declined' };
    const last = Array.isArray(input) ? input[input.length - 1].content : input;
    let reply = /coffee/i.test(last) ? 'Head through the East Promenade to the Networking Lounge, the coffee bar there is excellent.\n[gesture: point] [go: lounge]' : 'Mostly the cellular therapy updates, honestly. And seeing friends from Muscat!\n[gesture: laugh]';
    let out = '';
    for (const ch of reply.match(/.{1,12}/gs)) { await sleep(40); if (opts.signal && opts.signal.aborted) throw { code: 'cancelled', text: out }; out += ch; opts.onText && opts.onText({ text: out, delta: ch }); }
    return { text: out, truncated: false, modelTierApplied: 'quick' };
  }
  const peers = [];
  const room = {
    onPeers(fn) { window.__mock.peersHandler = fn; setTimeout(() => fn({ peers: room.peers(), joined: [], left: [], updated: [] }), 50); return () => {}; },
    peers() { return Object.freeze(peers.slice()); },
    presence(p) { window.__mock.presence.push(JSON.parse(JSON.stringify(p))); return Promise.resolve(); },
    emit() { return Promise.resolve(); }, on() { return () => {}; }, connected() { return true; },
  };
  window.__mock.setPeers = (list) => { peers.length = 0; for (const p of list) peers.push(Object.freeze({ peer: p.peer, by: p.by, isMe: false, sameTab: false, kind: 'viewer', guest: !!p.guest, presence: Object.freeze(p.presence), updatedAt: Date.now() })); window.__mock.peersHandler && window.__mock.peersHandler({ peers: room.peers(), joined: [], left: [], updated: [] }); };
  const user = { me: async () => ({ id: 'u_me', name: 'Medhat', color: '#3a7bd5', avatarUrl: '', email: null, isOwner: true, canEdit: true }), profiles: async (ids) => Object.fromEntries([].concat(ids).map(id => [id, { id, name: { u_a: 'Lina', u_b: 'Karim' }[id] || '', color: { u_a: '#2e9e6b', u_b: '#d08a2c' }[id] || '#888', avatarUrl: '', email: null, isMe: false, guest: false }])) };
  const store = window.__store = {}; window.__dbDeny = cfg.dbDeny || false;
  const docRef = (path) => ({ id: path.split('/').pop(), path, get: async () => { if (cfg.rules && cfg.owner === false && /^(analytics|reports)\//.test(path)) throw { code: 'permission_denied' }; return { id: path.split('/').pop(), exists: !!store[path], data: () => store[path] && JSON.parse(JSON.stringify(store[path])) }; }, set: async (d) => { if (window.__dbDeny) throw { code: 'permission_denied' }; store[path] = JSON.parse(JSON.stringify(d)); } });
  const query = (col, lim = 1000) => ({ limit: (n) => query(col, n), get: async () => { const docs = Object.keys(store).filter(k => k.startsWith(col + '/') && k.split('/').length === col.split('/').length + 1).slice(0, lim).map(k => ({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(store[k])) })); return { docs, size: docs.length, empty: !docs.length }; } });
  const db = { doc: docRef, collection: (c) => Object.assign(query(c), { doc: (id) => docRef(c + '/' + id) }) };
  user.id = async () => cfg.uid || 'u_me'; user.isOwner = async () => cfg.owner !== false;
  window.claude = { use: async (n) => { await sleep(20); if (n === 'sample') return cfg.sample ? sample : null; if (n === 'room') return cfg.room ? room : null; if (n === 'user') return user; if (n === 'db') return cfg.db === false ? null : db; if (n === 'downloads') return { save: async (o) => { window.__mock.saved = { filename: o.filename, size: o.data.size, type: o.data.type }; return { status: 'saved' }; } }; return null; } };
})();
