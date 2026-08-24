import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";

// Mirrors abstract-themes/[themeId] — org-staff only, in-use themes can't be
// deleted (reassign first; matches the abstracts rule so organizers get one
// mental model).

const updateThemeSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; themeId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/session-proposal-themes/[themeId]:PUT" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Event first, un-wrapped (bound to the session org); its org is the lane
    // for the theme read + update (swept).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposal-themes:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const theme = await db.sessionProposalTheme.findFirst({
        where: { id: themeId, eventId },
        select: { id: true },
      });
      if (!theme) {
        apiLogger.warn({ msg: "session-proposal-themes:theme-not-found", eventId, themeId });
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }

      const body = await req.json();
      const parsed = updateThemeSchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: "session-proposal-themes:invalid-input", eventId, errors: parsed.error.flatten() });
        return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
      }

      const updated = await db.sessionProposalTheme.update({
        where: { id: themeId },
        data: parsed.data,
        select: { id: true, name: true, sortOrder: true },
      });

      return NextResponse.json(updated);
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      apiLogger.warn({ err, msg: "session-proposal-themes:duplicate-name" });
      return NextResponse.json({ error: "A theme with this name already exists" }, { status: 409 });
    }
    apiLogger.error({ err }, "session-proposal-themes:PUT failed");
    return NextResponse.json({ error: "Failed to update theme" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/session-proposal-themes/[themeId]:DELETE" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Event first, un-wrapped (bound to the session org); its org is the lane
    // for the theme read (+ its proposal _count, swept) and delete.
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "session-proposal-themes:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const theme = await db.sessionProposalTheme.findFirst({
        where: { id: themeId, eventId },
        select: { id: true, _count: { select: { proposals: true } } },
      });
      if (!theme) {
        apiLogger.warn({ msg: "session-proposal-themes:theme-not-found", eventId, themeId });
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }

      if (theme._count.proposals > 0) {
        apiLogger.warn({ msg: "session-proposal-themes:delete-in-use", eventId, themeId, count: theme._count.proposals });
        return NextResponse.json(
          { error: `Cannot delete: ${theme._count.proposals} proposal(s) are using this theme. Reassign them first.` },
          { status: 400 },
        );
      }

      await db.sessionProposalTheme.delete({ where: { id: themeId } });

      return NextResponse.json({ success: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "session-proposal-themes:DELETE failed");
    return NextResponse.json({ error: "Failed to delete theme" }, { status: 500 });
  }
}
