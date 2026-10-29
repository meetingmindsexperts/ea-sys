import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { renderQrPng } from "@/lib/barcode";
import { isExhibitorBadge } from "@/lib/badge-layout";
import { isPresenterTierName } from "@/lib/presenter-tiers";
import { registerTierSlug } from "@/lib/main-register-tiers";
import { readCodeRequiredTiers, tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { mintDeskQrToken } from "@/lib/desk-qr-token";
import { localDateInTz, resolveTimezone, wallTimeInTzToDate } from "@/lib/event-time";

/**
 * The desk's Walk-in QR (docs/ONSITE_DESK_PLAN.md §8.1).
 *
 * GET  .../registrations/desk-qr  what the panel can offer: the Exhibitor
 *      type's rate and the Complimentary rate.
 * POST .../registrations/desk-qr  { kind } → a link to that rate's form in
 *      desk mode, and its QR: ONE QR per event and kind, valid to the end of
 *      the event's last day, the same every time, printable (owner, Oct 29).
 *      Exhibitors type their own sponsor's code, which credits the sponsor.
 *
 * `registrations.create`, the walk-in panel's key: showing the QR lets people
 * register themselves at the desk.
 */

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ROUTE = "events/[eventId]/registrations/desk-qr";

/** The rate named Complimentary (owner, Oct 29): the event's complimentary form. */
const COMPLIMENTARY_SLUG = "complimentary";

const postSchema = z.object({ kind: z.enum(["exhibitor", "complimentary"]) });

/** The end of the event's last day, in its own timezone: when its desk QRs stop. */
function eventEnds(endDate: Date, timezone: string | null): Date {
  const tz = resolveTimezone(timezone);
  return wallTimeInTzToDate(`${localDateInTz(endDate, tz)}T23:59:59`, tz);
}

interface TierRow {
  id: string;
  name: string;
  isActive: boolean;
  requiresApproval: boolean;
}
interface TypeRow {
  id: string;
  name: string;
  pricingTiers: TierRow[];
}

/** A rate a desk QR may use: on, not a presenter rate, and needing no approval (owner, Oct 29). */
function deskUsable(tier: TierRow): boolean {
  return tier.isActive && !tier.requiresApproval && !isPresenterTierName(tier.name);
}

/**
 * The Exhibitor type and its rate: the one that needs a sponsor's code when
 * there is one, else its first usable rate. Null when the event has no
 * Exhibitor type or no usable rate on it.
 */
function exhibitorRate(types: TypeRow[], codeRequired: string[]): { typeId: string; tier: TierRow } | null {
  const type = types.find((t) => isExhibitorBadge(t.name));
  if (!type) return null;
  // The sponsor-code rate when the type has one; one that needs approval
  // means no QR, never a quiet fall back to another of the type's rates.
  const sponsorRate = type.pricingTiers.find((t) => t.isActive && tierNeedsSponsorCode(t.name, codeRequired));
  const tier = sponsorRate ?? type.pricingTiers.find(deskUsable);
  return tier && deskUsable(tier) ? { typeId: type.id, tier } : null;
}

/** The Complimentary rate on any type but Exhibitor. Null when the event has none. */
function complimentaryRate(types: TypeRow[]): TierRow | null {
  for (const type of types) {
    if (isExhibitorBadge(type.name)) continue;
    const tier = type.pricingTiers.find((t) => deskUsable(t) && registerTierSlug(t.name) === COMPLIMENTARY_SLUG);
    if (tier) return tier;
  }
  return null;
}

/** The event's master registration switch; the public register route refuses everything while it is off. */
function registrationClosed(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as Record<string, unknown>).registrationOpen === false;
}

async function loadEvent(eventWhere: object) {
  return db.event.findFirst({
    where: eventWhere,
    select: {
      id: true,
      slug: true,
      eventType: true,
      settings: true,
      endDate: true,
      timezone: true,
      ticketTypes: {
        where: { isActive: true, isFaculty: false },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          pricingTiers: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, isActive: true, requiresApproval: true } },
        },
      },
    },
  });
}

async function guard(eventId: string, method: "GET" | "POST") {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "desk-qr:unauthenticated", eventId, method });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  const route = `${ROUTE}:${method}`;
  const orgGuard = requireOrgId(session, { route, eventId });
  if ("error" in orgGuard) return { ok: false, response: orgGuard.error } as const;
  const gate = requirePermission(session, "registrations.create", { route, eventId });
  if (!gate.ok) return { ok: false, response: gate.response } as const;
  return { ok: true, session, orgId: orgGuard.orgId, gate, route } as const;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  const { eventId } = await params;
  try {
    const g = await guard(eventId, "GET");
    if (!g.ok) return g.response;
    return await runWithTenant(g.orgId, async () => {
      const event = await loadEvent(g.gate.eventWhere);
      if (!event) {
        apiLogger.warn({ msg: "desk-qr:event-not-found", eventId, userId: g.session.user.id });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const exhibitor = exhibitorRate(event.ticketTypes, readCodeRequiredTiers(event.settings));
      const complimentary = complimentaryRate(event.ticketTypes);
      const ends = eventEnds(event.endDate, event.timezone);
      return NextResponse.json({
        webinar: event.eventType === "WEBINAR",
        // Registration switched off: the desk QR is refused too (owner, Oct 29).
        registrationClosed: registrationClosed(event.settings),
        eventEnded: ends.getTime() <= Date.now(),
        timezone: resolveTimezone(event.timezone),
        exhibitor: exhibitor ? { rateName: exhibitor.tier.name, validUntil: ends.toISOString() } : null,
        complimentary: complimentary ? { rateName: complimentary.name } : null,
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "desk-qr:options-failed", eventId });
    return NextResponse.json({ error: "Failed to load the walk-in QR options" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
  const { eventId } = await params;
  try {
    const g = await guard(eventId, "POST");
    if (!g.ok) return g.response;
    const userId = g.session.user.id;

    // One every 15 minutes per open panel; this leaves room for several desks.
    const limit = checkRateLimit({ key: `desk-qr:${userId}`, limit: 120, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return rateLimited(limit, { route: g.route, userId, eventId, limit: 120, windowSeconds: 3600 });
    }

    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "desk-qr:invalid-body", eventId, userId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const input = parsed.data;

    return await runWithTenant(g.orgId, async () => {
      const event = await loadEvent(g.gate.eventWhere);
      if (!event) {
        apiLogger.warn({ msg: "desk-qr:event-not-found", eventId, userId });
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (event.eventType === "WEBINAR") {
        apiLogger.warn({ msg: "desk-qr:webinar", eventId, userId });
        return NextResponse.json({ error: "A webinar has no registration desk.", code: "WEBINAR" }, { status: 400 });
      }
      if (registrationClosed(event.settings)) {
        apiLogger.warn({ msg: "desk-qr:registration-closed", eventId, userId });
        return NextResponse.json(
          { error: "Registration is switched off for this event (Settings → Registration).", code: "REGISTRATION_CLOSED" },
          { status: 400 },
        );
      }

      // Both QRs last to the end of the event; a finished event has none.
      const until = eventEnds(event.endDate, event.timezone);
      if (until.getTime() <= Date.now()) {
        apiLogger.warn({ msg: "desk-qr:event-ended", eventId, userId });
        return NextResponse.json({ error: "This event has ended.", code: "EVENT_ENDED" }, { status: 400 });
      }

      let rate: string;
      if (input.kind === "exhibitor") {
        const exhibitor = exhibitorRate(event.ticketTypes, readCodeRequiredTiers(event.settings));
        if (!exhibitor) {
          apiLogger.warn({ msg: "desk-qr:no-exhibitor-rate", eventId, userId });
          return NextResponse.json(
            { error: "This event has no Exhibitor registration type with a rate that needs no approval.", code: "NO_EXHIBITOR_RATE" },
            { status: 400 },
          );
        }
        rate = registerTierSlug(exhibitor.tier.name);
      } else {
        const complimentary = complimentaryRate(event.ticketTypes);
        if (!complimentary) {
          apiLogger.warn({ msg: "desk-qr:no-complimentary-rate", eventId, userId });
          return NextResponse.json(
            { error: "This event has no Complimentary rate that needs no approval.", code: "NO_COMPLIMENTARY_RATE" },
            { status: 400 },
          );
        }
        rate = registerTierSlug(complimentary.name);
      }

      // One QR per event and kind, the same every time it is shown (a printed
      // sheet matches the screen), so it names no staff member; the audit
      // row below does.
      const { token, expiresAt, jti } = mintDeskQrToken(
        { eventId: event.id, kind: input.kind, rate, promoCodeId: null, issuedBy: "desk" },
        Date.now(),
        until,
      );
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const url = `${appUrl}/e/${event.slug}/register/${rate}?${new URLSearchParams({ desk: token }).toString()}`;
      const qr = await renderQrPng(url, { scale: 6 });

      // Who showed which QR, so a registration's audit row (which names the QR's
      // id) traces back to it. Never the token: it is the key to the form.
      db.auditLog
        .create({
          data: {
            eventId: event.id,
            userId,
            action: "DESK_QR_SHOWN",
            entityType: "Event",
            entityId: event.id,
            changes: { kind: input.kind, deskQrId: jti, expiresAt: expiresAt.toISOString() },
          },
        })
        .catch((err) => apiLogger.warn({ err, msg: "desk-qr:audit-write-failed", eventId }));
      apiLogger.info({ msg: "desk-qr:shown", eventId, userId, kind: input.kind, deskQrId: jti });
      return NextResponse.json({
        url,
        qr: `data:image/png;base64,${qr.toString("base64")}`,
        expiresAt: expiresAt.toISOString(),
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "desk-qr:mint-failed", eventId });
    return NextResponse.json({ error: "Failed to make the walk-in QR" }, { status: 500 });
  }
}
