/**
 * Unified speaker activity timeline.
 *
 * Merges, in one chronological feed:
 *   • the speaker's own AuditLog (entityType "Speaker") + EmailLog ("SPEAKER")
 *   • IF the speaker is linked to a registration — that registration's
 *     AuditLog ("Registration") + EmailLog ("REGISTRATION"), labeled
 *     source: "registration".
 *
 * The link is resolved POINTED, never duplicated:
 *   1. `Speaker.sourceRegistrationId` (set on import-registrations), else
 *   2. a read-time email match — a Registration in the same event whose
 *      Attendee.email equals the speaker's email (covers speakers imported
 *      before the pointer existed, and any speaker who is also a registrant).
 * Independent / manually-added speakers simply have no link → speaker-only feed.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getEmailLogsFor } from "@/lib/email-log";

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

type ActivitySource = "speaker" | "registration";

interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: "audit" | "email";
  at: string; // ISO
  // audit
  action?: string;
  changes?: unknown;
  actor?: string | null;
  ipAddress?: string | null;
  // email
  subject?: string;
  to?: string;
  status?: string;
  templateSlug?: string | null;
  errorMessage?: string | null;
}

function actorLabel(user: { firstName: string | null; lastName: string | null } | null): string | null {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Org-scope the event (404 to avoid existence leak). Read-only — open to
    // any authenticated org member who can already view the speaker page.
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        ...(session.user.organizationId ? { organizationId: session.user.organizationId } : {}),
      },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const speaker = await db.speaker.findFirst({
      where: { id: speakerId, eventId },
      select: { id: true, email: true, sourceRegistrationId: true },
    });
    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    // Resolve the linked registration — pointer first, else email match.
    let linkedRegistrationId: string | null = speaker.sourceRegistrationId ?? null;
    let linkedBy: "pointer" | "email" | null = speaker.sourceRegistrationId ? "pointer" : null;
    if (!linkedRegistrationId && speaker.email) {
      const match = await db.registration.findFirst({
        where: { eventId, attendee: { email: speaker.email } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      if (match) {
        linkedRegistrationId = match.id;
        linkedBy = "email";
      }
    }

    const auditSelect = {
      id: true,
      action: true,
      changes: true,
      ipAddress: true,
      createdAt: true,
      user: { select: { firstName: true, lastName: true } },
    } as const;

    const [speakerAudit, speakerEmail, regAudit, regEmail] = await Promise.all([
      db.auditLog.findMany({
        where: { entityType: "Speaker", entityId: speakerId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: auditSelect,
      }),
      getEmailLogsFor("SPEAKER", speakerId, session.user.organizationId),
      linkedRegistrationId
        ? db.auditLog.findMany({
            where: { entityType: "Registration", entityId: linkedRegistrationId },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: auditSelect,
          })
        : Promise.resolve([]),
      linkedRegistrationId
        ? getEmailLogsFor("REGISTRATION", linkedRegistrationId, session.user.organizationId)
        : Promise.resolve([]),
    ]);

    const items: ActivityItem[] = [];

    const pushAudit = (rows: typeof speakerAudit, source: ActivitySource) => {
      for (const r of rows) {
        items.push({
          id: `audit:${r.id}`,
          source,
          kind: "audit",
          at: r.createdAt.toISOString(),
          action: r.action,
          changes: r.changes,
          actor: actorLabel(r.user),
          ipAddress: r.ipAddress,
        });
      }
    };
    const pushEmail = (rows: typeof speakerEmail, source: ActivitySource) => {
      for (const r of rows) {
        items.push({
          id: `email:${r.id}`,
          source,
          kind: "email",
          at: r.createdAt.toISOString(),
          subject: r.subject,
          to: r.to,
          status: r.status,
          templateSlug: r.templateSlug,
          errorMessage: r.errorMessage,
        });
      }
    };

    pushAudit(speakerAudit, "speaker");
    pushEmail(speakerEmail, "speaker");
    pushAudit(regAudit, "registration");
    pushEmail(regEmail, "registration");

    // Newest first.
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return NextResponse.json({
      items,
      linkedRegistration: linkedRegistrationId
        ? { id: linkedRegistrationId, linkedBy }
        : null,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error loading speaker activity timeline" });
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }
}
