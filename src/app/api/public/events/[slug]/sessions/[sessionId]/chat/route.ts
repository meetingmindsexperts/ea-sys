import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveAsker } from "@/lib/webinar/viewer-question-access";
import {
  CHAT_INTERVAL_S,
  CHAT_PER_MINUTE,
  CHAT_SLOW_INTERVAL_S,
  chatPostSchema,
} from "@/lib/webinar/chat";
import {
  appendToChatSnapshot,
  getChatSnapshot,
  messagesAfter,
  resolveChatViewer,
  toView,
} from "@/lib/webinar/chat-server";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const STATUSES = ["DRAFT", "PUBLISHED", "LIVE", "COMPLETED"] as const;
const NO_STORE = { "Cache-Control": "private, no-store" };

/** Seconds between one person's messages: staff never slowed, slow mode stretches attendees. */
function postIntervalSeconds(staff: boolean, slowMode: boolean | undefined): number {
  if (staff) return CHAT_INTERVAL_S;
  return slowMode ? CHAT_SLOW_INTERVAL_S : CHAT_INTERVAL_S;
}

/** Why this viewer cannot post right now, for the panel's one line; null when they can. */
function postBlockedBy(canPost: boolean, muted: boolean, mutedAll: boolean | undefined, phase: string): string | null {
  if (canPost) return null;
  if (muted) return "muted";
  if (mutedAll) return "muted-all";
  return phase;
}

/**
 * Attendee chat on a webinar's Custom stream page (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md
 * §6). GET is the page's 3-second poll, answered from the cached snapshot (chat-server.ts); POST
 * sends a message. Both need a signed-in viewer who may watch (viewer-entitlement.ts) or staff.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    // A poll every 3 s is 1,200 an hour; twice that is a runaway tab, not a person.
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-chat-read:${authSession.user.id}`,
      limit: 2400,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId }, "webinar-chat:read-rate-limited");
      return NextResponse.json(
        { error: "Too many requests", retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const eventWhere = await publicEventWhere(req, slug, { statuses: [...STATUSES] });
    const snapshot = await getChatSnapshot(eventWhere, slug, sessionId);
    if (!snapshot) {
      apiLogger.warn({ slug, sessionId }, "webinar-chat:not-the-webinar-room");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!snapshot.enabled) return NextResponse.json({ enabled: false }, { headers: NO_STORE });

    return await runWithTenant(snapshot.organizationId, async () => {
      const asker = await resolveChatViewer(authSession.user, snapshot.event);
      if (!asker) {
        apiLogger.warn({ userId: authSession.user.id, eventId: snapshot.event.id }, "webinar-chat:read-not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const staff = asker.kind === "staff";
      const { chat, phase } = snapshot;
      // Before the room opens attendees see nothing; staff read whatever the phase, to test.
      if (phase === "closed" && !staff) {
        return NextResponse.json({ enabled: true, phase, canPost: false, messages: [], removed: [], reset: true, pinned: null }, { headers: NO_STORE });
      }
      const search = new URL(req.url).searchParams;
      const versionParam = search.get("v");
      const { fresh, removed, reset } = messagesAfter(
        snapshot,
        search.get("after"),
        versionParam === null ? null : Number(versionParam),
      );
      const pinnedRow = snapshot.pinned;
      const muted = asker.kind === "attendee" && (chat.mutedRegistrationIds ?? []).includes(asker.registrationId);
      const canPost = phase === "open" && (staff || (!chat.mutedAll && !muted));
      return NextResponse.json(
        {
          enabled: true,
          phase,
          canPost,
          // Why not, for the panel's one line.
          postBlockedBy: postBlockedBy(canPost, muted, chat.mutedAll, phase),
          intervalSeconds: postIntervalSeconds(staff, chat.slowMode),
          // The name a "Post as" choice shows; staff are always named.
          postAs: asker.name,
          canPostAnonymously: !staff,
          messages: fresh.map((m) => toView(m, snapshot, asker, authSession.user.id)),
          removed,
          reset,
          version: snapshot.version,
          pinned: pinnedRow ? toView(pinnedRow, snapshot, asker, authSession.user.id) : null,
        },
        { headers: NO_STORE },
      );
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-chat:read-failed");
    return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => ({})),
    ]);
    if (!authSession?.user) {
      apiLogger.warn({ slug, sessionId }, "webinar-chat:post-unauthenticated");
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const userId = authSession.user.id;

    const parsed = chatPostSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ userId, errors: parsed.error.flatten() }, "webinar-chat:validation-failed");
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid message" }, { status: 400 });
    }

    // Before any database work (review of f35de631: a refused post used to rebuild the snapshot
    // everyone reads, so anyone signed in could keep every viewer's polls missing the cache).
    const early = checkRateLimit({ key: `webinar-chat-post:${userId}`, limit: CHAT_PER_MINUTE, windowMs: 60_000 });
    if (!early.allowed) {
      apiLogger.warn({ userId, sessionId }, "webinar-chat:post-rate-limited");
      return NextResponse.json(
        { error: "You are sending messages too quickly", retryAfterSeconds: early.retryAfterSeconds, code: "CHAT_TOO_FAST" },
        { status: 429, headers: { "Retry-After": String(early.retryAfterSeconds) } },
      );
    }

    // Fresh, not the poll's cache: a mute, a close or a cancellation must bite at once. Rebuilt in
    // place (one rebuild at a time per webinar), never discarded under the other viewers.
    const eventWhere = await publicEventWhere(req, slug, { statuses: [...STATUSES] });
    const snapshot = await getChatSnapshot(eventWhere, slug, sessionId, { fresh: true });
    if (!snapshot) {
      apiLogger.warn({ slug, sessionId }, "webinar-chat:post-not-the-webinar-room");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!snapshot.enabled) {
      apiLogger.warn({ userId, eventId: snapshot.event.id }, "webinar-chat:post-chat-off");
      return NextResponse.json({ error: "Chat is off for this webinar", code: "CHAT_OFF" }, { status: 409 });
    }

    return await runWithTenant(snapshot.organizationId, async () => {
      const { event, chat, phase } = snapshot;
      const asker = await resolveAsker(userId, event.id, authSession.user, event.organizationId);
      if (!asker) {
        apiLogger.warn({ userId, eventId: event.id }, "webinar-chat:post-not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const staff = asker.kind === "staff";
      if (phase !== "open") {
        apiLogger.warn({ userId, eventId: event.id, phase }, "webinar-chat:post-closed");
        return NextResponse.json({ error: "Chat is closed", code: "CHAT_CLOSED" }, { status: 409 });
      }
      if (!staff && chat.mutedAll) {
        apiLogger.warn({ userId, eventId: event.id }, "webinar-chat:post-muted-all");
        return NextResponse.json({ error: "The moderator has paused chat", code: "CHAT_MUTED_ALL" }, { status: 403 });
      }
      if (asker.kind === "attendee" && (chat.mutedRegistrationIds ?? []).includes(asker.registrationId)) {
        apiLogger.warn({ userId, eventId: event.id }, "webinar-chat:post-muted");
        return NextResponse.json({ error: "You have been muted in this chat", code: "CHAT_MUTED" }, { status: 403 });
      }
      if (parsed.data.handoutId && !staff) {
        apiLogger.warn({ userId, eventId: event.id }, "webinar-chat:handout-share-not-staff");
        return NextResponse.json({ error: "Only the organisers share handouts" }, { status: 403 });
      }
      if (parsed.data.handoutId && !snapshot.handoutNames.has(parsed.data.handoutId)) {
        apiLogger.warn({ userId, eventId: event.id, handoutId: parsed.data.handoutId }, "webinar-chat:handout-not-found");
        return NextResponse.json({ error: "That handout is no longer attached" }, { status: 404 });
      }

      const intervalS = postIntervalSeconds(staff, chat.slowMode);
      const gap = checkRateLimit({ key: `webinar-chat-gap:${userId}:${event.id}`, limit: 1, windowMs: intervalS * 1000 });
      if (!gap.allowed) {
        apiLogger.warn({ userId, eventId: event.id }, "webinar-chat:post-too-soon");
        return NextResponse.json(
          { error: "You are sending messages too quickly", retryAfterSeconds: gap.retryAfterSeconds, code: "CHAT_TOO_FAST" },
          { status: 429, headers: { "Retry-After": String(gap.retryAfterSeconds) } },
        );
      }

      const created = await db.webinarChatMessage.create({
        data: {
          eventId: event.id,
          organizationId: event.organizationId,
          sessionId,
          registrationId: asker.kind === "attendee" ? asker.registrationId : null,
          userId: staff ? userId : null,
          // The real name always; the anonymous flag decides what others see.
          authorName: asker.name,
          authorKind: staff ? "staff" : "attendee",
          anonymous: !staff && parsed.data.anonymous,
          kind: parsed.data.handoutId ? "handout" : "message",
          handoutId: parsed.data.handoutId ?? null,
          body: parsed.data.body,
        },
        select: {
          id: true, body: true, authorName: true, authorKind: true, anonymous: true, kind: true,
          handoutId: true, registrationId: true, userId: true, createdAt: true,
        },
      });
      appendToChatSnapshot(eventWhere, slug, sessionId, { ...created, deleted: false });
      apiLogger.info({ eventId: event.id, sessionId, messageId: created.id, staff }, "webinar-chat:posted");
      return NextResponse.json({ id: created.id }, { status: 201, headers: NO_STORE });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-chat:post-failed");
    return NextResponse.json({ error: "Failed to send your message" }, { status: 500 });
  }
}
