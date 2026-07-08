/**
 * Dinner RSVP — invite list / roster (organizer).
 *
 *   GET            → roster (invites + per-dinner responses) + headcount
 *                    tiles. `?export=csv` streams a CSV.
 *   POST           → bulk-add invitees (picker or manual). Mints a token
 *                    per invitee; de-dups on (eventId, email) — an email
 *                    already invited is skipped (not errored).
 *
 * Org-scoped; POST is denyReviewer-guarded + rate-limited. The token is
 * the invitee's link key; it is returned so the UI can copy/send links.
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import {
  computeDinnerHeadcounts,
  generateRsvpToken,
  normalizeRsvpEmail,
  rsvpInviteBulkSchema,
} from "@/lib/rsvp/rsvp";

type RouteParams = { params: Promise<{ eventId: string }> };

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const [dinners, invites] = await Promise.all([
      db.rsvpDinner.findMany({
        where: { eventId },
        orderBy: [{ sortOrder: "asc" }, { dinnerAt: "asc" }],
        select: { id: true, name: true, dinnerAt: true },
      }),
      db.rsvpInvite.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          inviteeName: true,
          inviteeEmail: true,
          token: true,
          dietary: true,
          status: true,
          respondedAt: true,
          responses: { select: { dinnerId: true, attending: true, guestCount: true } },
        },
      }),
    ]);

    const headcounts = computeDinnerHeadcounts(dinners, invites);

    const url = new URL(req.url);
    if (url.searchParams.get("export") === "csv") {
      const header = [
        "Name",
        "Email",
        "Status",
        "Responded At",
        "Dietary",
        ...dinners.map((d) => d.name),
        ...dinners.map((d) => `${d.name} guests`),
      ];
      const rows = invites.map((inv) => {
        const byDinner = new Map(inv.responses.map((r) => [r.dinnerId, r]));
        return [
          inv.inviteeName,
          inv.inviteeEmail,
          inv.status,
          inv.respondedAt ? inv.respondedAt.toISOString() : "",
          inv.dietary ?? "",
          ...dinners.map((d) => (byDinner.get(d.id)?.attending ? "Yes" : "No")),
          ...dinners.map((d) => String(byDinner.get(d.id)?.guestCount ?? 0)),
        ];
      });
      const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="dinner-rsvp-${eventId}.csv"`,
        },
      });
    }

    return NextResponse.json({ dinners, invites, headcounts });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:list-failed");
    return NextResponse.json({ error: "Failed to load RSVP roster" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `rsvp-invites-add:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "rsvp-invites:add-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = rsvpInviteBulkSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId }, "rsvp-invites:add-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // De-dup within the payload + against already-invited emails.
    const seen = new Set<string>();
    const deduped = parsed.data.invitees.filter((i) => {
      const email = normalizeRsvpEmail(i.email);
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
    const existing = await db.rsvpInvite.findMany({
      where: { eventId, inviteeEmail: { in: [...seen] } },
      select: { inviteeEmail: true },
    });
    const already = new Set(existing.map((e) => e.inviteeEmail));

    const toCreate = deduped.filter((i) => !already.has(normalizeRsvpEmail(i.email)));
    let created = 0;
    if (toCreate.length > 0) {
      await db.rsvpInvite.createMany({
        data: toCreate.map((i) => ({
          eventId,
          token: generateRsvpToken(),
          inviteeName: i.name.trim(),
          inviteeEmail: normalizeRsvpEmail(i.email),
          registrationId: i.registrationId || null,
          speakerId: i.speakerId || null,
        })),
        skipDuplicates: true,
      });
      created = toCreate.length;
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "RSVP_INVITE",
          entityId: `bulk:${created}`,
          changes: { created, skipped: deduped.length - created, bulk: true },
        },
      })
      .catch((err) => apiLogger.error({ err }, "rsvp-invites:audit-failed"));

    return NextResponse.json(
      { created, skipped: deduped.length - created },
      { status: 201 },
    );
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:add-failed");
    return NextResponse.json({ error: "Failed to add invitees" }, { status: 500 });
  }
}
