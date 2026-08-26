/**
 * Public travel-grant consent form — tokenized load + submit (no login).
 *
 *   GET  /api/public/events/[slug]/travel-grant/[token]
 *     → validates the token, asserts it belongs to the URL's event, returns
 *       event branding, the author's name, the organizer's terms, and status.
 *
 *   POST /api/public/events/[slug]/travel-grant/[token]
 *     → records the decision. A consent needs the explicit tick and a typed
 *       signature; a decline needs neither. The status flip is a CONDITIONAL
 *       CLAIM on PENDING, so two tabs cannot both record an answer.
 *
 * Rate-limited per IP + per token. Every rejection logs `{ slug, stage }`.
 *
 * NOTE ON ORDERING: the tenant org is resolved from the un-swept Event by
 * host+slug BEFORE the token lookup, because the token is globally unique and
 * a swept findUnique fail-closes outside the owning lane. See
 * lib/travel-grant/public.ts.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  DEFAULT_TRAVEL_GRANT_TERMS_HTML,
  travelGrantSubmitSchema,
} from "@/lib/travel-grant/constants";
import { readTravelGrantSettings } from "@/lib/travel-grant/settings";
import { loadTravelGrantForSlug, resolveTravelGrantEventOrg } from "@/lib/travel-grant/public";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

/** One wording for every not-found case, so the endpoint is not an oracle. */
const INVALID = "This travel grant link is invalid.";

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const limit = checkRateLimit({ key: `tg-load:${ip}`, limit: 120, windowMs: 3600_000 });
    if (!limit.allowed) {
      apiLogger.warn({ slug, ip, stage: "load" }, "travel-grant-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const org = await resolveTravelGrantEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "load-org" }, "travel-grant-public:invalid-token");
      return NextResponse.json({ error: INVALID }, { status: 404 });
    }

    return await runWithTenant(org, async () => {
      const row = await loadTravelGrantForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "load" }, "travel-grant-public:invalid-token");
        return NextResponse.json({ error: INVALID }, { status: 404 });
      }

      // The organizer can switch the feature off after links have gone out.
      // Refuse rather than accept an answer nobody will read.
      //
      // Gated on `switchedOn`, NOT `enabled`. `enabled` is additionally false
      // while the home-country list is empty, and emptying it is what an
      // organizer does halfway through CHANGING it — which would kill every
      // outstanding link mid-edit, and show the author the same "invalid or
      // already used" message as a forged token. Residency was decided when
      // this grant was minted; reading or answering the form does not depend on
      // the exempt list. Only an explicit switch-off is a withdrawal.
      if (!readTravelGrantSettings(row.event.settings).switchedOn) {
        apiLogger.warn(
          { slug, eventId: row.eventId, stage: "load-disabled" },
          "travel-grant-public:feature-disabled",
        );
        return NextResponse.json({ error: INVALID }, { status: 404 });
      }

      return NextResponse.json({
        status: row.status,
        signedName: row.signedName,
        submittedAt: row.submittedAt,
        recipientName: [row.speaker.firstName, row.speaker.lastName].filter(Boolean).join(" "),
        termsHtml: row.event.travelGrantTermsHtml?.trim() || DEFAULT_TRAVEL_GRANT_TERMS_HTML,
        event: {
          name: row.event.name,
          slug: row.event.slug,
          bannerImage: row.event.bannerImage,
          bannerImageMobile: row.event.bannerImageMobile,
          startDate: row.event.startDate,
          endDate: row.event.endDate,
          timezone: row.event.timezone,
          venue: row.event.venue,
          city: row.event.city,
          organizationName: row.event.organization?.name ?? null,
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "travel-grant-public:load-failed");
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);

    const perIp = checkRateLimit({ key: `tg-submit:${ip}`, limit: 30, windowMs: 3600_000 });
    if (!perIp.allowed) {
      apiLogger.warn({ slug, ip, stage: "submit" }, "travel-grant-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(perIp.retryAfterSeconds) } },
      );
    }
    const perToken = checkRateLimit({ key: `tg-submit-token:${token}`, limit: 10, windowMs: 3600_000 });
    if (!perToken.allowed) {
      apiLogger.warn({ slug, stage: "submit-token" }, "travel-grant-public:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(perToken.retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = travelGrantSubmitSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn(
        { slug, stage: "submit-validation", errors: parsed.error.flatten().fieldErrors },
        "travel-grant-public:invalid-input",
      );
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const d = parsed.data;

    const org = await resolveTravelGrantEventOrg(req, slug);
    if (!org) {
      apiLogger.warn({ slug, stage: "submit-org" }, "travel-grant-public:invalid-token");
      return NextResponse.json({ error: INVALID }, { status: 404 });
    }

    return await runWithTenant(org, async () => {
      const row = await loadTravelGrantForSlug(req, slug, token);
      if (!row) {
        apiLogger.warn({ slug, stage: "submit-load" }, "travel-grant-public:invalid-token");
        return NextResponse.json({ error: INVALID }, { status: 404 });
      }
      // Same rule as the load path above: an explicit switch-off withdraws the
      // offer; a half-edited country list does not.
      if (!readTravelGrantSettings(row.event.settings).switchedOn) {
        apiLogger.warn(
          { slug, eventId: row.eventId, stage: "submit-disabled" },
          "travel-grant-public:feature-disabled",
        );
        return NextResponse.json({ error: INVALID }, { status: 404 });
      }

      const consenting = d.decision === "consent";

      // Conditional claim on PENDING. Two tabs both submitting commit once, and
      // the loser is told what actually happened rather than silently
      // overwriting the first answer.
      const { count } = await db.travelGrant.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: consenting
          ? {
              status: "CONSENTED",
              // Snapshots, taken here and never re-derived: the speaker's
              // profile and the organizer's terms are both editable afterwards,
              // and neither may rewrite what this person signed.
              countryAtConsent: row.speaker.country ?? null,
              fullName: [row.speaker.firstName, row.speaker.lastName].filter(Boolean).join(" "),
              institution: row.speaker.organization ?? null,
              termsSnapshot:
                row.event.travelGrantTermsHtml?.trim() || DEFAULT_TRAVEL_GRANT_TERMS_HTML,
              signedName: d.signedName?.trim() ?? null,
              submittedAt: new Date(),
              submittedIp: ip,
            }
          : { status: "DECLINED", submittedAt: new Date(), submittedIp: ip },
      });

      if (count === 0) {
        apiLogger.warn(
          { slug, eventId: row.eventId, stage: "submit-already-answered", status: row.status },
          "travel-grant-public:already-answered",
        );
        return NextResponse.json(
          { error: "This form has already been completed.", status: row.status },
          { status: 409 },
        );
      }

      // Audit with the IP, matching the agreement-acceptance trail: this is the
      // record that a named person made a declaration on a given date.
      db.auditLog
        .create({
          data: {
            action: consenting ? "TRAVEL_GRANT_CONSENTED" : "TRAVEL_GRANT_DECLINED",
            entityType: "TravelGrant",
            entityId: row.id,
            eventId: row.eventId,
            userId: null,
            ipAddress: ip,
            changes: {
              actor: "AUTHOR",
              speakerId: row.speaker.id,
              signedName: consenting ? (d.signedName?.trim() ?? null) : null,
              countryAtConsent: consenting ? (row.speaker.country ?? null) : null,
            },
          },
        })
        .catch((err) => apiLogger.error({ err, stage: "submit-audit" }, "travel-grant-public:audit-failed"));

      if (consenting) {
        notifyEventAdmins(row.eventId, {
          // Its own type: filing this as ABSTRACT made a travel-grant consent
          // render under the abstract icon, the same mistake corrected on
          // Aug 17 2026 when "Session Created" was filed as REGISTRATION.
          type: "TRAVEL_GRANT",
          title: "Travel grant request",
          message: `${[row.speaker.firstName, row.speaker.lastName].filter(Boolean).join(" ")} has requested a travel grant.`,
          link: `/events/${row.eventId}/travel-grants`,
        }).catch((err) =>
          apiLogger.error({ err, stage: "submit-notify" }, "travel-grant-public:notify-failed"),
        );
      }

      apiLogger.info(
        { eventId: row.eventId, speakerId: row.speaker.id, decision: d.decision },
        "travel-grant-public:answered",
      );
      return NextResponse.json({ ok: true, status: consenting ? "CONSENTED" : "DECLINED" });
    });
  } catch (err) {
    apiLogger.error({ err }, "travel-grant-public:submit-failed");
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
