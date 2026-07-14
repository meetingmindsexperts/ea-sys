# Moved → [`/AGENTS.md`](../AGENTS.md)

This file has moved to the repository root as **`AGENTS.md`**, which is the location the
cross-tool convention expects (Codex, Cursor, Copilot and Zed auto-load a root-level `AGENTS.md`;
nothing ever auto-loaded it from `docs/`, which is why it sat stale from ~March 2026).

The content also changed shape. `AGENTS.md` now holds **invariants only** — the rules and structures
that stay true when a feature ships. It carries no feature list, because the feature list is what
rotted: this file still claimed Stripe, badge printing and E2E tests were "Not Started" long after
they shipped, and named Brevo as the mail provider months after the switch to SES.

**Where things live now:**

| | |
|---|---|
| Invariants, hard rules, entry-point model | [`/AGENTS.md`](../AGENTS.md) |
| Domain index — read before touching a domain | [`docs/DOMAIN_MAP.html`](DOMAIN_MAP.html) |
| Feature history + deep context | [`/CLAUDE.md`](../CLAUDE.md) |
| Deferred / known-broken | [`docs/ROADMAP.md`](ROADMAP.md) |
