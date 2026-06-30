// read-burst — SAFE on production (off-hours). No writes, no emails, no Stripe.
//
// Hammers the two public READ paths an attendee hits before registering:
//   1. GET  /api/public/events/{slug}        (the registration page's data load)
//   2. POST /api/public/events/{slug}/check-email  (the "already registered?" preflight)
// Validates: single-box request throughput, DB read latency under concurrency,
// and where the per-IP rate limits start returning 429.
//
// IMPORTANT — single-IP caveat: all traffic from one machine shares one client
// IP, so the per-IP rate limits (check-email 200/hr) WILL trip and you'll measure
// the limiter, not raw box capacity. To measure the box itself, either run from an
// allowlisted IP / the box's own network, temporarily raise the limit, or use
// distributed k6 (k6 cloud). The 429 counter below tells you when the limit hit.
//
// Run:
//   k6 run -e BASE_URL=https://staging.example.com -e EVENT_SLUG=my-event loadtest/k6/read-burst.js
//
// Tune the load with the stages below or override VUs/duration on the CLI.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE_URL, EVENT_SLUG, commonThresholds, requireEnv } from './config.js';

const rateLimited = new Counter('rate_limited_429');
const okRate = new Rate('checks_ok');

export const options = {
  scenarios: {
    read_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 }, // ramp to 50 concurrent
        { duration: '1m', target: 200 }, // burst to 200
        { duration: '30s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: commonThresholds,
};

export default function () {
  requireEnv('EVENT_SLUG', EVENT_SLUG);

  // 1) Public event detail — the heaviest read on the register page.
  const detail = http.get(`${BASE_URL}/api/public/events/${EVENT_SLUG}`, {
    tags: { name: 'public-event-detail' },
  });
  if (detail.status === 429) rateLimited.add(1);
  okRate.add(
    check(detail, { 'event detail 200': (r) => r.status === 200 || r.status === 429 }),
  );

  // 2) Email preflight — non-mutating; reports {exists} for a random address.
  const email = `loadtest+${__VU}-${__ITER}-${Date.now()}@loadtest.invalid`;
  const pre = http.post(
    `${BASE_URL}/api/public/events/${EVENT_SLUG}/check-email`,
    JSON.stringify({ email }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'check-email' } },
  );
  if (pre.status === 429) rateLimited.add(1);
  okRate.add(check(pre, { 'check-email 200/429': (r) => r.status === 200 || r.status === 429 }));

  sleep(Math.random() * 0.5); // small think time
}
