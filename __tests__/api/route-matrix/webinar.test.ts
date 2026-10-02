/**
 * Route status matrix, domain 9 of the Phase 2 sweep: the webinar console
 * (settings, provisioning, room, live stream, sequence, panelists, questions,
 * presence, attendance, engagement, recording) and a session's Zoom meeting
 * and panelists, plus the event's Zoom settings. Recorded on the unswept code
 * (Oct 2, 2026); the sweep onto `requirePermission` must leave it byte for
 * byte unchanged except where a change is intended and reviewed. See
 * ./harness.ts for what a cell means.
 *
 * One intended change, re-recorded on purpose: the attendance CSV (every
 * attendee's email) needs `webinar.attendance.export`, so Member and Onsite
 * get 403 where they downloaded it before (owner, Oct 2, 2026).
 *
 * Every network call fails here (`fetch` is stubbed to throw) and the email
 * sender is mocked, so nothing can reach Zoom, the stream server or a mailbox.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({
  validateApiKey: (await import("./harness")).mockValidateApiKey,
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async () => ({ success: true, messageId: "matrix" })),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as webinarGET, PUT as webinarPUT, POST as webinarPOST } from "@/app/api/events/[eventId]/webinar/route";
import { GET as attendanceGET, POST as attendancePOST } from "@/app/api/events/[eventId]/webinar/attendance/route";
import { GET as engagementGET, POST as engagementPOST } from "@/app/api/events/[eventId]/webinar/engagement/route";
import { GET as livestreamGET, POST as livestreamPOST } from "@/app/api/events/[eventId]/webinar/livestream/route";
import { POST as resendPOST } from "@/app/api/events/[eventId]/webinar/panelists/[panelistId]/resend/route";
import { GET as panelistsGET, POST as panelistsPOST, DELETE as panelistsDELETE } from "@/app/api/events/[eventId]/webinar/panelists/route";
import { POST as syncSpeakersPOST } from "@/app/api/events/[eventId]/webinar/panelists/sync-speakers/route";
import { GET as presenceGET } from "@/app/api/events/[eventId]/webinar/presence/route";
import { GET as questionsGET, PATCH as questionsPATCH } from "@/app/api/events/[eventId]/webinar/questions/route";
import { POST as recordingPOST } from "@/app/api/events/[eventId]/webinar/recording/fetch/route";
import { POST as roomPOST } from "@/app/api/events/[eventId]/webinar/room/route";
import { GET as sequenceGET, POST as sequencePOST } from "@/app/api/events/[eventId]/webinar/sequence/route";
import { GET as zoomSettingsGET, PUT as zoomSettingsPUT } from "@/app/api/events/[eventId]/zoom/settings/route";
import {
  GET as sessionZoomGET,
  POST as sessionZoomPOST,
  PUT as sessionZoomPUT,
  DELETE as sessionZoomDELETE,
} from "@/app/api/events/[eventId]/sessions/[sessionId]/zoom/route";
import {
  GET as sessionPanelistsGET,
  POST as sessionPanelistsPOST,
  DELETE as sessionPanelistsDELETE,
} from "@/app/api/events/[eventId]/sessions/[sessionId]/zoom/panelists/route";

const sess = { sessionId: "s1" };

const CASES: HandlerCase[] = [
  { name: "GET webinar", handler: webinarGET, method: "GET" },
  { name: "PUT webinar", handler: webinarPUT, method: "PUT", body: { waitingRoom: true } },
  { name: "POST webinar (provision)", handler: webinarPOST, method: "POST", body: {} },
  { name: "GET webinar/attendance", handler: attendanceGET, method: "GET" },
  { name: "GET webinar/attendance (csv)", handler: attendanceGET, method: "GET", query: "export=csv" },
  { name: "POST webinar/attendance (sync)", handler: attendancePOST, method: "POST", body: {} },
  { name: "GET webinar/engagement", handler: engagementGET, method: "GET" },
  { name: "POST webinar/engagement (sync)", handler: engagementPOST, method: "POST", body: {} },
  { name: "GET webinar/livestream", handler: livestreamGET, method: "GET" },
  { name: "POST webinar/livestream", handler: livestreamPOST, method: "POST", body: { action: "sync" } },
  { name: "GET webinar/panelists", handler: panelistsGET, method: "GET" },
  { name: "POST webinar/panelists", handler: panelistsPOST, method: "POST", body: { name: "Pat Panel", email: "pat@test.local" } },
  { name: "DELETE webinar/panelists", handler: panelistsDELETE, method: "DELETE", query: "panelistId=p1" },
  { name: "POST webinar/panelists/[panelistId]/resend", handler: resendPOST, method: "POST", params: { panelistId: "p1" }, body: {} },
  { name: "POST webinar/panelists/sync-speakers", handler: syncSpeakersPOST, method: "POST", body: {} },
  { name: "GET webinar/presence", handler: presenceGET, method: "GET" },
  { name: "GET webinar/questions", handler: questionsGET, method: "GET" },
  { name: "PATCH webinar/questions", handler: questionsPATCH, method: "PATCH", body: { id: "q1", status: "ANSWERED" } },
  { name: "POST webinar/recording/fetch", handler: recordingPOST, method: "POST", body: {} },
  { name: "POST webinar/room", handler: roomPOST, method: "POST", body: { open: true } },
  { name: "GET webinar/sequence", handler: sequenceGET, method: "GET" },
  { name: "POST webinar/sequence", handler: sequencePOST, method: "POST", body: {} },
  { name: "GET zoom/settings", handler: zoomSettingsGET, method: "GET" },
  { name: "PUT zoom/settings", handler: zoomSettingsPUT, method: "PUT", body: { enabled: true } },
  { name: "GET sessions/[sessionId]/zoom", handler: sessionZoomGET, method: "GET", params: sess },
  { name: "POST sessions/[sessionId]/zoom", handler: sessionZoomPOST, method: "POST", params: sess, body: {} },
  { name: "PUT sessions/[sessionId]/zoom", handler: sessionZoomPUT, method: "PUT", params: sess, body: { waitingRoom: true } },
  { name: "DELETE sessions/[sessionId]/zoom", handler: sessionZoomDELETE, method: "DELETE", params: sess },
  { name: "GET sessions/[sessionId]/zoom/panelists", handler: sessionPanelistsGET, method: "GET", params: sess },
  { name: "POST sessions/[sessionId]/zoom/panelists", handler: sessionPanelistsPOST, method: "POST", params: sess, body: {} },
  { name: "DELETE sessions/[sessionId]/zoom/panelists", handler: sessionPanelistsDELETE, method: "DELETE", params: sess, query: "panelistId=p1" },
];

describe("route status matrix: webinar", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("webinar", CASES)).toMatchFileSnapshot("./__snapshots__/webinar.matrix.txt");
  });
});
