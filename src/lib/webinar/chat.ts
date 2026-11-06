/**
 * Attendee chat on a webinar's Custom stream page (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md
 * §6). Pure and client-safe: the settings, the rules the routes and the page share, and the shape
 * a viewer receives.
 *
 * Owner decisions (Nov 6): the attendee chooses per message, full name or anonymous, producers
 * always see the real name; links from attendees are plain text; chat opens with the room (a
 * producer switch opens it in the waiting room); chat is on only once a moderating producer is
 * named for the webinar.
 */
import { z } from "zod";

export const CHAT_MESSAGE_MAX = 500;
/** One message per this many seconds per person; slow mode stretches it. */
export const CHAT_INTERVAL_S = 3;
export const CHAT_SLOW_INTERVAL_S = 15;
export const CHAT_PER_MINUTE = 20;
/** How many recent messages the page holds and the route caches. */
export const CHAT_WINDOW = 200;
/** How often the page asks for new messages. */
export const CHAT_POLL_MS = 3000;
/** What other attendees see for an anonymous message. */
export const ANONYMOUS_AUTHOR = "Attendee";

export interface WebinarChatSettings {
  enabled?: boolean;
  /** The producer moderating this webinar's chat. Chat is off while unset. */
  moderatorUserId?: string | null;
  /** Open chat in the waiting room, before the producer opens the room. */
  openInLobby?: boolean;
  /** Attendees read but cannot post. */
  mutedAll?: boolean;
  /** One message per CHAT_SLOW_INTERVAL_S per person. */
  slowMode?: boolean;
  /** Registrations muted for this webinar. */
  mutedRegistrationIds?: string[];
  /** The message pinned at the top of the panel. */
  pinnedMessageId?: string | null;
}

export function readChatSettings(webinar: { chat?: unknown } | null | undefined): WebinarChatSettings {
  const raw = webinar?.chat;
  if (!raw || typeof raw !== "object") return {};
  const c = raw as Record<string, unknown>;
  return {
    enabled: c.enabled === true,
    moderatorUserId: typeof c.moderatorUserId === "string" && c.moderatorUserId ? c.moderatorUserId : null,
    openInLobby: c.openInLobby === true,
    mutedAll: c.mutedAll === true,
    slowMode: c.slowMode === true,
    mutedRegistrationIds: Array.isArray(c.mutedRegistrationIds)
      ? c.mutedRegistrationIds.filter((x): x is string => typeof x === "string")
      : [],
    pinnedMessageId: typeof c.pinnedMessageId === "string" && c.pinnedMessageId ? c.pinnedMessageId : null,
  };
}

/** On only when switched on AND a moderator is named (owner, Nov 6): never live unwatched. */
export function chatEnabled(chat: WebinarChatSettings): boolean {
  return chat.enabled === true && Boolean(chat.moderatorUserId);
}

/**
 * Where chat stands for this webinar right now.
 * - "closed": before the room opens (and not opened in the waiting room): nothing to read or post.
 * - "open": read and post.
 * - "readonly": after the webinar ended: read, no new posts.
 */
export type ChatPhase = "closed" | "open" | "readonly";

export function chatPhase(args: { roomOpen: boolean; ended: boolean; openInLobby: boolean }): ChatPhase {
  if (args.roomOpen) return "open";
  if (args.ended) return "readonly";
  return args.openInLobby ? "open" : "closed";
}

export const chatPostSchema = z.object({
  body: z
    .string()
    // Control characters other than newline and tab never reach the page.
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(1, "Type a message").max(CHAT_MESSAGE_MAX)),
  anonymous: z.boolean().default(false),
  /** Staff only: share one of the webinar's handouts as a card. */
  handoutId: z.string().min(1).max(64).optional(),
});
export type ChatPost = z.infer<typeof chatPostSchema>;

/** One message as a viewer receives it: never a registration id, user id or an anonymous name. */
export interface ChatMessageView {
  id: string;
  body: string;
  author: string;
  authorKind: "attendee" | "staff";
  kind: "message" | "handout";
  handout: { id: string; name: string } | null;
  mine: boolean;
  createdAt: string;
}

/**
 * The name other people see. Staff are always named; an anonymous attendee is "Attendee"; the
 * author themself sees their own message as theirs (the page shows "You").
 */
export function displayAuthor(m: { authorName: string; authorKind: string; anonymous: boolean }): string {
  if (m.authorKind === "staff") return m.authorName;
  return m.anonymous ? ANONYMOUS_AUTHOR : m.authorName;
}

/** https links in a STAFF message, for the page to make clickable; attendee text stays plain. */
export function splitLinks(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  const re = /https:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    const href = m[0].replace(/[.,;:!?)]+$/, "");
    parts.push({ text: href, href });
    last = at + href.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
