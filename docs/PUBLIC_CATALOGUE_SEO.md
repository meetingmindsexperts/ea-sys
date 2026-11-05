# Public event catalogue, event pages and search engines

Built November 4, 2026. This is the operator's guide: how an event gets listed,
where every part of the public pages comes from, and what search engines and AI
assistants receive. The code is the truth; the files are named at the end.

## The three public surfaces

| Address | What it is |
|---|---|
| `/catalogue` | Every listed event, searchable, with Upcoming and Past tabs |
| `/catalogue/specialty/{x}` and `/catalogue/country/{x}` | One page per specialty or country that has a listed event, e.g. `/catalogue/specialty/cardiology` |
| `/e/{slug}` | The event's own page: what, when, where, CME, faculty, programme, questions, and Register |

The registration form itself is unchanged at `/e/{slug}/register`.

## Getting an event listed

1. The event is **PUBLISHED** (or LIVE). Drafts and cancelled events never show.
2. Switch it on in Settings, **Catalogue**, Listed events, or in the event's own **Settings, Registration tab** (**Show in the event catalogue**, then **Save registration settings**).

The switch is off by default, so a closed or invite-only meeting is never
advertised. An unlisted but published event still has its `/e/{slug}` page for
people with the link; that page is marked `noindex`, so it stays out of search
results. Once the event ends it moves to the Past tab (as COMPLETED or not).

## Where every part of the page comes from

Nothing on these pages is written by hand for the page; it all comes from what
is already set on the event. Fill these in and the pages fill themselves.

| On the page | Comes from (where to edit it) |
|---|---|
| Banner | Event Settings, Branding: banner image and mobile banner. Cards use the mobile banner (about 16:9); without one, the wide banner is shown whole |
| Name, dates, venue, city, country | Event Settings, General |
| Type and specialty chips, topic pages | Event Settings, General: event type and specialty. **Specialty is free text, so spell it the same way on every event**; spelling or spacing variants are grouped, but a different word ("Cardiac" vs "Cardiology") is a different page |
| The one-line summary under the headline | Written by the page from type, specialty, city, country and CME hours |
| **About** | Event Settings, General: **description**. Shown only when there is one. Only 5 of 24 public events had one on Nov 4, 2026, and it is the single biggest improvement for search |
| CME hours and accreditation | The event's **Certificates page, CME settings**: the event's CME hours, and the accreditors (DHA, DOH, SCFHS, EACCME, ACCME, or a named "Other") with their reference numbers. The CME tile and section appear only when hours are set |
| Registration types ("Who can register") | Registration Types page: every active type except the hidden Faculty type |
| Price ("From ...") and Register | Registration Types and pricing tiers, read by the same rule the form uses: the lowest paid price at the rate the main Register link lands on. Closed, full, and ended events say so instead |
| Faculty and programme | The agenda: shown only once **Publish Agenda** is on (Event Settings, Registration tab), the same rule as the public agenda page. Faculty are the speakers on its sessions and topics, with their photo, title and organisation from the speaker record |
| Venue card and Maps link | Venue, address, city, country |
| Questions (FAQ) | Written by the page from the facts above; a question is asked only when the event can answer it |
| Organiser name and logo, support email | Organisation settings, and the event's support email |
| Topic page intro | Written from the topic's upcoming events: how many, where, the most CME hours |
| Catalogue hero photo | Settings, **Catalogue** tab: the photo (a landscape conference photo, about 2400 px wide, under 2 MB). Shown under a navy wash; without one, or if the file is deleted, the hero draws an ECG-paper pattern |
| Line above the headline, headline, description | Settings, **Catalogue** tab. Empty uses the page's own: the organisation's name, "Medical conferences and CME, from {first city} to {last city}.", and the standard intro. The description is also the page's search and social description |
| Which sections show | Settings, **Catalogue** tab, Sections: track record, banners in the hero, Next up, How registering works, Browse by specialty and country (all on by default; a hidden section also loses its link in the top bar) |
| Banners fanned in the hero | The next three listed upcoming events' banners (the mobile banner, else the desktop one); the fan appears with two or more |
| Headline places ("from Dubai to Muscat") | The cities of those next events, in date order; webinars are left out |
| Hero numbers | Counted from the database: events hosted (published, live or completed, listed or not), delegates registered (not cancelled or waitlisted, Faculty type excluded), faculty (one per email), countries. Hidden for an organisation with fewer than three events |
| Next up, rates per type | The soonest listed event: each registration type's price at the rate the Register link lands on ("Early Bird rates"), by the same rule as the form |
| Card status and price | "Early Bird" (the rate's name), "Sold out" or "Registration closed", and "From $X": the same rule as the form |
| Footer about line and contact | Settings, **Catalogue** tab, Footer. Empty contact uses the company email and phone (Settings, Billing) |
| Which events are listed | Settings, **Catalogue** tab, Listed events: one switch per published event, the same switch as the event's own Settings, Registration tab |

## What search engines and AI assistants receive

| File | What it says |
|---|---|
| `/robots.txt` | Every crawler, AI assistants included (owner decision), may read the catalogue and event pages. The dashboard, API, sign-in pages, a person's own pages, and every secret-link page (shared views, survey, RSVP, agreements, completion and reset links, floor-plan links) are disallowed |
| `/sitemap.xml` | The catalogue, its topic pages, and every listed event |
| `/llms.txt` | A short plain-text map for AI assistants: the organisation, the catalogue, the topic pages, and the upcoming listed events with dates, place, type, specialty and CME hours |
| Page metadata | A title and description per page, a canonical address, and a social-sharing card |
| Structured data (JSON-LD) | Catalogue and topic pages: Organization, BreadcrumbList, ItemList of Events. Event page: Event (dates, place or online, image, organiser, price and availability, faculty, description), BreadcrumbList, FAQPage |

All of these are built from the request's address, so the platform instance
(another organisation on another domain) gets its own, listing only its events.

**Filtered catalogue views** (`/catalogue?country=...`) are `noindex, follow`:
search engines index one catalogue and the topic pages, not every combination of
filters.

**Known limitation:** a page that is not found answers HTTP 200 with `noindex`
rather than 404, because the root `loading.tsx` starts streaming every page
before it can decide. Search engines honour the `noindex`. Changing it is an
app-wide decision.

## After a deploy: the owner's steps

1. In Settings, **Catalogue**: upload a photo, review the headline and description, and switch on the events to advertise.
2. Add a **description** to each listed event.
3. In **Google Search Console** and **Bing Webmaster Tools**, verify
   `events.meetingmindsgroup.com` and submit `/sitemap.xml`.
4. Paste an event page into Google's **Rich Results Test** to confirm the Event
   and FAQ data are read.
5. After a few weeks, use Search Console to see which searches bring people in,
   and add topic pages or descriptions for those.

## Files

| Concern | File |
|---|---|
| Which events list, filters, topics (pure) | `src/lib/catalogue.ts` |
| Site organisation, topic values (server) | `src/lib/catalogue-data.ts` |
| Origin per host, JSON-LD, robots rules, llms.txt text | `src/lib/seo.ts` |
| Event page facts, price and state, FAQ, Event JSON-LD | `src/lib/event-overview.ts` |
| The one availability rule (API, form, event page) | `src/lib/public-availability.ts` |
| Settings, Catalogue tab | `src/components/settings/catalogue-settings-card.tsx`, `src/app/api/organization/catalogue/route.ts` (GET, PUT the settings; PATCH one event's listing); stored in `Organization.settings.catalogue`, read by `readCatalogueSettings` |
| Pages | `src/app/catalogue/page.tsx`, `src/app/catalogue/[kind]/[topic]/page.tsx`, `src/app/e/[slug]/page.tsx` |
| Shared catalogue components | `src/components/catalogue/catalogue-parts.tsx`, the hero's banner fan in `banner-fan.tsx` |
| robots, sitemap, llms.txt | `src/app/robots.ts`, `src/app/sitemap.ts`, `src/app/llms.txt/route.ts` |
| Tests | `__tests__/lib/catalogue.test.ts`, `seo.test.ts`, `event-overview.test.ts`, `public-availability.test.ts` |
