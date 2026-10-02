/**
 * Route status matrix, domain 10 of the Phase 2 sweep: faculty extras
 * (reimbursements and their settings, send, PDF and documents; a speaker's
 * honorarium and reimbursement types; travel grants; RSVP campaigns, items,
 * invites and the invite send; survey responses, their export and a
 * registration's survey reset). Recorded on the unswept code (Oct 2, 2026);
 * the sweep onto `requirePermission` must leave it byte for byte unchanged
 * except where a change is intended and reviewed. See ./harness.ts for what a
 * cell means.
 *
 * One intended change, re-recorded on purpose: MEMBER reads survey answers
 * (`surveys.read`), which it was refused before although the route's comment
 * and the catalogue both said it could (owner, Oct 2, 2026). The CSV export
 * stays with the hosts (`surveys.export`).
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
import { GET as reimbsGET, POST as reimbsPOST } from "@/app/api/events/[eventId]/reimbursements/route";
import {
  GET as reimbGET,
  PATCH as reimbPATCH,
  DELETE as reimbDELETE,
} from "@/app/api/events/[eventId]/reimbursements/[reimbursementId]/route";
import { GET as reimbPdfGET } from "@/app/api/events/[eventId]/reimbursements/[reimbursementId]/pdf/route";
import { GET as reimbDocGET } from "@/app/api/events/[eventId]/reimbursements/[reimbursementId]/documents/[documentId]/route";
import { POST as reimbSendPOST } from "@/app/api/events/[eventId]/reimbursements/send/route";
import { GET as reimbSettingsGET, PUT as reimbSettingsPUT } from "@/app/api/events/[eventId]/reimbursements/settings/route";
import { GET as honorariumGET, PATCH as honorariumPATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/honorarium/route";
import {
  GET as claimTypesGET,
  PATCH as claimTypesPATCH,
} from "@/app/api/events/[eventId]/speakers/[speakerId]/reimbursement-types/route";
import { GET as grantsGET, POST as grantsPOST } from "@/app/api/events/[eventId]/travel-grants/route";
import { PATCH as grantPATCH } from "@/app/api/events/[eventId]/travel-grants/[grantId]/route";
import { GET as campaignsGET, POST as campaignsPOST } from "@/app/api/events/[eventId]/rsvp-campaigns/route";
import {
  GET as campaignGET,
  PUT as campaignPUT,
  DELETE as campaignDELETE,
} from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/route";
import { GET as itemsGET, POST as itemsPOST } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/items/route";
import { PUT as itemPUT, DELETE as itemDELETE } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]/route";
import { GET as invitesGET, POST as invitesPOST } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route";
import { DELETE as inviteDELETE } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/[inviteId]/route";
import { POST as inviteSendPOST } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/send/route";
import { GET as surveyGET } from "@/app/api/events/[eventId]/survey/responses/route";
import { GET as surveyExportGET } from "@/app/api/events/[eventId]/survey/responses/export/route";
import { DELETE as surveyResetDELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/survey/route";

const reimb = { reimbursementId: "rb1" };
const spk = { speakerId: "sp1" };
const camp = { campaignId: "rc1" };
const item = { name: "Gala dinner", startsAt: "2027-01-10T19:00:00.000Z" };

const CASES: HandlerCase[] = [
  { name: "GET reimbursements", handler: reimbsGET, method: "GET" },
  { name: "GET reimbursements (csv)", handler: reimbsGET, method: "GET", query: "export=csv" },
  { name: "POST reimbursements", handler: reimbsPOST, method: "POST", body: { speakerIds: ["sp1"] } },
  { name: "GET reimbursements/[reimbursementId]", handler: reimbGET, method: "GET", params: reimb },
  { name: "PATCH reimbursements/[reimbursementId]", handler: reimbPATCH, method: "PATCH", params: reimb, body: { action: "reopen" } },
  { name: "DELETE reimbursements/[reimbursementId]", handler: reimbDELETE, method: "DELETE", params: reimb },
  { name: "GET reimbursements/[reimbursementId]/pdf", handler: reimbPdfGET, method: "GET", params: reimb },
  {
    name: "GET reimbursements/[reimbursementId]/documents/[documentId]",
    handler: reimbDocGET,
    method: "GET",
    params: { ...reimb, documentId: "rd1" },
  },
  { name: "POST reimbursements/send", handler: reimbSendPOST, method: "POST", body: { reimbursementId: "rb1" } },
  { name: "GET reimbursements/settings", handler: reimbSettingsGET, method: "GET" },
  { name: "PUT reimbursements/settings", handler: reimbSettingsPUT, method: "PUT", body: { claimItems: ["FLIGHT"] } },
  { name: "GET speakers/[speakerId]/honorarium", handler: honorariumGET, method: "GET", params: spk },
  { name: "PATCH speakers/[speakerId]/honorarium", handler: honorariumPATCH, method: "PATCH", params: spk, body: { amount: 500, currency: "USD" } },
  { name: "GET speakers/[speakerId]/reimbursement-types", handler: claimTypesGET, method: "GET", params: spk },
  { name: "PATCH speakers/[speakerId]/reimbursement-types", handler: claimTypesPATCH, method: "PATCH", params: spk, body: { claimItems: ["FLIGHT"] } },
  { name: "GET travel-grants", handler: grantsGET, method: "GET" },
  { name: "GET travel-grants (csv)", handler: grantsGET, method: "GET", query: "export=csv" },
  { name: "POST travel-grants", handler: grantsPOST, method: "POST", body: { speakerIds: ["sp1"] } },
  { name: "PATCH travel-grants/[grantId]", handler: grantPATCH, method: "PATCH", params: { grantId: "tg1" }, body: { status: "CONSENTED" } },
  { name: "GET rsvp-campaigns", handler: campaignsGET, method: "GET" },
  { name: "POST rsvp-campaigns", handler: campaignsPOST, method: "POST", body: { name: "Gala", firstItem: item } },
  { name: "GET rsvp-campaigns/[campaignId]", handler: campaignGET, method: "GET", params: camp },
  { name: "PUT rsvp-campaigns/[campaignId]", handler: campaignPUT, method: "PUT", params: camp, body: { name: "Gala 2" } },
  { name: "DELETE rsvp-campaigns/[campaignId]", handler: campaignDELETE, method: "DELETE", params: camp },
  { name: "GET rsvp-campaigns/[campaignId]/items", handler: itemsGET, method: "GET", params: camp },
  { name: "POST rsvp-campaigns/[campaignId]/items", handler: itemsPOST, method: "POST", params: camp, body: item },
  { name: "PUT rsvp-campaigns/[campaignId]/items/[itemId]", handler: itemPUT, method: "PUT", params: { ...camp, itemId: "ri1" }, body: { name: "Lunch" } },
  { name: "DELETE rsvp-campaigns/[campaignId]/items/[itemId]", handler: itemDELETE, method: "DELETE", params: { ...camp, itemId: "ri1" } },
  { name: "GET rsvp-campaigns/[campaignId]/invites", handler: invitesGET, method: "GET", params: camp },
  { name: "GET rsvp-campaigns/[campaignId]/invites (csv)", handler: invitesGET, method: "GET", params: camp, query: "export=csv" },
  {
    name: "POST rsvp-campaigns/[campaignId]/invites",
    handler: invitesPOST,
    method: "POST",
    params: camp,
    body: { invitees: [{ name: "Guest", email: "guest@test.local" }] },
  },
  {
    name: "DELETE rsvp-campaigns/[campaignId]/invites/[inviteId]",
    handler: inviteDELETE,
    method: "DELETE",
    params: { ...camp, inviteId: "rv1" },
  },
  { name: "POST rsvp-campaigns/[campaignId]/invites/send", handler: inviteSendPOST, method: "POST", params: camp, body: { inviteId: "rv1" } },
  { name: "GET survey/responses", handler: surveyGET, method: "GET" },
  { name: "GET survey/responses/export", handler: surveyExportGET, method: "GET" },
  { name: "DELETE registrations/[registrationId]/survey", handler: surveyResetDELETE, method: "DELETE", params: { registrationId: "r1" } },
];

describe("route status matrix: faculty extras", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("faculty extras", CASES)).toMatchFileSnapshot("./__snapshots__/faculty-extras.matrix.txt");
  });
});
