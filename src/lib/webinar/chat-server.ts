/**
 * Server side of webinar chat (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §6.2): the cached
 * snapshot every viewer's 3-second poll reads, and the per-person viewer cache.
 *
 * At 500 viewers the read route gets about 170 requests a second. None of them should reach the
 * database: the snapshot (the event, the room's state, the last CHAT_WINDOW messages) is rebuilt
 * at most every SNAPSHOT_TTL_MS per container, as lobby-status does, and who a viewer is (staff,
 * or a registration that may watch) is cached per person for VIEWER_TTL_MS, as stream-status does.
 * A post drops this container's snapshot so the poster sees their message at once; other
 * containers catch up within the TTL.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { readWebinarSettings, type WebinarSettings } from "@/lib/webinar";
import { webinarRoomEnded } from "@/lib/webinar-page-layout";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveEventTenant } from "@/lib/tenant/event-tenant";
import { readHandouts } from "@/lib/webinar/handouts";
import { resolveAsker, type Asker } from "@/lib/webinar/viewer-question-access";
import {
  CHAT_WINDOW,
  chatEnabled,
  chatPhase,
  displayAuthor,
  readChatSettings,
  type ChatMessageView,
  type ChatPhase,
  type WebinarChatSettings,
} from "@/lib/webinar/chat";

const SNAPSHOT_TTL_MS = 2000;
/** How far before a viewer's cursor the route looks again for messages that committed late. The race
 *  lasts milliseconds; every message inside the window is resent on every poll, so it is kept short
 *  (the Nov 6 load test at 200 messages a minute: 5 s meant about 15 repeats per poll). */
const LATE_COMMIT_OVERLAP_MS = 2000;
const VIEWER_TTL_MS = 60_000;
const CACHE_MAX = 5000;

/** A stored message as the snapshot keeps it: ids stay server-side. */
export interface CachedChatMessage {
  id: string;
  body: string;
  authorName: string;
  authorKind: string;
  anonymous: boolean;
  kind: string;
  handoutId: string | null;
  registrationId: string | null;
  userId: string | null;
  deleted: boolean;
  createdAt: Date;
}

export interface ChatSnapshot {
  /** The tenant, found by the sanctioned discovery read (event-tenant.ts); callers enter its lane. */
  organizationId: string;
  event: { id: string; organizationId: string; status: string; webinar: WebinarSettings | null };
  chat: WebinarChatSettings;
  /** Chat is switched on (with a moderator) and the webinar is in Custom stream mode. */
  enabled: boolean;
  phase: ChatPhase;
  messages: CachedChatMessage[];
  /** The pinned message, found even when it has aged out of the window; null when none or deleted. */
  pinned: CachedChatMessage | null;
  /** Moderation version (chat settings): a page holding another reloads the window. */
  version: number;
  handoutNames: Map<string, string>;
  at: number;
}

const snapshots = new Map<string, ChatSnapshot>();
/** One rebuild per key at a time: 500 polls missing together share a single set of queries. */
const building = new Map<string, Promise<ChatSnapshot | null>>();
const viewers = new Map<string, { asker: Asker; until: number }>();

/** Test hook. */
export function resetChatCaches(): void {
  snapshots.clear();
  building.clear();
  viewers.clear();
}

function snapshotKey(eventWhere: Prisma.EventWhereInput, slug: string, sessionId: string): string {
  const org = typeof eventWhere.organizationId === "string" ? eventWhere.organizationId : "none";
  return `${org}:${slug}:${sessionId}`;
}

/**
 * Put a just-posted message into this container's snapshot, so the poster and everyone on this
 * container see it at once without a rebuild (review of f35de631: invalidating on every post
 * rebuilt the snapshot twice per message).
 */
export function appendToChatSnapshot(
  eventWhere: Prisma.EventWhereInput,
  slug: string,
  sessionId: string,
  message: CachedChatMessage,
): void {
  const key = snapshotKey(eventWhere, slug, sessionId);
  const current = snapshots.get(key);
  if (!current) return;
  snapshots.set(key, { ...current, messages: [...current.messages, message].slice(-CHAT_WINDOW) });
}

/** Drop this container's snapshots for a session, after a console change (it knows no slug). */
export function invalidateChatSnapshotsForSession(sessionId: string): void {
  for (const key of snapshots.keys()) if (key.endsWith(`:${sessionId}`)) snapshots.delete(key);
}

/**
 * The session's chat as it stands, from cache when fresh (or rebuilt with `fresh`, which a post
 * uses so a mute or a close bites at once, without discarding the entry everyone else reads).
 * Null when this is not a webinar's room (not a WEBINAR event, or not its anchor session), so the
 * route answers 404 as Q&A does.
 */
export async function getChatSnapshot(
  eventWhere: Prisma.EventWhereInput,
  slug: string,
  sessionId: string,
  opts: { fresh?: boolean; now?: number } = {},
): Promise<ChatSnapshot | null> {
  const now = opts.now ?? Date.now();
  const key = snapshotKey(eventWhere, slug, sessionId);
  const cached = snapshots.get(key);
  if (!opts.fresh && cached && now - cached.at < SNAPSHOT_TTL_MS) return cached;
  const inFlight = building.get(key);
  if (inFlight) return inFlight;
  const build = buildSnapshot(eventWhere, sessionId, now).finally(() => building.delete(key));
  building.set(key, build);
  const snapshot = await build;
  if (snapshot) {
    if (snapshots.size >= CACHE_MAX) snapshots.clear();
    snapshots.set(key, snapshot);
  }
  return snapshot;
}

async function buildSnapshot(eventWhere: Prisma.EventWhereInput, sessionId: string, now: number): Promise<ChatSnapshot | null> {
  // Discover the tenant through the one sanctioned pre-lane read, then read the event's content
  // inside its lane (Event RLS preparation, Nov 5, 2026: event-lane-ratchet.test.ts).
  const tenant = await resolveEventTenant(eventWhere);
  if (!tenant) return null;

  return runWithTenant(tenant.organizationId, async () => {
    const event = await db.event.findFirst({
      where: { id: tenant.id },
      select: { id: true, organizationId: true, status: true, eventType: true, settings: true },
    });
    if (!event || event.eventType !== "WEBINAR") return null;
    const webinar = readWebinarSettings(event.settings);
    if (webinar?.sessionId !== sessionId) return null;
    const [session, rows] = await Promise.all([
      db.eventSession.findFirst({
        where: { id: sessionId, eventId: event.id },
        select: { status: true, startTime: true, endTime: true },
      }),
      db.webinarChatMessage.findMany({
        where: { sessionId, eventId: event.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CHAT_WINDOW,
        select: {
          id: true,
          body: true,
          authorName: true,
          authorKind: true,
          anonymous: true,
          kind: true,
          handoutId: true,
          registrationId: true,
          userId: true,
          deletedAt: true,
          createdAt: true,
        },
      }),
    ]);
    if (!session) return null;
    const chat = readChatSettings(webinar);
    const messages: CachedChatMessage[] = rows.reverse().map(({ deletedAt, ...m }) => ({ ...m, deleted: deletedAt !== null }));
    // The pin outlives the window (review of f35de631): look it up when it has aged out.
    let pinned = chat.pinnedMessageId ? messages.find((m) => m.id === chat.pinnedMessageId) ?? null : null;
    if (chat.pinnedMessageId && !pinned) {
      const row = await db.webinarChatMessage.findFirst({
        where: { id: chat.pinnedMessageId, sessionId, eventId: event.id },
        select: {
          id: true, body: true, authorName: true, authorKind: true, anonymous: true, kind: true,
          handoutId: true, registrationId: true, userId: true, deletedAt: true, createdAt: true,
        },
      });
      pinned = row ? (({ deletedAt, ...m }) => ({ ...m, deleted: deletedAt !== null }))(row) : null;
    }
    if (pinned?.deleted) pinned = null;
    const roomOpen = session.status === "LIVE" || event.status === "DRAFT";
    const ended = webinarRoomEnded({
      status: session.status,
      startMs: session.startTime.getTime(),
      endMs: session.endTime.getTime(),
      now,
    });
    const snapshot: ChatSnapshot = {
      organizationId: tenant.organizationId,
      event: { id: event.id, organizationId: event.organizationId, status: event.status, webinar },
      chat,
      enabled: chatEnabled(chat) && webinar?.viewingMode === "hls",
      phase: chatPhase({ roomOpen, ended, openInLobby: chat.openInLobby === true }),
      messages,
      pinned,
      version: chat.version ?? 0,
      handoutNames: new Map(readHandouts(webinar).map((h) => [h.id, h.name])),
      at: now,
    };
    return snapshot;
  });
}

/**
 * Who this signed-in person is on this event's chat: staff, a registration that may watch, or
 * nobody (null). Positive answers are cached for a minute, so a cancelled registration can read
 * for up to that long (the same trade-off as stream-status, review L4 of Nov 5).
 */
export async function resolveChatViewer(
  user: { id: string; role?: string | null; organizationId?: string | null; firstName?: string | null; lastName?: string | null },
  event: { id: string; organizationId: string },
  now = Date.now(),
): Promise<Asker | null> {
  const key = `${user.id}:${event.id}`;
  const hit = viewers.get(key);
  if (hit && hit.until > now) return hit.asker;
  const asker = await resolveAsker(user.id, event.id, user, event.organizationId);
  if (!asker) return null;
  if (viewers.size >= CACHE_MAX) viewers.clear();
  viewers.set(key, { asker, until: now + VIEWER_TTL_MS });
  return asker;
}

function isMine(m: CachedChatMessage, asker: Asker, userId: string): boolean {
  return asker.kind === "attendee" ? m.registrationId === asker.registrationId : m.userId === userId;
}

/** One message for this viewer. Never a registration id, user id or an anonymous author's name. */
export function toView(
  m: CachedChatMessage,
  snapshot: Pick<ChatSnapshot, "handoutNames">,
  asker: Asker,
  userId: string,
): ChatMessageView {
  const handoutName = m.handoutId ? snapshot.handoutNames.get(m.handoutId) : undefined;
  return {
    id: m.id,
    body: m.body,
    author: displayAuthor(m),
    authorKind: m.authorKind === "staff" ? "staff" : "attendee",
    kind: m.kind === "handout" && handoutName ? "handout" : "message",
    handout: m.handoutId && handoutName ? { id: m.handoutId, name: handoutName } : null,
    mine: isMine(m, asker, userId),
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * What a viewer gets back for `after` (the newest id they hold) and `version` (the moderation
 * version they hold): newer undeleted messages, plus the ids deleted in the window so the page
 * drops them. A reset (the whole window) when `after` is unknown (first load, or scrolled out of
 * the window) or the moderation version moved (a restore). Messages from the few seconds before
 * the cursor are sent again: one that committed after a later one would otherwise sort behind the
 * cursor and be skipped for good (review of f35de631); the page drops ids it already holds.
 */
export function messagesAfter(
  snapshot: Pick<ChatSnapshot, "messages" | "version">,
  after: string | null,
  version: number | null = null,
): { fresh: CachedChatMessage[]; removed: string[]; reset: boolean } {
  const removed = snapshot.messages.filter((m) => m.deleted).map((m) => m.id);
  const stale = version !== null && version !== snapshot.version;
  const at = after && !stale ? snapshot.messages.findIndex((m) => m.id === after) : -1;
  if (at === -1) return { fresh: snapshot.messages.filter((m) => !m.deleted), removed, reset: true };
  const since = snapshot.messages[at].createdAt.getTime() - LATE_COMMIT_OVERLAP_MS;
  let from = at;
  while (from > 0 && snapshot.messages[from - 1].createdAt.getTime() >= since) from -= 1;
  const fresh = snapshot.messages.slice(from).filter((m, i) => !m.deleted && (from + i > at || m.id !== after));
  return { fresh, removed, reset: false };
}
