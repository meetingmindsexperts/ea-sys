# Travel Grant: the organizer picks the home country / countries

**Status: BUILT, 2026-08-26.** Written 2026-08-25 and built the next day. The
plan below is kept as the reasoning; deviations from it are recorded here.

- **D6 answered (owner):** two or more home countries render as
  `"Local, not eligible"` in the badge, with the full list in the settings card,
  the console tile's hover text and the badge's own `title`. One country names
  itself.
- **Open question 3 answered:** exactly ONE event on prod had the feature
  enabled (`printing-test-event`), with zero `TravelGrant` rows ever. Migration
  `20260826120000` backfills `homeCountries: ["AE"]` for any such event, so the
  change is behaviour-preserving rather than merely harmless.
- **Open question 4 answered:** `countries.ts` holds 196 entries. The "249" in
  `countries.ts`, `country-select.tsx` and CLAUDE.md was wrong and is corrected.
- **Deviation from step 5:** Save is NOT blocked when the switch is on with no
  country. One Save covers the whole tab, so blocking would stop unrelated
  settings from saving — the same class of bug as the M9 deadline guard. The
  reader fails closed and an amber panel explains it instead. The Save button
  was also moved BELOW the Travel Grant card: it sat at the foot of Submissions,
  which left the only button that persists the picker scrolled off above it.
  Found by opening the page, which is what step 5 asked for.
- **Deferred:** informal aliases cover `uae`/`uk`/`usa`/`ksa` and the UAE's
  alpha-3 `are`; alpha-3 is not supported generally because `countries.ts`
  carries no alpha-3 column.

Companion to [TRAVEL_GRANT.md](TRAVEL_GRANT.md) (what is built) and
[TRAVEL_GRANT_PLAN.md](TRAVEL_GRANT_PLAN.md) (the nine decisions behind it).

---

## 1. The problem

`classifyResidency()` has the UAE hard-coded:

```ts
const UAE_ALIASES: ReadonlySet<string> = new Set([
  "united arab emirates", "the united arab emirates", "uae", "u a e", "ae", "are",
]);
```

That is one customer's geography baked into a shared feature. A tenant running
a Riyadh conference has the identical need with a different home country, and
today they would be offering travel grants to their own local authors while
withholding them from everyone in Dubai. It is not "not yet multi-tenant" — it
is **wrong for every tenant except MM Group.**

### Why now rather than later

**Zero real events have used the feature.** Nothing to backfill, no live
configuration whose meaning would silently change, no organizer who has
already reasoned about what the toggle does. Once ten events are enabled under
implied-UAE semantics, this becomes a data migration *plus* a semantics change,
and the two land at the same time on live events.

**It also removes a special case rather than adding one.** Six hand-written UAE
spellings become a general resolver that every country uses. See §3.3.

---

## 2. Decisions to lock before building

| # | Question | Recommendation |
|---|---|---|
| D1 | One home country, or a list? | **A list.** One element is the common case, but a Dubai conference plausibly treats Saudi and Qatar as local (1-2h flight). A list with one entry costs nothing more than a scalar. |
| D2 | Event-level or org-level? | **Event.** The conference has a physical location and an org can run events in several countries. Same granularity as the toggle it sits beside. |
| D3 | Org-level default that pre-fills the event field? | **No, not in v1.** Two places to look is what makes a settings screen unexplainable. Revisit if organizers complain about retyping. |
| D4 | What does "enabled, no home country" mean? | **Disabled.** See §3.4 — this is the one place where the obvious reading fails OPEN. |
| D5 | Region presets (GCC, Schengen, EU) as first-class? | **No.** They are a list of countries; let the organizer pick them. A named region invites arguments about membership that are not ours to settle. |
| D6 | What replaces the label "UAE, not eligible"? | See §3.5 — needs an owner call on the 2+ country wording. |

---

## 3. Design

### 3.1 Storage

`Event.settings.travelGrant.homeCountries: string[]` — **ISO alpha-2 codes**,
not display names.

No migration, no column. Same escape hatch as every other feature config
(`settings.badge`, `settings.abstractLimits`, `settings.webinar`), and
`updateEventSettings` already gives an atomic locked merge.

Codes rather than names is load-bearing, not tidiness — see §3.3.

### 3.2 The predicate

`ResidencyClass` becomes `"home" | "overseas" | "unknown"`.

**The three states must survive the generalisation.** The reason `unknown`
exists does not go away, it multiplies: the CSV importers write `Speaker.country`
as free text, so `"Dubai"` is a reachable value and Dubai is in the UAE.
Generalise the home country and `"Jeddah"`, `"Doha"` and `"Riyadh"` join it.
Treating unrecognised input as `overseas` would mail a grant offer to a local
resident; routing it to the console for a human is recoverable.

```ts
export function classifyResidency(
  country: string | null | undefined,
  homeCodes: readonly string[],
): ResidencyClass
```

Renaming `uae` → `home` is deliberately a **compile error at every consumer**,
because `RESIDENCY_LABEL` is a `Record<ResidencyClass, string>`. The compiler
performs the sweep; nothing can be silently missed.

### 3.3 The alias problem, and why codes solve it

Today there are six hand-written spellings of one country. Hand-writing
aliases for 196 countries is not on the table, so the resolution has to change
shape:

1. The organizer picks from **the same `CountrySelect` the author used**, and
   we store the **code**.
2. An author's stored `country` is resolved to a code by matching it against
   `countries.ts` on **either** name or code — which is exactly what
   `KNOWN_COUNTRIES` already does today, except it throws the code away.
3. Compare codes.

The six UAE aliases shrink to a small **informal-alias table** that is now a
shared resource rather than one country's exception:

```ts
const INFORMAL_ALIASES: Record<string, string> = {
  "uae": "AE", "u a e": "AE", "the united arab emirates": "AE",
  "ksa": "SA", "uk": "GB", "usa": "US", "holland": "NL",
  // grows on evidence, never on speculation
};
```

Everything unresolvable still falls through to `unknown`. **The safety
property is unchanged; only the set of countries it protects grew.**

`CountrySelect` already resolves a stored value on either code or name
([country-select.tsx](../src/components/ui/country-select.tsx)), which is why
`"AE"` is reachable in production data at all. That behaviour is what this
design leans on.

### 3.4 Enabled-but-unconfigured must read as DISABLED

This is the trap, and it is the opposite of the intuitive reading.

If an empty `homeCountries` meant "no exemptions", then every recognised
country classifies as `overseas`, and the feature **mails grant offers to
local authors** — precisely what it exists to prevent. That is fail-OPEN, on
the path that sends email.

So `readTravelGrantSettings` returns `enabled: false` when the list is empty,
and the settings save requires the picker when the toggle is on. Same
direction as the existing `enabled === true` strictness, and the same reasoning:
the direction is chosen per flag by asking which mistake is cheaper.

**Consequence to check before shipping, not assume:** any event that already
has `travelGrant.enabled === true` goes inert until a home country is set.
Nothing has run yet, so this should be a no-op — but count them on production
first rather than reasoning that it must be zero.

### 3.5 The label (needs D6)

`RESIDENCY_LABEL.uae` is the string `"UAE, not eligible"`. It has to name the
actual country now, so the flat `Record` becomes a function:

```ts
residencyLabel(residency, homeCountryNames): string
```

- **One home country** → `"United Arab Emirates, not eligible"`.
- **Two or more** → open question. `"Local, not eligible"` reads cleanly but
  hides which countries; `"Exempt country, not eligible"` is accurate but
  clumsy. Recommendation: the short form in the badge, with the full list in
  the settings card and the console's help text.

The shared-vocabulary guard
([travel-grant-shared-ui.test.ts](../__tests__/lib/travel-grant-shared-ui.test.ts))
must be updated in step, so the console and the speaker card still cannot
drift apart.

---

## 4. What actually changes, grounded

**Five `classifyResidency` call sites**, and the useful finding is that
**every one of them already holds the event's `settings` blob** — so this
costs **zero additional queries**:

| Site | Already has settings? |
|---|---|
| [server.ts:64](../src/lib/travel-grant/server.ts) (email block) | Yes — takes `settings` as a param for the master switch |
| [console.ts:120,149,220](../src/lib/travel-grant/console.ts) (roster + speaker lookup) | The route selects `settings`; the functions take only `eventId` and must be given it |
| [send.ts:253](../src/lib/travel-grant/send.ts) (named-send re-check) | The route selects `settings` and passes the whole `event`; only the input interface needs the field |

Plus:

- [settings.ts](../src/lib/travel-grant/settings.ts) — read + validate the list, apply §3.4
- [constants.ts](../src/lib/travel-grant/constants.ts) — `RESIDENCY_LABEL` becomes a function
- [travel-grant-badges.tsx](../src/components/travel-grant/travel-grant-badges.tsx) — takes the names
- [travel-grants/page.tsx](../src/app/%28dashboard%29/events/%5BeventId%5D/travel-grants/page.tsx) — stat tiles use the new label
- Settings → Abstracts — a multi-country picker beside the toggle
- The event PUT's settings handling
- ~45 existing eligibility tests gain the second argument; new tests for
  code resolution, the informal-alias table, and the empty-list fail-closed rule
- `TRAVEL_GRANT.md`, the user guide's Travel Grants section, and this file

Roughly half a day.

---

## 5. Build order

1. **The predicate.** `classifyResidency(country, homeCodes)`, `home` replaces
   `uae`, code resolution, informal aliases. Tests first — the existing 45 are
   the regression net, and the compiler names every consumer.
2. **The settings reader.** `homeCountries` + the §3.4 fail-closed rule.
3. **Thread it.** Five call sites, all already holding the blob.
4. **The label.** Function, badges, tiles, shared-vocabulary guard.
5. **The picker.** Settings → Abstracts, required when the toggle is on.
6. **Docs.** Both travel-grant docs + the user guide.

Each step gated (tsc, eslint, vitest, build) and the picker verified in a
browser, not only compiled — the Setup-hub outage on 2026-08-25 was a change
that passed all four and still took a page down.

---

## 6. Deliberately NOT in this

- Org-level default with per-event override (D3).
- Region presets (D5).
- Distance-based or flight-time-based eligibility. Someone will ask; it needs
  data we do not have and rules nobody has agreed.
- Per-country grant amounts or tiers. The feature captures **consent and
  interest only** and holds nothing financial (TRAVEL_GRANT_PLAN.md D1). That
  boundary is not moved here.
- Changing what an author sees. The consent form and the email block are
  untouched.

---

## 7. Open questions

1. **D6** — the 2+ country label wording.
2. Should the picker offer a **"same as the event's country"** shortcut?
   `Event.country` exists. Tempting, but it makes the home country implicit
   again, which is the thing this plan is removing. Recommendation: no.
3. Is there any event on production with `travelGrant.enabled === true`?
   §3.4 says count, do not assume.
4. `countries.ts` holds **196** entries; CLAUDE.md claims 249. Harmless drift,
   but the number in the docs should match the file if anyone quotes it.
