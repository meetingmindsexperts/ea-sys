/**
 * GET /api/admin/lookup?q=<text> — resolve ids to names.
 *
 * WHAT IT ANSWERS. A log line names rows by id: `{"eventId":"cmt8fkgbl…"}`.
 * This route takes that id (or the whole pasted line) and says which event,
 * which person, which session. It is the read-side companion to /logs.
 *
 * BOTH WALLS (multi-tenancy item 5). `denyNonOperator` is the RBAC one and
 * `dbOperator` is the database one, and this route needs both: an id in a log
 * line may belong to ANY tenant, so a single tenant lane would return zero
 * rows for exactly the ids an operator most needs to identify. Neither wall
 * substitutes for the other.
 *
 * WHY IT MATCHES EVERY MODEL RATHER THAN TAKING A TYPE. Sometimes the log
 * line labels the id (`eventId`) and sometimes it does not (a bare id in an
 * error string, a Prisma P2025 message). Asking the operator to know the type
 * would fail in precisely the case where the tool is most needed. One
 * `findMany … id IN (…)` per model means the cost is fixed by the number of
 * MODELS, not by how many ids were pasted — so accepting a whole log line
 * costs the same as accepting one id.
 *
 * READ-ONLY BY CONSTRUCTION: every statement here is a findMany.
 *
 * ADDING A MODEL is one entry in RESOLVERS below. Keep the shape: the title
 * is the human name, the subtitle is supporting detail, and neither should
 * carry PII beyond the name already needed to identify the row.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { dbOperator } from "@/lib/db";
import { denyNonOperator } from "@/lib/platform-operator";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import {
  extractIdCandidates,
  MAX_LOOKUP_IDS,
  type LookupHit,
  type LookupResult,
} from "@/lib/id-lookup";
import { formatPersonName } from "@/lib/utils";
import { formatSerialId } from "@/lib/registration-serial";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { formatSessionProposalSerial } from "@/lib/session-proposal-serial";

/** Joins the non-empty parts of a subtitle so a null field never leaves " · ·". */
function detail(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" · ");
}

function shortDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * One resolver per model. Each takes every candidate id and returns the rows
 * that matched, already described. They run in parallel, so the whole lookup
 * costs one round trip per model regardless of how many ids were pasted.
 */
type Resolver = (ids: string[]) => Promise<LookupHit[]>;

const RESOLVERS: Resolver[] = [
  // ---- The two that appear most often in log lines -----------------------
  async (ids) =>
    (
      await dbOperator.event.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          startDate: true,
          endDate: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Event",
      id: r.id,
      title: r.name,
      subtitle: detail(
        r.slug,
        r.status,
        `${shortDate(r.startDate)} → ${shortDate(r.endDate)}`,
      ),
      eventId: r.id,
      organizationId: r.organizationId,
      href: `/events/${r.id}`,
    })),

  async (ids) =>
    (
      await dbOperator.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          organizationId: true,
          deactivatedAt: true,
        },
      })
    ).map((r) => ({
      kind: "User",
      id: r.id,
      title: `${r.firstName} ${r.lastName}`.trim() || r.email,
      subtitle: detail(
        r.email,
        r.role,
        r.deactivatedAt ? "DEACTIVATED" : null,
      ),
      organizationId: r.organizationId,
      href: null,
    })),

  // ---- People and their event-scoped facets ------------------------------
  async (ids) =>
    (
      await dbOperator.registration.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          serialId: true,
          status: true,
          paymentStatus: true,
          eventId: true,
          organizationId: true,
          attendee: {
            select: { title: true, firstName: true, lastName: true, email: true },
          },
        },
      })
    ).map((r) => ({
      kind: "Registration",
      id: r.id,
      title: formatPersonName(
        r.attendee.title,
        r.attendee.firstName,
        r.attendee.lastName,
      ),
      subtitle: detail(
        `#${formatSerialId(r.serialId)}`,
        r.attendee.email,
        r.status,
        r.paymentStatus,
      ),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/registrations`,
    })),

  async (ids) =>
    (
      await dbOperator.speaker.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          status: true,
          eventId: true,
        },
      })
    ).map((r) => ({
      kind: "Speaker",
      id: r.id,
      title: formatPersonName(r.title, r.firstName, r.lastName),
      subtitle: detail(r.email, r.status),
      eventId: r.eventId,
      href: `/events/${r.eventId}/speakers/${r.id}`,
    })),

  async (ids) =>
    (
      await dbOperator.attendee.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Attendee",
      id: r.id,
      title: formatPersonName(r.title, r.firstName, r.lastName),
      subtitle: detail(r.email, "the person behind a registration"),
      organizationId: r.organizationId,
      href: null,
    })),

  async (ids) =>
    (
      await dbOperator.contact.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Contact",
      id: r.id,
      title: formatPersonName(r.title, r.firstName, r.lastName),
      subtitle: detail(r.email),
      organizationId: r.organizationId,
      href: `/contacts/${r.id}`,
    })),

  // ---- Programme ---------------------------------------------------------
  async (ids) =>
    (
      await dbOperator.eventSession.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          startTime: true,
          status: true,
          type: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Session",
      id: r.id,
      title: r.name,
      subtitle: detail(r.startTime.toISOString().slice(0, 16).replace("T", " "), r.type, r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/agenda`,
    })),

  async (ids) =>
    (
      await dbOperator.abstract.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          serialId: true,
          status: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Abstract",
      id: r.id,
      title: r.title,
      subtitle: detail(formatAbstractSerial(r.serialId), r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/abstracts/${r.id}/edit`,
    })),

  async (ids) =>
    (
      await dbOperator.sessionProposal.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          serialId: true,
          status: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Session proposal",
      id: r.id,
      title: r.title,
      subtitle: detail(formatSessionProposalSerial(r.serialId), r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/session-proposals`,
    })),

  async (ids) =>
    (
      await dbOperator.track.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, eventId: true, organizationId: true },
      })
    ).map((r) => ({
      kind: "Track",
      id: r.id,
      title: r.name,
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/agenda`,
    })),

  // ---- Money and ticketing ----------------------------------------------
  async (ids) =>
    (
      await dbOperator.ticketType.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          price: true,
          currency: true,
          isFaculty: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Registration type",
      id: r.id,
      title: r.name,
      subtitle: detail(
        `${r.currency} ${r.price.toString()}`,
        r.isFaculty ? "faculty (hidden)" : null,
      ),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/tickets`,
    })),

  async (ids) =>
    (
      await dbOperator.invoice.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          invoiceNumber: true,
          type: true,
          status: true,
          total: true,
          currency: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Invoice",
      id: r.id,
      title: r.invoiceNumber,
      subtitle: detail(r.type, r.status, `${r.currency} ${r.total.toString()}`),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/invoices`,
    })),

  // ---- Operational surfaces ---------------------------------------------
  async (ids) =>
    (
      await dbOperator.accommodation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Accommodation",
      id: r.id,
      title: `Booking ${shortDate(r.checkIn)} → ${shortDate(r.checkOut)}`,
      subtitle: detail(r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/accommodation`,
    })),

  async (ids) =>
    (
      await dbOperator.hotel.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, eventId: true, organizationId: true },
      })
    ).map((r) => ({
      kind: "Hotel",
      id: r.id,
      title: r.name,
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/accommodation`,
    })),

  async (ids) =>
    (
      await dbOperator.speakerReimbursement.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          fullName: true,
          status: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Reimbursement",
      id: r.id,
      title: r.fullName ?? "Reimbursement claim",
      subtitle: detail(r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/reimbursements`,
    })),

  async (ids) =>
    (
      await dbOperator.certificateIssueRun.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          type: true,
          status: true,
          totalCount: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Certificate run",
      id: r.id,
      title: `${r.type} run`,
      subtitle: detail(r.status, `${r.totalCount} recipient(s)`),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/events/${r.eventId}/certificates`,
    })),

  async (ids) =>
    (
      await dbOperator.zoomMeeting.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          meetingType: true,
          organizationId: true,
          session: { select: { name: true, eventId: true } },
        },
      })
    ).map((r) => ({
      kind: "Zoom meeting",
      id: r.id,
      title: r.session?.name ?? "Zoom meeting",
      subtitle: detail(r.meetingType),
      eventId: r.session?.eventId ?? null,
      organizationId: r.organizationId,
      href: r.session ? `/events/${r.session.eventId}/agenda` : null,
    })),

  async (ids) =>
    (
      await dbOperator.mediaFile.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "Media file",
      id: r.id,
      title: r.filename,
      subtitle: detail(r.mimeType),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: r.eventId ? `/events/${r.eventId}/media` : "/media",
    })),

  // ---- CRM ---------------------------------------------------------------
  async (ids) =>
    (
      await dbOperator.crmDeal.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          status: true,
          eventId: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "CRM deal",
      id: r.id,
      title: r.name,
      subtitle: detail(r.status),
      eventId: r.eventId,
      organizationId: r.organizationId,
      href: `/crm/deals/${r.id}`,
    })),

  async (ids) =>
    (
      await dbOperator.crmCompany.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, organizationId: true },
      })
    ).map((r) => ({
      kind: "CRM company",
      id: r.id,
      title: r.name,
      organizationId: r.organizationId,
      href: `/crm/companies/${r.id}`,
    })),

  async (ids) =>
    (
      await dbOperator.crmContact.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          organizationId: true,
        },
      })
    ).map((r) => ({
      kind: "CRM contact",
      id: r.id,
      title: `${r.firstName} ${r.lastName}`.trim(),
      subtitle: detail(r.email),
      organizationId: r.organizationId,
      href: `/crm/contacts/${r.id}`,
    })),

  // ---- Organization (last: rarely the thing being chased) -----------------
  async (ids) =>
    (
      await dbOperator.organization.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, slug: true },
      })
    ).map((r) => ({
      kind: "Organization",
      id: r.id,
      title: r.name,
      subtitle: detail(r.slug),
      organizationId: r.id,
      href: "/settings",
    })),
];

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "admin-lookup:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Both walls: RBAC here, the privileged lane below.
  const denied = denyNonOperator(session, { route: "admin:lookup" });
  if (denied) return denied;

  const raw = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 20_000);
  const ids = extractIdCandidates(raw);

  if (ids.length === 0) {
    // Not an error — an empty box or a paste with no ids in it. Say so.
    return NextResponse.json({ ids: [], results: [], truncated: false });
  }

  const rl = checkRateLimit({
    key: `admin-lookup:${session.user.id}`,
    limit: 120,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, {
      route: "admin:lookup",
      userId: session.user.id,
      limit: 120,
      windowSeconds: 3600,
    });
  }

  try {
    const hits = (await Promise.all(RESOLVERS.map((run) => run(ids)))).flat();

    // Resolve the parent names in one more round trip each, so a Registration
    // hit can say WHICH event without the operator running a second lookup.
    const eventIds = [
      ...new Set(hits.map((h) => h.eventId).filter((v): v is string => Boolean(v))),
    ];
    const orgIds = [
      ...new Set(
        hits.map((h) => h.organizationId).filter((v): v is string => Boolean(v)),
      ),
    ];
    const [events, orgs] = await Promise.all([
      eventIds.length
        ? dbOperator.event.findMany({
            where: { id: { in: eventIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      orgIds.length
        ? dbOperator.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const eventName = new Map(events.map((e) => [e.id, e.name]));
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));

    const enriched: LookupHit[] = hits.map((h) => ({
      ...h,
      eventName: h.eventId ? (eventName.get(h.eventId) ?? null) : null,
      organizationName: h.organizationId
        ? (orgName.get(h.organizationId) ?? null)
        : null,
    }));

    // Group back by the id the operator submitted, preserving paste order, so
    // a pasted log line reads back in the order its ids appeared.
    const results: LookupResult[] = ids.map((id) => ({
      id,
      hits: enriched.filter((h) => h.id === id),
    }));

    apiLogger.info({
      msg: "admin-lookup:resolved",
      userId: session.user.id,
      idCount: ids.length,
      hitCount: enriched.length,
    });

    return NextResponse.json({
      ids,
      results,
      truncated: raw.trim().length > 0 && ids.length >= MAX_LOOKUP_IDS,
    });
  } catch (err) {
    apiLogger.error({
      msg: "admin-lookup:failed",
      userId: session.user.id,
      idCount: ids.length,
      err,
    });
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
