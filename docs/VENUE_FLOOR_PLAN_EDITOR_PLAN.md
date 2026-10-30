# Venue floor plan editor: plan

Status: IN BUILD (Oct 23, 2026; the exhibitor floor plan, section 10, planned Oct 30). Phases 0a (PDF export), 0 (the plan model) and 1 (the editor) BUILT the same day, phase 2 (polish) Oct 24; the owner accepted F1 to F8 as recommended ("proceed, phase by phase"). Owner request: "we want to drag rooms
and adjust room size and sides and so on; eventually a real floor plan image will
be used; the 3D walkable venue takes whatever 2D plan is made", and "the 2D floor
plan is exportable as PDF too".

This revisits decision **D10** in [EVENT_BLUEPRINT_PLAN.md](EVENT_BLUEPRINT_PLAN.md)
("generated venues use a fixed, adaptable floor plan ... free placement from the
sketch can come later"). Free placement is now.

## 1. Where we are

- **The plan is generated, never drawn.** The Venue tab keeps a list of rooms
  (`VenueRoom {id, name, kind, capacity}`, [rooms.ts](../src/lib/venue/rooms.ts)),
  saved in `Event.settings.venue.rooms`. [layout.ts](../src/lib/venue/layout.ts)
  turns that list into a building every time it is needed: foyer at the south,
  a corridor up the middle, the plenary at the north, halls / workshops / posters
  west, exhibition / lounge east, each room sized from its capacity. Nothing
  about position is stored.
- **One layout feeds everything.** `generateLayout()` returns a `VenueLayout`
  (zones, walls, doors, furniture items, people, hotspots, crowd routes). The 2D
  plan ([venue-floor-plan.tsx](../src/components/venue/venue-floor-plan.tsx)),
  the 3D venue (`window.EHC_LAYOUT` read by `buildLayout()` in
  [world.js](../vendor/ehc-venue/src/world.js)), session-to-room matching and
  sponsor stands all read it.
- **Walkability is checked, not hoped for.** [layout-check.ts](../src/lib/venue/layout-check.ts)
  walks a 0.5 m grid from the entrance and refuses a layout unless every room,
  door, stand and hotspot is reachable. It already works on any geometry, not
  only the template.
- **The 3D engine builds whatever the layout says, within two limits:** walls
  are straight and axis-aligned (`axis: "x" | "z"`), and rooms are rectangles.
  Rotation is therefore in 90 degree steps unless we also teach the engine angled
  walls (section 8).
- **Usage today (prod, read-only, Oct 23):** one event has saved rooms, none has
  opened its venue. Moving the data model is low risk now and gets harder later.

## 2. What we are building

The organiser starts from today's generated plan and then changes it on a 2D
canvas:

1. **Drag rooms** anywhere on a snapping grid.
2. **Resize rooms** by their edges and corners (metres shown live).
3. **Turn a room** 90 degrees, and **choose which wall its door is on** and where
   along it.
4. **Draw walkways** (corridors) as rectangles, and **place the entrance** on any
   outside wall.
5. **Exhibition stands:** set how many, then later drag them and say which
   sponsor takes which stand.
6. **Later: a real floor plan image** under the canvas, scaled to metres, to
   trace rooms over.
7. **Export the 2D plan as a PDF** (owner, Oct 23): for the venue, the
   exhibitors and the printed programme.

What the organiser draws is exactly what the 2D plan shows and what the 3D venue
builds. There is one plan, never a second copy for 3D.

## 3. Design

### 3.1 Two modes, one output

`settings.venue.plan` is new. It is absent for every venue today, which means
**automatic** (today's behaviour, unchanged). Once the organiser edits the plan
it becomes **custom**:

```ts
interface VenuePlan {
  v: 1;
  mode: "custom";
  /** Placement per room, keyed by VenueRoom.id. A room missing here is unplaced. */
  rooms: Record<string, { rect: Rect; door: { wall: "n" | "s" | "e" | "w"; at: number; width?: number } }>;
  /** Walkways the organiser drew; the foyer counts as one. */
  corridors: { id: string; rect: Rect }[];
  entrance: { wall: "n" | "s" | "e" | "w"; at: number; width: number };
  /** Stands: phase 3. Absent = generated from capacity, as today. */
  stands?: { count?: number; placed?: { n: number; x: number; z: number; face: number }[] };
  /** Phase 4: the underlay. */
  underlay?: { url: string; metresPerPixel: number; offset: [number, number]; opacity: number };
  updatedAt: number;
  updatedBy: string;
}
```

- **The room list stays the source of identity** (name, kind, capacity). The
  plan only adds geometry, keyed by room id, so session matching, sponsors and
  the AI prompt keep working unchanged.
- `generateLayout(rooms, opts)` gains `opts.plan`. With no plan it runs today's
  template; with a plan it runs a new `layoutFromPlan()`. **Both return the same
  `VenueLayout`**, so the 2D plan, the check and the 3D venue need no fork.
- **"Reset to automatic"** deletes the plan. **"Edit the floor plan"** creates a
  plan from the current automatic layout (`planFromLayout()`), so the organiser
  starts from what they already see, not from a blank page.

### 3.2 `layoutFromPlan()`

Reuses everything that does not depend on the template:

- **Zones** from the placed rectangles (plus corridors, plus the foyer).
- **Walls**: each room's four edges; edges shared by two rooms become one wall;
  the outside is the outline of the union of all rectangles. A door cuts an
  opening in its wall. All walls stay axis-aligned.
- **Furniture**: the existing furnishers (theatre, workshop, posters,
  exhibition, lounge, foyer) already work in a room's own frame from its door
  (`frame(zone, door)`). We add the missing **north** door frame; nothing else
  in the furnishers changes.
- **Signs, hotspots, spawn points** from the door positions, as today.
- **Crowd routes**: one loop per corridor rectangle instead of the one fixed
  loop.

### 3.3 Checking what the organiser drew

Three layers, cheapest first, all shown on the canvas as they happen:

1. **Shape rules** (instant, in the browser): rooms inside the building limit,
   no two rooms overlapping, each room at least its kind's minimum size, a door
   that opens onto a corridor, the foyer or another room (not onto the outside).
2. **Fit** (instant): the existing `fits()` tells whether a room's furniture
   holds its capacity. A room too small says so on the plan ("Hall B holds 84 of
   120 seats").
3. **Walkability** (`checkLayout`; measured Oct 23 on the templates: 17 ms for
   the congress plan at 45 m x 95 m, 1 ms for the meeting plan): run on every
   change, debounced; for a much larger drawn building, in a Web Worker so
   dragging stays smooth. Unreachable areas are tinted red with the reason
   ("Workshop 2: its door opens into a wall").

**Saving** reruns all three on the server (`saveVenuePlan` in the venue service,
beside `saveVenueRooms`), with the same `updatedAt` version check so two editors
cannot overwrite each other.

### 3.4 Keeping the room list and the plan in step

- **Room added** on the list: placed automatically in the first free spot beside
  a corridor and highlighted ("placed for you, drag it where it belongs").
- **Room removed**: its placement is dropped.
- **Capacity changed**: the room keeps its size; the fit message updates.
- **Blueprint "start from rooms"**: replaces the room list as today. It asks
  whether to keep the drawn plan (rooms matched by id) or reset to automatic.

### 3.5 The editor

A desktop canvas on the Venue tab (an editing surface is not offered on phones:
the plan stays viewable there):

- **Canvas**: the existing SVG plan, plus pointer handlers. Drag to move, edge
  and corner handles to resize, snapping to 0.5 m and to other rooms' edges,
  arrow keys to nudge 0.5 m (Shift for 5 m), scroll to zoom, space-drag to pan.
- **Side panel** for the selected room: name, kind, capacity (from the list),
  width x depth in metres, Turn 90 degrees, door wall and position.
- **Tools**: Select, Walkway (draw a corridor), Entrance.
- **Undo and redo** (Ctrl/Cmd+Z); unsaved changes are kept in the browser if
  the tab closes.
- **A status bar** in plain words: "Walkable: every room can be reached" or
  "2 problems: Workshop 2 has no way in; Hall B is too small for 120".
- **Preview in 3D** opens the venue with the unsaved plan, so the organiser can
  walk it before saving.

### 3.6 The 3D venue

**Found in phase 0, fixed in phase 1:** three spots in `world.js` still assume
the template's south entrance with the corridor north of the foyer: the foyer
directory board is drawn facing south (fixed yaw and an x-wide box), the
registration desks the same, and the event banners are placed beside the first
corridor's mouth by x. The layout already carries the right yaw and footprint
for each (the furnishers face the entrance), so the fix is to read them.


`buildLayout()` already builds walls, doors and furniture from coordinates. The
changes are small and in our copy of the vendor code (D5):

- doors and signs on any of the four walls (today side rooms only face east or
  west);
- several corridor zones (the minimap and navigation already treat zones
  generically);
- larger buildings: check the draw distance and the navigation grid size.

The vendor's own tests (no wall penetration, every door passable, every room
reachable) run against a set of drawn plans as well as the template.

### 3.7 PDF export of the 2D plan

The PDF is drawn from the same `VenueLayout`, so it works for an automatic plan
and a drawn one alike, and can ship before the editor.

- **Made on the server** with pdfkit and the shared PDF primitives in
  [src/lib/pdf/](../src/lib/pdf/) (the invoices and purchase orders already use
  them): crisp vector lines at any zoom, the same file for everyone, and no
  dependence on the viewer's browser.
- **What is on it**: the event name, dates and venue; every room with its name
  and capacity; walls, doors and the entrance; walkways; exhibition stands with
  their numbers and, when assigned, the sponsor's name; a north arrow, a scale
  bar in metres and a legend of room types. Furniture (seat rows, tables) is
  drawn lightly so the plan stays readable.
- **Page**: A3 landscape by default, A4 offered; the plan is scaled to fit and
  the scale is printed ("1 : 400").
- **Where**: a "Download PDF" button above the plan on the Venue tab;
  `GET /api/events/[eventId]/venue/plan-pdf?paper=A3|A4`, needing `events.read`,
  like the plan itself, 30 renders an hour per person. The download is logged.
- **As built (phase 0a)**: the page turns portrait or landscape to fit the
  plan; stands show their number and a key under the plan names each stand's
  sponsor (a 3 m stand is too small for a name at plan scale); room labels move
  off stands when the centre would hide them.
- **The underlay image is left out** by default (it may be the hotel's own
  drawing), with a tick box to include it once phase 4 exists.

### 3.8 The underlay image (phase 4)

- Upload a PNG or JPG of the venue's plan (a PDF is converted to an image on
  upload). Stored with the existing storage (`uploadMedia`, S3 in production);
  the 2 MB media limit is raised for this one purpose, to about 10 MB, matching
  the Blueprint's floor plan upload.
- **Scale it**: the organiser draws a line along a wall they know and types its
  length ("this wall is 42 m"). That fixes metres per pixel.
- Move and fade it (opacity), then **trace rooms over it** with the same tools.
- The image is shown in 2D only. The 3D venue is built from the traced rooms,
  never from the picture.

## 4. Phases

Each phase ships behind `VENUE_MODULE_ENABLED`, is reviewed, and leaves the
automatic mode untouched.

| Phase | What | Size | Done when |
|---|---|---|---|
| 0a | PDF export of the current 2D plan (3.7), automatic plans included | 1 session | The congress template downloads as an A3 PDF with rooms, doors, stands, scale bar and north arrow |
| 0 | Data model, `planFromLayout()`, `layoutFromPlan()`, north frame, save route + service, no UI | 1 session | A golden test: automatic layout, turned into a plan, rebuilt from the plan, gives the same layout (zones, doors, furniture, walkable) for every template. **BUILT Oct 23**: `src/lib/venue/plan.ts` (model, `planFromLayout`, `planIssues`), `plan-layout.ts` (`layoutFromPlan`, walls found from the rectangles, `buildVenueLayout`); exact round trip on all seven layout fixtures (`venue-plan.test.ts`); `PUT /venue { plan, planVersion }`, plan null resets; a room removed from the list drops its placement, a room added leaves the venue automatic until placed. The plan extent is 600 m, since the automatic layout's largest building is 388 m deep |
| 1 | Editor: drag, resize, turn, door wall, walkways, entrance, live checks, undo, save, Reset to automatic; 3D doors on any wall, several corridors | 2 to 3 sessions | An organiser rearranges the congress template, saves, and walks it in 3D; a broken plan cannot be saved and says why. **BUILT Oct 23**: `venue-plan-editor.tsx` + `venue-plan-canvas.tsx` on the edits in `plan-edit.ts`; the browser runs the save's three checks live; placing a room added to the list (3.4) came forward from phase 2 as "Put … on the plan". 3D: desks, directory and banners read their facing from the layout; two drawn plans added to the vendor fixtures pass its walk checks. Left for phase 2: snapping to other rooms' edges, zoom and pan, Preview in 3D, keyboard nudging, unsaved changes kept in the browser, and the venue's guide phrases "off the main corridor" (social.js), which assume the template |
| 2 | Polish: snapping to edges, zoom and pan, Preview in 3D before saving, keyboard nudging, the room list and plan kept in step (3.4) | 1 session | Field test with the events team on one real event. **BUILT Oct 24** (field test still to run): edges line up with other areas' edges within 0.75 m, with guide lines (Alt places freely); zoom 100 to 400 % by buttons or Ctrl/Cmd + wheel about the pointer, the frame scrolls, Space + drag or the middle button pans; arrow keys nudge 0.5 m, Shift 5 m; **Preview in 3D** posts the unsaved plan to `POST /e/:slug/venue/preview` (event team, same origin, checked as a save, rendered offline with a preview strip, nothing stored); unsaved changes are kept in the browser and offered back; the attendees' directions (social.js) and the AI attendees' venue description (ai-prompt.ts) name what each door opens onto, keeping the automatic plan's wording. Room list and plan in step (3.4) was done in phase 1, except the Blueprint "start from rooms" question, which has no caller yet |
| 3 | Stands: count, drag stands, choose the sponsor per stand (replacing "nth stand to nth sponsor by tier" when set) | 1 session | Sponsors land on the stands the team chose, in 2D and 3D. **Superseded Oct 30 by section 10, phase A** (placed stands of any size, editable numbers) |
| 4 | Underlay image: upload, scale by a known wall, opacity, trace | 1 to 2 sessions | The team traces a real hotel plan and walks it. **Now section 10, phase B** |
| 2b | The architectural 2D look (owner Oct 24: "walls and stairs and similar need better visual representations"): solid walls, heavier outside; door leaves and swings; glazing; room sizes; fixtures (stairs, lift, toilets, emergency exit, pillar, catering point) placed in the editor, drawn as plan symbols, in the PDF and its legend, and built in 3D | 1 session | **BUILT Oct 24**: `plan.fixtures` (schema default `[]`, so saved plans read unchanged), `venue-plan-drawing.tsx`, `drawFixture` / `drawDoorSwings` in the PDF, `fixture()` in world.js; a solid fixture drops the furniture it stands on and stands are numbered again |
| 5 | Several floors (section 9) | 2 to 3 sessions | **BUILT Oct 26** (owner decisions F9 to F12, section 9): Ground and Level 1; see "What was built" in section 9 |
| later | Angled walls and non-rectangular rooms (L-shapes) | separate plan | Only if a real venue needs it |

## 5. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| F1 | Rotation: 90 degree steps only for now (the 3D engine builds straight walls), angled rooms later if a venue needs them? | Yes, 90 degree steps |
| F2 | A room drawn too small for its capacity: block the save, or allow it with a warning (3D draws fewer seats)? | Allow with a clear warning; venues are often tighter than the list says |
| F3 | Walkways: drawn by the organiser, or generated between rooms? | Drawn, starting from the automatic plan's corridor; generation guesses wrong in real venues |
| F4 | Once a plan is drawn, should adding a room on the list place it automatically? | Yes, beside a walkway, highlighted to move |
| F5 | Editing on phones? | View only on phones; edit on desktop |
| F6 | Underlay image limit | 10 MB, PNG / JPG / PDF, same as the Blueprint upload |
| F7 | Changing the plan after the venue is opened to staff: live at once, or only after "Publish"? | Live at once, as the room list is today; revisit when attendees (not only staff) walk it |
| F8 | PDF: who may download it, and should sponsor names be printed on the stands? | Anyone who can see the event (`events.read`); sponsor names on, since exhibitors are the main readers |

## 6. Risks

- **A plan that looks right but is not walkable** frustrates people. The answer
  is the live check with the reason drawn on the room, never a bare "invalid".
- **Bigger, irregular buildings in 3D**: draw distance, navigation grid and
  frame rate on modest laptops. Phase 1 includes a check on a 150 m building.
- **Two sources of truth**: the room list and the plan can drift. Section 3.4
  keeps them in step, and the save refuses a plan that names a room not on the
  list.
- **Vendor code** (`world.js`): we own our copy (D5), but each change there
  should stay small and be covered by the vendor's own tests.

## 7. Not in scope

- Several floors: planned in section 9, not built. (Stairs and lifts as fixtures on one floor were built Oct 24, phase 2b.)
- Seat-level editing (choosing individual chairs or rows).
- Importing CAD files (DWG, DXF).
- Showing the uploaded image inside the 3D venue.

## 8. If angled walls are ever needed

The layout's walls would gain a free direction (two end points instead of an
axis), `checkLayout` would rasterise them, and `world.js` would build rotated
wall boxes. Furniture already uses yaw, so rooms could follow. This is a
separate plan, only when a real venue needs it.

## Review findings, phase 2b (Oct 24): pushed as is by the owner, all FIXED the same day

- MED: removing a room from the room list keeps fixtures that stood in it, which then fail `planIssues`, so the venue falls back to automatic (`prunedPlan` in venue-rooms-service.ts should drop fixtures no area holds).
- MED: moving, resizing or turning a room leaves its fixtures where they were (`withRect` / `turn` in plan-edit.ts should carry or clamp them).
- MED: in 3D the stair treads are climbable up to the ceiling and beyond (cap the climbable height below the ceiling and make the rest solid, world.js `fixture()`).
- LOW: on screen the glass entrance is drawn over a solid wall; wall ends run into door openings; the PDF "ENTRANCE" label can leave the page for a west, east or north entrance; turning a fixture against a wall pushes it out of its room; a pillar in an aisle can drop a stand's visit point but keep the stand; fixtures renumber stands, which shifts stand activity during a live event (accepted, to be noted for organisers); the PDF legend can cut the fixture entries in a busy plan; cleanups (a no-op ternary in world.js, "Remove" to name the fixture, a second fixture of a kind lands on the first, a small pillar's handles cover it).

## 9. Several floors (BUILT Oct 26)

Owner, Oct 24: "what if we have multi floors?". Hotels often put the ballroom on
one floor and the exhibition or meeting rooms on another, so this is a real
case, but no event on EA-SYS has needed it yet. Recommended approach (**A,
floors linked by stairs and lifts**), chosen over **B, stacked floors you
climb**, because B means reworking the 3D engine's route finding, camera,
crowd and minimap for heights, for little gain in an online venue.

**Model.** The plan gains floors; each floor holds its own rooms, walkways and
fixtures; the entrance is on one floor (the ground floor by default). A saved
one-floor plan reads as a single floor, so nothing saved breaks.

```ts
interface VenuePlan {
  v: 2;
  floors: { id: string; name: string; level: number; rooms: PlacedRoom[]; corridors: PlanCorridor[]; fixtures: PlanFixture[] }[];
  entrance: PlanDoor & { floor: string };
}
// Stairs and lifts gain `link`: fixtures with the same link on different floors connect.
interface PlanFixture { /* as today */ link?: string }
```

**Building.** One `VenueLayout` per floor, made exactly as today. The walkable
venue receives all of them, laid side by side far apart (so one world holds
them and nothing about the engine's flat floor changes). Walking into a linked
lift or stair offers "Go to Level 1"; taking it fades out and places you at the
matching lift or stair on the other floor. The minimap and the venue guide
show the floor you are on, with floor buttons.

**Checks.** Each floor is checked walkable from its own links (the entrance
floor from the entrance), and every floor must be reachable through links from
the entrance floor. A link with nothing on another floor is an issue ("Lift A
on Level 1 goes nowhere").

**2D, PDF, programme.** Floor tabs in the plan view and the editor; the PDF
prints one page per floor; sessions still find their room by name, whatever
floor it is on; the attendees' directions say "on Level 1, take the lift".

**Decisions for the owner** (before building):

| # | Question | Recommendation |
|---|---|---|
| F9 | Floor names: fixed (Ground, Level 1, Level 2) or typed by the organiser ("Ballroom level")? | Typed, starting as Ground / Level 1 |
| F10 | Does a lift serve every floor it is drawn on, and do stairs join only neighbouring floors? | Yes to both, as in a real building |
| F11 | Moving between floors in 3D: a short fade (recommended), or an animated lift ride? | Fade; a ride is polish for later |
| F12 | Most floors per venue | 4 |

**Risks.** The world's size grows with each floor (draw calls, the 1 m
navigation grid): measure on a 4-floor congress before shipping; an
organiser drawing a floor nobody can reach is caught by the checks above.

**Owner decisions, Oct 26:** F9 fixed names, Ground and Level 1. F10 as recommended (a lift serves every
floor it is drawn on, stairs join neighbouring floors). F11 a short fade. F12 two floors for now.

**What was built (Oct 26), and where it differs from the sketch above:**

- **No `v: 2`.** Each room, walkway and fixture carries an optional `floor` (`"ground"` or `"level-1"`); none
  means Ground, so every saved plan reads unchanged and the schema stays `v: 1`. Two floors at most, by the
  schema's enum. The foyer must stay on Ground.
- **No `link` field.** A Level 1 stair or lift joins the ground-floor one of the same kind drawn in the same
  place (`floorLinks`), as a stairwell or lift shaft stands over itself, so there is nothing extra to set.
  A Level 1 stair or lift with nothing under it is refused with that reason, and Level 1 needs at least one.
- **Building:** each floor is built on its own (`floorLayout`), then `layoutFromPlan` stands Level 1 30 m east
  of the ground floor and adds a `"floor"` hotspot at each end of every link (`to` = where you step out).
  The layout gains `levels` (names and outlines) and each zone a `level`. A one-floor plan builds exactly as
  before. `checkLayout` carries its walk through the floor hotspots, so an unreachable Level 1 is refused.
- **3D:** E at a stair or lift fades to the other floor and says which floor you are on; the zone label and
  the minimap show the current floor only. Level 1's stairs are drawn as the stairwell going down.
- **Editor:** Ground and Level 1 tabs; every tool works on one floor's view (`floorView` / `withFloor`), the
  other floor is drawn faintly underneath with its stairs and lifts labelled, and a room or walkway has a
  Floor choice (`toFloor`: same place when free there, else beside that floor's building).
- **2D and PDF:** both floors side by side on one page, each named, rather than a tab or page per floor.
- **Directions:** the AI attendees hear which rooms are upstairs and how to get there; the scripted
  directions say "on Level 1, off the ...".

**Follow-up, Oct 26 (owner):** stacking stairs by hand was the hard part ("Stairs on Level 1 has no stairs
under it"), so a selected unmatched stair or lift offers **Put the matching stairs on Ground / Level 1**
(`missingPartner`, `addPartner` in plan-edit.ts), and adding one lands it over an unmatched one on the other
floor. Three fixtures for customising rooms came with it: registration counter (staffed, badge prompt),
photo wall (E takes a photo, hotspot `action: "photo"`) and standing banner.


## 10. The exhibitor floor plan (planned Oct 30, 2026)

Owner, Oct 30: "build a venue 2D road map from the event blueprint". The
blueprint here is the venue's own drawing, as the team receives it from the
hotel or draws it for exhibitors (the two examples given: the MEHFC hall, 13
stands, and the Conrad Dubai second floor, about 40). The plan has two readers:

- **Sponsors and exhibitors**, who need to see where their stand is.
- **The team**, for whom the plan is the internal record of the venue.

**Stand numbers change up to the last minute** as sponsors cancel or join.

### 10.1 What the drawings need that the plan cannot hold today

| In the drawings | Today |
|---|---|
| Stands of mixed sizes (6x3, 4x3, 3x3, 3x2), each with its own number | Every stand is 3x3, the count comes from capacity, numbers are generated (`layout.ts`, exhibition furnisher) |
| The sponsor's name printed on its stand | Stand n carries the nth sponsor by tier |
| Stands along a pre-function walkway (Conrad) or in the foyer (MEHFC stand 01) | Stands exist only inside an exhibition room |
| Sponsor tables ("Gulf Rider Table") | Nothing |
| Stage, AV console, program wall | Not fixture kinds |
| The venue's drawing under the plan | Phase 4, not built |
| Curved outside walls (Conrad east wall, MEHFC foyer) | Rectangles only. Traced as rectangles; the drawing under the plan shows the true shape in 2D (section 8 stays "later") |

### 10.2 Owner decisions (Oct 30)

| # | Question | Decision |
|---|---|---|
| G1 | How sponsors receive the plan | **One secret link per event for all exhibitors**; a sponsor finds their stand by searching their name. Not a link per sponsor |
| G2 | What sponsors see | **Every stand's number, size and sponsor name**, rooms, entrances, toilets, stage. Staff notes and staff-only fixtures (AV console) never leave the staff view |
| G3 | The first venue | **A demo event copying the Conrad second floor**, to present to the executives |
| G4 | Where the demo runs | **The local machine**, by screen share. Nothing reaches production before the presentation |

Recommended, to be confirmed while building:

| # | Question | Recommendation |
|---|---|---|
| G5 | May one sponsor hold several stands or tables? | Yes |
| G6 | Does the exhibitor link expire? | No by default; the team can switch it off or replace it at any time |
| G7 | Is the venue's drawing shown on the exhibitor map? | Off by default (it is often the hotel's drawing); a tick box turns it on |

### 10.3 Design

**Stands become placed objects** (phase A). `plan.stands` is an array of
`{ id, number, rect, dir, floor, sponsorId, note, kind }`:

- `id` is fixed and never shown; `number` is a free label ("07", "A3"), unique
  within the plan and editable at any time. Everything that must survive a
  renumbering (the sponsor, the 3D visit counts, the exhibitor search) keys on
  `id`, never on `number`. A **Renumber** action numbers the stands in reading
  order for the team that wants a tidy sequence after changes.
- Any size from 1 m to 20 m each way; the editor offers presets 3x2, 3x3, 4x3,
  6x3, 6x6 and a **table** (2 x 1 m, `kind: "table"`, numbered and sponsored
  like a stand).
- A stand may stand in any room or walkway. The walk check keeps working as
  it does for fixtures: every stand's front must be reachable.
- `sponsorId` points at the event's `Sponsor` row; empty shows **Available**.
  A sponsor deleted later reads as Available with a warning in the editor, and
  is never an error that breaks the plan.
- **Absent means automatic**, as today. The first stand edit converts the
  exhibition rooms' generated grid into placed stands (through
  `planFromLayout`), so the team starts from what it already sees. When
  `plan.stands` exists, the "nth sponsor by tier" rule no longer applies.
- `note` (staff only, 300 characters): "power 2 x 13 A", "rigging point above".

**New fixture kinds**: stage, AV console, program wall. Every fixture gains
`note` and `internal`; `internal` defaults by kind (the AV console is internal)
and keeps the item off the exhibitor map and the exhibitor PDF.

**The venue's drawing behind the plan** (phase B, was phase 4, 3.8) with three
changes:

- A PDF is turned into an image **in the browser** with `pdfjs-dist` (already a
  dependency): page 1 or a chosen page, about 4000 px wide, uploaded as PNG.
  No server-side PDF renderer.
- **Scale by something you know**: drag a line over a wall or over a stand
  whose size is printed on the drawing ("this stand is 6 m"). Both example
  drawings print every stand's size, so that is the quicker way.
- One drawing **per floor**.

**The exhibitor map** (phase C):

- `/e/<slug>/floor-plan/<token>`, read only, no sign-in. One link per event
  (G1), created, switched off or replaced on the Venue tab. It reuses the
  shared-view machinery (`share-token.ts`, `share-link-access.ts`) with a small
  `VenueShareLink` table (additive migration, `organizationId` and an RLS policy
  like the other share links), because a token held in `Event.settings` cannot
  be looked up by index.
- The page: event branding, the 2D plan with pinch zoom and pan (it will be
  opened on phones), floor tabs, and a list of exhibitors with search.
  Choosing "Takeda" highlights its stand and says "Stand 12, 6 x 3 m, Ground".
  A **Download PDF** button gives the exhibitor PDF.
- It always reads the live plan, so a renumbering shows at once; the page says
  when the plan was last changed.
- **One renderer**: the page draws with the same drawing code as the staff
  plan, given an "exhibitor" filter that drops internal items and notes. The
  PDF takes the same filter.
- Rate-limited per IP; every refused token is logged.

**The staff view** keeps everything: notes on stands and fixtures, internal
fixtures, and a staff PDF with a notes key under the plan.

### 10.4 The demo (phase D)

- A local seed script (`prisma/seed-venue-demo.ts`, refusing any database
  but the local one) creates a draft event with the Conrad second floor
  traced, its sponsors with tiers, about 40 stands and tables with the sizes
  and numbers from the drawing, a stage, registration and program wall, the
  drawing itself behind the plan, and the exhibitor link.
- Sponsor names are copied from the 2025 drawing. The event stays on the local
  machine (G4).
- A rehearsal script for the presentation, with screenshots in
  `screenshots/`. It covers the staff editor, a last-minute change (a sponsor
  cancels, their stand becomes Available, another sponsor takes it, the stands
  are renumbered), the exhibitor link on a phone-sized screen, and both PDFs.

### 10.5 Phases

| Phase | What | Size |
|---|---|---|
| A | Placed stands and tables (any size, editable numbers, sponsor per stand, notes), stage / AV console / program wall fixtures, `internal` flag; in the editor, 2D, PDF and 3D | 2 sessions |
| B | The venue's drawing behind the plan: upload (PDF converted in the browser), scale by a known length, opacity, per floor | 1 to 2 sessions |
| C | The exhibitor link and map page, the exhibitor PDF | 1 to 2 sessions |
| D | The Conrad demo event and the rehearsal | 1 session |

A comes first because it is what sponsors are shown; B makes tracing a real
venue quick; C is the sponsors' door; D only puts together what A to C built.

**Later, only after A to D**: read a draft of the stands straight from a
vector PDF's text layer (both example drawings carry "3x3" and the sponsor
names with their positions). Offered as a draft the team checks, never applied
on its own, like the Blueprint's rooms. A scanned drawing would not work this
way.

### 10.6 Risks

- **Renumbering during a live event** moves nothing that matters, since
  everything keys on the stand's id. That is the reason for the id.
- **Stands in walkways narrow them.** The walk check catches a stand that
  closes a walkway; a stand that only narrows one is the team's call.
- **Curved walls drawn as rectangles** look blocky in 3D. The 2D plan with the
  drawing behind it shows the true shape to the team (and to exhibitors when
  G7 is on), so the demo leads with 2D.
