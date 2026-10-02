/**
 * Route status matrix, domain 4 of the Phase 2 sweep: speakers (the list,
 * detail, tags, imports, activity, agreement, documents, email, companion
 * registration and profile form). Recorded on the unswept code (Oct 2, 2026);
 * the sweep onto `requirePermission` must leave it byte for byte unchanged.
 * See ./harness.ts for what a cell means. Honorarium and reimbursement types
 * go with the faculty extras domain.
 *
 * Several handlers combine two checks (the documents GET admits MEMBER, the
 * activity GET the desk roles): this is exactly the case safety net 2 exists
 * for (plan §7.5), so every handler is listed, including the narrow ones.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi } from "vitest";

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
import { GET as speakersGET, POST as speakersPOST } from "@/app/api/events/[eventId]/speakers/route";
import { GET as speakerGET, PUT as speakerPUT, DELETE as speakerDELETE } from "@/app/api/events/[eventId]/speakers/[speakerId]/route";
import { PATCH as bulkTagsPATCH } from "@/app/api/events/[eventId]/speakers/bulk-tags/route";
import { GET as tagsGET } from "@/app/api/events/[eventId]/speakers/tags/route";
import { POST as importContactsPOST } from "@/app/api/events/[eventId]/speakers/import-contacts/route";
import { POST as importRegistrationsPOST } from "@/app/api/events/[eventId]/speakers/import-registrations/route";
import { GET as activityGET } from "@/app/api/events/[eventId]/speakers/[speakerId]/activity/route";
import { PATCH as agreementPATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/agreement/route";
import { GET as documentsGET, POST as documentsPOST } from "@/app/api/events/[eventId]/speakers/[speakerId]/documents/route";
import { DELETE as documentDELETE } from "@/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/route";
import { GET as documentFileGET } from "@/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/file/route";
import { POST as emailPOST, PATCH as emailPATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/email/route";
import { POST as grantCompanionPOST } from "@/app/api/events/[eventId]/speakers/[speakerId]/grant-companion/route";
import { GET as profileFormGET, POST as profileFormPOST, PATCH as profileFormPATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/profile-form/route";

const sp = { speakerId: "sp1" };
const doc = { speakerId: "sp1", documentId: "d1" };

const CASES: HandlerCase[] = [
  { name: "GET speakers", handler: speakersGET, method: "GET" },
  { name: "POST speakers", handler: speakersPOST, method: "POST", body: { email: "new@speaker.test", firstName: "New", lastName: "Speaker" } },
  { name: "GET speakers/[speakerId]", handler: speakerGET, method: "GET", params: sp },
  { name: "PUT speakers/[speakerId]", handler: speakerPUT, method: "PUT", params: sp, body: { firstName: "Renamed" } },
  { name: "DELETE speakers/[speakerId]", handler: speakerDELETE, method: "DELETE", params: sp },
  { name: "PATCH speakers/bulk-tags", handler: bulkTagsPATCH, method: "PATCH", body: { speakerIds: ["sp1"], tags: ["vip"], mode: "add" } },
  { name: "GET speakers/tags", handler: tagsGET, method: "GET" },
  { name: "POST speakers/import-contacts", handler: importContactsPOST, method: "POST", body: { contactIds: ["c1"] } },
  { name: "POST speakers/import-registrations", handler: importRegistrationsPOST, method: "POST", body: { registrationIds: ["r1"] } },
  { name: "GET speakers/[speakerId]/activity", handler: activityGET, method: "GET", params: sp },
  { name: "PATCH speakers/[speakerId]/agreement", handler: agreementPATCH, method: "PATCH", params: sp, body: { accepted: true } },
  { name: "GET speakers/[speakerId]/documents", handler: documentsGET, method: "GET", params: sp },
  { name: "POST speakers/[speakerId]/documents (JSON, not multipart)", handler: documentsPOST, method: "POST", params: sp, body: {} },
  { name: "DELETE speakers/[speakerId]/documents/[documentId]", handler: documentDELETE, method: "DELETE", params: doc },
  { name: "GET speakers/[speakerId]/documents/[documentId]/file", handler: documentFileGET, method: "GET", params: doc },
  { name: "POST speakers/[speakerId]/email", handler: emailPOST, method: "POST", params: sp, body: { type: "template", templateSlug: "x" } },
  { name: "PATCH speakers/[speakerId]/email", handler: emailPATCH, method: "PATCH", params: sp, body: { newEmail: "changed@speaker.test" } },
  { name: "POST speakers/[speakerId]/grant-companion", handler: grantCompanionPOST, method: "POST", params: sp, body: {} },
  { name: "GET speakers/[speakerId]/profile-form", handler: profileFormGET, method: "GET", params: sp },
  { name: "POST speakers/[speakerId]/profile-form", handler: profileFormPOST, method: "POST", params: sp, body: {} },
  { name: "PATCH speakers/[speakerId]/profile-form (reopen)", handler: profileFormPATCH, method: "PATCH", params: sp, body: { reopen: true } },
];

describe("route status matrix: speakers", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("speakers", CASES)).toMatchFileSnapshot("./__snapshots__/speakers.matrix.txt");
  });
});
