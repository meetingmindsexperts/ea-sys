/*
 * EA-SYS runtime for the online venue (docs/EVENT_BLUEPRINT_PLAN.md phase 4).
 *
 * The vendor's venue (vendor/ehc-venue) was written against a host runtime it
 * reaches through `window.claude.use(name)`. This file provides that runtime,
 * backed by EA-SYS's /api/venue/<eventId>/* routes, so the vendor code runs
 * unchanged. The shapes are the ones its own test mock uses
 * (vendor/ehc-venue/tests/mock.js).
 *
 *   user       who is signed in, and whether they are the event team
 *   db         activity, reports and settings, as documents and collections
 *   downloads  saves a photo or a CSV straight to the device
 *   sample     AI attendees' replies, streamed from /ai; the server writes the
 *              instructions and holds the limits (phase 5B). Null when the
 *              event team has switched AI attendees off.
 *   room       live colleagues: positions up to /presence (at most 3 a
 *              second), everyone else down a server-sent event stream from
 *              the same route (phase 5C)
 *
 * Identity never comes from here: every route takes the person from the
 * session, and this file only names what to read or write. The page that
 * serves the venue sets window.EHC_VENUE = { api, userId, name, team, ai } first.
 */
(function () {
  "use strict";
  var V = window.EHC_VENUE;
  if (!V || typeof V.api !== "string") return;

  function call(method, path, body) {
    var json = body === undefined ? undefined : JSON.stringify(body);
    return fetch(V.api + path, {
      method: method,
      credentials: "same-origin",
      // A save sent as the page closes (the vendor's pagehide) must outlive the page (review L7).
      // Browsers refuse a keepalive body over 64 KB, so a larger one goes the ordinary way.
      keepalive: method === "PUT" && !!json && json.length < 60000,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: json,
    }).then(function (r) {
      if (r.status === 403) throw { code: "permission_denied" };
      if (!r.ok) throw { code: "upstream_error", status: r.status };
      return r.json();
    });
  }

  function snapshot(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : JSON.parse(JSON.stringify(data)); }, metadata: {} };
  }

  // Settings and the team's report list are read once per page load; a failed read is not kept,
  // so the next use tries again instead of failing until a reload (review L6).
  var configP = null;
  function config() { return configP || (configP = call("GET", "/config").catch(function (e) { configP = null; throw e; })); }
  var reportsP = null;
  function reports() { return reportsP || (reportsP = call("GET", "/reports").then(function (r) { return r.reports || []; }).catch(function (e) { reportsP = null; throw e; })); }

  function doc(path) {
    var parts = path.split("/");
    return {
      get: function () {
        if (parts[0] === "analytics") return call("GET", "/activity/me").then(function (r) { return snapshot(parts[1], r.activity); });
        if (path === "config/filter") return config().then(function (c) { return snapshot("filter", c.filter); });
        if (path === "config/screens") return config().then(function (c) { return snapshot("screens", c.screens ? { map: c.screens } : null); });
        // Read fresh, not from the once-per-load copy: the team's AI tab shows today's running count.
        if (path === "config/ai") { configP = null; return config().then(function (c) { return snapshot("ai", c.ai || null); }); }
        return Promise.resolve(snapshot(parts[parts.length - 1], null));
      },
      set: function (data) {
        if (parts[0] === "analytics") return call("PUT", "/activity/me", data);
        if (path === "config/filter") { configP = null; return call("PUT", "/config", { filter: data }); }
        if (path === "config/ai") { configP = null; return call("PUT", "/config", { ai: { on: !!(data && data.on) } }); }
        if (parts[0] === "reports" && parts[2] === "items") { reportsP = null; return call("POST", "/reports", data); }
        if (parts[0] === "reports") return Promise.resolve(); // the per-reporter index: the server needs none
        return Promise.reject({ code: "permission_denied" });
      },
    };
  }

  function collection(path) {
    var parts = path.split("/");
    var q = {
      get: function () {
        var p;
        if (path === "analytics") p = call("GET", "/activity").then(function (r) { return r.activity || []; });
        // The team's Reports tab reads the bare collection and takes each doc's `items` (team.js
        // drawReports). One doc carrying every report; no `uid`, so it asks for no per-reporter lists.
        else if (path === "reports") p = reports().then(function (all) { return [{ items: all.map(function (x) { return x.item; }) }]; });
        else if (parts[0] === "reports" && parts[2] === "items") p = reports().then(function (all) { return all.filter(function (x) { return x.reporterId === parts[1]; }).map(function (x) { return x.item; }); });
        else p = Promise.resolve([]);
        return p.then(function (rows) {
          var docs = rows.map(function (d, i) { return snapshot(String(i), d); });
          return { docs: docs, size: docs.length, empty: docs.length === 0 };
        });
      },
    };
    q.limit = function () { return q; };
    q.where = function () { return q; };
    q.orderBy = function () { return q; };
    return q;
  }

  /** A colleague's badge colour, the same in every tab (FNV-1a of the user id). */
  var PALETTE = ["#2e9e6b", "#3a7bd5", "#c0563b", "#8e5cc2", "#c79a2b", "#1f8a9e", "#b84a7a", "#5a7d2a"];
  function colorFor(id) {
    var h = 2166136261;
    for (var i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return PALETTE[(h >>> 0) % PALETTE.length];
  }

  // ----- live colleagues (phase 5C) -----
  // One random id per tab; the server binds it to the signed-in user, so a tab can only move its own avatar.
  var names = {};
  var theRoom = null;
  function makeRoom() {
    var tab = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function (b) { return (b % 36).toString(36); }).join("");
    var handler = null, onClose = null, es = null, list = Object.freeze([]);
    var pending = null, last = null, sending = false, lastSent = 0, timer = null;
    function flush() {
      timer = null;
      if (!pending || sending) return;
      var wait = 333 - (Date.now() - lastSent);
      if (wait > 0) { timer = setTimeout(flush, wait); return; }
      var p = pending; pending = null; sending = true; lastSent = Date.now(); last = p;
      // A refused update (too many tabs, venue full) only means others do not see this one; the walk goes on.
      call("POST", "/presence", { peer: tab, presence: p }).catch(function () { return null; }).then(function () { sending = false; if (pending && !timer) flush(); });
    }
    function deliver() { if (handler) handler({ peers: list, joined: [], left: [], updated: [] }); }
    function connect() {
      es = new EventSource(V.api + "/presence?peer=" + tab);
      // After a reconnect the server no longer has this tab: send where it is again.
      es.onopen = function () { if (last && !pending) { pending = last; flush(); } };
      es.onmessage = function (e) {
        var d = null;
        try { d = JSON.parse(e.data); } catch { return; }
        var peers = d && Array.isArray(d.peers) ? d.peers : [];
        list = Object.freeze(peers.map(function (p) {
          if (typeof p.by === "string") names[p.by] = typeof p.name === "string" ? p.name : "";
          return Object.freeze({ peer: p.peer, by: p.by, isMe: !!p.isMe, sameTab: !!p.sameTab, kind: p.kind, guest: !!p.guest, presence: Object.freeze(p.presence || {}), updatedAt: p.updatedAt });
        }));
        deliver();
      };
      // EventSource reconnects by itself; CLOSED means it gave up (signed out, venue switched off).
      es.onerror = function () { if (es.readyState === 2 && onClose) onClose(); };
    }
    window.addEventListener("pagehide", function () {
      if (es) es.close();
      if (!last) return;
      fetch(V.api + "/presence", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ peer: tab, leave: true }) }).catch(function () { return null; });
    });
    return {
      onPeers: function (fn, close) { handler = fn; onClose = close || null; if (es) deliver(); else connect(); return function () { handler = null; }; },
      peers: function () { return list; },
      presence: function (p) { pending = p; if (!timer) flush(); return Promise.resolve(); },
      emit: function () { return Promise.resolve(); },
      on: function () { return function () {}; },
      connected: function () { return !!es && es.readyState === 1; },
    };
  }
  function room() { return theRoom || (theRoom = makeRoom()); }

  var user = {
    id: function () { return Promise.resolve(V.userId); },
    me: function () { return Promise.resolve({ id: V.userId, name: V.name || "", color: colorFor(V.userId), avatarUrl: "", email: null, isOwner: !!V.team, canEdit: !!V.team }); },
    // Colleagues' names come with their positions (staff of the same organisation, plan §5.4).
    profiles: function (ids) {
      var out = {};
      [].concat(ids).forEach(function (id) { if (typeof id === "string") out[id] = { id: id, name: names[id] || "", color: colorFor(id) }; });
      return Promise.resolve(out);
    },
    isOwner: function () { return Promise.resolve(!!V.team); },
    canEdit: function () { return Promise.resolve(!!V.team); },
    can: function () { return Promise.resolve(true); },
  };

  var downloads = {
    save: function (o) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(o.data);
      a.download = o.filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      return Promise.resolve({ status: "saved" });
    },
  };

  /**
   * An AI attendee's reply (social.js `reply()`): `messages` is [the page's own
   * instructions, ...the conversation]. The instructions are NOT sent: the
   * server writes its own from `opts.venue` (the persona and the scene). The
   * text streams back and is passed to `onText` as it grows. Refusals become
   * the codes the page already handles: AI off or the event's daily limit ->
   * "sampling_disabled" (pre-written answers from then on), this person's
   * hourly limit -> "rate_limited", Stop or walking away -> "cancelled".
   */
  function sample(messages, opts) {
    opts = opts || {};
    var v = opts.venue;
    if (!v || typeof v !== "object") return Promise.reject({ code: "not_declared" });
    var text = "";
    var body = { persona: v.persona, zone: v.zone, pose: v.pose, role: v.role, greeting: v.greeting, turns: (messages || []).slice(1) };
    return fetch(V.api + "/ai", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: opts.signal })
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            if (r.status === 403 || b.code === "AI_LIMIT_EVENT") throw { code: "sampling_disabled" };
            if (r.status === 429) throw { code: "rate_limited" };
            throw { code: "upstream_error", status: r.status };
          });
        }
        var reader = r.body.getReader(), dec = new TextDecoder();
        function pump() {
          return reader.read().then(function (c) {
            if (c.done) { text += dec.decode(); return { text: text }; }
            text += dec.decode(c.value, { stream: true });
            if (typeof opts.onText === "function") opts.onText({ text: text });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") throw { code: "cancelled", text: text };
        throw e;
      });
  }

  var db = { doc: doc, collection: function (p) { var c = collection(p); c.doc = function (id) { return doc(p + "/" + id); }; return c; } };

  window.claude = {
    use: function (name) {
      if (name === "user") return Promise.resolve(user);
      if (name === "db") return Promise.resolve(db);
      if (name === "downloads") return Promise.resolve(downloads);
      if (name === "sample") return Promise.resolve(V.ai === false ? null : sample);
      if (name === "room") return Promise.resolve(typeof EventSource === "undefined" ? null : room());
      return Promise.resolve(null);
    },
  };
})();
