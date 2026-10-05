/**
 * Route status matrix, domain 14 of the Phase 2 sweep (added Oct 5, 2026):
 * the event routes no other domain covers. Analytics, its CSV and check-in log
 * and the traffic view; the event activity feed; media; sponsors; clone; the
 * export bundle; the abstract, barcode, EventsAir, session and speaker
 * imports and the import log; the agreement PDF header and footer images; the
 * speaker agreement template; the event agent; the submitter's own context.
 * Recorded on the unswept code (Oct 5, 2026); the sweep onto
 * `requirePermission` must leave it byte for byte unchanged except where a
 * change is intended and reviewed. See ./harness.ts for what a cell means.
 *
 * Changes re-recorded on purpose (owner, Oct 5, 2026):
 *  - analytics, its CSV and per-attendee check-in log, the traffic view and
 *    the import log need `analytics.read`: REVIEWER, SUBMITTER and REGISTRANT
 *    read them on their linked events (another organisation's included)
 *    before, the gap DATA_EXPORTS.md recorded;
 *  - the speaker agreement template follows `speakers.read`: CRM_USER,
 *    HR_USER, ONSITE on unassigned events and WEBINARS on conferences read it
 *    before (an organisation-only lookup);
 *  - WEBINARS may run the speaker CSV import on webinars (`speakers.import`,
 *    which already let it import speakers from contacts and registrations).
 *
 * Every network call fails here (`fetch` is stubbed to throw), so neither
 * EventsAir nor a model provider is reachable.
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
import { GET as analyticsGET } from "@/app/api/events/[eventId]/analytics/route";
import { GET as trafficGET } from "@/app/api/events/[eventId]/analytics/traffic/route";
import { GET as activityGET } from "@/app/api/events/[eventId]/activity/route";
import { GET as mediaGET, POST as mediaPOST } from "@/app/api/events/[eventId]/media/route";
import { DELETE as mediaDELETE } from "@/app/api/events/[eventId]/media/[mediaId]/route";
import { GET as sponsorsGET, PUT as sponsorsPUT } from "@/app/api/events/[eventId]/sponsors/route";
import { POST as clonePOST } from "@/app/api/events/[eventId]/clone/route";
import { GET as bundleGET } from "@/app/api/events/[eventId]/export-bundle/route";
import { POST as importAbstractsPOST } from "@/app/api/events/[eventId]/import/abstracts/route";
import { POST as importBarcodesPOST } from "@/app/api/events/[eventId]/import/barcodes/route";
import { POST as importEventsAirPOST } from "@/app/api/events/[eventId]/import/eventsair/route";
import { POST as importSessionsPOST } from "@/app/api/events/[eventId]/import/sessions/route";
import { POST as importSpeakersPOST } from "@/app/api/events/[eventId]/import/speakers/route";
import { GET as importLogsGET } from "@/app/api/events/[eventId]/import-logs/route";
import { POST as pdfImagePOST, DELETE as pdfImageDELETE } from "@/app/api/events/[eventId]/agreement-pdf-images/route";
import {
  GET as agreementTplGET,
  POST as agreementTplPOST,
  DELETE as agreementTplDELETE,
} from "@/app/api/events/[eventId]/speaker-agreement-template/route";
import { POST as agentPOST } from "@/app/api/events/[eventId]/agent/execute/route";
import { GET as submitterCtxGET } from "@/app/api/events/[eventId]/submitter-context/route";

const json = (name: string, handler: HandlerCase["handler"], method: HandlerCase["method"], extra: Partial<HandlerCase> = {}): HandlerCase => ({
  name,
  handler,
  method,
  ...extra,
});

const CASES: HandlerCase[] = [
  json("GET analytics", analyticsGET, "GET"),
  json("GET analytics (csv)", analyticsGET, "GET", { query: "export=csv" }),
  json("GET analytics (check-in log)", analyticsGET, "GET", { query: "export=checkins" }),
  json("GET analytics/traffic", trafficGET, "GET"),
  json("GET activity", activityGET, "GET"),
  json("GET media", mediaGET, "GET"),
  json("POST media (JSON, not multipart)", mediaPOST, "POST", { body: {} }),
  json("DELETE media/[mediaId]", mediaDELETE, "DELETE", { params: { mediaId: "md1" } }),
  json("GET sponsors", sponsorsGET, "GET"),
  json("PUT sponsors", sponsorsPUT, "PUT", { body: { sponsors: [] } }),
  json("POST clone", clonePOST, "POST", { body: { includeSpeakers: false, includeAgenda: false } }),
  json("GET export-bundle", bundleGET, "GET"),
  json("POST import/abstracts (JSON, not multipart)", importAbstractsPOST, "POST", { body: {} }),
  json("POST import/barcodes (JSON, not multipart)", importBarcodesPOST, "POST", { body: {} }),
  json("POST import/eventsair", importEventsAirPOST, "POST", { body: { eventsAirEventId: "ea1" } }),
  json("POST import/sessions (JSON, not multipart)", importSessionsPOST, "POST", { body: {} }),
  json("POST import/speakers (JSON, not multipart)", importSpeakersPOST, "POST", { body: {} }),
  json("GET import-logs", importLogsGET, "GET"),
  json("POST agreement-pdf-images (JSON, not multipart)", pdfImagePOST, "POST", { body: {} }),
  json("DELETE agreement-pdf-images", pdfImageDELETE, "DELETE", { query: "scope=speaker&slot=header" }),
  json("GET speaker-agreement-template", agreementTplGET, "GET"),
  json("POST speaker-agreement-template (JSON, not multipart)", agreementTplPOST, "POST", { body: {} }),
  json("DELETE speaker-agreement-template", agreementTplDELETE, "DELETE"),
  json("POST agent/execute (empty body)", agentPOST, "POST", { body: {} }),
  json("GET submitter-context", submitterCtxGET, "GET"),
];

describe("route status matrix: remaining event routes", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("remaining event routes", CASES)).toMatchFileSnapshot("./__snapshots__/event-misc.matrix.txt");
  });
});
