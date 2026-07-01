// register-burst — WRITE scenario. Simulates a "registration opens" burst on the
// public self-register path: POST /api/public/events/{slug}/register.
//
// ⚠️  THIS CREATES REAL ROWS (User + Registration + Attendee). NEVER run against a
//     real production event. Use staging, or a disposable DRAFT test event you
//     delete afterward (deleting the event cascades the test registrations).
//     Use a FREE ticket type → no confirmation email is sent (gated on price > 0)
//     and no Stripe checkout is involved. The CONFIRM_WRITE / I_REALLY_MEAN_PROD
//     gates in config.js enforce this.
//
// Run (staging, free ticket type):
//   k6 run \
//     -e BASE_URL=https://staging.example.com \
//     -e EVENT_SLUG=loadtest-event \
//     -e TICKET_TYPE_ID=ckxxxx \
//     -e CONFIRM_WRITE=yes \
//     loadtest/k6/register-burst.js
//
// FIRST do a 1-VU smoke (set stages to target:1, 5s) and confirm you get a 200/201
// before ramping — the payload below must satisfy the event's current
// registrationSchema (required fields were tightened; adjust if your event differs).

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import {
  BASE_URL,
  EVENT_SLUG,
  TICKET_TYPE_ID,
  commonThresholds,
  requireEnv,
  uniqueEmail,
  assertWriteAllowed,
} from './config.js';

const created = new Counter('registrations_created');
const rateLimited = new Counter('rate_limited_429');
const validationFailed = new Counter('validation_400');
const okRate = new Rate('checks_ok');

export const options = {
  scenarios: {
    register_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 20 },
        { duration: '40s', target: 60 }, // sustained burst
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: commonThresholds,
};

export function setup() {
  assertWriteAllowed('register-burst');
  requireEnv('EVENT_SLUG', EVENT_SLUG);
  requireEnv('TICKET_TYPE_ID', TICKET_TYPE_ID);
}

export default function registerBurst() {
  const email = uniqueEmail();
  // Representative valid payload. Adjust fields to match your event's required
  // set (public registration requires title/role/names/email/jobTitle/
  // organization/city/phone/country/specialty, + customSpecialty when
  // specialty==="Others"). Use a non-"Others" specialty to skip that branch.
  const payload = {
    ticketTypeId: TICKET_TYPE_ID,
    title: 'MR',
    role: 'Delegate',
    firstName: 'Load',
    lastName: `Test${__VU}${__ITER}`,
    email,
    organization: 'Load Test Org',
    jobTitle: 'Tester',
    phone: '+10000000000',
    city: 'Testville',
    country: 'United Arab Emirates',
    specialty: 'Cardiology',
    password: 'LoadTest!2026',
    termsAccepted: true,
  };

  const res = http.post(
    `${BASE_URL}/api/public/events/${EVENT_SLUG}/register`,
    JSON.stringify(payload),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'public-register' } },
  );

  if (res.status === 429) rateLimited.add(1);
  if (res.status === 400) {
    validationFailed.add(1);
    // Surface the first validation failure so you can fix the payload fast.
    if (__ITER === 0) console.error(`register 400 body: ${res.body}`);
  }
  if (res.status === 200 || res.status === 201) created.add(1);

  okRate.add(
    check(res, {
      'register accepted (200/201) or limited (429)': (r) =>
        [200, 201, 429].includes(r.status),
    }),
  );
}
