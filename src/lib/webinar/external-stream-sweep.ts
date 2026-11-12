/**
 * The backstop behind a partner's stream key (Nov 12, 2026; external streams
 * step 3, docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.3 and §4.6).
 *
 * MediaMTX asks our publish check only when a stream starts, so a key that is
 * switched off or runs past its period does not, by itself, end a stream that
 * is already connected. Switching off and replacing disconnect at once
 * (external-stream-service.ts). This sweep is for what nobody presses a button
 * for: the END OF THE PERIOD, and a disconnect that failed when the button was
 * pressed. Every minute, from the worker's stream watchdog job:
 *
 *   1. ask MediaMTX who is publishing (one call);
 *   2. for each publisher on a PARTNER's key, ask whether that key may still
 *      be used now (switched on, inside its period), and whether the
 *      connection began before the key was last REPLACED (then it can only be
 *      on an old password: the disconnect at replace time must have failed);
 *   3. if either says no, disconnect it, and say so in the log and the audit
 *      trail.
 *
 * What it deliberately does NOT do:
 *  - Judge the password. Whether MediaMTX's connection list repeats the
 *    password the encoder sent was not verified, and a wrong guess would
 *    disconnect a good stream every minute. A replaced key is recognised by
 *    WHEN the connection began, and a connection whose start time MediaMTX
 *    does not give is left alone.
 *  - Touch a publisher whose key it cannot find. On the platform instance the
 *    tenant-less lookup finds nothing (ROADMAP, "Webinar streaming", item 2):
 *    "unknown" must never read as "not allowed", or every stream there would
 *    be cut once a minute. Only a partner's row that says no is acted on. An
 *    unknown key is SAID, once per connection (a session deleted with its
 *    partner stream still running leaves exactly this), and left running.
 *  - Touch our own Zoom's streams.
 *
 * Does nothing at all while the control API is not set up.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { externalKeyRefusal } from "@/lib/webinar/external-stream";
import { isMediamtxControlConfigured, kickPublisher, listPublishers, type Publisher } from "@/lib/webinar/mediamtx-control";
import { streamKeyOwner } from "@/lib/webinar/session-stream";

const LIVE_PATH = /^live\/([a-f0-9]{32})$/;

/** Connections already reported as publishing on a key nobody owns, so each is said once, not every minute. */
const reportedUnknown = new Set<string>();
const REPORTED_UNKNOWN_MAX = 500;

/** Test hook. */
export function resetExternalStreamSweep(): void {
  reportedUnknown.clear();
}

function reportUnknownOnce(publisher: Publisher): void {
  if (reportedUnknown.has(publisher.id)) return;
  if (reportedUnknown.size >= REPORTED_UNKNOWN_MAX) reportedUnknown.clear();
  reportedUnknown.add(publisher.id);
  apiLogger.warn({ remoteAddr: publisher.remoteAddr }, "external-stream-sweep:publisher-on-unknown-key");
}

type SweepReason = "SWITCHED_OFF" | "NOT_YET_VALID" | "EXPIRED" | "KEY_REPLACED";

/** Why this connection must end, or null. A start time we could not read never counts as "before". */
function sweepReason(
  owner: Extract<NonNullable<Awaited<ReturnType<typeof streamKeyOwner>>>, { source: "external" }>,
  publisher: Publisher,
  now: Date,
): SweepReason | null {
  const refusal = externalKeyRefusal(owner, now);
  if (refusal) return refusal;
  const replacedAt = owner.keyReplacedAt;
  if (replacedAt && publisher.connectedAt && publisher.connectedAt.getTime() < replacedAt.getTime()) return "KEY_REPLACED";
  return null;
}

export interface SweepReport {
  /** Publishers found on a partner's key. */
  checked: number;
  disconnected: number;
}

async function sweepOne(publisher: Publisher, streamKey: string, now: Date, report: SweepReport): Promise<void> {
  const owner = await streamKeyOwner(streamKey);
  if (!owner) {
    reportUnknownOnce(publisher);
    return;
  }
  if (owner.source !== "external") return;
  report.checked += 1;
  const refusal = sweepReason(owner, publisher, now);
  if (!refusal) return;

  const done = await kickPublisher(publisher);
  if (!done) {
    apiLogger.warn({ eventId: owner.eventId, sessionId: owner.sessionId, reason: refusal }, "external-stream-sweep:disconnect-failed");
    return;
  }
  report.disconnected += 1;
  apiLogger.warn({ eventId: owner.eventId, sessionId: owner.sessionId, reason: refusal }, "external-stream-sweep:disconnected");
  await db.auditLog.create({
    data: {
      eventId: owner.eventId,
      action: "EXTERNAL_STREAM_DISCONNECTED",
      entityType: "ExternalStream",
      entityId: owner.id,
      changes: { reason: refusal, sessionId: owner.sessionId, source: "worker" },
    },
  });
}

export async function sweepExternalPublishers(now: Date = new Date()): Promise<SweepReport> {
  const report: SweepReport = { checked: 0, disconnected: 0 };
  if (!isMediamtxControlConfigured()) return report;
  const listed = await listPublishers();
  if (!listed.ok) return report; // logged by listPublishers

  for (const publisher of listed.publishers) {
    const match = LIVE_PATH.exec(publisher.path);
    if (!match) continue;
    try {
      await sweepOne(publisher, match[1], now, report);
    } catch (err) {
      // One stream's failure (a lookup error, an audit write) never stops the others.
      apiLogger.error({ err }, "external-stream-sweep:publisher-failed");
    }
  }
  return report;
}
