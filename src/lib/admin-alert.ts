/**
 * Generic admin alert helper — push a short email to the operator(s)
 * whenever the system needs to escalate beyond logs.
 *
 * Two callers today:
 *   - `notifyAdminOfSendFailure` in src/lib/email.ts — fires whenever
 *     `sendEmail()` itself fails (the original use case from
 *     commit e60cb65). Carries rich per-email context.
 *   - `withAdminAlertForwarding` in src/lib/logger.ts — fires whenever
 *     ANY `apiLogger.error()` is called. Carries module + message
 *     context.
 *
 * Both share the same dedupe map + the same recipient-self recursion
 * guard so a flood of errors → one alert per (dedupKey) per hour,
 * regardless of which caller produces them.
 *
 * Why a separate file: src/lib/email.ts already imports from
 * src/lib/logger.ts (apiLogger). If logger.ts then imported from
 * email.ts (for the alert wiring), we'd have a circular module-init
 * dependency that breaks under Node's CJS loader and tsx. This file
 * has NO static imports from either; it lazy-imports `sendEmail` so
 * the cycle is broken at runtime.
 *
 * Side-effect-free at module load: just exports + initializes the
 * dedupe map. No SES client init, no DB calls.
 */

export const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ALERT_DEDUP_MAX_KEYS = 200;

/**
 * Global budget: at most this many alert emails per rolling hour, across ALL
 * fingerprints and ALL containers. On the hour a broad incident produces 50
 * distinct fingerprints, you want one page and a look at /logs — not 50 emails
 * that bury the one that matters.
 *
 * Deliberately generous. The operator's stated preference is to be over-alerted
 * rather than under-alerted, so this is a backstop against a pathological storm,
 * not a noise-reduction dial. When the budget is exhausted we send exactly one
 * more email saying so, then go quiet until the window rolls.
 */
const ALERT_HOURLY_CEILING = Number(process.env.ALERT_HOURLY_CEILING ?? 30);

const CEILING_KEY = "__ceiling__";
const SILENCE_KEY = "__silence__";

/**
 * In-memory fallback dedupe, used ONLY when the database is unreachable.
 *
 * This matters more than it looks: a DB outage is exactly when errors storm,
 * and if the dedup claim itself needs the DB then a DB outage would silence
 * the alerting pipeline at the moment you most need it. So the DB path is the
 * primary (atomic, shared, survives restarts) and this degraded per-process map
 * is the fallback — noisier, but noisy beats silent.
 */
const memoryLastSentAt = new Map<string, number>();

function memoryShouldSend(dedupKey: string): boolean {
  const now = Date.now();
  const last = memoryLastSentAt.get(dedupKey);
  if (last !== undefined && now - last < ALERT_DEDUP_WINDOW_MS) return false;
  if (memoryLastSentAt.size >= ALERT_DEDUP_MAX_KEYS) {
    const oldestKey = memoryLastSentAt.keys().next().value;
    if (oldestKey !== undefined) memoryLastSentAt.delete(oldestKey);
  }
  memoryLastSentAt.set(dedupKey, now);
  return true;
}

/** Exported for tests + for callers that want a cheap pre-check. */
export function shouldSendAdminAlert(dedupKey: string): boolean {
  return memoryShouldSend(dedupKey);
}

export interface AlertClaim {
  /** Whether this process won the right to send the email. */
  send: boolean;
  /** Occurrences of this fingerprint suppressed since the last email. */
  suppressed: number;
  /** True when this send is the "budget exhausted" digest, not a real alert. */
  ceilingDigest?: boolean;
}

/**
 * Atomically claim the right to send an alert for `dedupKey`.
 *
 * The whole thing is one conditional upsert per step, so two containers racing
 * on the same fingerprint cannot both win — Postgres arbitrates. `ON CONFLICT
 * DO UPDATE ... WHERE` updates (and returns a row) only when the guard holds;
 * when it doesn't, we get zero rows back and know we were beaten to it.
 *
 * Never throws. On any DB failure it degrades to the in-memory map and still
 * lets the alert through (see memoryLastSentAt above).
 */
export async function claimAlertSend(dedupKey: string): Promise<AlertClaim> {
  try {
    const { db } = await import("./db");

    // ── 0. Operator silence window ────────────────────────────────────────
    // Env var is the break-glass (needs a restart); the DB row is the one an
    // on-call engineer can flip from /admin/infra while they fix the thing
    // that is paging them. Nobody should be emailed by their own remediation.
    const envSilencedUntil = process.env.ALERTS_SILENCED_UNTIL;
    if (envSilencedUntil && new Date(envSilencedUntil).getTime() > Date.now()) {
      return { send: false, suppressed: 0 };
    }
    const silence = await db.alertState.findUnique({ where: { key: SILENCE_KEY } });
    if (silence?.silencedUntil && silence.silencedUntil.getTime() > Date.now()) {
      return { send: false, suppressed: 0 };
    }

    // ── 1. Record the occurrence (always) ─────────────────────────────────
    // Runs even when we end up suppressing, so the eventual email can say
    // "this has fired 240 times in the last hour" — the single most useful
    // number in the whole message, and the one the old pipeline never had.
    const occurrence = await db.$queryRaw<Array<{ counter: number }>>`
      INSERT INTO "AlertState" ("key", "lastSentAt", "windowStartedAt", "counter", "updatedAt")
      VALUES (${dedupKey}, to_timestamp(0), now(), 1, now())
      ON CONFLICT ("key") DO UPDATE
        SET "counter" = "AlertState"."counter" + 1,
            "updatedAt" = now()
      RETURNING "counter"
    `;
    const suppressed = Math.max(0, (occurrence[0]?.counter ?? 1) - 1);

    // ── 2. Claim the per-fingerprint hourly slot ──────────────────────────
    const windowSeconds = ALERT_DEDUP_WINDOW_MS / 1000;
    const claimed = await db.$queryRaw<Array<{ key: string }>>`
      UPDATE "AlertState"
         SET "lastSentAt" = now(),
             "counter" = 0,
             "updatedAt" = now()
       WHERE "key" = ${dedupKey}
         AND "lastSentAt" < now() - make_interval(secs => ${windowSeconds}::double precision)
      RETURNING "key"
    `;
    if (claimed.length === 0) {
      return { send: false, suppressed };
    }

    // ── 3. Spend from the global hourly budget ────────────────────────────
    const budget = await db.$queryRaw<Array<{ counter: number }>>`
      INSERT INTO "AlertState" ("key", "lastSentAt", "windowStartedAt", "counter", "updatedAt")
      VALUES (${CEILING_KEY}, now(), now(), 1, now())
      ON CONFLICT ("key") DO UPDATE
        SET "windowStartedAt" = CASE
              WHEN "AlertState"."windowStartedAt" < now() - interval '1 hour' THEN now()
              ELSE "AlertState"."windowStartedAt" END,
            "counter" = CASE
              WHEN "AlertState"."windowStartedAt" < now() - interval '1 hour' THEN 1
              ELSE "AlertState"."counter" + 1 END,
            "updatedAt" = now()
      RETURNING "counter"
    `;
    const spent = budget[0]?.counter ?? 1;

    if (spent > ALERT_HOURLY_CEILING + 1) {
      // Budget blown and the digest has already gone out. Stay quiet.
      return { send: false, suppressed };
    }
    if (spent === ALERT_HOURLY_CEILING + 1) {
      // The one email that tells you we're going quiet, so silence is never
      // mistaken for health.
      return { send: true, suppressed, ceilingDigest: true };
    }

    return { send: true, suppressed };
  } catch {
    // DB unreachable — degrade, don't go silent. See memoryLastSentAt.
    return { send: memoryShouldSend(dedupKey), suppressed: 0 };
  }
}

/**
 * Silence all admin alerts until `until` (or lift the silence with null).
 * Backs the "Silence alerts" control on /admin/infra.
 */
export async function setAlertSilence(until: Date | null): Promise<void> {
  const { db } = await import("./db");
  await db.alertState.upsert({
    where: { key: SILENCE_KEY },
    create: { key: SILENCE_KEY, silencedUntil: until },
    update: { silencedUntil: until },
  });
}

/** Current silence window, or null when alerting is live. */
export async function getAlertSilence(): Promise<Date | null> {
  try {
    const { db } = await import("./db");
    const row = await db.alertState.findUnique({ where: { key: SILENCE_KEY } });
    if (!row?.silencedUntil) return null;
    return row.silencedUntil.getTime() > Date.now() ? row.silencedUntil : null;
  } catch {
    return null;
  }
}

export interface AdminAlertInput {
  /** Subject line — keep short, the body carries the detail. */
  subject: string;
  /** Plain-text body — rendered as `<pre>` in the HTML mirror so any
   *  newlines or column alignment is preserved in email clients. */
  body: string;
  /** Stable key used to dedupe. Same key within 1h = no new alert. */
  dedupKey: string;
  /**
   * Optional detail line — surfaced as `Detail: ...` in the email body
   * just below the message. Used by the logger forwarder to carry the
   * actual underlying error text when the structured `msg` field is a
   * generic title (e.g. "Prisma error" without classification — the
   * real error message was previously dropped from the alert body).
   */
  detail?: string;
  /**
   * Search term to pre-fill the /logs deep link with. The old alert body
   * literally said "open /logs in the dashboard or Sentry for the full
   * picture" and then included a link to neither — so acting on an alert meant
   * opening a laptop, guessing the time range and guessing the search term.
   */
  logsSearch?: string;
  /** Sentry event id, when the caller captured one — becomes a direct link. */
  sentryEventId?: string;
  /** Optional pointer into /admin/docs for a known failure mode. */
  runbook?: string;
}

/**
 * Decide whether this process should fire admin alerts at all.
 *
 * Rules (in order):
 *   1. NODE_ENV=production → ALWAYS fire (the load-bearing case;
 *      no opt-out, dev never gates the prod alert pipeline)
 *   2. Otherwise → only fire when ENABLE_ADMIN_ALERTS=true (explicit
 *      opt-in for dev/staging when an engineer is intentionally
 *      testing the alert wiring)
 *   3. Otherwise → skip, no SES call, no console noise
 *
 * Closes the dev-spam gap: pre-fix, a Prisma blip on a local
 * `npm run dev` would email the prod alert inbox because there
 * was no env gate. Now dev needs to opt in.
 */
export function shouldFireInThisEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.ENABLE_ADMIN_ALERTS === "true";
}

/**
 * Send an admin alert email via SES. Honors the dedupe map + the
 * recipient-self guard. Fire-and-forget from callers — failures of
 * the alert send itself log to console.error (last-resort, since the
 * caller might BE the apiLogger.error path that just decided to fire
 * this alert in the first place).
 *
 * No-throw guarantee: this function never throws. All paths return
 * cleanly so callers can `void notifyAdminAlert(...)` without a
 * .catch() block and without poisoning the calling tick.
 */
export async function notifyAdminAlert(input: AdminAlertInput): Promise<void> {
  try {
    // Environment gate — skip silently when in non-production without
    // explicit opt-in. See shouldFireInThisEnvironment() above for the
    // policy. Returns BEFORE the dedupe map updates so a dev-mode
    // run doesn't pollute the dedupe state of a subsequent prod run
    // (matters when ENABLE_ADMIN_ALERTS gets toggled mid-process,
    // rare but worth getting right).
    if (!shouldFireInThisEnvironment()) {
      return;
    }

    const alertFrom = (
      process.env.ALERT_EMAIL_FROM ?? "alerts@meetingmindsexperts.com"
    ).trim();
    const alertToRaw = (
      process.env.ALERT_EMAIL_TO ?? "krishna@meetingmindsdubai.com"
    ).trim();
    const alertTo = alertToRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (alertTo.length === 0) return;

    const claim = await claimAlertSend(input.dedupKey);
    if (!claim.send) {
      return;
    }

    const body = `${input.body}\n${await buildActionFooter(input, claim)}`;
    const subject = claim.ceilingDigest
      ? `${input.subject} — ⚠ ALERT BUDGET EXHAUSTED, going quiet`
      : input.subject;

    // Lazy import — breaks the email.ts ↔ logger.ts ↔ admin-alert.ts
    // circular import at module-init time. Resolution happens once
    // per process, then is module-cached.
    const { sendEmail } = await import("./email");

    await sendEmail({
      to: alertTo.map((email) => ({ email })),
      from: { email: alertFrom, name: "EA-SYS Alerts" },
      subject,
      htmlContent: `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap; font-size: 13px; line-height: 1.4;">${escapeAlertHtml(body)}</pre>`,
      textContent: body,
      emailType: "admin_alert",
      stream: "transactional",
      // No logContext: this is an out-of-band administrative ping, not
      // an entity-bound email.
    });
  } catch (alertErr) {
    // Last-resort logging — we cannot use apiLogger here because that
    // would re-enter the very hook that called us (createLogger →
    // .error() → forwardToAdminAlert → notifyAdminAlert → fails →
    // apiLogger.error → forwardToAdminAlert → recursion). console.error
    // bypasses the logger pipeline entirely.
    //
    // The cost: this line lands as a Docker stdout entry, NOT as a
    // SystemLog row + /logs viewer entry. Acceptable trade-off for
    // a recursion-safety guarantee.
    console.error("admin-alert:notify-failed", alertErr);
  }
}

/**
 * The part of the email you can actually act on.
 *
 * Before this, the body ended with the line "open /logs in the dashboard or
 * Sentry for the full picture" — and contained a link to neither, no SHA, no
 * host, and no idea whether this had happened once or four thousand times. At
 * 3am on a phone that is a notification, not an alert.
 *
 * build-info is imported lazily on purpose: it reads `os.hostname()`, and
 * admin-alert.ts is reachable from logger.ts which is reachable from client
 * components. A static `import os` would be bundled as `undefined` for the
 * browser and blow up at runtime with no log line — the exact failure class
 * that bit us in the survey builder.
 */
async function buildActionFooter(input: AdminAlertInput, claim: AlertClaim): Promise<string> {
  const { buildInfoLine, appBaseUrl, getBuildInfo } = await import("./build-info");
  const base = appBaseUrl();
  const build = getBuildInfo();

  const lines: string[] = ["", "── What to do ──"];

  const search = input.logsSearch ?? input.subject;
  lines.push(
    `Logs:    ${base}/logs?level=error&search=${encodeURIComponent(search.slice(0, 120))}`
  );

  if (input.sentryEventId) {
    lines.push(`Sentry:  event ${input.sentryEventId}`);
  }
  if (input.runbook) {
    lines.push(`Runbook: ${base}/admin/docs?path=${encodeURIComponent(input.runbook)}`);
  }
  lines.push(`Health:  ${base}/api/health   ·   Worker: ${base}/worker/health`);
  lines.push(`Infra:   ${base}/admin/infra`);

  lines.push("");
  if (claim.suppressed > 0) {
    lines.push(
      `Occurrences: this fingerprint fired ${claim.suppressed + 1} times in the last hour ` +
        `(${claim.suppressed} suppressed).`
    );
  } else {
    lines.push("Occurrences: first time this hour.");
  }

  if (claim.ceilingDigest) {
    lines.push("");
    lines.push(
      `⚠ The hourly alert budget (${ALERT_HOURLY_CEILING}) is now spent. Further alerts are ` +
        `SUPPRESSED until the window rolls. This is a broad incident, not a single error — ` +
        `go to /logs and /admin/infra rather than waiting for more email.`
    );
  }

  lines.push("");
  lines.push(`Running: ${buildInfoLine()}${build.builtAt ? ` · built ${build.builtAt}` : ""}`);
  lines.push(`Silence alerts while you fix this: ${base}/admin/infra`);
  lines.push("--");
  lines.push("ea-sys automated alert");

  return lines.join("\n");
}

function escapeAlertHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Recipient self-guard ──────────────────────────────────────────────
// Exported as a pure check so callers can decide BEFORE building the
// full body whether to attempt an alert. Saves the body-build cost on
// every email-related send to the alert address itself.

export function isAlertSelfRecipient(recipientEmail: string): boolean {
  const alertToRaw = (
    process.env.ALERT_EMAIL_TO ?? "krishna@meetingmindsdubai.com"
  ).trim();
  const alertTo = alertToRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return alertTo.includes(recipientEmail.toLowerCase());
}
