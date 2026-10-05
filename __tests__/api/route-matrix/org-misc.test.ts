/**
 * Route status matrix, the organisation-level routes no domain covered:
 * email history and a stored email body, the organisation media library,
 * the PDF and photo uploads, the EventsAir event import, and the staff
 * profile. Recorded on the unswept code (Oct 5, 2026); the sweep onto
 * permission keys must leave it byte for byte unchanged except where a
 * change is intended and reviewed. See ./harness.ts for what a cell means.
 * None of these routes is under an event.
 *
 * Every network call fails here (`fetch` is stubbed to throw).
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

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as logsGET } from "@/app/api/email-logs/route";
import { GET as logBodyGET } from "@/app/api/email-logs/[emailLogId]/body/route";
import { GET as mediaGET, POST as mediaPOST } from "@/app/api/media/route";
import { DELETE as mediaDELETE } from "@/app/api/media/[mediaId]/route";
import { POST as pdfPOST } from "@/app/api/upload/pdf/route";
import { POST as photoPOST } from "@/app/api/upload/photo/route";
import { POST as eventsAirPOST } from "@/app/api/import/eventsair/route";
import { GET as profileGET, PATCH as profilePATCH } from "@/app/api/profile/route";

const org = { perEvent: false } as const;
const png = { name: "p.png", type: "image/png", content: "\x89PNG\r\n\x1a\nmatrix" };

const CASES: HandlerCase[] = [
  { name: "GET email-logs (REGISTRATION)", handler: logsGET, method: "GET", query: "entityType=REGISTRATION&entityId=r1", ...org },
  { name: "GET email-logs (SPEAKER)", handler: logsGET, method: "GET", query: "entityType=SPEAKER&entityId=sp1", ...org },
  { name: "GET email-logs (CONTACT)", handler: logsGET, method: "GET", query: "entityType=CONTACT&entityId=ct1", ...org },
  { name: "GET email-logs (USER)", handler: logsGET, method: "GET", query: "entityType=USER&entityId=u-admin", ...org },
  { name: "GET email-logs (OTHER)", handler: logsGET, method: "GET", query: "entityType=OTHER&entityId=x1", ...org },
  { name: "GET email-logs/[emailLogId]/body", handler: logBodyGET, method: "GET", params: { emailLogId: "el1" }, ...org },
  { name: "GET media", handler: mediaGET, method: "GET", ...org },
  { name: "POST media (png file)", handler: mediaPOST, method: "POST", form: { file: png }, ...org },
  { name: "DELETE media/[mediaId]", handler: mediaDELETE, method: "DELETE", params: { mediaId: "md1" }, ...org },
  { name: "POST upload/pdf (png file)", handler: pdfPOST, method: "POST", form: { file: png }, ...org },
  { name: "POST upload/photo (png file)", handler: photoPOST, method: "POST", form: { file: png }, ...org },
  { name: "POST import/eventsair", handler: eventsAirPOST, method: "POST", body: { eventsAirEventId: "ea1" }, ...org },
  { name: "GET profile", handler: profileGET, method: "GET", ...org },
  { name: "PATCH profile", handler: profilePATCH, method: "PATCH", body: { emailSignature: "<p>Regards</p>" }, ...org },
];

describe("route status matrix: organisation-level leftovers", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("organisation-level leftovers", CASES)).toMatchFileSnapshot("./__snapshots__/org-misc.matrix.txt");
  });
});
