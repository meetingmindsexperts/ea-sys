/**
 * Route status matrix, domain 8 of the Phase 2 sweep: certificates
 * (templates, settings, eligibility and preview, issue runs and their
 * download, cancel, retry and send, issued certificates, reissue and resend).
 * Recorded on the unswept code (Oct 2, 2026); the sweep onto
 * `requirePermission` must leave it byte for byte unchanged except where a
 * change is intended and reviewed. See ./harness.ts for what a cell means.
 *
 * The email sender is mocked and every id is a fixture id the database does
 * not hold, so nothing here can issue or send a certificate.
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
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async () => ({ success: true, messageId: "matrix" })),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as analyticsGET } from "@/app/api/events/[eventId]/certificates/auto-issue/analytics/route";
import { POST as bulkReissuePOST } from "@/app/api/events/[eventId]/certificates/bulk-reissue/route";
import { GET as eligibleGET } from "@/app/api/events/[eventId]/certificates/eligible/route";
import { POST as issueSinglePOST } from "@/app/api/events/[eventId]/certificates/issue-single/route";
import { POST as issuePOST } from "@/app/api/events/[eventId]/certificates/issue/route";
import { POST as reissuePOST } from "@/app/api/events/[eventId]/certificates/issued/[certificateId]/reissue/route";
import { POST as resendBundlePOST } from "@/app/api/events/[eventId]/certificates/issued/resend-bundle/route";
import { POST as resendPreviewPOST } from "@/app/api/events/[eventId]/certificates/issued/resend-preview/route";
import { GET as issuedGET } from "@/app/api/events/[eventId]/certificates/issued/route";
import { GET as previewGET } from "@/app/api/events/[eventId]/certificates/preview/route";
import { POST as runCancelPOST } from "@/app/api/events/[eventId]/certificates/runs/[runId]/cancel/route";
import { GET as runDownloadGET } from "@/app/api/events/[eventId]/certificates/runs/[runId]/download/route";
import { POST as runRetryPOST } from "@/app/api/events/[eventId]/certificates/runs/[runId]/retry-failed/route";
import { GET as runGET } from "@/app/api/events/[eventId]/certificates/runs/[runId]/route";
import { POST as runSendPOST } from "@/app/api/events/[eventId]/certificates/runs/[runId]/send/route";
import { GET as runsGET } from "@/app/api/events/[eventId]/certificates/runs/route";
import { GET as settingsGET, PATCH as settingsPATCH } from "@/app/api/events/[eventId]/certificates/settings/route";
import { POST as duplicatePOST } from "@/app/api/events/[eventId]/certificates/templates/[templateId]/duplicate/route";
import { PATCH as templatePATCH, DELETE as templateDELETE } from "@/app/api/events/[eventId]/certificates/templates/[templateId]/route";
import { GET as templatesGET, POST as templatesPOST } from "@/app/api/events/[eventId]/certificates/templates/route";
import { POST as starterPOST } from "@/app/api/events/[eventId]/certificates/templates/starter/route";

const run = { runId: "run1" };
const tpl = { templateId: "ct1" };

const CASES: HandlerCase[] = [
  { name: "GET certificates/auto-issue/analytics", handler: analyticsGET, method: "GET" },
  { name: "GET certificates/templates", handler: templatesGET, method: "GET" },
  { name: "POST certificates/templates", handler: templatesPOST, method: "POST", body: { name: "Attendance", category: "ATTENDANCE" } },
  { name: "PATCH certificates/templates/[templateId]", handler: templatePATCH, method: "PATCH", params: tpl, body: { name: "Attendance 2" } },
  { name: "DELETE certificates/templates/[templateId]", handler: templateDELETE, method: "DELETE", params: tpl },
  { name: "POST certificates/templates/[templateId]/duplicate", handler: duplicatePOST, method: "POST", params: tpl, body: {} },
  { name: "POST certificates/templates/starter", handler: starterPOST, method: "POST", body: { category: "ATTENDANCE" } },
  { name: "GET certificates/settings", handler: settingsGET, method: "GET" },
  { name: "PATCH certificates/settings", handler: settingsPATCH, method: "PATCH", body: {} },
  { name: "GET certificates/eligible", handler: eligibleGET, method: "GET", query: "templateId=ct1" },
  { name: "GET certificates/preview", handler: previewGET, method: "GET", query: "templateId=ct1" },
  { name: "POST certificates/issue", handler: issuePOST, method: "POST", body: { templateIds: ["ct1"], emailSubject: "Your certificate", emailBody: "Attached." } },
  { name: "POST certificates/issue-single", handler: issueSinglePOST, method: "POST", body: { templateIds: ["ct1"], registrationId: "r1", sendEmail: false } },
  { name: "GET certificates/runs", handler: runsGET, method: "GET" },
  { name: "GET certificates/runs/[runId]", handler: runGET, method: "GET", params: run },
  { name: "GET certificates/runs/[runId]/download", handler: runDownloadGET, method: "GET", params: run },
  { name: "POST certificates/runs/[runId]/cancel", handler: runCancelPOST, method: "POST", params: run, body: {} },
  { name: "POST certificates/runs/[runId]/retry-failed", handler: runRetryPOST, method: "POST", params: run, body: {} },
  { name: "POST certificates/runs/[runId]/send", handler: runSendPOST, method: "POST", params: run, body: {} },
  { name: "GET certificates/issued", handler: issuedGET, method: "GET", query: "registrationId=r1" },
  { name: "POST certificates/issued/[certificateId]/reissue", handler: reissuePOST, method: "POST", params: { certificateId: "ic1" }, body: {} },
  { name: "POST certificates/issued/resend-bundle", handler: resendBundlePOST, method: "POST", body: { registrationId: "r1" } },
  { name: "POST certificates/issued/resend-preview", handler: resendPreviewPOST, method: "POST", body: { registrationId: "r1" } },
  { name: "POST certificates/bulk-reissue", handler: bulkReissuePOST, method: "POST", body: { templateId: "ct1" } },
];

describe("route status matrix: certificates", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("certificates", CASES)).toMatchFileSnapshot("./__snapshots__/certificates.matrix.txt");
  });
});
