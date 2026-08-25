import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { denyReviewer } from "@/lib/auth-guards";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";

/**
 * Sub-themes under one abstract theme.
 *
 * There is no GET here on purpose: the sub-themes ride nested inside
 * `GET /abstract-themes`, so the submit forms and the management dialog read
 * ONE list and cannot show a theme whose children came from a stale fetch.
 * This route is writes only, and staff only.
 */

const createSubThemeSchema = z.object({
  name: z.string().min(1).max(200).trim(),
});

interface RouteParams {
  params: Promise<{ eventId: string; themeId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, themeId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/abstract-themes/[themeId]/sub-themes:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { route: "events/[eventId]/abstract-themes/[themeId]/sub-themes:POST" });
    if (denied) return denied;

    const body = await req.json().catch(() => null);
    const parsed = createSubThemeSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "abstract-sub-themes:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      // Bind the theme to the event AND the event to the org before writing:
      // a themeId from another org must not become a parent here.
      const theme = await db.abstractTheme.findFirst({
        where: { id: themeId, eventId, event: { organizationId: orgGuard.orgId } },
        select: { id: true },
      });
      if (!theme) {
        apiLogger.warn({ msg: "abstract-sub-themes:theme-not-found", eventId, themeId, userId: session.user.id });
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }

      try {
        // sortOrder computed inside the transaction that creates the row, so
        // two admins adding at once cannot land on the same position.
        const subTheme = await tenantTransaction(async (tx) => {
          const last = await tx.abstractSubTheme.aggregate({
            where: { themeId },
            _max: { sortOrder: true },
          });
          return tx.abstractSubTheme.create({
            data: {
              themeId,
              eventId,
              organizationId: orgGuard.orgId,
              name: parsed.data.name,
              sortOrder: (last._max.sortOrder ?? -1) + 1,
            },
            select: { id: true, name: true, sortOrder: true },
          });
        });
        return NextResponse.json(subTheme, { status: 201 });
      } catch (err) {
        // @@unique([themeId, name]) — a duplicate is a user mistake, not a 500.
        if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
          apiLogger.warn({ msg: "abstract-sub-themes:duplicate-name", eventId, themeId, name: parsed.data.name });
          return NextResponse.json(
            { error: "That sub-theme already exists under this theme", code: "DUPLICATE_SUB_THEME" },
            { status: 409 },
          );
        }
        throw err;
      }
    });
  } catch (err) {
    apiLogger.error({ err }, "abstract-sub-themes:POST failed");
    return NextResponse.json({ error: "Failed to create sub-theme" }, { status: 500 });
  }
}
