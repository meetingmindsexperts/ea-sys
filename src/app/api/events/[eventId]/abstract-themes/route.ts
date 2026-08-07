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
 * GET authorizes via buildEventAccessWhere, NOT requireOrgId (fixed Aug 6,
 * 2026 — the "noted latent gap" from the Session Proposals build, confirmed
 * live in the warning triage): org-null SUBMITTERs must be able to read the
 * theme list to fill the abstract form's theme picker; requireOrgId 403'd
 * them, leaving the picker empty on themed events. Theme names are not
 * sensitive. Writes (POST) stay org-staff only. Mirrors the
 * session-proposal-themes GET, which was built on this pattern for exactly
 * this reason.
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

    // Resource org: event resolved first, un-wrapped, for its org (the
    // session-proposal-themes pattern) — org-null submitters linked to the
    // event pass; a foreign event still 404s.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "abstract-themes:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const themes = await runWithTenant(event.organizationId, () =>
      db.abstractTheme.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          sortOrder: true,
          _count: { select: { abstracts: true } },
          // Nested rather than a second endpoint: the sub-theme dropdown is
          // driven entirely by the theme the submitter just picked, so shipping
          // the children with the parent avoids a request per selection and
          // keeps the two lists impossible to get out of step.
          subThemes: {
            select: { id: true, name: true, sortOrder: true },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { sortOrder: "asc" },
      }),
    );

    const response = NextResponse.json(themes);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (err) {
    apiLogger.error({ err }, "abstract-themes:GET failed");
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

    return await runWithTenant(orgGuard.orgId, async () => {
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const parsed = createThemeSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "events/abstract-themes:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const maxOrder = await db.abstractTheme.findFirst({
      where: { eventId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = parsed.data.sortOrder ?? (maxOrder?.sortOrder ?? -1) + 1;

    const theme = await db.abstractTheme.create({
      data: { eventId, organizationId: orgGuard.orgId, name: parsed.data.name, sortOrder },
      select: { id: true, name: true, sortOrder: true },
    });

    return NextResponse.json(theme, { status: 201 });
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A theme with this name already exists" }, { status: 409 });
    }
    apiLogger.error({ err }, "abstract-themes:POST failed");
    return NextResponse.json({ error: "Failed to create theme" }, { status: 500 });
  }
}
