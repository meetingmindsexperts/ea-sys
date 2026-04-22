import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { safeFetchHtml, safeFetchImage } from "@/lib/safe-fetch";
import { uploadMedia } from "@/lib/storage";
import { readWebinarSettings, readSponsors, SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";
import type { ToolExecutor } from "./_shared";

const listZoomMeetings: ToolExecutor = async (_input, ctx) => {
  try {
    const meetings = await db.zoomMeeting.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true,
        zoomMeetingId: true,
        meetingType: true,
        joinUrl: true,
        passcode: true,
        status: true,
        isRecurring: true,
        duration: true,
        session: { select: { id: true, name: true, startTime: true, endTime: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (meetings.length === 0) {
      return { message: "No Zoom meetings linked to sessions in this event." };
    }

    return {
      count: meetings.length,
      meetings: meetings.map((m) => ({
        id: m.id,
        zoomMeetingId: m.zoomMeetingId,
        meetingType: m.meetingType,
        status: m.status,
        joinUrl: m.joinUrl,
        passcode: m.passcode,
        isRecurring: m.isRecurring,
        duration: m.duration,
        sessionName: m.session.name,
        sessionId: m.session.id,
        sessionStart: m.session.startTime?.toISOString(),
        sessionEnd: m.session.endTime?.toISOString(),
      })),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_zoom_meetings failed");
    return { error: "Failed to list Zoom meetings" };
  }
};

const createZoomMeetingTool: ToolExecutor = async (input, ctx) => {
  try {
    const sessionId = input.sessionId as string;
    const meetingType = (input.meetingType as string) || "MEETING";
    const passcode = input.passcode as string | undefined;
    const waitingRoom = input.waitingRoom !== false;

    if (!sessionId) return { error: "sessionId is required" };
    if (!["MEETING", "WEBINAR", "WEBINAR_SERIES"].includes(meetingType)) {
      return { error: "meetingType must be MEETING, WEBINAR, or WEBINAR_SERIES" };
    }

    // Check if Zoom is configured
    const { isZoomConfigured } = await import("@/lib/zoom");
    const configured = await isZoomConfigured(ctx.organizationId);
    if (!configured) {
      return { error: "Zoom is not configured for this organization. Ask an admin to set up Zoom credentials in Organization Settings → Integrations." };
    }

    // Verify session exists and has no zoom meeting
    const [session, existing] = await Promise.all([
      db.eventSession.findFirst({
        where: { id: sessionId, eventId: ctx.eventId },
        select: { id: true, name: true, startTime: true, endTime: true, description: true },
      }),
      db.zoomMeeting.findUnique({ where: { sessionId } }),
    ]);

    if (!session) return { error: "Session not found in this event" };
    if (existing) return { error: `Session "${session.name}" already has a Zoom meeting linked (ID: ${existing.zoomMeetingId})` };

    // Get event timezone
    const event = await db.event.findFirst({
      where: { id: ctx.eventId },
      select: { timezone: true },
    });

    const duration = Math.ceil(
      (session.endTime.getTime() - session.startTime.getTime()) / 60000
    );

    const { createZoomMeeting, createZoomWebinar } = await import("@/lib/zoom");
    const meetingParams = {
      topic: session.name,
      startTime: session.startTime.toISOString(),
      duration,
      timezone: event?.timezone || "UTC",
      passcode,
      waitingRoom,
      autoRecording: "none" as const,
      agenda: session.description || undefined,
    };

    ctx.counters.creates++;

    let zoomResponse;
    if (meetingType === "MEETING") {
      zoomResponse = await createZoomMeeting(ctx.organizationId, meetingParams);
    } else {
      zoomResponse = await createZoomWebinar(ctx.organizationId, meetingParams);
    }

    const zoomMeeting = await db.zoomMeeting.create({
      data: {
        sessionId,
        eventId: ctx.eventId,
        zoomMeetingId: String(zoomResponse.id),
        meetingType: meetingType as "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
        joinUrl: zoomResponse.join_url,
        startUrl: zoomResponse.start_url,
        passcode: zoomResponse.password || passcode,
        duration,
        zoomResponse: JSON.parse(JSON.stringify(zoomResponse)),
      },
    });

    apiLogger.info(
      { zoomMeetingId: zoomMeeting.zoomMeetingId, sessionId, meetingType, userId: ctx.userId },
      "agent:zoom-meeting-created",
    );

    return {
      message: `Created Zoom ${meetingType.toLowerCase()} for session "${session.name}"`,
      zoomMeetingId: zoomMeeting.zoomMeetingId,
      joinUrl: zoomMeeting.joinUrl,
      meetingType: zoomMeeting.meetingType,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_zoom_meeting failed");
    const message = err instanceof Error ? err.message : "Failed to create Zoom meeting";
    return { error: message };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Expansion (April 2026) — 22 new tools across 4 tranches
// ═══════════════════════════════════════════════════════════════════════════════
// Tranche 0: create_event (the obvious missing CRUD tool)
// Tranche A: orchestration reads (5) — composite answers for common questions
// Tranche B: actions (4) — plug the read/write asymmetry with update tools
// Tranche C: recently shipped features (12) — webinar + sponsors + agreement
//                                              template + promo codes + scheduled
// ═══════════════════════════════════════════════════════════════════════════════

const getWebinarInfo: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, name: true, eventType: true, settings: true, startDate: true, endDate: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar) {
      return {
        event: { id: event.id, name: event.name, eventType: event.eventType },
        webinar: null,
        message: "This event has no webinar configuration. Only WEBINAR-type events have this.",
      };
    }

    let anchorSession = null;
    let zoomMeeting = null;
    if (webinar.sessionId) {
      anchorSession = await db.eventSession.findFirst({
        where: { id: webinar.sessionId, eventId: event.id },
        select: { id: true, name: true, startTime: true, endTime: true, location: true },
      });
      zoomMeeting = await db.zoomMeeting.findUnique({
        where: { sessionId: webinar.sessionId },
        select: {
          id: true,
          zoomMeetingId: true,
          meetingType: true,
          joinUrl: true,
          startUrl: true,
          passcode: true,
          duration: true,
          recordingStatus: true,
          recordingUrl: true,
          recordingFetchedAt: true,
          lastAttendanceSyncAt: true,
        },
      });
    }

    return {
      event: { id: event.id, name: event.name, eventType: event.eventType },
      webinar,
      anchorSession,
      zoomMeeting,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:get_webinar_info failed");
    return { error: "Failed to fetch webinar info" };
  }
};

const listWebinarAttendance: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 500);

    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true, _count: { select: { registrations: true } } },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) {
      return { error: "This event has no webinar configuration" };
    }

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: webinar.sessionId },
      select: { id: true },
    });
    if (!zoomMeeting) {
      return { error: "No Zoom webinar is attached to the anchor session" };
    }

    const [attendance, totalAttendance] = await Promise.all([
      db.zoomAttendance.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          name: true,
          email: true,
          joinTime: true,
          leaveTime: true,
          durationSeconds: true,
          attentivenessScore: true,
          registrationId: true,
        },
        orderBy: { durationSeconds: "desc" },
        take: limit,
      }),
      db.zoomAttendance.count({ where: { zoomMeetingId: zoomMeeting.id } }),
    ]);

    // Count distinct attendees (participantId) to get unique count vs segment count
    const distinctAttendees = new Set(attendance.map((a) => a.email?.toLowerCase() ?? a.name));

    const totalWatchSeconds = attendance.reduce((s, a) => s + (a.durationSeconds ?? 0), 0);
    const attended = distinctAttendees.size;

    return {
      zoomMeetingId: zoomMeeting.id,
      registered: event._count.registrations,
      attended,
      totalSegments: totalAttendance,
      attendanceRate: event._count.registrations === 0
        ? 0
        : Math.round((attended / event._count.registrations) * 100),
      avgWatchTimeSeconds: attended === 0 ? 0 : Math.round(totalWatchSeconds / attended),
      rows: attendance,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_webinar_attendance failed");
    return { error: "Failed to fetch webinar attendance" };
  }
};

const listWebinarEngagement: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const webinar = readWebinarSettings(event.settings);
    if (!webinar?.sessionId) return { error: "This event has no webinar configuration" };

    const zoomMeeting = await db.zoomMeeting.findUnique({
      where: { sessionId: webinar.sessionId },
      select: { id: true },
    });
    if (!zoomMeeting) return { error: "No Zoom webinar attached" };

    const [polls, questions] = await Promise.all([
      db.webinarPoll.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          title: true,
          questions: true,
          responses: {
            select: { participantName: true, answers: true, submittedAt: true },
          },
        },
      }),
      db.webinarQuestion.findMany({
        where: { zoomMeetingId: zoomMeeting.id },
        select: {
          id: true,
          askerName: true,
          askerEmail: true,
          question: true,
          answer: true,
          answeredByName: true,
          askedAt: true,
        },
        orderBy: { askedAt: "asc" },
      }),
    ]);

    return {
      polls: polls.map((p) => ({
        id: p.id,
        title: p.title,
        questions: p.questions,
        responseCount: p.responses.length,
        responses: p.responses,
      })),
      questions,
      totalPolls: polls.length,
      totalQuestions: questions.length,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_webinar_engagement failed");
    return { error: "Failed to fetch webinar engagement" };
  }
};

const listSponsors: ToolExecutor = async (_input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    const sponsors = readSponsors(event.settings);
    const grouped: Record<string, SponsorEntry[]> = {};
    for (const s of sponsors) {
      const tier = s.tier ?? "exhibitor";
      if (!grouped[tier]) grouped[tier] = [];
      grouped[tier].push(s);
    }

    return {
      sponsors,
      total: sponsors.length,
      byTier: grouped,
      availableTiers: SPONSOR_TIERS,
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_sponsors failed");
    return { error: "Failed to fetch sponsors" };
  }
};

const UPSERT_SPONSORS_MODES = new Set(["replace", "merge"]);

const upsertSponsors: ToolExecutor = async (input, ctx) => {
  try {
    const event = await db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) return { error: "Event not found or access denied" };

    if (!Array.isArray(input.sponsors)) {
      return { error: "sponsors must be an array" };
    }

    const mode = input.mode ? String(input.mode) : "replace";
    if (!UPSERT_SPONSORS_MODES.has(mode)) {
      return {
        error: `Invalid mode. Must be one of: ${[...UPSERT_SPONSORS_MODES].join(", ")}`,
        code: "INVALID_MODE",
      };
    }

    const safeUrl = (raw: unknown, opts: { allowRelative: boolean }): string | undefined => {
      if (raw == null) return undefined;
      const s = String(raw).trim();
      if (!s) return undefined;
      if (opts.allowRelative && s.startsWith("/")) return s;
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error(`Rejected URL scheme: ${u.protocol}`);
        }
        return u.toString();
      } catch {
        throw new Error(`Invalid URL: ${s}`);
      }
    };

    const tierSet = new Set<string>(SPONSOR_TIERS);
    const incoming: SponsorEntry[] = [];
    for (let i = 0; i < (input.sponsors as unknown[]).length; i++) {
      const raw = (input.sponsors as unknown[])[i];
      if (!raw || typeof raw !== "object") return { error: `sponsors[${i}] is not an object` };
      const r = raw as Record<string, unknown>;
      const name = String(r.name ?? "").trim();
      if (!name) return { error: `sponsors[${i}].name is required` };
      const tier = r.tier ? String(r.tier) : undefined;
      if (tier && !tierSet.has(tier)) {
        return { error: `sponsors[${i}].tier must be one of: ${SPONSOR_TIERS.join(", ")}` };
      }
      let logoUrl: string | undefined;
      let websiteUrl: string | undefined;
      try {
        logoUrl = safeUrl(r.logoUrl, { allowRelative: true });
        websiteUrl = safeUrl(r.websiteUrl, { allowRelative: false });
      } catch (e) {
        return { error: `sponsors[${i}]: ${e instanceof Error ? e.message : "invalid URL"}` };
      }

      incoming.push({
        id: r.id ? String(r.id) : `sponsor-${crypto.randomUUID()}`,
        name: name.slice(0, 255),
        tier: tier as SponsorEntry["tier"],
        logoUrl,
        websiteUrl,
        description: r.description ? String(r.description).slice(0, 1000) : undefined,
        sortOrder: i, // Provisional — finalised below
      });
    }

    // Mode: replace (default) = incoming wins, outgoing are deleted.
    //       merge            = incoming is overlaid onto existing list
    //                          matched by id first, then by case-insensitive
    //                          (name, tier) composite. Unmatched rows in the
    //                          existing list are kept; unmatched rows in the
    //                          incoming list are appended.
    let sanitized: SponsorEntry[];
    let mergeReport: { updated: number; added: number; kept: number } | undefined;
    if (mode === "replace") {
      sanitized = incoming.map((s, i) => ({ ...s, sortOrder: i }));
    } else {
      const existing = readSponsors(event.settings);
      const byId = new Map(existing.map((s) => [s.id, s]));
      const compositeKey = (s: Pick<SponsorEntry, "name" | "tier">) =>
        `${s.name.toLowerCase().trim()}::${s.tier ?? ""}`;
      const byComposite = new Map(existing.map((s) => [compositeKey(s), s]));

      const touchedIds = new Set<string>();
      const merged: SponsorEntry[] = [...existing];
      let updated = 0;
      let added = 0;
      for (const row of incoming) {
        const idMatch = byId.get(row.id);
        const match = idMatch ?? byComposite.get(compositeKey(row));
        if (match) {
          const idx = merged.findIndex((m) => m.id === match.id);
          if (idx >= 0) {
            merged[idx] = { ...match, ...row, id: match.id };
            touchedIds.add(match.id);
            updated++;
          }
        } else {
          merged.push(row);
          touchedIds.add(row.id);
          added++;
        }
      }
      sanitized = merged.map((s, i) => ({ ...s, sortOrder: i }));
      mergeReport = {
        updated,
        added,
        kept: sanitized.length - updated - added,
      };
    }

    const currentSettings = (event.settings as Record<string, unknown>) ?? {};
    const nextSettings = { ...currentSettings, sponsors: sanitized };

    await db.event.update({
      where: { id: event.id },
      data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
    });

    await db.auditLog.create({
      data: {
        eventId: event.id,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Event",
        entityId: event.id,
        changes: {
          source: "mcp",
          field: "settings.sponsors",
          mode,
          count: sanitized.length,
          ...(mergeReport ?? {}),
        },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:upsert_sponsors audit-log-failed"));

    return {
      success: true,
      mode,
      sponsors: sanitized,
      total: sanitized.length,
      ...(mergeReport ? { mergeReport } : {}),
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:upsert_sponsors failed");
    return { error: err instanceof Error ? err.message : "Failed to update sponsors" };
  }
};

// ── research_sponsor: scrape a sponsor's public site for OG metadata + logo ──

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function extractMetaProperty(html: string, property: string): string | undefined {
  // Match <meta property="..." content="..."> or <meta name="..." content="...">, order-independent
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) {
      const value = decodeHtmlEntities(m[1]).trim();
      if (value) return value;
    }
  }
  return undefined;
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (!m?.[1]) return undefined;
  const value = decodeHtmlEntities(m[1]).trim();
  return value || undefined;
}

function extractLinkHref(html: string, relMatcher: RegExp): string | undefined {
  // Match <link rel="..." href="..."> or <link href="..." rel="..."> for each link element
  const linkRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = /\brel=["']([^"']+)["']/i.exec(tag);
    if (!relMatch || !relMatcher.test(relMatch[1])) continue;
    const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (hrefMatch?.[1]) {
      const value = decodeHtmlEntities(hrefMatch[1]).trim();
      if (value) return value;
    }
  }
  return undefined;
}

function resolveRelative(raw: string, base: string): string | undefined {
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

function mapFetchReason(reason: string, detail?: string): string {
  switch (reason) {
    case "invalid_url": return "Invalid URL";
    case "scheme_blocked": return "URL scheme not allowed (must be http or https)";
    case "dns_failed": return "Could not resolve hostname";
    case "ip_blocked": return "URL resolves to a blocked IP range";
    case "timeout": return "Site timed out";
    case "too_large": return "Site response too large";
    case "too_many_redirects": return "Too many redirects";
    case "bad_content_type": return `Unsupported content type${detail ? `: ${detail}` : ""}`;
    case "http_error":
    default: return detail ? `HTTP error: ${detail}` : "HTTP error";
  }
}

const researchSponsor: ToolExecutor = async (input, ctx) => {
  try {
    const rawName = typeof input.name === "string" ? input.name.trim() : "";
    const rawUrl = typeof input.websiteUrl === "string" ? input.websiteUrl.trim() : "";

    if (!rawName && !rawUrl) {
      return { error: "Provide at least one of: name, websiteUrl" };
    }

    // Dedicated rate-limit bucket so outbound scraping abuse can't piggyback
    // on the general 20/hr agent budget.
    const RESEARCH_SPONSOR_LIMIT = 30;
    const RESEARCH_SPONSOR_WINDOW_MS = 60 * 60 * 1000;
    const rl = checkRateLimit({
      key: `research-sponsor:${ctx.userId}:${ctx.eventId}`,
      limit: RESEARCH_SPONSOR_LIMIT,
      windowMs: RESEARCH_SPONSOR_WINDOW_MS,
    });
    if (!rl.allowed) {
      return {
        error: `Rate limit exceeded: ${RESEARCH_SPONSOR_LIMIT} sponsor research calls per hour. Retry after ${rl.retryAfterSeconds}s.`,
        code: "RATE_LIMITED",
        retryAfterSeconds: rl.retryAfterSeconds,
        limit: RESEARCH_SPONSOR_LIMIT,
        windowSeconds: Math.floor(RESEARCH_SPONSOR_WINDOW_MS / 1000),
      };
    }

    if (!rawUrl) {
      return {
        proposed: { name: rawName.slice(0, 255) },
        meta: {
          source: "echo",
          scrapedAt: new Date().toISOString(),
          warnings: ["No websiteUrl provided — only name echoed back. Ask the user for the sponsor's website URL."],
        },
      };
    }

    const htmlResult = await safeFetchHtml(rawUrl);
    if (!htmlResult.ok) {
      apiLogger.warn({
        msg: "agent:research_sponsor fetch failed",
        eventId: ctx.eventId,
        websiteUrl: rawUrl,
        reason: htmlResult.reason,
        detail: htmlResult.detail,
      });
      return {
        error: mapFetchReason(htmlResult.reason, htmlResult.detail),
        websiteUrl: rawUrl,
      };
    }

    const html = htmlResult.data;
    const finalUrl = htmlResult.finalUrl;
    const warnings: string[] = [];

    // Name priority: og:site_name → og:title → <title> → caller-supplied name → hostname.
    // Use `||` for the rawName step because rawName can be "" (falsy) — `??` would
    // only fall through on null/undefined and we'd end up with an empty name.
    const extractedName =
      extractMetaProperty(html, "og:site_name") ??
      extractMetaProperty(html, "og:title") ??
      extractTitle(html) ??
      (rawName || new URL(finalUrl).hostname);

    // Description priority: og:description → meta[name=description]
    const extractedDescription =
      extractMetaProperty(html, "og:description") ??
      extractMetaProperty(html, "description");

    // Logo candidates in priority order
    const logoCandidates: string[] = [];
    const ogImage = extractMetaProperty(html, "og:image");
    if (ogImage) logoCandidates.push(ogImage);
    const appleTouch = extractLinkHref(html, /(^|\s)apple-touch-icon(-precomposed)?(\s|$)/i);
    if (appleTouch) logoCandidates.push(appleTouch);
    const icon = extractLinkHref(html, /(^|\s)(?:shortcut\s+)?icon(\s|$)/i);
    if (icon) logoCandidates.push(icon);
    // Absolute fallback: /favicon.ico at origin
    try {
      const origin = new URL(finalUrl).origin;
      logoCandidates.push(`${origin}/favicon.ico`);
    } catch { /* ignore */ }

    // Canonical URL (if present)
    const canonicalHref = extractLinkHref(html, /(^|\s)canonical(\s|$)/i);
    let canonicalUrl = finalUrl;
    if (canonicalHref) {
      const resolved = resolveRelative(canonicalHref, finalUrl);
      if (resolved) canonicalUrl = resolved;
    }

    // Try to download a logo, picking the first candidate that succeeds
    let logoUrl: string | undefined;
    let fallbackLogo = false;
    for (const candidate of logoCandidates) {
      const resolved = resolveRelative(candidate, finalUrl);
      if (!resolved) continue;
      const imgResult = await safeFetchImage(resolved);
      if (imgResult.ok) {
        try {
          const filename = `sponsor-logo-${randomUUID()}.${imgResult.data.ext}`;
          logoUrl = await uploadMedia(imgResult.data.buffer, filename, imgResult.data.mime);
          break;
        } catch (err) {
          apiLogger.warn({ msg: "agent:research_sponsor uploadMedia failed", err, candidate: resolved });
          // Fall back to remote URL (must be http/https — resolveRelative already canonicalised).
          logoUrl = resolved;
          fallbackLogo = true;
          break;
        }
      } else if (imgResult.reason === "bad_content_type" || imgResult.reason === "http_error") {
        // Try next candidate silently — favicon.ico often returns text/html on SPA sites.
        continue;
      } else {
        // ip_blocked / scheme_blocked / timeout — don't try remote fallback for these.
        apiLogger.debug({ msg: "agent:research_sponsor logo rejected", candidate: resolved, reason: imgResult.reason });
        continue;
      }
    }

    if (!logoUrl) warnings.push("Could not fetch a logo from og:image, apple-touch-icon, icon, or /favicon.ico.");
    if (!extractedDescription) warnings.push("No og:description or meta description found.");

    const proposed = {
      name: extractedName.slice(0, 255),
      websiteUrl: canonicalUrl,
      ...(logoUrl ? { logoUrl } : {}),
      ...(extractedDescription ? { description: extractedDescription.slice(0, 1000) } : {}),
    };

    apiLogger.info({
      msg: "agent:research_sponsor ok",
      eventId: ctx.eventId,
      host: new URL(finalUrl).hostname,
      bytes: html.length,
      fallbackLogo,
      warnings: warnings.length,
    });

    return {
      proposed,
      meta: {
        source: "scrape",
        scrapedAt: new Date().toISOString(),
        ...(fallbackLogo ? { fallbackLogo: true } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  } catch (err) {
    apiLogger.error({ err }, "agent:research_sponsor failed");
    return { error: err instanceof Error ? err.message : "Failed to research sponsor" };
  }
};

export const WEBINAR_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_zoom_meetings",
    description: "List all sessions that have a linked Zoom meeting or webinar. Shows meeting type, status, join URL.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_zoom_meeting",
    description: "Create a Zoom meeting or webinar linked to an existing session. Requires Zoom to be configured for the organization and enabled for the event.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "ID of the session to link the Zoom meeting to" },
        meetingType: { type: "string", enum: ["MEETING", "WEBINAR", "WEBINAR_SERIES"], description: "Type of Zoom meeting (default: MEETING)" },
        passcode: { type: "string", description: "Optional meeting passcode (max 10 chars)" },
        waitingRoom: { type: "boolean", description: "Enable waiting room (default: true)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_webinar_info",
    description: "Get webinar configuration: settings.webinar + anchor session + linked ZoomMeeting (join URL, passcode, recording status).",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_webinar_attendance",
    description: "Webinar attendance KPIs (registered / attended / rate / avg watch time) + top N attendee rows sorted by duration.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max attendee rows to return (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "list_webinar_engagement",
    description: "Webinar engagement: polls with per-question data + all Q&A with asker/question/answer.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_sponsors",
    description: "List event sponsors grouped by tier (platinum/gold/silver/bronze/partner/exhibitor).",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "research_sponsor",
    description: "Fetch a sponsor's public website and propose SponsorEntry fields (name, websiteUrl, logoUrl, description). Does NOT save — review the proposal, ask the user to pick a tier, then call upsert_sponsors. Tier is NEVER inferred. Rate limited to 30/hr/user/event.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Sponsor name hint. Used as fallback if the site has no <title>/og:site_name." },
        websiteUrl: { type: "string", description: "Absolute http(s) URL of the sponsor's public site. Required for scraping — without it only the name is echoed back." },
      },
      required: [],
    },
  },
  {
    name: "upsert_sponsors",
    description: "Update the sponsor list for this event. mode='replace' (default — matches existing dashboard PUT behaviour) deletes anything not in the passed array; mode='merge' overlays incoming rows onto the existing list by id, or failing that by case-insensitive (name, tier) composite, and APPENDS unmatched rows without deleting anything. Use merge when you only have a few rows to add or change and don't want to accidentally wipe the rest. Each sponsor needs { name, tier?, logoUrl?, websiteUrl?, description? }. URL scheme whitelist rejects javascript: and data: URLs.",
    input_schema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["replace", "merge"],
          description: "replace (default) deletes anything not in the array; merge overlays by id or (name,tier) and appends. Default is replace for backwards-compatibility with existing callers.",
        },
        sponsors: {
          type: "array",
          description: "Sponsors to upsert. In replace mode, this is the full final list. In merge mode, this is the delta.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Existing sponsor id (omit to create a new one)." },
              name: { type: "string" },
              tier: { type: "string", enum: ["platinum", "gold", "silver", "bronze", "partner", "exhibitor"] },
              logoUrl: { type: "string", description: "http(s) URL or relative /uploads/... path." },
              websiteUrl: { type: "string", description: "Absolute http(s) URL." },
              description: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
      required: ["sponsors"],
    },
  },
];

export const WEBINAR_EXECUTORS: Record<string, ToolExecutor> = {
  list_zoom_meetings: listZoomMeetings,
  create_zoom_meeting: createZoomMeetingTool,
  get_webinar_info: getWebinarInfo,
  list_webinar_attendance: listWebinarAttendance,
  list_webinar_engagement: listWebinarEngagement,
  list_sponsors: listSponsors,
  research_sponsor: researchSponsor,
  upsert_sponsors: upsertSponsors,
};
