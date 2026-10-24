# Venue floor plan editor: plan

Status: IN BUILD (Oct 23, 2026). Phases 0a (PDF export), 0 (the plan model) and 1 (the editor) BUILT the same day, phase 2 (polish) Oct 24; the owner accepted F1 to F8 as recommended ("proceed, phase by phase"). Owner request: "we want to drag rooms
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
| 3 | Stands: count, drag stands, choose the sponsor per stand (replacing "nth stand to nth sponsor by tier" when set) | 1 session | Sponsors land on the stands the team chose, in 2D and 3D |
| 4 | Underlay image: upload, scale by a known wall, opacity, trace | 1 to 2 sessions | The team traces a real hotel plan and walks it |
| later | Angled walls and non-rectangular rooms (L-shapes), several floors | separate plan | Only if a real venue needs it |

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

- Several floors, stairs and lifts.
- Seat-level editing (choosing individual chairs or rows).
- Importing CAD files (DWG, DXF).
- Showing the uploaded image inside the 3D venue.

## 8. If angled walls are ever needed

The layout's walls would gain a free direction (two end points instead of an
axis), `checkLayout` would rasterise them, and `world.js` would build rotated
wall boxes. Furniture already uses yaw, so rooms could follow. This is a
separate plan, only when a real venue needs it.
