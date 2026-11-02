/**
 * The Conrad demo (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, phase D, G3 and G4): a draft event laid out as
 * the Conrad Dubai's second floor, for presenting the venue floor plan to the executives on this machine. It puts
 * together what phases A to C built: the stands placed on the plan with their sponsors and numbers, the hotel's
 * own drawing traced underneath, a classroom ballroom, and the exhibitor link.
 *
 *   npx tsx prisma/seed-venue-demo.ts
 *
 * LOCAL ONLY (G4: nothing reaches production before the presentation): refuses to run unless DATABASE_URL points
 * at localhost and a database whose name says local. Re-running replaces the demo event (found by its slug, deleted
 * by its id) with a fresh one.
 *
 * Positions come from the hotel's plan (screenshots/venue-demo/conrad-second-floor.pdf), read at 0.1 m per pixel
 * of its 1300-pixel rendering, the origin moved to (300, 140) so the floor starts near (0, 0).
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const url = process.env.DATABASE_URL ?? "";
const parsed = (() => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
})();
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) || !/local/i.test(parsed.pathname)) {
  throw new Error(`[seed-venue-demo] Refusing to run: DATABASE_URL is not a local database (got ${parsed ? `${parsed.hostname}${parsed.pathname}` : "an unreadable URL"}).`);
}
// The drawing is stored through the app's storage, so a shell set up for S3 would put it in the live bucket.
if ((process.env.STORAGE_PROVIDER ?? "local") !== "local") {
  throw new Error(`[seed-venue-demo] Refusing to run: STORAGE_PROVIDER is "${process.env.STORAGE_PROVIDER}", not local.`);
}

const SLUG = "conrad-demo-2027";
const DRAWING = path.resolve(process.cwd(), "screenshots/venue-demo/conrad-second-floor.jpg");
/** The rendering the positions were read from was 1300 px wide; the drawing file is wider. */
const READ_WIDTH = 1300;

type Rect = [number, number, number, number];
/** A point on the hotel's plan, in its 1300-pixel rendering, to metres on ours. */
const m = (px: number, pz: number): [number, number] => [Math.round((px * 0.1 - 30) * 10) / 10, Math.round((pz * 0.1 - 14) * 10) / 10];
/** A w x d stand centred on a plan point. */
const at = (px: number, pz: number, w: number, d: number): Rect => {
  const [x, z] = m(px, pz);
  return [x - w / 2, z - d / 2, x + w / 2, z + d / 2].map((n) => Math.round(n * 10) / 10) as Rect;
};

// [sponsor or null for Available, hotel plan point, width, depth, facing]
type StandSpec = [string | null, number, number, number, number, "n" | "e" | "s" | "w"];
const STANDS: StandSpec[] = [
  // West foyer
  ["Hikma", 437, 295, 3, 3, "w"],
  ["Endosoft", 385, 345, 3, 3, "e"],
  ["Al Naghi", 385, 393, 3, 3, "e"],
  ["Novo Nordisk", 385, 442, 3, 3, "e"],
  ["Endohub", 475, 368, 3, 3, "w"],
  ["Abbott", 473, 495, 3, 3, "w"],
  ["Xeedia", 473, 535, 3, 3, "w"],
  // The central gallery, two rows
  ["Tabuk Pharma", 563, 268, 3, 3, "e"],
  [null, 563, 318, 3, 3, "e"],
  ["NewBridge", 563, 365, 3, 3, "e"],
  ["Pharmalink", 563, 470, 3, 3, "e"],
  ["Fujifilm", 563, 518, 3, 3, "e"],
  [null, 700, 268, 3, 3, "w"],
  [null, 700, 318, 3, 3, "w"],
  ["Boston Scientific", 700, 365, 3, 3, "w"],
  ["Al Shirawi", 700, 413, 3, 3, "w"],
  ["Gaelan", 700, 460, 3, 3, "w"],
  ["Gulf Drug", 700, 508, 3, 3, "w"],
  // The south pre-function, the large stands
  ["Premium MS", 473, 590, 3, 3, "s"],
  ["Olympus", 385, 577, 4, 3, "s"],
  ["Spectre", 555, 620, 3, 3, "s"],
  ["Sanofi", 620, 620, 4, 3, "s"],
  ["Takeda", 750, 620, 6, 3, "s"],
  ["AbbVie", 900, 620, 6, 3, "s"],
  ["Ferring", 437, 690, 4, 3, "n"],
  ["Ipsen", 540, 690, 4, 3, "n"],
  ["Lilly", 668, 690, 6, 3, "n"],
  ["Amgen", 745, 690, 4, 3, "n"],
  ["J&J", 835, 690, 6, 3, "n"],
  ["Gilead", 922, 690, 3, 3, "n"],
];
// Tables at the top of the gallery
const TABLES: [string, number, number][] = [
  ["Gulf Ridge", 598, 197],
  ["Medtech", 630, 197],
  ["Al Mazrui", 662, 197],
  [null as unknown as string, 572, 228],
  [null as unknown as string, 686, 228],
];

const PLATINUM = new Set(["Takeda", "AbbVie", "Lilly", "J&J"]);
const GOLD = new Set(["Sanofi", "Amgen", "Ferring", "Ipsen", "Olympus", "Novo Nordisk"]);
const tierOf = (name: string) => (PLATINUM.has(name) ? "platinum" : GOLD.has(name) ? "gold" : "exhibitor");

async function main() {
  const { db } = await import("../src/lib/db");
  const { planSchema } = await import("../src/lib/venue/plan");
  const { buildVenueLayout } = await import("../src/lib/venue/plan-layout");
  const { checkLayout } = await import("../src/lib/venue/layout-check");
  const { roomsSchema } = await import("../src/lib/venue/rooms");
  const { uploadFile } = await import("../src/lib/storage");
  const { newShareToken } = await import("../src/lib/share-token");
  const { runWithTenant } = await import("../src/lib/tenant-context");

  const org = await db.organization.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  const owner = org && (await db.user.findFirst({ where: { organizationId: org.id, role: "SUPER_ADMIN" }, select: { id: true } }));
  if (!org || !owner) throw new Error("[seed-venue-demo] No organisation with a super admin in this database.");

  await runWithTenant(org.id, async () => {
    // Only this organisation's draft demo: a real event that happens to share the slug is never deleted.
    // (A budget attached to the demo event blocks the delete; remove the budget first.)
    const old = await db.event.findFirst({ where: { organizationId: org.id, slug: SLUG }, select: { id: true, status: true, name: true } });
    if (old && (old.status !== "DRAFT" || !old.name.startsWith("Conrad Demo"))) {
      throw new Error(`[seed-venue-demo] Refusing to replace event ${old.id}: it uses the slug ${SLUG} but is not the draft demo.`);
    }
    if (old) {
      await db.event.delete({ where: { id: old.id } });
      console.log(`removed the previous demo event ${old.id}`);
    }

    const event = await db.event.create({
      data: {
        organizationId: org.id,
        name: "Conrad Demo: Gulf Medical Congress 2027",
        slug: SLUG,
        startDate: new Date("2027-03-10T05:00:00Z"),
        endDate: new Date("2027-03-12T14:00:00Z"),
        timezone: "Asia/Dubai",
        venue: "Conrad Dubai, second floor",
        city: "Dubai",
        country: "United Arab Emirates",
        status: "DRAFT",
      },
      select: { id: true },
    });

    // Sponsors, in the order a stand list reads: platinum, gold, then exhibitors.
    const names = [...new Set([...STANDS.flatMap(([n]) => (n ? [n] : [])), ...TABLES.flatMap(([n]) => (n ? [n] : []))])];
    const order = (n: string) => ["platinum", "gold", "exhibitor"].indexOf(tierOf(n));
    names.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const sponsorId = new Map<string, string>();
    for (const [i, name] of names.entries()) {
      const s = await db.sponsor.create({ data: { eventId: event.id, organizationId: org.id, name, tier: tierOf(name), sortOrder: i }, select: { id: true } });
      sponsorId.set(name, s.id);
    }

    // The rooms, then the plan: the ballroom, the gallery as the exhibition, the foyer with registration, and the
    // west foyer and south pre-function as walkways that hold stands.
    const rooms = [
      { id: "foyer", name: "Registration Foyer", kind: "foyer" as const, capacity: 600 },
      { id: "ballroom", name: "Conrad Ballroom", kind: "plenary" as const, capacity: 500, setup: "classroom" as const, stage: { w: 12, d: 4 }, screen: { w: 10, h: 3 } },
      { id: "gallery", name: "Exhibition Gallery", kind: "exhibition" as const, capacity: 400 },
    ];
    const roomCheck = roomsSchema.safeParse(rooms);
    if (!roomCheck.success) throw new Error(`[seed-venue-demo] rooms refused: ${roomCheck.error.issues.map((i) => i.message).join("; ")}`);

    const fixtures = [
      ...STANDS.map(([name, px, pz, w, d, dir], i) => ({
        id: `stand-n${String(i + 1).padStart(6, "0")}`,
        kind: "stand" as const,
        rect: at(px, pz, w, d),
        dir,
        name: "Exhibition stand",
        number: String(i + 1).padStart(2, "0"),
        sponsorId: name ? sponsorId.get(name)! : null,
      })),
      ...TABLES.map(([name, px, pz], i) => ({
        id: `table-n${String(i + 1).padStart(6, "0")}`,
        kind: "table" as const,
        rect: at(px, pz, 2, 1),
        dir: "s" as const,
        name: "Table",
        number: `T${i + 1}`,
        sponsorId: name ? sponsorId.get(name)! : null,
      })),
      { id: "program-wall-1", kind: "program-wall" as const, rect: at(1045, 690, 6, 0.6), dir: "n" as const, name: "Program Wall" },
      { id: "av-console-1", kind: "av-console" as const, rect: [55, 34, 61, 36] as Rect, dir: "n" as const, name: "AV console", note: "AV crew, staff only" },
    ];
    const plan = {
      v: 1 as const,
      rooms: [
        { id: "foyer", rect: [70, 41.5, 81, 60] as Rect, door: { wall: "w" as const, at: 50, width: 6 } },
        { id: "ballroom", rect: [43.5, 2, 81, 41.5] as Rect, door: { wall: "s" as const, at: 62, width: 4 } },
        { id: "gallery", rect: [22.5, 2, 43.5, 41.5] as Rect, door: { wall: "s" as const, at: 33, width: 6 } },
      ],
      corridors: [
        { id: "west-foyer", name: "West Foyer", rect: [4, 2, 22.5, 41.5] as Rect },
        { id: "prefunction", name: "Pre-function", rect: [4, 41.5, 70, 60] as Rect },
      ],
      entrance: { wall: "e" as const, at: 52, width: 6 },
      fixtures,
      standsPlaced: true,
    };

    // The hotel's drawing under the plan, shown to the team (and, ticked here, to exhibitors).
    let underlays: unknown[] = [];
    if (existsSync(DRAWING)) {
      const bytes = readFileSync(DRAWING);
      const stored = await uploadFile(bytes, `${randomUUID()}.jpg`, "image/jpeg", `venue-drawings/${event.id}`);
      const pxWide = 4000;
      underlays = [{ path: stored, name: "Conrad second floor.jpg", px: [pxWide, 2827], mpp: (0.1 * READ_WIDTH) / pxWide, at: [-30, -14], opacity: 0.55, exhibitors: true }];
      console.log(`drawing stored at ${stored}`);
    } else {
      console.warn(`no drawing at ${DRAWING}; the plan is seeded without it`);
    }

    const full = { ...plan, ...(underlays.length && { underlays }) };
    const planCheck = planSchema.safeParse(full);
    if (!planCheck.success) throw new Error(`[seed-venue-demo] plan refused: ${planCheck.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const built = buildVenueLayout(rooms, planCheck.data, { eventName: "Conrad Demo" });
    if (built.mode !== "drawn") throw new Error(`[seed-venue-demo] the plan is not used: ${built.planIssues.join("; ")}`);
    const walk = checkLayout(built.layout);
    if (!walk.ok) throw new Error(`[seed-venue-demo] not walkable: ${walk.issues.join("; ")}`);

    const now = Date.now();
    await db.event.update({
      where: { id: event.id },
      data: { settings: { venue: { rooms: { list: rooms, updatedAt: now, updatedBy: owner.id }, plan: { plan: planCheck.data, updatedAt: now, updatedBy: owner.id }, open: true } } },
    });
    const link = await db.venueShareLink.create({
      data: { eventId: event.id, organizationId: org.id, token: newShareToken(), createdById: owner.id, updatedById: owner.id },
      select: { token: true },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3113";
    console.log(`\nConrad demo ready (${STANDS.length} stands, ${TABLES.length} tables, ${names.length} sponsors) in ${org.name}.`);
    console.log(`  Venue tab:      ${appUrl}/events/${event.id}/venue`);
    console.log(`  Exhibitor link: ${appUrl}/e/${SLUG}/floor-plan/${link.token}`);
    if (process.env.VENUE_MODULE_ENABLED !== "true") console.log("  Note: VENUE_MODULE_ENABLED is not true here, so both pages 404 until it is set in .env.local.");
  });
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
