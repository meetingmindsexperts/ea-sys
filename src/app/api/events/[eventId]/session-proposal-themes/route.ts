import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";

/**
 * Session-proposal themes — the event's OWN theme list for session proposals
 * (mirrors abstract-themes; deliberately a separate table, see
 * docs/SESSION_PROPOSALS_PLAN.md).
 *
 * GET authorizes via buildEventAccessWhere (NOT requireOrgId like the
 * abstract-themes GET): org-null SUBMITTERs must be able to read the theme
 * list to fill the proposal form's theme picker. Theme names are not
 * sensitive. Writes stay org-staff only.
 */

const createThemeSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Resource org: org-null SUBMITTERs read the theme picker too (the dual-route
    // rule). Event resolved first, un-wrapped, for its org.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposal-themes:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const themes = await runWithTenant(event.organizationId, () =>
      db.sessionProposalTheme.findMany({
        where: { eventId },
        select: { id: true, name: true, sortOrder: true, _count: { select: { proposals: true } } },
        orderBy: { sortOrder: "asc" },
      }),
    );

    const response = NextResponse.json(themes);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (err) {
    apiLogger.error({ err }, "session-proposal-themes:GET failed");
    return NextResponse.json({ error: "Failed to fetch themes" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposal-themes:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const parsed = createThemeSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "session-proposal-themes:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Staff-only write: session-org lane (event is already bound to it above).
    const theme = await runWithTenant(orgGuard.orgId, async () => {
      const maxOrder = await db.sessionProposalTheme.findFirst({
        where: { eventId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const sortOrder = parsed.data.sortOrder ?? (maxOrder?.sortOrder ?? -1) + 1;

      return db.sessionProposalTheme.create({
        data: {
          eventId,
          organizationId: event.organizationId,
          name: parsed.data.name,
          sortOrder,
        },
        select: { id: true, name: true, sortOrder: true },
      });
    });

    return NextResponse.json(theme, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      apiLogger.warn({ err, msg: "session-proposal-themes:duplicate-name" });
      return NextResponse.json({ error: "A theme with this name already exists" }, { status: 409 });
    }
    apiLogger.error({ err }, "session-proposal-themes:POST failed");
    return NextResponse.json({ error: "Failed to create theme" }, { status: 500 });
  }
}
