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
import { isSponsorCoveredCode, readCodeRequiredTiers, tierNeedsSponsorCode } from "@/lib/code-required-tiers";
import { mintDeskQrToken } from "@/lib/desk-qr-token";

/**
 * The desk's Walk-in QR (docs/ONSITE_DESK_PLAN.md §8.1).
 *
 * GET  .../registrations/desk-qr  what the panel can offer: the Exhibitor
 *      type's rate and the sponsors' codes for it, and the Complimentary rate.
 * POST .../registrations/desk-qr  { kind, promoCodeId? } → a 30-minute link to
 *      that rate's form in desk mode, and its QR. The panel asks again every
 *      15 minutes while it is open.
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

const postSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exhibitor"), promoCodeId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("complimentary") }),
]);

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

/** The sponsors' codes an exhibitor may use: their sponsor pays, on the Exhibitor type, still open. */
async function sponsorCodes(eventId: string, exhibitorTypeId: string) {
  const now = new Date();
  const codes = await db.promoCode.findMany({
    where: {
      eventId,
      isActive: true,
      sponsorId: { not: null },
      sponsorCoversFee: true,
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      maxUses: true,
      usedCount: true,
      sponsorId: true,
      sponsorCoversFee: true,
      sponsor: { select: { name: true } },
      ticketTypes: { select: { ticketTypeId: true } },
    },
  });
  return codes
    .filter((c) => isSponsorCoveredCode(c))
    .filter((c) => c.ticketTypes.length === 0 || c.ticketTypes.some((t) => t.ticketTypeId === exhibitorTypeId))
    .map((c) => ({
      promoCodeId: c.id,
      code: c.code,
      sponsorName: c.sponsor?.name ?? c.code,
      placesLeft: c.maxUses === null ? null : Math.max(0, c.maxUses - c.usedCount),
    }));
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
      return NextResponse.json({
        webinar: event.eventType === "WEBINAR",
        // Registration switched off: the desk QR is refused too (owner, Oct 29).
        registrationClosed: registrationClosed(event.settings),
        exhibitor: exhibitor
          ? { rateName: exhibitor.tier.name, sponsors: await sponsorCodes(event.id, exhibitor.typeId) }
          : null,
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

      let rate: string;
      let promo: { id: string; code: string } | null = null;
      if (input.kind === "exhibitor") {
        const exhibitor = exhibitorRate(event.ticketTypes, readCodeRequiredTiers(event.settings));
        if (!exhibitor) {
          apiLogger.warn({ msg: "desk-qr:no-exhibitor-rate", eventId, userId });
          return NextResponse.json(
            { error: "This event has no Exhibitor registration type with a rate that needs no approval.", code: "NO_EXHIBITOR_RATE" },
            { status: 400 },
          );
        }
        const found = (await sponsorCodes(event.id, exhibitor.typeId)).find((c) => c.promoCodeId === input.promoCodeId);
        if (found?.placesLeft === 0) {
          // Every registration through it would fail on the code's limit.
          apiLogger.warn({ msg: "desk-qr:sponsor-code-full", eventId, userId, promoCodeId: input.promoCodeId });
          return NextResponse.json(
            { error: "This sponsor has no places left. Raise the code's limit in Promo Codes.", code: "SPONSOR_CODE_FULL" },
            { status: 400 },
          );
        }
        if (!found) {
          apiLogger.warn({ msg: "desk-qr:sponsor-code-not-usable", eventId, userId, promoCodeId: input.promoCodeId });
          return NextResponse.json(
            { error: "That sponsor's code cannot be used for exhibitors.", code: "SPONSOR_CODE_NOT_USABLE" },
            { status: 400 },
          );
        }
        rate = registerTierSlug(exhibitor.tier.name);
        promo = { id: found.promoCodeId, code: found.code };
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

      const { token, expiresAt, jti } = mintDeskQrToken({
        eventId: event.id,
        kind: input.kind,
        rate,
        promoCodeId: promo?.id ?? null,
        issuedBy: userId,
      });
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const query = new URLSearchParams({ desk: token });
      if (promo) query.set("promo", promo.code);
      const url = `${appUrl}/e/${event.slug}/register/${rate}?${query.toString()}`;
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
            changes: { kind: input.kind, deskQrId: jti, promoCodeId: promo?.id ?? null, expiresAt: expiresAt.toISOString() },
          },
        })
        .catch((err) => apiLogger.warn({ err, msg: "desk-qr:audit-write-failed", eventId }));
      apiLogger.info({ msg: "desk-qr:shown", eventId, userId, kind: input.kind, promoCodeId: promo?.id ?? null, deskQrId: jti });
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
