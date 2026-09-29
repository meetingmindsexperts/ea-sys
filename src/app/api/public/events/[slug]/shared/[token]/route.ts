/**
 * Shared submission view, the public side (Sep 29, 2026;
 * docs/SUBMISSION_SHARE_PLAN.md). No login: the secret link is the key.
 *
 *   GET /api/public/events/[slug]/shared/[token]
 *     → event branding + the link's kind + the visible field keys + the rows,
 *       each projected through src/lib/submission-share.ts so a field the
 *       organiser has not switched on is ABSENT from the response.
 *
 * The event resolves from the slug first (its org opens the tenant lane), then
 * the link is loaded by token and must belong to THAT event and be enabled. An
 * unknown token, another event's token and a switched-off link all answer the
 * same 404, so the response never says which. `no-store`: a withdrawn link
 * must stop working at once, not after a proxy's cache expires.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  SHARE_ROW_CAP,
  effectiveFields,
  effectiveStatuses,
  projectAbstract,
  projectProposal,
  speakerSelect,
  type ShareKind,
  type SharedItem,
} from "@/lib/submission-share";
import type { AbstractStatus, SessionProposalStatus } from "@prisma/client";

type RouteParams = { params: Promise<{ slug: string; token: string }> };

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function gone(): NextResponse {
  return NextResponse.json(
    { error: "This link is no longer active. Ask the organiser for a new one.", code: "LINK_INACTIVE" },
    { status: 404, headers: HEADERS },
  );
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, token } = await params;
    const ip = getClientIp(req);
    const limit = checkRateLimit({ key: `public-shared:ip:${ip}`, limit: 120, windowMs: 60_000 });
    if (!limit.allowed) {
      apiLogger.warn({ msg: "public-shared:rate-limited", slug, ip, retryAfterSeconds: limit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please try again shortly." },
        { status: 429, headers: { ...HEADERS, "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    if (token.length < 20 || token.length > 100) {
      apiLogger.warn({ msg: "public-shared:malformed-token", slug });
      return gone();
    }

    // Event carries no RLS policy, so this lookup runs before any lane; any
    // status, because sharing is an explicit organiser act and abstracts are
    // often reviewed before an event is published.
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug),
      select: {
        id: true,
        organizationId: true,
        name: true,
        startDate: true,
        endDate: true,
        timezone: true,
        bannerImage: true,
        bannerImageMobile: true,
        organization: { select: { name: true, logo: true } },
      },
    });
    if (!event) {
      apiLogger.warn({ msg: "public-shared:event-not-found", slug });
      return gone();
    }

    return await runWithTenant(event.organizationId, async () => {
      const link = await db.submissionShareLink.findUnique({
        where: { token },
        select: { id: true, eventId: true, organizationId: true, kind: true, enabled: true, statuses: true, fields: true },
      });
      if (!link || link.eventId !== event.id) {
        apiLogger.warn({ msg: "public-shared:invalid-token", slug, eventId: event.id });
        return gone();
      }
      if (!(await eventMatchesRequestTenant(req, event.organizationId))) {
        apiLogger.warn({ msg: "public-shared:tenant-mismatch", slug, linkId: link.id });
        return gone();
      }
      if (!link.enabled) {
        apiLogger.warn({ msg: "public-shared:link-disabled", slug, linkId: link.id });
        return gone();
      }

      const kind = link.kind as ShareKind;
      const on = effectiveFields(kind, link.fields);
      const statuses = effectiveStatuses(kind, link.statuses);
      const items = await loadItems(kind, event.id, statuses, on);

      return NextResponse.json(
        {
          event: {
            name: event.name,
            startDate: event.startDate,
            endDate: event.endDate,
            timezone: event.timezone,
            bannerImage: event.bannerImage,
            bannerImageMobile: event.bannerImageMobile,
            organizationName: event.organization.name,
            organizationLogo: event.organization.logo,
          },
          kind,
          fields: [...on],
          items: items.slice(0, SHARE_ROW_CAP),
          truncated: items.length > SHARE_ROW_CAP,
          generatedAt: new Date().toISOString(),
        },
        { headers: HEADERS },
      );
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "public-shared:failed" });
    return NextResponse.json({ error: "Could not load this page. Please try again." }, { status: 500, headers: HEADERS });
  }
}

/** One extra row past the cap is read so the page can say the list was cut. */
async function loadItems(kind: ShareKind, eventId: string, statuses: string[], on: Set<string>): Promise<SharedItem[]> {
  if (statuses.length === 0) return [];
  if (kind === "ABSTRACTS") {
    const rows = await db.abstract.findMany({
      where: { eventId, status: { in: statuses as AbstractStatus[] } },
      select: {
        serialId: true,
        title: true,
        content: true,
        status: true,
        presentationType: true,
        specialty: true,
        coAuthors: true,
        submittedAt: true,
        theme: { select: { name: true } },
        subTheme: { select: { name: true } },
        track: { select: { name: true } },
        speaker: { select: speakerSelect(on) },
      },
      orderBy: [{ serialId: "asc" }, { submittedAt: "asc" }],
      take: SHARE_ROW_CAP + 1,
    });
    return rows.map((r) => projectAbstract(r, on));
  }
  const rows = await db.sessionProposal.findMany({
    where: { eventId, status: { in: statuses as SessionProposalStatus[] } },
    select: {
      serialId: true,
      title: true,
      description: true,
      status: true,
      proposedFormat: true,
      durationMinutes: true,
      submittedAt: true,
      createdAt: true,
      theme: { select: { name: true } },
      speaker: { select: speakerSelect(on) },
    },
    orderBy: [{ serialId: "asc" }, { createdAt: "asc" }],
    take: SHARE_ROW_CAP + 1,
  });
  return rows.map((r) => projectProposal(r, on));
}
