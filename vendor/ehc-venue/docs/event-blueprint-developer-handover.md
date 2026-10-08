# Event Blueprint & Online Venue — Developer Handover

5 October 2026 · Medhat Nassar, MM Group

**Live pages**

- Event Blueprint: https://claude.ai/artifact/YYYi9hgRjDz6rENioXcLHG
- EHC 2026 online venue: https://claude.ai/artifact/X3kng94BNpNVoTAEcLCXWE
- This document (live version): https://claude.ai/artifact/DL2BqkLdijTfXTXg8gHBtA

## 1. Summary

Two working pages are live as private Claude artifacts and ready to move onto MM Group's own server: the **Event Blueprint** (a guided intake that turns any event idea or real event into a build-ready brief) and the **EHC 2026 online venue** (a walkable 3D twin of the Emirates Hematology Conference at Conrad Dubai). Both were written so the server move is a configuration change, not a rewrite.

|  | Event Blueprint | Online venue |
| --- | --- | --- |
| What it does | 13-step brief for any event type, reality checks against published benchmarks, layout sketch, starter packs, submission tracking, section owners | Walkable venue, AI attendees, live colleagues, avatar actions, four camera views, safety tools, language filter, sponsor activity, recordings on screens |
| Size | One HTML file, about 235 KB, no external libraries | One HTML file, about 275 KB, custom WebGL 2 engine, no external libraries |
| Runs today on | Claude artifact (sign-in, shared data, AI, uploads) | Claude artifact (AI, live presence, shared data) |
| Server switch | `window.EVENT_BLUEPRINT_BACKEND` | `window.EHC_TTS`, `window.EHC_SCREENS`, `window.EHC_FILTER`, `window.EHC_CONTACT`, data adapter to add |
| Tests | 4 automated browser test suites | 9 automated browser test suites |

What the developers need to decide: where the API lives (likely next to EA-SYS), how users sign in, and which voice and video services to use. Section 9 lists these with a suggested order.

## 2. Event Blueprint: how it is built

The Blueprint is one self-contained HTML page built from five source files; everything outside the browser goes through a single adapter object, `Platform`, so moving to your server touches only that object.

| File | Holds |
| --- | --- |
| `part1.html` | Markup and all CSS (light and dark themes, phone-first layout) |
| `data.js` | Event types, the 13 sections, examples per type, avatar options, ability lists, upload categories |
| `bench.js` | Benchmarks with their sources, reality checks, planning numbers, the to-scale layout sketch, starter packs, date and headcount parsing, memoisation |
| `platform.js` | The adapter: storage, AI, file uploads, identity, downloads, notifications, in three modes |
| `app.js` | State, sanitising, readiness scoring, change tracking, every section's UI, quick fill (talk it through, read documents), submission, tracker, templates, section owners |

A build script concatenates them into `dist/index.html`. There is no framework and no external library; the only network calls are the adapter's and, when a PDF is read, pdf.js from cdnjs.

**State.** One plain object per blueprint (`v: 2`), saved whole on every change (debounced 1 s) and kept in `localStorage` as a fallback. Top-level keys: `path`, `type`, `format`, `basics` (incl. `food`), `concept` (incl. AI `options`), `spaces` (name, purpose, layout, cap, area), `programme`, `people`, `avatars`, `partners`, `look`, `online`, `delivery`, `files` (incl. `uploads`), `sketch.rooms`, `checkAck`, `owners`, `notes`, plus workflow fields `status`, `ref`, `submissions`, `statusLog`, `approvals` and `baseline` (a snapshot at the last submission, used to list changes not yet sent). Every load, template and AI answer passes through `sanitise()`, which rebuilds the object field by field with fixed types and lengths.

**Adapter modes.**

- **artifact** (today): Claude's runtime gives sign-in (`user`), shared storage (`db`, rules: blueprints and templates readable and writable by Contributors), AI (`sample`), uploads (`assets`) and file saving (`downloads`).
- **api** (your server): set `window.EVENT_BLUEPRINT_BACKEND = { api: 'https://…/api/blueprint', ai: true, files: true }` before the script; every call becomes a `fetch` with cookies to the endpoints in section 4.
- **local**: no backend; everything stays on the device and the page says so in plain words.

## 3. Online venue: how it is built

The venue is a single page with its own small 3D engine (WebGL 2, no Three.js), split into eleven modules that a build script joins in a fixed order (`engine`, `textures`, `world`, `chars`, `physics`, `audio`, `filter`, `social`, `abilities`, `team`, `game`); only the people layer reaches outside the page.

The loop in `game.js` runs physics at a fixed 60 Hz and draws as fast as the device allows, lowering resolution and then switching to Balanced quality when a phone struggles.

| Area | How it works |
| --- | --- |
| Rendering | Static geometry merged into a few batches (about 30 draw calls), instanced people with three levels of detail, nearest-12 point lights, ACES tone mapping, canvas-drawn textures |
| Physics | Capsule against boxes and circles, step-up, ground snapping, soft crowd push, a camera arm that never enters walls (600 random poses tested per view) |
| Navigation | 1 m grid with A* and path smoothing, wall-crossing checks between cells, queue lines kept clear; 90 of 90 room-to-room routes arrive |
| AI attendees | Each crowd member gets a persona; replies come from Claude (`sample`, quick tier) with venue facts in the prompt, streamed and spoken sentence by sentence |
| Live colleagues | Presence through `room`: position, gesture, last line said; all incoming values clamped and rendered as text only |
| Event team | Mute and block (per device); append-only reports with a copy-to-send fallback; activity kept on the device and merged with the saved copy, names only with consent; a cancellable device check that is not counted as visits; recordings on screens. Panels behave as dialogs: focus moves in, Tab stays inside, Escape closes |
| Crowd limits | At most 8 speech bubbles on screen (the person you talk to first, then the nearest), sizes measured once per message; at most 2 other voices queued, the conversation partner always spoken |
| Language filter | `filter.js` checks chat between attendees, before sending and before showing. English and Arabic (script and Latin spelling), disguised spellings (f.u.c.k, sh1t, f*ck), whole words so "cocktail" passes. Owner chooses mask or hide, extra and allowed words; settings live in `config/filter`. Three filtered messages from one person alert the viewer |

## 4. API contract

The Blueprint already calls these endpoints when API mode is on; the venue endpoints are proposed to match what the page does today. All are JSON over HTTPS with the user's session cookie; the server, not the browser, holds the Claude API key.

**Event Blueprint (already wired in `platform.js`)**

| Method and path | Sends | Returns | Notes |
| --- | --- | --- | --- |
| `GET /me` | — | `{ id, isEditor }` | Who is signed in; `isEditor` shows the build-team stage control |
| `GET /blueprints` | — | `[blueprint]` | Only the signed-in owner's, newest first |
| `GET /blueprints/:id` | — | `blueprint` | 404 when not the owner's (the server must check) |
| `PUT /blueprints/:id` | `blueprint` | `{ ok }` | Whole object; reject if `ownerId` differs from the session user |
| `GET /templates`, `PUT /templates/:id` | `template` | `[template]` | Templates are personal (owner-only list) |
| `POST /ai/json` | `{ prompt, tier, images? }` | parsed JSON | Server calls the Claude API; `tier` quick or default; images as base64 |
| `POST /files` (multipart) | `file` | `{ id, url, sizeBytes, contentType }` | 20 MB cap; `GET` and `DELETE /files/:id` |
| `POST /events` | `{ type, blueprintId, ref, … }` | `{ ok }` | `submitted`, `update`, `approval`: send confirmation emails, notify the team |

**Online venue (proposed)**

| Method and path | Sends | Returns | Replaces today's |
| --- | --- | --- | --- |
| `POST /venue/ai` | `{ persona, turns }` | streamed text | `sample` (AI attendee replies) |
| `WS /venue/room` | presence updates | everyone's presence | `room` (live colleagues) |
| `PUT /venue/activity/me` | activity document | `{ ok }` | `db` `analytics/<user>` |
| `GET /venue/activity` | — | all activity | owner-only report |
| `POST /venue/reports` | report | `{ ok }` | `db` `reports/<user>/items/<id>` (append-only: one record per report, never read back) |
| `POST /tts` | `{ text, voice, gender, lang }` | audio | `window.EHC_TTS` (natural voices) |
| `GET /venue/screens` | — | `{ screenId: { url, title } }` | `window.EHC_SCREENS` or `screens.json` |
| `GET /venue/config/filter` | — | `{ on, mode, extra, allow }` | `window.EHC_FILTER` or db `config/filter` |
| `PUT /venue/config/filter` | filter settings (event team only) | `{ ok }` | Language tab "Save for everyone" |

**EA-SYS hand-off.** On `POST /events` with `type: 'submitted'`, the server creates or updates the event in EA-SYS from the blueprint (title, dates, venue, spaces, programme, partners) and writes back the EA-SYS event id and stage. The Blueprint's tracker already shows seven stages (Draft, Submitted, In review, Plan ready, Building, Preview, Live); EA-SYS stage changes should map onto these so the organiser sees progress without logging into anything else.

## 5. What moves to your server, and why

Five things only work fully once the pages run on your server, because the Claude hosting deliberately limits what an anonymous visitor can save or load.

| What | Limit today | On your server |
| --- | --- | --- |
| Sponsor activity for every visitor | Only signed-in Contributors can save data, so open-link visitors are not counted | Every visitor counted; named records only with consent |
| Safety reports from every visitor | Open-link visitors can mute and block, but not send reports | Everyone can report; reports reach the team by email or dashboard |
| Ownership of blueprints | Contributors with access could overwrite another person's blueprint (no planted code can run; the risk is data tampering) | The server checks the owner on every write |
| Full-length recordings | Clips are published with the page, 15 MB each | Streamed from your video host (any size), mapped per screen |
| Natural voices | Device voices only; quality varies by phone | One neural voice service, same voice on every device, via `POST /tts` |

Everything else (the 3D venue, AI attendees through your Claude API key, the Blueprint's checks and sketch) runs unchanged.

## 6. Security and privacy

Both pages treat every saved record, AI answer and live message as untrusted, and the first independent audit's two serious findings are fixed and re-tested; the server must now enforce ownership, which the browser cannot.

- **Sanitising.** `sanitise()` in the Blueprint rebuilds every loaded blueprint and template with fixed types and lengths; sketch positions are numbers only, so nothing saved can reach the SVG as markup. Templates list only the owner's own.
- **AI answers.** Wrong-shaped JSON is dropped with a "try again" note, never saved. AI text is shown with `textContent`, never as HTML.
- **Live presence.** Incoming positions are clamped to the venue, colours must be `#rrggbb`, speech is capped at 280 characters and rendered as text.
- **Links.** `javascript:` links are never made clickable; recording URLs must be `https` or same-site video files.
- **Spreadsheets.** CSV exports prefix cells starting with `=`, `+`, `-` or `@`, so a name cannot run as a formula in Excel.
- **Consent.** The welcome screen says visits are counted and kept with the attendee's sign-in, and sponsors see totals only unless the attendee ticks the box. The same choice sits in the Venue guide, so it can be changed at any time after entering.
- **Language.** Chat between attendees is filtered before it is sent and again before it is shown, so an old or modified page cannot bypass it for others. Only the event team can save filter settings; the server should enforce that on `PUT /venue/config/filter`. The filter catches common words, not everything, so mute, block and report stay the backstop.
- **Server duties.** Check the owner on every blueprint write; rate-limit `/ai/json` and `/venue/ai`; keep the Claude key server-side; store reports and activity with access limited to the event team.

**UAE PDPL points to confirm with counsel:** a privacy notice for the venue and Blueprint; the lawful basis for anonymous counting; retention periods for activity, reports and uploaded files; where the data is hosted; and how an attendee can ask for their data to be deleted.

## 7. Realistic avatars: what to ask a 3D artist for

Realistic people need rigged character files from a 3D artist or an avatar service; the engine then needs a glTF loader and a skinning shader added (today it draws stylised figures from simple shapes). Hand the artist this specification.

| Item | Specification |
| --- | --- |
| Format | glTF 2.0 binary (`.glb`), one file per character plus shared animation files |
| Orientation and scale | Metres, Y up, facing +Z, feet at 0 |
| Rig | Humanoid skeleton with Mixamo-style bone names, at most 60 bones, at most 4 bone weights per vertex |
| Triangles (phones first) | Near: up to 15,000 · middle distance: about 5,000 · far: about 1,500 (three levels of detail) |
| Textures | PBR metallic-roughness, 1024 × 1024 (2048 only for the face), KTX2 preferred, else JPEG or PNG |
| File size | Under 3 MB per character including textures |
| Outfits | Separate swappable meshes: business suit, smart casual, kandura with ghutra, abaya with shayla, evening wear, staff uniform, white coat |
| Variety | At least 8 faces and a full range of skin tones; hair as separate meshes |
| Animations (in place, 30 fps) | Idle, walk, run, sit down, seated idle, stand up, wave, clap, hand on heart, raise hand, point, nod, handshake, talk gestures, hold a cup, photo pose |
| Lip movement (optional) | Visemes as blend shapes (Oculus 15 set or ARKit 52) |
| Rights | Full commercial rights to modify and use on the web; any real person's likeness only with recorded consent |

## 8. Testing

Thirteen automated browser test suites (Playwright with Chromium) cover both pages and run on every change; the one gap is real-device speed, because the test machine has no graphics card.

| Suite | Page | What it proves |
| --- | --- | --- |
| `verify.py` | Venue | 15,000 random steps with no wall penetration over 0.6 mm, 13 of 13 doors passable, 600 camera poses never inside geometry, 24 of 24 points of interest open |
| `abil_test.py` | Venue | Sit and stand, gestures and applause, both queues serve, 90 of 90 walk-me-there routes arrive with no teleports, follow stays about 2 m behind, photo saves |
| `social_test.py` | Venue | AI attendee conversation and memory, live colleagues, hostile presence data clamped, no injected HTML |
| `view_test.py` | Venue | Four camera views, eye view height and movement, voice ranking and sentence-by-sentence speech |
| `team_test.py` | Venue | Mute, block, report (stored and refused cases), activity saved and reported, CSV safety, recordings play on screens, device check |
| `r1_test.py` | Venue | Second audit round 1: identity only from the platform, reports append-only, activity kept across visits when reads are refused |
| `r2_test.py` | Venue | Round 2: hostile activity records, videos pause and mute on leaving, photo during a queue, Venue guide layout on a phone |
| `lf_test.py` | Venue | Language filter: masking in chat and bubbles, the three-strike alert, outgoing filtering, owner saves hide mode and extra words, attendees pick them up |
| `r3_test.py` | Venue | Round 3: Escape and focus in every panel, device check cancels and adds no visits, 40 px tap targets, 20 talkers capped at 8 bubbles and 2 queued voices, report fallback |
| `s1_test.py` | Blueprint | Talk it through with a PDF, uploads, submit with reference, change tracking, approvals, templates, device-only mode |
| `s3_test.py` | Blueprint | Starter packs, reality checks per section, accept and reopen, layout sketch drag, rotate, keyboard and PNG |
| `r3_test.py` | Blueprint | Round 3: no long tasks while typing with 40 spaces and 300 partners at 4x slower CPU, owner email changes tracked, same-name owners kept apart, owner form keys |
| Audit scripts | Blueprint | The first audit's repro cases: tampered templates, malformed AI answers, dates, headcounts, performance, accessibility |

**Known limits.** Frame rates measured here are software-rendered and meaningless; use the venue's own "Check this device" button on real phones. Speech is checked by which voice is chosen, not by listening.

## 9. Open decisions and next steps

The server move is the next step; it needs four decisions from MM Group before any code is written, in this order.

1. **Where the API lives.** Next to EA-SYS (one sign-in, one database) or as a separate service that talks to EA-SYS.
2. **How people sign in.** EA-SYS accounts for organisers; for venue attendees, the registration link from EA-SYS or a one-time email code.
3. **Which services to use.** A video host for full-length recordings, and a neural voice service for `POST /tts`.
4. **Privacy.** Counsel signs off the PDPL points in section 6 before attendee activity is collected on your server.

Then, in order:

- [ ] Implement the Blueprint endpoints in section 4 and switch on API mode
- [ ] Map Blueprint stages to EA-SYS stages and send `submitted` events into EA-SYS
- [ ] Add the venue endpoints and a data adapter in the venue, matching the Blueprint's
- [x] Second independent audit of both pages, fixed in three rounds (see section 10)
- [ ] Walk the venue on an iPhone and a mid-range Android with "Check this device" and send the results
- [ ] Commission realistic avatars against section 7, if wanted
- [ ] Arabic right-to-left interface (agreed to come last)

## 10. Changes since the first handover

The second audit's findings are all fixed, in three rounds, and a language filter was added; the venue is now at version 7 and the Blueprint at version 6. Newest first:

| Round | Page | Change |
| --- | --- | --- |
| 3 | Blueprint | Off-screen layout sketch no longer redraws while someone types; it catches up after a pause or when scrolled into view (long tasks of 140–390 ms at 4x slower CPU are gone) |
| 3 | Blueprint | Owner email-only changes appear in the change list; owners sharing a name are kept apart by email; long names wrap; Enter saves and Escape cancels the owner form, with focus returned |
| 3 | Blueprint | Reality-check source links and accepted-check toggles are at least 40 px tall on a phone |
| 3 | Venue | Every panel is a proper dialog: focus moves in, Tab stays inside, Escape closes the top one, tapping outside closes People and Event team |
| 3 | Venue | Device check has a Cancel button that works at once; its jumps between rooms are not counted as visits |
| 3 | Venue | All phone and chat buttons at least 40 px; consent text now accurate (visits kept with the sign-in, sponsors see totals unless the attendee opts in); the name-sharing choice is also in the Venue guide |
| 3 | Venue | Failed reports explain plainly, point to the event team (set `window.EHC_CONTACT` to show its email) and offer Copy report |
| 3 | Venue | At most 8 speech bubbles and 2 queued voices from others, so large crowds stay smooth |
| — | Venue | Language filter for chat between attendees, with an owner Language tab (see section 3) |
| 2 | Venue | Hostile activity records cannot break the owner report; recordings keep playing from the side of the plenary, pause and mute on leaving, and keep sound through an open panel |
| 2 | Venue | A photo taken while queuing keeps the place in the queue; Stop leaves it cleanly; Venue guide shows the current room with Walk and Go on one line |
| 1 | Venue | Identity comes only from the platform, never from what a page sends; reports are append-only records, so attendees can file them without read access |
| 1 | Venue | Activity totals are kept on the device and merged with the saved copy, so a refused read no longer wipes history; keys work while the consent box has focus; missing `screens.json` no longer logs errors |

One open item from round 3: the event team's contact email for the report fallback message.
