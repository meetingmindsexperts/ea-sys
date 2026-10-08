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
 *   sample     AI attendees: off in this phase (they answer from their
 *              pre-written lines)
 *   room       live colleagues: off in this phase
 *
 * Identity never comes from here: every route takes the person from the
 * session, and this file only names what to read or write. The page that
 * serves the venue sets window.EHC_VENUE = { api, userId, name, team } first.
 */
(function () {
  "use strict";
  var V = window.EHC_VENUE;
  if (!V || typeof V.api !== "string") return;

  function call(method, path, body) {
    return fetch(V.api + path, {
      method: method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 403) throw { code: "permission_denied" };
      if (!r.ok) throw { code: "upstream_error", status: r.status };
      return r.json();
    });
  }

  function snapshot(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : JSON.parse(JSON.stringify(data)); }, metadata: {} };
  }

  // Settings and the team's report list are read once per page load.
  var configP = null;
  function config() { return configP || (configP = call("GET", "/config")); }
  var reportsP = null;
  function reports() { return reportsP || (reportsP = call("GET", "/reports").then(function (r) { return r.reports || []; })); }

  function doc(path) {
    var parts = path.split("/");
    return {
      get: function () {
        if (parts[0] === "analytics") return call("GET", "/activity/me").then(function (r) { return snapshot(parts[1], r.activity); });
        if (path === "config/filter") return config().then(function (c) { return snapshot("filter", c.filter); });
        if (path === "config/screens") return config().then(function (c) { return snapshot("screens", c.screens ? { map: c.screens } : null); });
        return Promise.resolve(snapshot(parts[parts.length - 1], null));
      },
      set: function (data) {
        if (parts[0] === "analytics") return call("PUT", "/activity/me", data);
        if (path === "config/filter") { configP = null; return call("PUT", "/config", { filter: data }); }
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

  var user = {
    id: function () { return Promise.resolve(V.userId); },
    me: function () { return Promise.resolve({ id: V.userId, name: V.name || "", color: "#3a7bd5", avatarUrl: "", email: null, isOwner: !!V.team, canEdit: !!V.team }); },
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

  var db = { doc: doc, collection: function (p) { var c = collection(p); c.doc = function (id) { return doc(p + "/" + id); }; return c; } };

  window.claude = {
    use: function (name) {
      if (name === "user") return Promise.resolve(user);
      if (name === "db") return Promise.resolve(db);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null); // sample (AI) and room (live colleagues): off in this phase
    },
  };
})();
