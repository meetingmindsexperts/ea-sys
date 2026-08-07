import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";

/** Rename or remove one sub-theme. Staff only, org-bound, like its parent. */

const updateSubThemeSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; themeId: string; subThemeId: string }>;
}

/**
 * Resolve the sub-theme with every id in the URL bound together, so a
 * sub-theme belonging to another theme (or another org's event) is a 404
 * rather than an editable row.
 */
async function loadOwned(orgId: string, eventId: string, themeId: string, subThemeId: string) {
  return db.abstractSubTheme.findFirst({
    where: {
      id: subThemeId,
      themeId,
      eventId,
      event: { organizationId: orgId },
    },
    select: { id: true, _count: { select: { abstracts: true } } },
  });
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId, subThemeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    const body = await req.json().catch(() => null);
    const parsed = updateSubThemeSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "abstract-sub-theme:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const existing = await loadOwned(orgGuard.orgId, eventId, themeId, subThemeId);
      if (!existing) {
        apiLogger.warn({ msg: "abstract-sub-theme:not-found", eventId, themeId, subThemeId, userId: session.user.id });
        return NextResponse.json({ error: "Sub-theme not found" }, { status: 404 });
      }

      try {
        // Compound where: the org binding is part of the WRITE, not only of the
        // lookup above it.
        const updated = await db.abstractSubTheme.update({
          where: { id: subThemeId, themeId, eventId },
          data: parsed.data,
          select: { id: true, name: true, sortOrder: true },
        });
        return NextResponse.json(updated);
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
          apiLogger.warn({ msg: "abstract-sub-theme:duplicate-name", eventId, themeId, name: parsed.data.name });
          return NextResponse.json(
            { error: "That sub-theme already exists under this theme", code: "DUPLICATE_SUB_THEME" },
            { status: 409 },
          );
        }
        throw err;
      }
    });
  } catch (err) {
    apiLogger.error({ err }, "abstract-sub-theme:PUT failed");
    return NextResponse.json({ error: "Failed to update sub-theme" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId, subThemeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
      const existing = await loadOwned(orgGuard.orgId, eventId, themeId, subThemeId);
      if (!existing) {
        apiLogger.warn({ msg: "abstract-sub-theme:not-found", eventId, themeId, subThemeId, userId: session.user.id });
        return NextResponse.json({ error: "Sub-theme not found" }, { status: 404 });
      }

      // Same rule the parent theme uses: refuse while abstracts point at it,
      // rather than silently blanking their classification. The FK is SET NULL
      // so a delete would not error — it would just quietly lose data.
      if (existing._count.abstracts > 0) {
        apiLogger.warn({ msg: "abstract-sub-theme:delete-blocked-in-use", eventId, themeId, subThemeId, abstracts: existing._count.abstracts });
        return NextResponse.json(
          {
            error: `Cannot delete: ${existing._count.abstracts} abstract(s) are using this sub-theme. Reassign them first.`,
            code: "SUB_THEME_IN_USE",
          },
          { status: 400 },
        );
      }

      await db.abstractSubTheme.delete({ where: { id: subThemeId, themeId, eventId } });
      return NextResponse.json({ success: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "abstract-sub-theme:DELETE failed");
    return NextResponse.json({ error: "Failed to delete sub-theme" }, { status: 500 });
  }
}
