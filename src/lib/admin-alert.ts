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

const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ALERT_DEDUP_MAX_KEYS = 200;
const lastSentAt = new Map<string, number>();

/**
 * In-memory dedupe check. Returns true (caller should send) when the
 * key has either never fired or fired more than ALERT_DEDUP_WINDOW_MS
 * ago. Updates lastSentAt as a side effect on send.
 *
 * Map is bounded — when full, oldest entry is evicted FIFO. For our
 * scale (a healthy day = 0 entries; a bad day = maybe 5-10 unique
 * fingerprints) the cap is very generous.
 */
export function shouldSendAdminAlert(dedupKey: string): boolean {
  const now = Date.now();
  const last = lastSentAt.get(dedupKey);
  if (last !== undefined && now - last < ALERT_DEDUP_WINDOW_MS) {
    return false;
  }
  if (lastSentAt.size >= ALERT_DEDUP_MAX_KEYS) {
    const oldestKey = lastSentAt.keys().next().value;
    if (oldestKey !== undefined) lastSentAt.delete(oldestKey);
  }
  lastSentAt.set(dedupKey, now);
  return true;
}

export interface AdminAlertInput {
  /** Subject line — keep short, the body carries the detail. */
  subject: string;
  /** Plain-text body — rendered as `<pre>` in the HTML mirror so any
   *  newlines or column alignment is preserved in email clients. */
  body: string;
  /** Stable key used to dedupe. Same key within 1h = no new alert. */
  dedupKey: string;
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

    if (!shouldSendAdminAlert(input.dedupKey)) {
      return;
    }

    // Lazy import — breaks the email.ts ↔ logger.ts ↔ admin-alert.ts
    // circular import at module-init time. Resolution happens once
    // per process, then is module-cached.
    const { sendEmail } = await import("./email");

    await sendEmail({
      to: alertTo.map((email) => ({ email })),
      from: { email: alertFrom, name: "EA-SYS Alerts" },
      subject: input.subject,
      htmlContent: `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap; font-size: 13px; line-height: 1.4;">${escapeAlertHtml(input.body)}</pre>`,
      textContent: input.body,
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
