/**
 * What a stale DR stream actually MEANS, which its age alone cannot say.
 *
 * Deliberately dependency-free. The digest worker (server) and the Infra page
 * ("use client") both need this wording, and aws-ops.ts pulls in the AWS SDK
 * and Prisma — a VALUE import from there would land both in the browser
 * bundle. The input is structural for the same reason: the DrArtifact type is
 * erased at build time, a real import would not be.
 *
 * For a stream that writes a heartbeat (the uploads mirror), the two
 * timestamps answer different questions:
 *   - heartbeat     — did the sync last COMPLETE cleanly?
 *   - newest object — did anything actually land?
 *
 * They come apart on a PARTIAL failure. `aws s3 sync` exits non-zero if ANY
 * object fails, and the cron is `sync … && … heartbeat`, so one unreadable
 * file freezes the heartbeat while every other file keeps mirroring hourly.
 * On Sep 16, 2026 that ran for 40 hours: a single 9.5MB object failed on
 * s3:GetObjectTagging (above 8MB the CLI uses multipart copy, which asks for
 * tags; the instance role was never granted that action), and the digest said
 * only "newest is 11h old" — which reads as a dead mirror and sends whoever is
 * on call to entirely the wrong place.
 */

export type DrStaleKind =
  /** Files are still landing, but no run finished cleanly: something is failing mid-sync. */
  | "sync-failing"
  /** Nothing landed recently and no run completed: a dead cron, or genuinely no uploads. */
  | "nothing-arriving"
  /** The prefix is empty — this stream has never produced a restore point. */
  | "never-arrived";

/** The fields of a DR row this needs. Structural, so this module imports nothing. */
export interface DrStalenessInput {
  prefix: string;
  latestAt: string | null;
  ageHours: number | null;
  staleAfterHours: number;
  stale: boolean;
  heartbeatAt: string | null;
  newestObjectAt: string | null;
}

export interface DrStaleness {
  kind: DrStaleKind;
  /** One sentence naming what is wrong and, where it exists, where to look. */
  detail: string;
}

function hoursSince(at: string | null, now: number): number | null {
  if (at == null) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : (now - t) / 3_600_000;
}

/**
 * null when the row is healthy, so callers stay a plain `if`.
 *
 * `now` is injectable for tests only; production never passes it.
 */
export function describeDrStaleness(row: DrStalenessInput, now: number = Date.now()): DrStaleness | null {
  if (!row.stale) return null;

  if (row.latestAt == null) {
    return {
      kind: "never-arrived",
      detail: `Nothing has ever landed under ${row.prefix} in the DR bucket, so this stream has no restore point at all.`,
    };
  }

  const heartbeatAge = hoursSince(row.heartbeatAt, now);
  const objectAge = hoursSince(row.newestObjectAt, now);

  // Objects still arriving while the heartbeat has frozen: the sync IS running,
  // it just never finishes cleanly. Naming the log is the whole point — this is
  // the state that used to read as "the mirror is dead".
  if (
    heartbeatAge != null &&
    heartbeatAge > row.staleAfterHours &&
    objectAge != null &&
    objectAge < heartbeatAge
  ) {
    return {
      kind: "sync-failing",
      detail:
        `Files ARE still copying (newest landed ${objectAge.toFixed(0)}h ago) but no run has completed ` +
        `cleanly for ${heartbeatAge.toFixed(0)}h, so some files are failing while the rest mirror fine. ` +
        `Check /home/ubuntu/cron-dr-uploads-sync.log on the box for the failing object.`,
    };
  }

  return {
    kind: "nothing-arriving",
    detail:
      `Expected within ${row.staleAfterHours}h; newest is ` +
      `${row.ageHours == null ? "missing" : `${row.ageHours.toFixed(0)}h old`}. ` +
      `A restore needs ALL three streams.`,
  };
}
