/**
 * A venue drawing on the exhibitor floor plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10, G7): served only
 * for a floor whose drawing the team ticked "Show to exhibitors", and only from this event's private folder.
 *
 *   GET /api/public/events/[slug]/floor-plan/[token]/drawing?floor=ground | level-1
 *
 * No sign-in; the checks are exhibitor-link.ts. A drawing not ticked answers the same 404 as no drawing.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { readStoredFile } from "@/lib/storage";
import { exhibitorPlan } from "@/lib/venue/exhibitor-view";
import { FLOOR_PLAN_HEADERS, withFloorPlanLink } from "@/lib/venue/exhibitor-link";
import { PLAN_FLOORS, type PlanFloor } from "@/lib/venue/plan";
import { drawingFolder } from "@/lib/venue/underlay";

type RouteParams = { params: Promise<{ slug: string; token: string }> };
const ROUTE = "public-floor-plan-drawing";
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const floor = (new URL(req.url).searchParams.get("floor") ?? "ground") as PlanFloor;
    if (!PLAN_FLOORS.includes(floor)) {
      apiLogger.warn({ msg: `${ROUTE}:invalid-floor`, slug });
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: FLOOR_PLAN_HEADERS });
    }
    return await withFloorPlanLink(req, slug, token, { route: ROUTE, bucket: "public-floor-plan", limit: 120, windowMs: 60_000 }, async ({ event, plan }) => {
      const shown = plan ? exhibitorPlan(plan.plan).underlays ?? [] : [];
      const u = shown.find((d) => (d.floor ?? "ground") === floor);
      const folder = drawingFolder(event.id);
      if (!u || !u.path.startsWith(folder)) {
        apiLogger.warn({ msg: `${ROUTE}:not-shown`, slug, eventId: event.id, floor });
        return NextResponse.json({ error: "Not found" }, { status: 404, headers: FLOOR_PLAN_HEADERS });
      }
      const ext = u.path.slice(u.path.lastIndexOf(".") + 1);
      const bytes = await readStoredFile(u.path, folder);
      if (!bytes) {
        apiLogger.error({ msg: `${ROUTE}:file-missing`, slug, eventId: event.id, floor });
        return NextResponse.json({ error: "Not found" }, { status: 404, headers: FLOOR_PLAN_HEADERS });
      }
      return new NextResponse(new Uint8Array(bytes), {
        headers: { ...FLOOR_PLAN_HEADERS, "Content-Type": TYPES[ext] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: FLOOR_PLAN_HEADERS });
  }
}
