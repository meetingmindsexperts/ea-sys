import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import type { Prisma } from "@prisma/client";

/**
 * Team/user email-activity feed for one event — the "who on the team sent what"
 * rollup that powers the Communications → Email Activity section.
 *
 * Read-only, org-scoped, and `denyReviewer`-gated (matches /api/email-logs):
 * only ADMIN / SUPER_ADMIN / ORGANIZER reach it. It exposes recipient +
 * subject + sender, so restricted roles (REVIEWER/SUBMITTER/REGISTRANT/MEMBER/
 * ONSITE) are blocked.
 *
 * Returns paginated rows for the filter bar, a per-sender SUMMARY (computed
 * over the whole event, independent of the row filters, so the team board stays
 * stable while you drill the table), and the distinct template/sender options
 * that actually appear on this event (so the dropdowns only offer real values).
 */

const PAGE_SIZE = 30;

const querySchema = z.object({
  senderId: z.string().min(1).max(100).optional(),
  status: z.enum(["SENT", "FAILED"]).optional(),
  templateSlug: z.string().min(1).max(120).optional(),
  q: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: "No organization" }, { status: 403 });
    }

    // Event must belong to the caller's org (ADMIN/ORGANIZER are org-scoped to
    // all events; 404 rather than 403 to avoid cross-org existence leaks).
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ msg: "email-activity:event-not-found", eventId, orgId });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      senderId: searchParams.get("senderId") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      templateSlug: searchParams.get("templateSlug") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      page: searchParams.get("page") ?? undefined,
    });
    if (!parsed.success) {
      apiLogger.warn({ msg: "email-activity:invalid-input", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }
    const { senderId, status, templateSlug, q, page = 1 } = parsed.data;

    // Row filter for the table (respects every control).
    const rowWhere: Prisma.EmailLogWhereInput = {
      eventId,
      ...(senderId ? { triggeredByUserId: senderId } : {}),
      ...(status ? { status } : {}),
      ...(templateSlug ? { templateSlug } : {}),
      ...(q
        ? {
            OR: [
              { to: { contains: q, mode: "insensitive" } },
              { subject: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, rowsRaw, summaryGroups, templateSlugs] = await Promise.all([
      db.emailLog.count({ where: rowWhere }),
      db.emailLog.findMany({
        where: rowWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          to: true,
          subject: true,
          templateSlug: true,
          status: true,
          errorMessage: true,
          htmlBody: true, // presence flag only — mapped to hasBody + stripped
          createdAt: true,
          triggeredBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      // Per-sender rollup across the WHOLE event (not the row filters), so the
      // team board is a stable "who sent what" regardless of table drilling.
      db.emailLog.groupBy({
        by: ["triggeredByUserId", "status"],
        where: { eventId },
        _count: { _all: true },
      }),
      db.emailLog.findMany({
        where: { eventId, templateSlug: { not: null } },
        distinct: ["templateSlug"],
        select: { templateSlug: true },
        orderBy: { templateSlug: "asc" },
      }),
    ]);

    const rows = rowsRaw.map(({ htmlBody, ...rest }) => ({ ...rest, hasBody: htmlBody != null }));

    // Resolve sender names for the summary buckets.
    const senderIds = [
      ...new Set(summaryGroups.map((g) => g.triggeredByUserId).filter((id): id is string => !!id)),
    ];
    const users = senderIds.length
      ? await db.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Fold (userId, status) groups into one row per sender.
    const summaryMap = new Map<
      string,
      { userId: string | null; name: string; email: string | null; sent: number; failed: number }
    >();
    for (const g of summaryGroups) {
      const key = g.triggeredByUserId ?? "__system__";
      const existing = summaryMap.get(key);
      const u = g.triggeredByUserId ? userById.get(g.triggeredByUserId) : null;
      const entry =
        existing ??
        {
          userId: g.triggeredByUserId ?? null,
          name: u ? `${u.firstName} ${u.lastName}`.trim() : "System / automated",
          email: u?.email ?? null,
          sent: 0,
          failed: 0,
        };
      if (g.status === "SENT") entry.sent += g._count._all;
      else if (g.status === "FAILED") entry.failed += g._count._all;
      summaryMap.set(key, entry);
    }
    const summary = [...summaryMap.values()].sort(
      (a, b) => b.sent + b.failed - (a.sent + a.failed),
    );

    return NextResponse.json({
      rows,
      total,
      page,
      pageSize: PAGE_SIZE,
      summary,
      templateOptions: templateSlugs
        .map((t) => t.templateSlug)
        .filter((s): s is string => !!s),
      senderOptions: summary
        .filter((s) => s.userId)
        .map((s) => ({ id: s.userId as string, name: s.name })),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "email-activity:failed" });
    return NextResponse.json({ error: "Failed to load email activity" }, { status: 500 });
  }
}
