/**
 * Route status matrix, domain 12 of the Phase 2 sweep: the registrations desk
 * (the list and its CSV, add, a registration's detail, edit and delete, its
 * activity, barcode, check-in and undo, recorded payment, email and email
 * change, document resend, supporting document; badges and their preview;
 * bulk tags and type; import from contacts and from a spreadsheet, the
 * completion emails; the tag list; spare DTCM codes; registration share links;
 * the Onsite Staff tab). Refund, cancel, credit notes, a registration's promo
 * code and its quote go with the money domain. Recorded on the unswept code
 * (Oct 5, 2026); the sweep onto `requirePermission` must leave it byte for
 * byte unchanged except where a change is intended and reviewed. See
 * ./harness.ts for what a cell means.
 *
 * Changes re-recorded on purpose (Oct 5, 2026):
 *  - the barcode image: WEBINARS reaches it on every event where it works the
 *    desk (`registrations.read`), as its printed badges already do (owner;
 *    it 404'd on conferences);
 *  - the barcode image and the supporting document: the platform operator
 *    (SUPER_ADMIN with no organisation) is refused, because their field keys
 *    (`barcode.view`, `supportingDocs.view`) are organisation-wide and an
 *    organisation-wide key needs an organisation (`can()`). Before, it read
 *    both on any tenant's events.
 *  - the DTCM pool (read and import): the platform operator is refused for the
 *    same reason, since its barcode check moved onto `barcode.view` (field
 *    visibility, custom roles Phase 3).
 *
 * Every network call fails here (`fetch` is stubbed to throw) and the email
 * sender is mocked, so nothing can reach a mailbox.
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
import { GET as listGET, POST as createPOST } from "@/app/api/events/[eventId]/registrations/route";
import {
  GET as detailGET,
  PUT as detailPUT,
  DELETE as detailDELETE,
} from "@/app/api/events/[eventId]/registrations/[registrationId]/route";
import { GET as activityGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/activity/route";
import { GET as barcodeGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/barcode/route";
import {
  POST as checkInPOST,
  PUT as checkInPUT,
  DELETE as checkInDELETE,
} from "@/app/api/events/[eventId]/registrations/[registrationId]/check-in/route";
import { POST as paymentPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/payments/route";
import { POST as emailPOST, PATCH as emailPATCH } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";
import { POST as docsResendPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/documents/resend/route";
import { GET as supportingDocGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/supporting-document/route";
import { POST as badgesPOST } from "@/app/api/events/[eventId]/registrations/badges/route";
import { GET as badgePreviewGET } from "@/app/api/events/[eventId]/registrations/badges/preview/route";
import { PATCH as bulkTagsPATCH } from "@/app/api/events/[eventId]/registrations/bulk-tags/route";
import { PATCH as bulkTypePATCH } from "@/app/api/events/[eventId]/registrations/bulk-type/route";
import { POST as importContactsPOST } from "@/app/api/events/[eventId]/registrations/import-contacts/route";
import { POST as importCsvPOST } from "@/app/api/events/[eventId]/import/registrations/route";
import { POST as completionPOST } from "@/app/api/events/[eventId]/import/registrations/send-completion-emails/route";
import { GET as tagsGET } from "@/app/api/events/[eventId]/tags/route";
import { GET as dtcmGET, POST as dtcmPOST } from "@/app/api/events/[eventId]/dtcm-pool/route";
import { GET as sharesGET, POST as sharesPOST } from "@/app/api/events/[eventId]/registration-shares/route";
import { PUT as sharePUT, DELETE as shareDELETE } from "@/app/api/events/[eventId]/registration-shares/[viewId]/route";
import { POST as shareRegenPOST } from "@/app/api/events/[eventId]/registration-shares/[viewId]/regenerate/route";
import { GET as onsiteGET, POST as onsitePOST, DELETE as onsiteDELETE } from "@/app/api/events/[eventId]/onsite-staff/route";

const reg = { registrationId: "r1" };
const view = { viewId: "rv1" };
const shareBody = {
  label: "Sponsor list",
  enabled: true,
  expiresAt: null,
  statuses: ["CONFIRMED"],
  fields: ["name"],
  ticketTypeIds: [],
  sponsorIds: [],
  promoCodeIds: [],
  includeFaculty: false,
};

const CASES: HandlerCase[] = [
  { name: "GET registrations", handler: listGET, method: "GET" },
  { name: "GET registrations (csv)", handler: listGET, method: "GET", query: "export=csv" },
  { name: "GET registrations (sales csv)", handler: listGET, method: "GET", query: "export=sales" },
  {
    name: "POST registrations",
    handler: createPOST,
    method: "POST",
    body: { ticketTypeId: "tt1", attendee: { email: "new@test.local", firstName: "New", lastName: "Person" } },
  },
  { name: "GET registrations/[registrationId]", handler: detailGET, method: "GET", params: reg },
  { name: "PUT registrations/[registrationId]", handler: detailPUT, method: "PUT", params: reg, body: { notes: "Desk note" } },
  { name: "DELETE registrations/[registrationId]", handler: detailDELETE, method: "DELETE", params: reg },
  { name: "GET registrations/[registrationId]/activity", handler: activityGET, method: "GET", params: reg },
  { name: "GET registrations/[registrationId]/barcode", handler: barcodeGET, method: "GET", params: reg },
  { name: "POST registrations/[registrationId]/check-in", handler: checkInPOST, method: "POST", params: reg, body: {} },
  { name: "PUT registrations/[registrationId]/check-in", handler: checkInPUT, method: "PUT", params: reg, body: { qrCode: "Q1" } },
  { name: "DELETE registrations/[registrationId]/check-in", handler: checkInDELETE, method: "DELETE", params: reg },
  { name: "POST registrations/[registrationId]/payments", handler: paymentPOST, method: "POST", params: reg, body: { method: "cash", cashReceivedBy: "Desk" } },
  { name: "POST registrations/[registrationId]/email", handler: emailPOST, method: "POST", params: reg, body: { type: "confirmation" } },
  { name: "PATCH registrations/[registrationId]/email", handler: emailPATCH, method: "PATCH", params: reg, body: { newEmail: "moved@test.local" } },
  { name: "POST registrations/[registrationId]/documents/resend", handler: docsResendPOST, method: "POST", params: reg, body: {} },
  { name: "GET registrations/[registrationId]/supporting-document", handler: supportingDocGET, method: "GET", params: reg },
  { name: "POST registrations/badges", handler: badgesPOST, method: "POST", body: { registrationIds: ["r1"] } },
  { name: "GET registrations/badges/preview", handler: badgePreviewGET, method: "GET" },
  { name: "PATCH registrations/bulk-tags", handler: bulkTagsPATCH, method: "PATCH", body: { registrationIds: ["r1"], tags: ["vip"], mode: "add" } },
  { name: "PATCH registrations/bulk-type", handler: bulkTypePATCH, method: "PATCH", body: { registrationIds: ["r1"], ticketTypeId: "tt1" } },
  { name: "POST registrations/import-contacts", handler: importContactsPOST, method: "POST", body: { contactIds: ["ct1"] } },
  { name: "POST import/registrations (JSON, not multipart)", handler: importCsvPOST, method: "POST", body: {} },
  {
    name: "POST import/registrations (csv file)",
    handler: importCsvPOST,
    method: "POST",
    form: { file: { name: "regs.csv", type: "text/csv", content: "email,firstName,lastName\nimp@test.local,Ima,Port\n" } },
  },
  { name: "POST import/registrations/send-completion-emails", handler: completionPOST, method: "POST", body: { registrationIds: ["r1"] } },
  { name: "GET tags", handler: tagsGET, method: "GET" },
  { name: "GET dtcm-pool", handler: dtcmGET, method: "GET" },
  { name: "POST dtcm-pool", handler: dtcmPOST, method: "POST", body: { registrationId: "r1" } },
  { name: "GET registration-shares", handler: sharesGET, method: "GET" },
  { name: "POST registration-shares", handler: sharesPOST, method: "POST", body: shareBody },
  { name: "PUT registration-shares/[viewId]", handler: sharePUT, method: "PUT", params: view, body: shareBody },
  { name: "DELETE registration-shares/[viewId]", handler: shareDELETE, method: "DELETE", params: view },
  { name: "POST registration-shares/[viewId]/regenerate", handler: shareRegenPOST, method: "POST", params: view, body: {} },
  { name: "GET onsite-staff", handler: onsiteGET, method: "GET" },
  { name: "POST onsite-staff", handler: onsitePOST, method: "POST", body: { userId: "u-onsite" } },
  { name: "DELETE onsite-staff", handler: onsiteDELETE, method: "DELETE", query: "userId=u-onsite" },
];

describe("route status matrix: registrations desk", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("registrations desk", CASES)).toMatchFileSnapshot("./__snapshots__/registrations-desk.matrix.txt");
  });
});
