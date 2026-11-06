import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { recordExport } from "@/lib/audit-data-transfer";
import { escapeCsvCell } from "@/lib/csv-escape";
import { db } from "@/lib/db";
import { updateEventSettings } from "@/lib/event-settings";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { requireOrgId } from "@/lib/require-org";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { CHAT_MESSAGE_MAX, readChatSettings, type WebinarChatSettings } from "@/lib/webinar/chat";
import { invalidateChatSnapshotsForSession } from "@/lib/webinar/chat-server";
import { readHandouts } from "@/lib/webinar/handouts";

type RouteParams = { params: Promise<{ eventId: string }> };

const NO_STORE = { "Cache-Control": "private, no-store" };
/** How many recent messages the console shows; the CSV has them all. */
const CONSOLE_WINDOW = 500;

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    openInLobby: z.boolean().optional(),
    mutedAll: z.boolean().optional(),
    slowMode: z.boolean().optional(),
    /** "me" names the signed-in producer as the moderator. */
    moderator: z.literal("me").optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change" });

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["delete", "restore", "pin"]), messageId: z.string().min(1) }),
  z.object({ action: z.literal("unpin") }),
  z.object({ action: z.enum(["mute", "unmute"]), registrationId: z.string().min(1) }),
  z.object({
    action: z.literal("post"),
    body: z.string().trim().min(1, "Type a message").max(CHAT_MESSAGE_MAX),
    handoutId: z.string().min(1).max(64).optional(),
  }),
]);

/**
 * The producers' side of webinar chat (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6.4): GET is
 * the moderation feed with real names (and `?export=csv`, the record), PATCH the switches, POST the
 * moderation actions and a producer's own post. Reading needs `webinar.analytics.read`, the CSV
 * `webinar.attendance.export`, everything that changes chat `webinar.manage`, as Q&A and polls.
 */
async function loadEvent(eventWhere: Prisma.EventWhereInput) {
  const event = await db.event.findFirst({ where: eventWhere, select: { id: true, settings: true } });
  if (!event) return null;
  const webinar = readWebinarSettings(event.settings);
  return { id: event.id, webinar, sessionId: webinar?.sessionId ?? null, chat: readChatSettings(webinar) };
}

function fullName(u: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  return `${u?.firstName ?? ""} ${u?.lastName ?? ""}`.trim();
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/webinar/chat:GET";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const exportCsv = new URL(req.url).searchParams.get("export") === "csv";
    // The record carries every author's real name, so it needs the export key (as attendance).
    const gate = exportCsv
      ? requirePermission(session, "webinar.attendance.export", { route, eventId })
      : requirePermission(session, "webinar.analytics.read", { route, eventId, onMissing: "hide" });
    if (!gate.ok) return gate.response;

    if (exportCsv) {
      const { allowed, retryAfterSeconds } = checkRateLimit({
        key: `webinar-chat-export:${session.user.id}`,
        limit: 30,
        windowMs: 3600_000,
      });
      if (!allowed) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-chat:export-rate-limited");
        return NextResponse.json(
          { error: "Too many exports. Try again later.", retryAfterSeconds, limit: 30, windowSeconds: 3600 },
          { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
        );
      }
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await loadEvent(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-chat:console-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const handoutNames = new Map(readHandouts(ctx.webinar).map((h) => [h.id, h.name]));
      if (!ctx.sessionId) {
        return NextResponse.json({ chat: ctx.chat, moderator: null, messages: [], muted: [], handouts: [] }, { headers: NO_STORE });
      }

      const rows = await db.webinarChatMessage.findMany({
        where: { sessionId: ctx.sessionId, eventId: ctx.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(exportCsv ? {} : { take: CONSOLE_WINDOW }),
        select: {
          id: true,
          body: true,
          authorName: true,
          authorKind: true,
          anonymous: true,
          kind: true,
          handoutId: true,
          registrationId: true,
          deletedAt: true,
          createdAt: true,
        },
      });
      rows.reverse();

      if (exportCsv) {
        const header = ["Time (UTC)", "Author", "Shown as", "Kind", "Message", "Deleted at (UTC)"];
        const lines = [header.map(escapeCsvCell).join(",")];
        for (const m of rows) {
          const shownAs = m.authorKind === "staff" || !m.anonymous ? m.authorName : "Attendee (anonymous)";
          const kind = m.kind === "handout" ? `Handout: ${handoutNames.get(m.handoutId ?? "") ?? "removed"}` : m.authorKind;
          lines.push(
            [m.createdAt.toISOString(), m.authorName, shownAs, kind, m.body, m.deletedAt?.toISOString() ?? ""]
              .map(escapeCsvCell)
              .join(","),
          );
        }
        recordExport(req, {
          entityType: "WebinarChatMessage",
          eventId: ctx.id,
          organizationId: orgGuard.orgId,
          userId: session.user.id,
          role: session.user.role,
          rowCount: rows.length,
          format: "csv",
        });
        apiLogger.info({ eventId: ctx.id, userId: session.user.id, rows: rows.length }, "webinar-chat:exported");
        return new NextResponse(lines.join("\n"), {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="webinar-chat-${ctx.id}.csv"`,
            ...NO_STORE,
          },
        });
      }

      const muteIds = ctx.chat.mutedRegistrationIds ?? [];
      const [moderator, mutedRegs] = await Promise.all([
        ctx.chat.moderatorUserId
          ? db.user.findFirst({
              where: { id: ctx.chat.moderatorUserId, organizationId: orgGuard.orgId },
              select: { id: true, firstName: true, lastName: true },
            })
          : null,
        muteIds.length
          ? db.registration.findMany({
              where: { id: { in: muteIds }, eventId: ctx.id },
              select: { id: true, attendee: { select: { firstName: true, lastName: true } } },
            })
          : [],
      ]);
      const muted = new Set(muteIds);
      return NextResponse.json(
        {
          chat: ctx.chat,
          moderator: moderator ? { id: moderator.id, name: fullName(moderator), isMe: moderator.id === session.user.id } : null,
          messages: rows.map((m) => ({
            id: m.id,
            body: m.body,
            authorName: m.authorName,
            authorKind: m.authorKind,
            anonymous: m.anonymous,
            kind: m.kind,
            handoutName: m.handoutId ? handoutNames.get(m.handoutId) ?? null : null,
            registrationId: m.registrationId,
            authorMuted: m.registrationId ? muted.has(m.registrationId) : false,
            deleted: m.deletedAt !== null,
            pinned: ctx.chat.pinnedMessageId === m.id,
            createdAt: m.createdAt.toISOString(),
          })),
          muted: mutedRegs.map((r) => ({ registrationId: r.id, name: fullName(r.attendee) || "Attendee" })),
          handouts: [...handoutNames].map(([id, name]) => ({ id, name })),
        },
        { headers: NO_STORE },
      );
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-chat:console-read-failed");
    return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
  }
}

/** Apply a change to the stored chat settings under the event row lock; only the `chat` key moves. */
async function writeChat(eventId: string, organizationId: string, change: (c: WebinarChatSettings) => WebinarChatSettings) {
  let next: WebinarChatSettings = {};
  await updateEventSettings(
    eventId,
    (current) => {
      const webinar =
        current.webinar && typeof current.webinar === "object" ? (current.webinar as Record<string, unknown>) : {};
      next = change(readChatSettings(webinar));
      return { ...current, webinar: { ...webinar, chat: next } };
    },
    { organizationId },
  );
  return next;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/webinar/chat:PATCH";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ eventId, errors: parsed.error.flatten() }, "webinar-chat:settings-validation-failed");
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await loadEvent(gate.eventWhere);
      if (!ctx) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-chat:settings-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const p = parsed.data;
      const outcome: { refused: string | null } = { refused: null };
      const next = await writeChat(ctx.id, orgGuard.orgId, (c) => {
        const moderatorUserId = p.moderator === "me" ? session.user.id : c.moderatorUserId;
        // Never live with nobody watching it (owner, Nov 6, 2026).
        if (p.enabled === true && !moderatorUserId) {
          outcome.refused = "Name a moderator before switching chat on";
          return c;
        }
        return {
          ...c,
          moderatorUserId,
          ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
          ...(p.openInLobby !== undefined ? { openInLobby: p.openInLobby } : {}),
          ...(p.mutedAll !== undefined ? { mutedAll: p.mutedAll } : {}),
          ...(p.slowMode !== undefined ? { slowMode: p.slowMode } : {}),
        };
      });
      if (outcome.refused) {
        apiLogger.warn({ eventId: ctx.id, userId: session.user.id }, "webinar-chat:enable-without-moderator");
        return NextResponse.json({ error: outcome.refused, code: "CHAT_NEEDS_MODERATOR" }, { status: 409 });
      }
      if (ctx.sessionId) invalidateChatSnapshotsForSession(ctx.sessionId);
      apiLogger.info({ eventId: ctx.id, userId: session.user.id, change: p }, "webinar-chat:settings-changed");
      return NextResponse.json({ chat: next });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "EVENT_NOT_FOUND") {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    apiLogger.error({ err: error }, "webinar-chat:settings-failed");
    return NextResponse.json({ error: "Failed to change chat settings" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const route = "events/[eventId]/webinar/chat:POST";
    const orgGuard = requireOrgId(session, { route });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route, eventId });
    if (!gate.ok) return gate.response;

    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ eventId, errors: parsed.error.flatten() }, "webinar-chat:action-validation-failed");
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid action" }, { status: 400 });
    }
    const userId = session.user.id;

    return await runWithTenant(orgGuard.orgId, async () => {
      const ctx = await loadEvent(gate.eventWhere);
      if (!ctx?.sessionId) {
        apiLogger.warn({ eventId, userId }, "webinar-chat:action-event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const sessionId = ctx.sessionId;
      const a = parsed.data;
      const done = (extra: Record<string, unknown> = {}, status = 200) => {
        invalidateChatSnapshotsForSession(sessionId);
        apiLogger.info({ eventId: ctx.id, userId, action: a.action, ...extra }, "webinar-chat:moderated");
        return NextResponse.json({ ok: true, ...extra }, { status });
      };
      const message = (id: string) =>
        db.webinarChatMessage.findFirst({ where: { id, sessionId, eventId: ctx.id }, select: { id: true } });

      switch (a.action) {
        case "delete":
        case "restore": {
          const res = await db.webinarChatMessage.updateMany({
            where: { id: a.messageId, sessionId, eventId: ctx.id },
            data: a.action === "delete" ? { deletedAt: new Date(), deletedById: userId } : { deletedAt: null, deletedById: null },
          });
          if (res.count === 0) return notFound(ctx.id, userId, a.action);
          // A deleted message is never left pinned.
          if (a.action === "delete" && ctx.chat.pinnedMessageId === a.messageId) {
            await writeChat(ctx.id, orgGuard.orgId, (c) => ({ ...c, pinnedMessageId: null }));
          }
          return done({ messageId: a.messageId });
        }
        case "pin": {
          if (!(await message(a.messageId))) return notFound(ctx.id, userId, a.action);
          await writeChat(ctx.id, orgGuard.orgId, (c) => ({ ...c, pinnedMessageId: a.messageId }));
          return done({ messageId: a.messageId });
        }
        case "unpin":
          await writeChat(ctx.id, orgGuard.orgId, (c) => ({ ...c, pinnedMessageId: null }));
          return done();
        case "mute":
        case "unmute": {
          const reg = await db.registration.findFirst({ where: { id: a.registrationId, eventId: ctx.id }, select: { id: true } });
          if (!reg) return notFound(ctx.id, userId, a.action);
          await writeChat(ctx.id, orgGuard.orgId, (c) => {
            const list = new Set(c.mutedRegistrationIds ?? []);
            if (a.action === "mute") list.add(reg.id);
            else list.delete(reg.id);
            return { ...c, mutedRegistrationIds: [...list] };
          });
          return done({ registrationId: reg.id });
        }
        case "post": {
          if (a.handoutId && !readHandouts(ctx.webinar).some((h) => h.id === a.handoutId)) {
            apiLogger.warn({ eventId: ctx.id, userId, handoutId: a.handoutId }, "webinar-chat:console-handout-not-found");
            return NextResponse.json({ error: "That handout is no longer attached" }, { status: 404 });
          }
          const created = await db.webinarChatMessage.create({
            data: {
              eventId: ctx.id,
              organizationId: orgGuard.orgId,
              sessionId,
              userId,
              authorName: fullName(session.user) || "Host",
              authorKind: "staff",
              kind: a.handoutId ? "handout" : "message",
              handoutId: a.handoutId ?? null,
              body: a.body,
            },
            select: { id: true },
          });
          return done({ messageId: created.id }, 201);
        }
      }
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-chat:action-failed");
    return NextResponse.json({ error: "Failed to update chat" }, { status: 500 });
  }
}

function notFound(eventId: string, userId: string, action: string) {
  apiLogger.warn({ eventId, userId, action }, "webinar-chat:action-target-not-found");
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
