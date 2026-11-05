# Events that register elsewhere: the plan

PLANNED, NOT BUILT (Nov 5, 2026). The first step toward a listing-only
customer such as DHA or EHS, who publish events in a catalogue but run
registration somewhere else. MM Group can use it at once for partner events.

## What it does

An event can say **"registration is handled elsewhere"** and give a link.
Then:

| Surface | Today | With an external link |
|---|---|---|
| Event page `/e/{slug}` | Register button to our form, price, "Registration closed" without types | **"Register on the organiser's site"** to the link, no price; everything else (dates, venue, CME, faculty, programme, Q&A) unchanged |
| Catalogue and topic cards | "From $X", Early Bird or Closed | **"External registration"** label; the card opens the event page |
| `/e/{slug}/register` and the public register API | The form | **Refused**: the page sends people to the event page, the API answers 409 and logs it, so nobody registers twice |
| Next up (catalogue) | Rates per type | The external button, no rates |
| JSON-LD `offers` | Our price and availability | `url` is the external link, no price |
| `llms.txt` and the FAQ | "Register at …" | "Registration is on the organiser's site: {link}" |
| Dashboard Registrations page | Normal | A banner: "Registration for this event happens on {host}" |

No ticket types, payments or forms are needed. Abstracts, agenda, speakers,
certificates and the rest still work if the organiser uses them.

## How it is stored and set

- `Event.settings.externalRegistration = { url, label? }`, settings JSON, no migration.
- **https only**, at most 500 characters, checked on the way in and out (the
  same rule shape as the catalogue photo). `label` is optional text, at most 40.
- Set in **Event Settings, Registration tab**: a "Registration is handled
  elsewhere" switch with the link and an optional button label. It is shown
  in the Catalogue tab's Listed events list as a tag.
- One reader, `readExternalRegistration(settings)`. `publicRegistration` gains
  an `"external"` state, so the event page, cards, Next up and JSON-LD follow
  the one public rule instead of each checking the setting
  (`public-availability.ts` stays the single decision).

## Files

`src/lib/event-overview.ts` (state), a new reader beside
`src/lib/public-availability.ts`, `src/app/e/[slug]/page.tsx`,
`src/components/catalogue/catalogue-parts.tsx`, `src/lib/seo.ts`,
`src/app/e/[slug]/register/page.tsx`, `src/app/api/public/events/[slug]/register/route.ts`
(and `group-register`), the event Settings page and its PUT allow-list, the
Registrations page banner, and tests.

## Later, for a listing-only customer (not in this plan)

1. **A short listing form**: name, dates, venue, specialty, CME hours and
   accreditor, description, banner, external link.
2. **A catalogue-only setup per organisation**: today module switches are per
   deployment; a per-organisation module list plus a "Catalogue editor"
   custom role would leave only Events and Catalogue.
3. **The platform instance** (their own domain), after §6 and §9.
4. **Only if they list other providers' events:** provider submission and
   review, a separate product.

## Decisions for the owner

- **D1.** The button opens the organiser's site in a new tab (recommended, so
  the catalogue stays open) or the same tab.
- **D2.** Default button text: "Register on the organiser's site" (recommended)
  or the link's domain, "Register at dha.gov.ae".
- **D3.** Optional free-text price line ("From AED 500, paid on the organiser's
  site") on external events, or no price at all (recommended until asked).

## Size

About a day, no migration.
