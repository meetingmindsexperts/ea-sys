/**
 * Travel Grants console — roster + sending.
 *
 *   GET  → every abstract author on the event with the country we hold, the
 *          residency verdict, and their grant if they have one (decision D7).
 *          `?export=csv` streams the confirmed list for whoever decides awards.
 *   POST → send the link. `{ speakerIds: [...] }` for named authors, or
 *          `{ target: "pending" }` to remind everyone still outstanding (D9).
 *
 * ACCESS: `denyReviewer(session)` on every handler, reads included, so
 * SUPER_ADMIN / ADMIN / ORGANIZER only. MEMBER is excluded deliberately even
 * though MEMBER is internal read-only staff: this is a list of who has asked to
 * have their travel paid for, which is a financial-adjacent decision list
 * rather than an operational one. Event lookup routes through
 * buildEventAccessWhere.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { recordExport } from "@/lib/audit-data-transfer";
import { escapeCsvCell as csvCell } from "@/lib/csv-escape";
import { readTravelGrantSettings } from "@/lib/travel-grant/settings";
import { countryNamesFor } from "@/lib/travel-grant/eligibility";
import { buildTravelGrantRoster, getTravelGrantForSpeaker } from "@/lib/travel-grant/console";
import { sendTravelGrantInvitations } from "@/lib/travel-grant/send";

type RouteParams = { params: Promise<{ eventId: string }> };

const sendSchema = z
  .object({
    speakerIds: z.array(z.string().min(1).max(100)).min(1).max(500).optional(),
    target: z.literal("pending").optional(),
    subject: z.string().trim().max(300).optional(),
    message: z.string().trim().max(5000).optional(),
  })
  .refine((v) => !!v.speakerIds !== !!v.target, {
    message: "Provide either speakerIds or target, not both.",
  });

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "travel-grants:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/travel-grants:GET" });
    if (denied) {
      apiLogger.warn({ eventId, role: session.user.role }, "travel-grants:role-refused");
      return denied;
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, slug: true, organizationId: true, settings: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "travel-grants:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
      const url = new URL(req.url);

      // Single-speaker mode, for the card on a speaker's profile page. Uses its
      // own lookup rather than filtering the roster, because a speaker with no
      // abstract is absent from the roster and the card still has to describe
      // them. See getTravelGrantForSpeaker.
      // Read once and reuse: `enabled` already folds in "a home country is
      // configured", and both the classifier and the label need the same set.
      const grantSettings = readTravelGrantSettings(event.settings);
      const homeCountryNames = countryNamesFor(grantSettings.homeCountries);

      const speakerId = url.searchParams.get("speakerId");
      if (speakerId) {
        const row = await getTravelGrantForSpeaker(eventId, speakerId, grantSettings.homeCountries);
        if (!row) {
          apiLogger.warn({ eventId, speakerId }, "travel-grants:speaker-not-found");
          return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
        }
        return NextResponse.json({
          enabled: grantSettings.enabled,
          homeCountries: homeCountryNames,
          eventSlug: event.slug,
          row,
        });
      }

      const roster = await buildTravelGrantRoster(eventId, grantSettings.homeCountries);

      if (url.searchParams.get("export") === "csv") {
        recordExport(req, {
          entityType: "TravelGrant",
          eventId,
          organizationId: event.organizationId,
          userId: session.user.id,
          role: session.user.role,
          format: "csv",
          rowCount: roster.length,
        });
        const header = [
          "Name",
          "Email",
          "Organization",
          "Country",
          "Eligibility",
          "Status",
          "Signed name",
          "Responded at",
          "Abstracts",
        ].join(",");
        const lines = roster.map((r) =>
          [
            csvCell(r.name),
            csvCell(r.email ?? ""),
            csvCell(r.organization ?? ""),
            csvCell(r.country ?? ""),
            csvCell(r.residency),
            csvCell(r.grant?.status ?? "NOT_INVITED"),
            csvCell(r.grant?.signedName ?? ""),
            csvCell(r.grant?.submittedAt ? r.grant.submittedAt.toISOString() : ""),
            csvCell(String(r.abstractCount)),
          ].join(","),
        );
        return new NextResponse([header, ...lines].join("\n"), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="travel-grants-${eventId}.csv"`,
          },
        });
      }

      return NextResponse.json({
        enabled: grantSettings.enabled,
        // Display names, so the console can print the tile and badge wording
        // without re-deriving it from codes and drifting from the shared label.
        homeCountries: homeCountryNames,
        // The console builds each author's public link from this + their token.
        eventSlug: event.slug,
        rows: roster,
        counts: {
          consented: roster.filter((r) => r.grant?.status === "CONSENTED").length,
          pending: roster.filter((r) => r.grant?.status === "PENDING").length,
          declined: roster.filter((r) => r.grant?.status === "DECLINED").length,
          notEligibleHome: roster.filter((r) => r.residency === "home").length,
          countryNotRecorded: roster.filter((r) => r.residency === "unknown").length,
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "travel-grants:list-failed");
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "travel-grants:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/travel-grants:POST" });
    if (denied) {
      apiLogger.warn({ eventId, role: session.user.role }, "travel-grants:role-refused");
      return denied;
    }

    const limit = checkRateLimit({
      key: `travel-grant-send:${session.user.id}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "travel-grants:rate-limited");
      return NextResponse.json(
        { error: "Too many sends. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn(
        { eventId, errors: parsed.error.flatten() },
        "travel-grants:invalid-input",
      );
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: {
        id: true,
        slug: true,
        name: true,
        organizationId: true,
        settings: true,
        travelGrantMessageHtml: true,
      },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "travel-grants:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    const grantSettings = readTravelGrantSettings(event.settings);
    if (!grantSettings.enabled) {
      apiLogger.warn(
        { eventId, switchedOn: grantSettings.switchedOn },
        "travel-grants:feature-disabled",
      );
      return NextResponse.json(
        { error: "Travel Grant is switched off for this event.", code: "FEATURE_DISABLED" },
        { status: 400 },
      );
    }

    return await runWithTenant(event.organizationId, async () => {
      const result = await sendTravelGrantInvitations({
        event: { ...event, homeCountries: grantSettings.homeCountries },
        speakerIds: parsed.data.speakerIds,
        // D9: "remind everyone pending" resolves from the GRANT table, never
        // from the roster the console is rendering. The roster deliberately
        // contains locally-based and unknown-country authors so a mis-classified
        // person is recoverable, and none of them has a grant row — so this
        // query structurally cannot reach them.
        pendingOnly: parsed.data.target === "pending",
        subject: parsed.data.subject,
        message: parsed.data.message,
        actor: session.user,
      });
      apiLogger.info({ eventId, ...result }, "travel-grants:sent");
      return NextResponse.json(result);
    });
  } catch (err) {
    apiLogger.error({ err }, "travel-grants:send-failed");
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
