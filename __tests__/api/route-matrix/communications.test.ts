/**
 * Route status matrix, domain 7 of the Phase 2 sweep: communications (bulk
 * email and its audience count, scheduled emails, templates, previews,
 * attachments, the email activity feed). Recorded on the unswept code
 * (Oct 2, 2026); the sweep onto `requirePermission` must leave it byte for
 * byte unchanged except where a change is intended and reviewed. See
 * ./harness.ts for what a cell means.
 *
 * The email sender is mocked: no handler in this file can send a real email,
 * whatever it reaches.
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
import { GET as audienceGET } from "@/app/api/events/[eventId]/emails/audience-count/route";
import { POST as bulkPOST } from "@/app/api/events/[eventId]/emails/bulk/route";
import { GET as scheduleGET, POST as schedulePOST } from "@/app/api/events/[eventId]/emails/schedule/route";
import { PATCH as schedulePATCH, DELETE as scheduleDELETE } from "@/app/api/events/[eventId]/emails/schedule/[id]/route";
import { POST as retryPOST } from "@/app/api/events/[eventId]/emails/schedule/[id]/retry/route";
import { GET as templatesGET, POST as templatesPOST } from "@/app/api/events/[eventId]/email-templates/route";
import {
  GET as templateGET,
  PUT as templatePUT,
  DELETE as templateDELETE,
  POST as templatePOST,
  PATCH as templatePATCH,
} from "@/app/api/events/[eventId]/email-templates/[templateId]/route";
import { POST as duplicatePOST } from "@/app/api/events/[eventId]/email-templates/[templateId]/duplicate/route";
import { POST as previewPOST } from "@/app/api/events/[eventId]/email-preview/route";
import { POST as attachmentsPOST } from "@/app/api/events/[eventId]/email-attachments/route";
import { GET as activityGET } from "@/app/api/events/[eventId]/email-activity/route";

const bulk = { recipientType: "registrations", emailType: "custom", customSubject: "Hello", customMessage: "Body", recipientIds: ["r1"] };
const sched = { id: "se1" };
const tpl = { templateId: "tp1" };

const CASES: HandlerCase[] = [
  { name: "GET emails/audience-count", handler: audienceGET, method: "GET", query: "recipientType=abstracts&emailType=abstract-accepted" },
  { name: "POST emails/bulk", handler: bulkPOST, method: "POST", body: bulk },
  { name: "GET emails/schedule", handler: scheduleGET, method: "GET" },
  { name: "POST emails/schedule", handler: schedulePOST, method: "POST", body: { ...bulk, scheduledFor: "2027-06-01T09:00:00.000Z" } },
  { name: "PATCH emails/schedule/[id]", handler: schedulePATCH, method: "PATCH", params: sched, body: { customSubject: "Hi" } },
  { name: "DELETE emails/schedule/[id]", handler: scheduleDELETE, method: "DELETE", params: sched },
  { name: "POST emails/schedule/[id]/retry", handler: retryPOST, method: "POST", params: sched, body: {} },
  { name: "GET email-templates", handler: templatesGET, method: "GET" },
  {
    name: "POST email-templates",
    handler: templatesPOST,
    method: "POST",
    body: { slug: "matrix-tpl", name: "Matrix", subject: "Subject", htmlContent: "<p>Hi</p>" },
  },
  { name: "GET email-templates/[templateId]", handler: templateGET, method: "GET", params: tpl },
  { name: "PUT email-templates/[templateId]", handler: templatePUT, method: "PUT", params: tpl, body: { name: "Renamed" } },
  { name: "DELETE email-templates/[templateId]", handler: templateDELETE, method: "DELETE", params: tpl },
  { name: "POST email-templates/[templateId] (preview)", handler: templatePOST, method: "POST", params: tpl, body: { action: "preview" } },
  { name: "PATCH email-templates/[templateId]", handler: templatePATCH, method: "PATCH", params: tpl, body: {} },
  { name: "POST email-templates/[templateId]/duplicate", handler: duplicatePOST, method: "POST", params: tpl, body: {} },
  { name: "POST email-preview", handler: previewPOST, method: "POST", body: { slug: "registration-confirmation" } },
  { name: "POST email-attachments (JSON, not multipart)", handler: attachmentsPOST, method: "POST", body: {} },
  { name: "GET email-activity", handler: activityGET, method: "GET" },
];

describe("route status matrix: communications", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("communications", CASES)).toMatchFileSnapshot("./__snapshots__/communications.matrix.txt");
  });
});
