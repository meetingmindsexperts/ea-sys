// checkin-burst — WRITE scenario simulating many desk lanes scanning at once:
//   PUT /api/events/{eventId}/registrations/{any}/check-in   body { qrCode }
//
// The check-in endpoint is AUTHENTICATED (session, ONSITE/MEMBER/ORGANIZER), so you
// must supply a valid NextAuth session cookie. It resolves the registration by the
// `qrCode` in the BODY (path id is a placeholder), matching qrCode OR dtcmBarcode.
//
// ⚠️  WRITE: it stamps checkedInAt on real registrations. Run against staging or a
//     disposable test event whose registrations you seeded (e.g. via register-burst).
//     The first scan of each code checks it in; re-scans return "already checked in"
//     (still a successful, idempotent-ish call — fine for load).
//
// Get a session cookie: log in as an ONSITE/admin user, open DevTools → Application
// → Cookies, copy the value of `__Secure-next-auth.session-token` (or
// `next-auth.session-token` on http). Pass the full `name=value` string as SESSION_COOKIE.
//
// Get qrCodes: from the seeded test registrations (DB, or the registrations list).
//
// Run:
//   k6 run \
//     -e BASE_URL=https://staging.example.com \
//     -e EVENT_ID=ckEvent \
//     -e SESSION_COOKIE='__Secure-next-auth.session-token=eyJ...' \
//     -e QRCODES=code1,code2,code3,...  \
//     -e CONFIRM_WRITE=yes \
//     loadtest/k6/checkin-burst.js

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import {
  BASE_URL,
  EVENT_ID,
  SESSION_COOKIE,
  QRCODES,
  commonThresholds,
  requireEnv,
  assertWriteAllowed,
} from './config.js';

const scanned = new Counter('checkins_ok');
const notFound = new Counter('checkins_404');
const okRate = new Rate('checks_ok');

export const options = {
  scenarios: {
    checkin_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 }, // ~10 desk lanes
        { duration: '45s', target: 30 }, // peak doors-open rush
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: commonThresholds,
};

export function setup() {
  assertWriteAllowed('checkin-burst');
  requireEnv('EVENT_ID', EVENT_ID);
  requireEnv('SESSION_COOKIE', SESSION_COOKIE);
  if (QRCODES.length === 0) throw new Error('Missing QRCODES (comma-separated). See header.');
}

export default function checkinBurst() {
  const qrCode = QRCODES[(__VU + __ITER) % QRCODES.length];
  const res = http.put(
    `${BASE_URL}/api/events/${EVENT_ID}/registrations/scan/check-in`,
    JSON.stringify({ qrCode }),
    {
      headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIE },
      tags: { name: 'check-in' },
    },
  );

  if (res.status === 200) scanned.add(1);
  if (res.status === 404) notFound.add(1);
  if (res.status === 401 && __ITER === 0) console.error('check-in 401 — SESSION_COOKIE invalid/expired');

  okRate.add(
    check(res, {
      // 200 = checked in; 400 = already checked in (still a healthy round-trip).
      'check-in handled (200/400)': (r) => r.status === 200 || r.status === 400,
    }),
  );
}
