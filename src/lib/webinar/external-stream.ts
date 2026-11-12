/**
 * A partner's stream key: what they are handed, and whether a publish that
 * presents it is let in (Nov 12, 2026; external streams step 2,
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.3).
 *
 * A key emailed to an agency is not like the one only Zoom's servers hold. It
 * must be replaceable without changing the address attendees watch on, stop
 * working after the webinar, and be switched off in one click. So a publish on
 * an external key is let in only when ALL of these hold:
 *
 *   the password    derived from the key AND its secretVersion (livestream.ts);
 *                   "Replace the key" adds one to the version, so the value the
 *                   partner holds stops matching
 *   switched on     ExternalStream.enabled
 *   in its period   from validFrom until validUntil, or 24 hours after the
 *                   session's scheduled end when it has no end date of its own
 *
 * The password is checked FIRST, so a stranger who only copied the key (every
 * viewer's player address contains it) is logged as a bad password whatever the
 * key's state. MediaMTX is answered 403 for every refusal alike; the reason is
 * for our log, so "it does not work" can be answered from it.
 *
 * MediaMTX asks only when a publish STARTS. An encoder already connected is not
 * asked again when its key is replaced, switched off or expires: ending that
 * connection is "cut the feed" (step 3), and no key is handed to a partner
 * before that exists.
 *
 * Pure: no database, no clock of its own.
 */
import { rtmpIngestUrl, STREAM_PUBLISH_USER, isValidPublishPassword, streamPublishPassword } from "@/lib/webinar/livestream";
import { externalStreamValidUntil } from "@/lib/webinar/session-stream";

export type ExternalPublishRefusal = "BAD_PASSWORD" | "SWITCHED_OFF" | "NOT_YET_VALID" | "EXPIRED";

export type ExternalPublishDecision = { allowed: true } | { allowed: false; reason: ExternalPublishRefusal };

export interface ExternalKeyState {
  streamKey: string;
  secretVersion: number;
  enabled: boolean;
  validFrom: Date;
  validUntil: Date | null;
  sessionEndTime: Date;
}

/** Whether a publish presenting `password` on this key is let in at `now`, and if not, why. */
export function externalPublishDecision(
  key: ExternalKeyState,
  password: string | null | undefined,
  now: Date,
): ExternalPublishDecision {
  if (!isValidPublishPassword(key.streamKey, password, key.secretVersion)) return { allowed: false, reason: "BAD_PASSWORD" };
  if (!key.enabled) return { allowed: false, reason: "SWITCHED_OFF" };
  if (now.getTime() < key.validFrom.getTime()) return { allowed: false, reason: "NOT_YET_VALID" };
  if (now.getTime() > externalStreamValidUntil(key).getTime()) return { allowed: false, reason: "EXPIRED" };
  return { allowed: true };
}

/**
 * The two values a partner types into their platform's "custom live streaming"
 * form: the same shape Zoom is sent for our own webinars (zoomPublishKey), so a
 * partner's Zoom account takes them unchanged. A HOST credential: only for
 * people who hold `zoomHost.view`, never for the agent, never in a log.
 */
export function externalStreamCredentials(key: { streamKey: string; secretVersion: number }): {
  serverUrl: string;
  streamKey: string;
} {
  return {
    serverUrl: rtmpIngestUrl(),
    streamKey: `${key.streamKey}?user=${STREAM_PUBLISH_USER}&pass=${streamPublishPassword(key.streamKey, key.secretVersion)}`,
  };
}
