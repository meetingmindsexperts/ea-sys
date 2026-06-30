// Shared config + helpers for the EA-SYS k6 load tests.
//
// Everything is env-driven so the same scripts run against localhost, a staging
// box, or (read-only scenarios only) production off-hours. See docs/LOAD_TESTING.md
// for the safety rules — DO NOT run the write scenarios against prod with a real
// event.

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3113').replace(/\/$/, '');
export const EVENT_SLUG = __ENV.EVENT_SLUG || '';
export const EVENT_ID = __ENV.EVENT_ID || '';
export const TICKET_TYPE_ID = __ENV.TICKET_TYPE_ID || '';
export const SESSION_COOKIE = __ENV.SESSION_COOKIE || '';
// Comma-separated list of real qrCodes from seeded test registrations (check-in).
export const QRCODES = (__ENV.QRCODES || '').split(',').map((s) => s.trim()).filter(Boolean);

// Hard gate for any scenario that WRITES (creates registrations, checks people
// in, hits Stripe). Refuses to run unless the operator sets CONFIRM_WRITE=yes,
// so a write test can never fire by accident against the wrong BASE_URL.
export function assertWriteAllowed(scenario) {
  if (__ENV.CONFIRM_WRITE !== 'yes') {
    throw new Error(
      `[${scenario}] This scenario WRITES data. Refusing to run.\n` +
        `Set CONFIRM_WRITE=yes AND point BASE_URL at staging or a disposable DRAFT ` +
        `test event (never a real prod event). See docs/LOAD_TESTING.md §Safety.`,
    );
  }
  if (/events\.meetingmindsgroup\.com/.test(BASE_URL) && __ENV.I_REALLY_MEAN_PROD !== 'yes') {
    throw new Error(
      `[${scenario}] BASE_URL points at PRODUCTION and this scenario writes. ` +
        `That creates real rows / emails / Stripe sessions. If you truly intend a ` +
        `disposable test event on prod, also set I_REALLY_MEAN_PROD=yes and use a ` +
        `FREE ticket type (no emails, no Stripe). Strongly prefer staging.`,
    );
  }
}

export function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env ${name} — see loadtest/README.md`);
  return val;
}

// Unique, guaranteed-undeliverable email per iteration. The `.invalid` TLD
// (RFC 2606) can never resolve, so even if a send were attempted it can't reach a
// real inbox — but you should still use a FREE ticket type so NO email is sent at
// all (the confirmation email is gated on price > 0).
export function uniqueEmail() {
  return `loadtest+${__VU}-${__ITER}-${Date.now()}@loadtest.invalid`;
}

// Standard thresholds — a run "passes" if these hold. Tune per event.
export const commonThresholds = {
  http_req_failed: ['rate<0.02'], // < 2% transport/5xx failures
  http_req_duration: ['p(95)<1000', 'p(99)<2500'], // p95 < 1s, p99 < 2.5s
};
