// webinar-chat — the attendee chat on a live webinar (Nov 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md
// §6.5 step 4): every viewer polls GET .../chat every 3 s following its cursor, as the page does,
// while a few post. Answers whether the cached polling holds at a webinar-sized audience: latency,
// errors, and (read separately from Postgres) how often polls actually reach the database.
//
// ⚠️  WRITE: posters create WebinarChatMessage rows. Run against a local or staging copy with a
//     disposable webinar whose chat is switched on and whose room is open, and delete the rows
//     afterwards. Never against a real webinar.
//
// Viewers need their own signed-in sessions (the route caches who a viewer is per person, and
// limits polls per person), one cookie per line in COOKIES_FILE (`name=value`), e.g. produced by
// signing in seeded test registrants.
//
// Run:
//   k6 run \
//     -e BASE_URL=http://localhost:3199 \
//     -e EVENT_SLUG=test-webinar-8 -e SESSION_ID=<anchor session id> \
//     -e COOKIES_FILE=/path/cookies.txt -e VIEWERS=500 -e POSTERS=20 -e DURATION=3m \
//     -e CONFIRM_WRITE=yes \
//     loadtest/k6/webinar-chat.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, EVENT_SLUG, assertWriteAllowed, requireEnv } from './config.js';

const SESSION_ID = __ENV.SESSION_ID || '';
const VIEWERS = Number(__ENV.VIEWERS || 500);
const POSTERS = Number(__ENV.POSTERS || 20);
const DURATION = __ENV.DURATION || '3m';
const COOKIES = open(requireEnv('COOKIES_FILE', __ENV.COOKIES_FILE))
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

const pollTime = new Trend('chat_poll_ms', true);
const postTime = new Trend('chat_post_ms', true);
const posted = new Counter('chat_posted');
const throttled = new Counter('chat_throttled');
const delivered = new Counter('chat_messages_delivered');

export const options = {
  scenarios: {
    viewers: {
      executor: 'constant-vus',
      vus: VIEWERS,
      duration: DURATION,
      exec: 'viewer',
    },
    posters: {
      executor: 'constant-vus',
      vus: POSTERS,
      duration: DURATION,
      exec: 'poster',
      startTime: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    chat_poll_ms: ['p(95)<300', 'p(99)<800'],
    chat_post_ms: ['p(95)<800'],
  },
};

export function setup() {
  assertWriteAllowed('webinar-chat');
  requireEnv('EVENT_SLUG', EVENT_SLUG);
  requireEnv('SESSION_ID', SESSION_ID);
  if (COOKIES.length < VIEWERS + POSTERS) {
    throw new Error(`COOKIES_FILE has ${COOKIES.length} sessions; VIEWERS + POSTERS = ${VIEWERS + POSTERS} people are needed`);
  }
}

const chatUrl = () => `${BASE_URL}/api/public/events/${EVENT_SLUG}/sessions/${SESSION_ID}/chat`;
// Each VU is one person: k6 numbers VUs across both scenarios, so viewers are people 1..VIEWERS
// and posters the next POSTERS.
const cookieFor = (vu) => COOKIES[vu - 1];

// Per-VU state survives iterations (module scope is per VU in k6).
let after = null;
let version = null;

export function viewer() {
  const q = [];
  if (after) q.push(`after=${encodeURIComponent(after)}`);
  if (version !== null) q.push(`v=${version}`);
  const res = http.get(q.length ? `${chatUrl()}?${q.join('&')}` : chatUrl(), {
    headers: { Cookie: cookieFor(__VU) },
    tags: { name: 'chat-poll' },
  });
  pollTime.add(res.timings.duration);
  const ok = check(res, { 'poll 200': (r) => r.status === 200 });
  if (ok) {
    const body = res.json();
    if (typeof body.version === 'number') version = body.version;
    const msgs = body.messages || [];
    delivered.add(msgs.length);
    if (msgs.length) after = msgs[msgs.length - 1].id;
  }
  sleep(3);
}

export function poster() {
  const res = http.post(
    chatUrl(),
    JSON.stringify({ body: `load test message from VU ${__VU} at ${Date.now()}`, anonymous: __ITER % 2 === 0 }),
    {
      headers: { Cookie: cookieFor(__VU), 'Content-Type': 'application/json', Origin: BASE_URL },
      tags: { name: 'chat-post' },
    },
  );
  postTime.add(res.timings.duration);
  if (res.status === 429) throttled.add(1);
  check(res, { 'post 201 or 429': (r) => r.status === 201 || r.status === 429 });
  if (res.status === 201) posted.add(1);
  // About one message every 6 s per poster: 20 posters ≈ 200 messages a minute, a busy chat.
  sleep(5 + Math.random() * 2);
}
