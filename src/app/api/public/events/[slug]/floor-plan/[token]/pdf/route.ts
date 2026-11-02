/**
 * The exhibitor floor plan as a PDF (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): the floor plan PDF drawn
 * from the exhibitor's view of the plan (staff-only fixtures and notes removed), each stand with its sponsor.
 *
 *   GET /api/public/events/[slug]/floor-plan/[token]/pdf?paper=A3 (default) | A4
 *
 * No sign-in; the checks are exhibitor-link.ts. 20 PDFs an hour per IP: pdfkit runs on the box that serves the door.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { exhibitorLayout } from "@/lib/venue/exhibitor-view";
import { FLOOR_PLAN_HEADERS, withFloorPlanLink } from "@/lib/venue/exhibitor-link";
import { PLAN_PAPERS, planDateLine, renderFloorPlanPdf, type PlanPaper } from "@/lib/venue/floor-plan-pdf";
import { loadVenueProgramme } from "@/services/venue-programme-service";

type RouteParams = { params: Promise<{ slug: string; token: string }> };
const ROUTE = "public-floor-plan-pdf";

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const paperParam = new URL(req.url).searchParams.get("paper") ?? "A3";
    if (!PLAN_PAPERS.includes(paperParam as PlanPaper)) {
      apiLogger.warn({ msg: `${ROUTE}:invalid-paper`, slug, paper: paperParam });
      return NextResponse.json({ error: "Paper must be A3 or A4", code: "INVALID_PAPER" }, { status: 400, headers: FLOOR_PLAN_HEADERS });
    }
    const paper = paperParam as PlanPaper;
    return await withFloorPlanLink(req, slug, token, { route: ROUTE, bucket: "public-floor-plan-pdf", limit: 20, windowMs: 60 * 60 * 1000 }, async ({ event, rooms, plan }) => {
      const { layout } = exhibitorLayout(rooms.rooms, plan?.plan ?? null, event.name);
      const zones = layout.zones.filter((z) => z.kind !== "corridor").map((z) => ({ id: z.id, name: z.name }));
      const programme = await loadVenueProgramme({ organizationId: event.organizationId, eventId: event.id }, zones, event.timezone);
      const place = [event.venue, event.city, event.country].map((p) => p?.trim()).filter(Boolean).join(", ") || null;
      const pdf = await renderFloorPlanPdf({ layout, eventName: event.name, dateLine: planDateLine(event.startDate, event.endDate, event.timezone), place, sponsors: programme.sponsors, paper, generatedAt: new Date() });
      apiLogger.info({ msg: `${ROUTE}:rendered`, slug, eventId: event.id, paper, bytes: pdf.length });
      return new NextResponse(new Uint8Array(pdf), {
        headers: { ...FLOOR_PLAN_HEADERS, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${event.slug}-floor-plan-${paper}.pdf"` },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "The floor plan PDF could not be made. Please try again." }, { status: 500, headers: FLOOR_PLAN_HEADERS });
  }
}
