import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getEventStatsRow, refreshEventStats } from "@/lib/event-stats";
import type { ToolExecutor } from "./_shared";

const getEventDashboard: ToolExecutor = async (_input, ctx) => {
  try {
    const now = new Date();
    const eventId = ctx.eventId;

    // Fetch cached stats + event metadata + time-dependent/entity data in parallel
    const [
      stats,
      event,
      upcomingSessionCount,
      liveSessionCount,
      pastSessionCount,
      recentRegistrations,
      nextSession,
    ] = await Promise.all([
      getEventStatsRow(eventId),
      db.event.findFirst({
        where: { id: eventId, organizationId: ctx.organizationId },
        select: { id: true, name: true, slug: true, status: true, eventType: true, startDate: true, endDate: true, timezone: true },
      }),
      db.eventSession.count({ where: { eventId, startTime: { gt: now } } }),
      db.eventSession.count({ where: { eventId, startTime: { lte: now }, endTime: { gte: now } } }),
      db.eventSession.count({ where: { eventId, endTime: { lt: now } } }),
      db.registration.findMany({
        where: { eventId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          createdAt: true,
          attendee: { select: { firstName: true, lastName: true, email: true } },
          ticketType: { select: { name: true } },
        },
      }),
      db.eventSession.findFirst({
        where: { eventId, startTime: { gt: now } },
        orderBy: { startTime: "asc" },
        select: { id: true, name: true, startTime: true, endTime: true, location: true },
      }),
    ]);

    if (!event) return { error: "Event not found or access denied" };

    // If cached stats exist, use them (14 queries → 1 row read)
    if (stats) {
      const byStatus = stats.registrationsByStatus as Record<string, number>;
      const totalConfirmed = (byStatus.CONFIRMED || 0) + (byStatus.CHECKED_IN || 0);
      return {
        event,
        registrations: {
          total: stats.totalRegistrations,
          byStatus,
          byPayment: stats.registrationsByPayment as Record<string, number>,
          checkInRate: totalConfirmed === 0 ? 0 : Math.round((stats.checkedInCount / totalConfirmed) * 100),
        },
        speakers: {
          total: stats.totalSpeakers,
          byStatus: stats.speakersByStatus as Record<string, number>,
          agreementsSigned: stats.agreementsSigned,
          agreementsUnsigned: stats.totalSpeakers - stats.agreementsSigned,
        },
        sessions: {
          total: stats.totalSessions,
          upcoming: upcomingSessionCount,
          liveNow: liveSessionCount,
          past: pastSessionCount,
        },
        recentRegistrations,
        nextSession,
      };
    }

    // Fallback: no cached stats yet — compute live and seed the row
    apiLogger.info({ eventId, msg: "event-stats:cache-miss — computing live" });
    refreshEventStats(eventId);

    const [regByStatus, regByPayment, speakerByStatus, totalSpeakers, agreementsSigned, checkedInCount, totalConfirmed] = await Promise.all([
      db.registration.groupBy({ by: ["status"], where: { eventId }, _count: true }),
      db.registration.groupBy({ by: ["paymentStatus"], where: { eventId }, _count: true }),
      db.speaker.groupBy({ by: ["status"], where: { eventId }, _count: true }),
      db.speaker.count({ where: { eventId } }),
      db.speaker.count({ where: { eventId, agreementAcceptedAt: { not: null } } }),
      db.registration.count({ where: { eventId, status: "CHECKED_IN" } }),
      db.registration.count({ where: { eventId, status: { in: ["CONFIRMED", "CHECKED_IN"] } } }),
    ]);

    const totalRegistrations = regByStatus.reduce((s, r) => s + r._count, 0);
    return {
      event,
      registrations: {
        total: totalRegistrations,
        byStatus: Object.fromEntries(regByStatus.map(r => [r.status, r._count])),
        byPayment: Object.fromEntries(regByPayment.map(r => [r.paymentStatus, r._count])),
        checkInRate: totalConfirmed === 0 ? 0 : Math.round((checkedInCount / totalConfirmed) * 100),
      },
      speakers: {
        total: totalSpeakers,
        byStatus: Object.fromEntries(speakerByStatus.map(r => [r.status, r._count])),
        agreementsSigned,
        agreementsUnsigned: totalSpeakers - agreementsSigned,
      },
      sessions: {
        total: upcomingSessionCount + liveSessionCount + pastSessionCount,
        upcoming: upcomingSessionCount,
        liveNow: liveSessionCount,
        past: pastSessionCount,
      },
      recentRegistrations,
      nextSession,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_event_dashboard failed");
    return { error: "Failed to build event dashboard" };
  }
};

const getEventStats: ToolExecutor = async (_input, ctx) => {
  try {
    const eventId = ctx.eventId;
    const stats = await getEventStatsRow(eventId);

    // If cached stats exist, return directly (7 queries → 1 row read)
    if (stats) {
      return {
        registrations: stats.registrationsByStatus as Record<string, number>,
        payments: stats.registrationsByPayment as Record<string, number>,
        speakers: stats.speakersByStatus as Record<string, number>,
        abstracts: stats.abstractsByStatus as Record<string, number>,
        sessions: stats.totalSessions,
        tracks: stats.totalTracks,
        checkedIn: stats.checkedInCount,
      };
    }

    // Fallback: no cached stats yet — compute live and seed the row
    apiLogger.info({ eventId, msg: "event-stats:cache-miss — computing live (getEventStats)" });
    refreshEventStats(eventId);

    const [regByStatus, regByPayment, speakersByStatus, abstractsByStatus, sessionCount, trackCount] = await Promise.all([
      db.registration.groupBy({ by: ["status"], where: { eventId }, _count: true }),
      db.registration.groupBy({ by: ["paymentStatus"], where: { eventId }, _count: true }),
      db.speaker.groupBy({ by: ["status"], where: { eventId }, _count: true }),
      db.abstract.groupBy({ by: ["status"], where: { eventId }, _count: true }),
      db.eventSession.count({ where: { eventId } }),
      db.track.count({ where: { eventId } }),
    ]);

    const checkedIn = await db.registration.count({ where: { eventId, checkedInAt: { not: null } } });

    return {
      registrations: Object.fromEntries(regByStatus.map((r) => [r.status, r._count])),
      payments: Object.fromEntries(regByPayment.map((r) => [r.paymentStatus, r._count])),
      speakers: Object.fromEntries(speakersByStatus.map((s) => [s.status, s._count])),
      abstracts: Object.fromEntries(abstractsByStatus.map((a) => [a.status, a._count])),
      sessions: sessionCount,
      tracks: trackCount,
      checkedIn,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_event_stats failed");
    return { error: "Failed to fetch event stats" };
  }
};

// ─── Zoom Tool Executors ──────────────────────────────────────────────────────
const searchEvent: ToolExecutor = async (input, ctx) => {
  try {
    const query = String(input.query ?? "").trim();
    if (!query || query.length < 2) return { error: "query must be at least 2 characters" };
    const limit = Math.min(Number(input.limit ?? 20), 100);

    const requestedDomains = Array.isArray(input.domains)
      ? (input.domains as unknown[]).map((d) => String(d))
      : ["registrations", "speakers", "abstracts", "contacts"];
    const domains = new Set(requestedDomains.filter((d) =>
      ["registrations", "speakers", "abstracts", "contacts"].includes(d)));

    const ci = { contains: query, mode: "insensitive" as const };

    const [registrations, speakers, abstracts, contacts] = await Promise.all([
      domains.has("registrations")
        ? db.registration.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { attendee: { firstName: ci } },
                { attendee: { lastName: ci } },
                { attendee: { email: ci } },
                { attendee: { organization: ci } },
                { attendee: { tags: { has: query } } },
              ],
            },
            select: {
              id: true,
              status: true,
              attendee: { select: { firstName: true, lastName: true, email: true, organization: true } },
            },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("speakers")
        ? db.speaker.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { firstName: ci },
                { lastName: ci },
                { email: ci },
                { organization: ci },
              ],
            },
            select: { id: true, firstName: true, lastName: true, email: true, organization: true, status: true },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("abstracts")
        ? db.abstract.findMany({
            where: {
              eventId: ctx.eventId,
              OR: [
                { title: ci },
                { speaker: { firstName: ci } },
                { speaker: { lastName: ci } },
              ],
            },
            select: {
              id: true,
              title: true,
              status: true,
              speaker: { select: { firstName: true, lastName: true, email: true } },
            },
            take: limit,
          })
        : Promise.resolve([]),
      domains.has("contacts")
        ? db.contact.findMany({
            where: {
              organizationId: ctx.organizationId,
              eventIds: { has: ctx.eventId },
              OR: [
                { firstName: ci },
                { lastName: ci },
                { email: ci },
                { organization: ci },
              ],
            },
            select: { id: true, firstName: true, lastName: true, email: true, organization: true },
            take: limit,
          })
        : Promise.resolve([]),
    ]);

    return {
      query,
      results: {
        registrations: registrations.map((r) => ({
          domain: "registration" as const,
          id: r.id,
          label: `${r.attendee.firstName} ${r.attendee.lastName} <${r.attendee.email}>`,
          status: r.status,
          organization: r.attendee.organization,
        })),
        speakers: speakers.map((s) => ({
          domain: "speaker" as const,
          id: s.id,
          label: `${s.firstName} ${s.lastName} <${s.email}>`,
          status: s.status,
          organization: s.organization,
        })),
        abstracts: abstracts.map((a) => ({
          domain: "abstract" as const,
          id: a.id,
          label: a.title,
          status: a.status,
          author: `${a.speaker.firstName} ${a.speaker.lastName}`,
        })),
        contacts: contacts.map((c) => ({
          domain: "contact" as const,
          id: c.id,
          label: `${c.firstName} ${c.lastName} <${c.email}>`,
          organization: c.organization,
        })),
      },
      totalFound: registrations.length + speakers.length + abstracts.length + contacts.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:search_event failed");
    return { error: "Failed to search event" };
  }
};

// ─── Tranche B: Action / update tools ─────────────────────────────────────────

export const DASHBOARD_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "get_event_stats",
    description: "Get comprehensive event statistics: registration counts by status, payment breakdown, speaker counts, session counts, abstract counts.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

export const DASHBOARD_EXECUTORS: Record<string, ToolExecutor> = {
  get_event_dashboard: getEventDashboard,
  get_event_stats: getEventStats,
  search_event: searchEvent,
};
