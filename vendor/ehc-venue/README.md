# EHC 2026 Online Venue — source code

A walkable 3D twin of the Emirates Hematology Conference 2026 (Conrad Dubai): AI attendees you can talk to, live colleagues, avatar actions, four camera views, safety tools (mute, block, report, language filter), sponsor activity for the event team, recordings on screens, and a device check.

- Live prototype: https://claude.ai/artifact/X3kng94BNpNVoTAEcLCXWE
- Developer handover (architecture, API contract, security, avatar spec): `docs/event-blueprint-developer-handover.html` (live version: https://claude.ai/artifact/DL2BqkLdijTfXTXg8gHBtA)

This folder is the version published as **venue version 7** (5 October 2026). `python3 build.py` reproduces the published page byte for byte.

## What's here

```
build.py            joins src/ in a fixed order into dist/index.html (+ dist/test.html, dist/screens.json)
screens.json        which recording plays on which screen ({} = animated titles only)
src/
  shell.html        markup and all CSS for the HUD, panels, chat and sheets
  engine.js         WebGL 2 renderer: batching, instancing, lights, tone mapping, quality levels
  textures.js       canvas-drawn textures (carpets, screens, banners, posters)
  world.js          the venue: rooms, zones, furniture, seats, stands, screens, points of interest
  chars.js          stylised people, outfits, three levels of detail, crowd and personas
  physics.js        capsule collision, step-up, ground snapping, camera arm, A* navigation grid
  audio.js          ambient sound and UI sounds
  filter.js         language filter (English and Arabic, disguised spellings)
  social.js         AI attendee conversations, live colleagues, speech bubbles, voices, mute/block
  abilities.js      gestures, sit, queues, walk-me-there, follow, photos
  team.js           event team: people list, reports, activity, recordings, language settings, device check
  game.js           main loop, input (keyboard, touch stick), camera views, HUD wiring, test API
dist/               built output (one self-contained file, ~275 KB, no libraries)
tests/
  run_all.py        runs every suite and checks the results (exit 0 = all passed)
  test_*.py         nine browser suites (Playwright + Chromium, software WebGL)
  filter_unit.js    unit test for the language filter (Node)
  mock.js           stands in for the Claude hosting runtime (sign-in, shared data, AI, live presence)
  verify.js         the physics and world checks used by test_world
  fixtures/         a short test video for the recordings-on-screens tests
docs/               the developer handover (HTML and Markdown)
```

No framework, no npm, no Three.js. Everything is plain JavaScript that runs in the browser.

## Build and open it

```
python3 build.py
python3 -m http.server 8000 -d dist     # then open http://localhost:8000
```

Opened like this it runs without the hosting runtime: you can walk everything, and AI attendees fall back to simple pre-written answers (the page says so). Live colleagues, saved activity and reports need the runtime or your own server. Needs a browser with WebGL 2 (any current phone or desktop browser).

## How it talks to the outside world

Today the page asks the Claude hosting runtime for five capabilities with `window.claude.use(name)`:

| Capability | Used by | For |
| --- | --- | --- |
| `sample` | `social.js` | AI attendee replies (streamed, quick tier) |
| `room` | `social.js` | Live colleagues: `presence()` out, `onPeers()` in |
| `user` | `social.js`, `team.js` | Who is signed in; whether they are the owner (event team) |
| `db` | `team.js` | Activity (`analytics/<user>`), reports (`reports/<user>/items/<id>`), settings (`config/filter`, `config/screens`) |
| `downloads` | `game.js`, `team.js` | Saving photos, CSV exports, the device check result |

Moving to MM Group's server, there are two routes:

1. **A small shim (fastest).** Provide your own `window.claude = { use(name) {...} }` that returns objects with the same methods, backed by your API (`POST /venue/ai`, `WS /venue/room`, `PUT /venue/activity/me`, `POST /venue/reports` … — section 4 of the handover). `tests/mock.js` is a working example of every method the page calls.
2. **A data adapter like the Blueprint's `Platform`** inside `social.js` and `team.js`. Cleaner long term; more edits.

Settings you can also inject before the page's script, without any runtime:

| Global | Effect |
| --- | --- |
| `window.EHC_TTS = { endpoint }` | Natural voices from your text-to-speech service (`POST {text, voice, gender, lang}` → audio); device voices are the fallback |
| `window.EHC_SCREENS = { 'plenary-main': { url, title }, … }` | Recordings per screen (else `screens.json`, else db `config/screens`). Screen ids: `plenary-main`, `plenary-left`, `plenary-right`, `hallA`, `hallB`, `hallC`, `workshop` |
| `window.EHC_FILTER = { on, mode: 'mask' \| 'hide', extra: [...], allow: [...] }` | Language filter settings (else db `config/filter`, saved from the Language tab) |
| `window.EHC_CONTACT = 'events@…'` | The event team contact shown when a report can't be sent |

Identity always comes from the runtime or your server, never from what another page sends; keep it that way on the server (see the handover's security section).

## Tests

```
pip install -r requirements-test.txt
python3 -m playwright install chromium
python3 build.py
python3 tests/run_all.py                     # all suites; allow 10–20 minutes (software WebGL is slow)
python3 tests/run_all.py filter round3       # just some suites
node tests/filter_unit.js                    # language filter unit test (also run by run_all if Node is installed)
```

| Suite | Covers |
| --- | --- |
| `test_world` | 15,000 random steps without passing through walls, every door passable, camera never inside geometry, every point of interest reachable |
| `test_abilities` | Sit and stand, gestures, applause, both queues serve, walk-me-there to every room, follow, photos |
| `test_social` | AI attendee conversations and memory, live colleagues, hostile presence data clamped, no injected HTML |
| `test_views` | Four camera views, eye view, camera safety, voice choice and sentence-by-sentence speech |
| `test_event_team` | Mute, block, report, activity saved and reported, CSV safety, recordings on screens, device check |
| `test_round1` / `test_round2` / `test_round3` | The second audit's fixes (identity, append-only reports, activity kept across visits, videos, queues, panels, tap targets, crowd limits) |
| `test_language_filter` | Masking and hiding in chat and bubbles, three-strike alert, outgoing filtering, owner settings reaching attendees |

Notes:

- Tests serve `dist/` on local port 8765 and use `tests/mock.js` in place of the runtime. They use the test API `window.__EHC`, which exists only in `dist/test.html`.
- Chromium runs with SwiftShader (software WebGL), so **frame rates in tests mean nothing**. Measure real devices with the venue's own "Check this device" button.
- Screenshots and reports go to `tests/out/`.
