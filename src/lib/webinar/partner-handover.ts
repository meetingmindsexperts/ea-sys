/**
 * What we send a partner so they can stream into our webinar (Nov 16, 2026;
 * external streams step 7, docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.4).
 * Client-safe: the console builds it from the key it has just shown, so the key
 * is fetched once, through the one audited reveal, and never by this module.
 */
import { formatDateTimeInTz } from "@/lib/event-time";

/** What we ask the partner's encoder for: the server passes the picture through untouched (plan §4.4). */
export const PARTNER_ENCODER_SETTINGS: ReadonlyArray<{ setting: string; value: string; why: string }> = [
  { setting: "Video", value: "H.264", why: "The player and iPhones need it" },
  { setting: "Audio", value: "AAC", why: "The same" },
  { setting: "Keyframe", value: "Every 2 seconds", why: "A longer gap freezes iPhones" },
  { setting: "Size and rate", value: "720p, 30 frames, about 2.5 Mbps (up to 1080p at 4.5 Mbps)", why: "Every attendee downloads exactly this" },
];

export interface PartnerHandoverInput {
  eventName: string;
  serverUrl: string;
  streamKey: string;
  validFrom: Date;
  validUntil: Date;
  /** false: the end date follows the webinar (24 hours after its scheduled end), so it moves with it. */
  validUntilIsOwn: boolean;
  /** The webinar's scheduled start: the technician plans around it, not around the key's period. */
  scheduledStart: Date | null;
  /** The attendee page. Zoom's custom live streaming form asks for a "live streaming page URL". */
  pageUrl: string | null;
  /**
   * A DRAFT event's room counts as open (viewer-entitlement.ts isViewerRoomOpen), so a test is seen
   * by registered people: the message must not tell the partner otherwise (review of 1f98a508).
   */
  draft: boolean;
  timezone: string;
  /** Who the partner calls on the day; optional, typed by the producer and never stored. */
  contact?: string;
}

function testingLine(draft: boolean): string {
  if (draft) return "The event page is still in draft, so anyone registered can see a test on it: please tell us before you test.";
  return "You can test any time in that period: attendees see nothing until we open the room.";
}

/**
 * The handover as plain text, ready to paste into an email. Plain on purpose:
 * it is pasted into whatever the producer writes with, and an encoder's fields
 * take exactly the two values on their own lines.
 */
export function partnerHandoverText(input: PartnerHandoverInput): string {
  const when = (d: Date) => formatDateTimeInTz(d, input.timezone);
  const untilNote = input.validUntilIsOwn ? "" : " (it moves if the webinar's date changes)";
  const lines = [`Streaming details for ${input.eventName.trim() || "the webinar"}`, ""];
  if (input.scheduledStart) lines.push(`The webinar starts at ${when(input.scheduledStart)}.`, "");
  lines.push(
    `Server (RTMP URL): ${input.serverUrl}`,
    `Stream key: ${input.streamKey}`,
    "Paste the whole stream key, including everything after the question mark: that part is its password.",
  );
  if (input.pageUrl) lines.push(`If your platform asks for a live streaming page URL: ${input.pageUrl}`);
  lines.push(
    "",
    `The key works from ${when(input.validFrom)} until ${when(input.validUntil)}${untilNote}.`,
    testingLine(input.draft),
    "",
    "Encoder settings:",
    ...PARTNER_ENCODER_SETTINGS.map((s) => `- ${s.setting}: ${s.value}`),
  );
  const contact = input.contact?.trim();
  if (contact) lines.push("", `Contact on the day: ${contact}`);
  lines.push("", "Please keep this key private. If it is shared by mistake, tell us and we will replace it.");
  return lines.join("\n");
}
