/**
 * Route status matrix, domain 16 of the Phase 2 sweep: the CRM (every route
 * under /api/crm, generated one case per exported handler with fixture ids
 * for the path parameters and an empty body, so a write shows its gate and
 * then its validation). Recorded on the unswept code (Oct 5, 2026); the sweep
 * of the CRM's shared guards onto `can()` must leave it byte for byte
 * unchanged except where a change is intended and reviewed. See ./harness.ts
 * for what a cell means. None of these routes is under an event.
 *
 * Every network call fails here (`fetch` is stubbed to throw) and the email
 * sender is mocked.
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
import { GET as h1 } from "@/app/api/crm/activity/export/route";
import { GET as h2 } from "@/app/api/crm/activity/feed/route";
import { GET as h3 } from "@/app/api/crm/activity/route";
import { GET as h4, PATCH as h5, DELETE as h6 } from "@/app/api/crm/companies/[companyId]/route";
import { GET as h7 } from "@/app/api/crm/companies/facets/route";
import { GET as h8, POST as h9 } from "@/app/api/crm/companies/route";
import { GET as h10 } from "@/app/api/crm/companies/tags/route";
import { GET as h11, PATCH as h12, DELETE as h13 } from "@/app/api/crm/contacts/[crmContactId]/route";
import { GET as h14, POST as h15 } from "@/app/api/crm/contacts/route";
import { GET as h16 } from "@/app/api/crm/contacts/tags/route";
import { PATCH as h17 } from "@/app/api/crm/deal-types/[dealTypeId]/route";
import { GET as h18, POST as h19, PATCH as h20 } from "@/app/api/crm/deal-types/route";
import { POST as h21 } from "@/app/api/crm/deals/[dealId]/close/route";
import { POST as h22, DELETE as h23 } from "@/app/api/crm/deals/[dealId]/contacts/route";
import { GET as h24, DELETE as h25 } from "@/app/api/crm/deals/[dealId]/documents/[documentId]/route";
import { GET as h26, POST as h27 } from "@/app/api/crm/deals/[dealId]/documents/route";
import { GET as h28, POST as h29, PATCH as h30, DELETE as h31 } from "@/app/api/crm/deals/[dealId]/products/route";
import { GET as h32, POST as h33 } from "@/app/api/crm/deals/[dealId]/quote/route";
import { PATCH as h34, DELETE as h35 } from "@/app/api/crm/deals/[dealId]/quotes/[quoteId]/route";
import { GET as h36 } from "@/app/api/crm/deals/[dealId]/quotes/route";
import { GET as h37, PATCH as h38, DELETE as h39 } from "@/app/api/crm/deals/[dealId]/route";
import { PATCH as h40 } from "@/app/api/crm/deals/[dealId]/stage/route";
import { GET as h41 } from "@/app/api/crm/deals/export/route";
import { GET as h42, POST as h43 } from "@/app/api/crm/deals/route";
import { PATCH as h44, DELETE as h45 } from "@/app/api/crm/email-templates/[templateId]/route";
import { GET as h46, POST as h47 } from "@/app/api/crm/email-templates/route";
import { GET as h48 } from "@/app/api/crm/events-lite/route";
import { POST as h49 } from "@/app/api/crm/import/companies/route";
import { POST as h50 } from "@/app/api/crm/import/contacts/route";
import { POST as h51 } from "@/app/api/crm/import/deals/route";
import { GET as h52 } from "@/app/api/crm/inbox/[threadId]/route";
import { GET as h53 } from "@/app/api/crm/inbox/messages/[messageId]/attachments/[index]/route";
import { GET as h54 } from "@/app/api/crm/inbox/route";
import { PATCH as h55, DELETE as h56 } from "@/app/api/crm/notes/[noteId]/route";
import { GET as h57, POST as h58 } from "@/app/api/crm/notes/route";
import { GET as h59, PATCH as h60 } from "@/app/api/crm/notifications/route";
import { PATCH as h61, DELETE as h62 } from "@/app/api/crm/pipeline-stages/[stageId]/route";
import { GET as h63, POST as h64, PATCH as h65 } from "@/app/api/crm/pipeline-stages/route";
import { PATCH as h66, DELETE as h67 } from "@/app/api/crm/products/[productId]/route";
import { GET as h68, POST as h69 } from "@/app/api/crm/products/route";
import { POST as h70 } from "@/app/api/crm/purge/route";
import { GET as h71 } from "@/app/api/crm/reports/route";
import { GET as h72 } from "@/app/api/crm/reps/route";
import { GET as h73 } from "@/app/api/crm/sponsor-email/recipients/route";
import { POST as h74 } from "@/app/api/crm/sponsor-email/send/route";
import { PATCH as h75, DELETE as h76 } from "@/app/api/crm/tasks/[taskId]/route";
import { GET as h77, POST as h78 } from "@/app/api/crm/tasks/route";

const org = { perEvent: false } as const;

const CASES: HandlerCase[] = [
  { name: "GET crm/activity/export", handler: h1, method: "GET", ...org },
  { name: "GET crm/activity/feed", handler: h2, method: "GET", ...org },
  { name: "GET crm/activity", handler: h3, method: "GET", ...org },
  { name: "GET crm/companies/[companyId]", handler: h4, method: "GET", params: {"companyId": "company1"}, ...org },
  { name: "PATCH crm/companies/[companyId]", handler: h5, method: "PATCH", params: {"companyId": "company1"}, body: {}, ...org },
  { name: "DELETE crm/companies/[companyId]", handler: h6, method: "DELETE", params: {"companyId": "company1"}, ...org },
  { name: "GET crm/companies/facets", handler: h7, method: "GET", ...org },
  { name: "GET crm/companies", handler: h8, method: "GET", ...org },
  { name: "POST crm/companies", handler: h9, method: "POST", body: {}, ...org },
  { name: "GET crm/companies/tags", handler: h10, method: "GET", ...org },
  { name: "GET crm/contacts/[crmContactId]", handler: h11, method: "GET", params: {"crmContactId": "crmContact1"}, ...org },
  { name: "PATCH crm/contacts/[crmContactId]", handler: h12, method: "PATCH", params: {"crmContactId": "crmContact1"}, body: {}, ...org },
  { name: "DELETE crm/contacts/[crmContactId]", handler: h13, method: "DELETE", params: {"crmContactId": "crmContact1"}, ...org },
  { name: "GET crm/contacts", handler: h14, method: "GET", ...org },
  { name: "POST crm/contacts", handler: h15, method: "POST", body: {}, ...org },
  { name: "GET crm/contacts/tags", handler: h16, method: "GET", ...org },
  { name: "PATCH crm/deal-types/[dealTypeId]", handler: h17, method: "PATCH", params: {"dealTypeId": "dealType1"}, body: {}, ...org },
  { name: "GET crm/deal-types", handler: h18, method: "GET", ...org },
  { name: "POST crm/deal-types", handler: h19, method: "POST", body: {}, ...org },
  { name: "PATCH crm/deal-types", handler: h20, method: "PATCH", body: {}, ...org },
  { name: "POST crm/deals/[dealId]/close", handler: h21, method: "POST", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "POST crm/deals/[dealId]/contacts", handler: h22, method: "POST", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "DELETE crm/deals/[dealId]/contacts", handler: h23, method: "DELETE", params: {"dealId": "deal1"}, ...org },
  { name: "GET crm/deals/[dealId]/documents/[documentId]", handler: h24, method: "GET", params: {"dealId": "deal1", "documentId": "document1"}, ...org },
  { name: "DELETE crm/deals/[dealId]/documents/[documentId]", handler: h25, method: "DELETE", params: {"dealId": "deal1", "documentId": "document1"}, ...org },
  { name: "GET crm/deals/[dealId]/documents", handler: h26, method: "GET", params: {"dealId": "deal1"}, ...org },
  { name: "POST crm/deals/[dealId]/documents", handler: h27, method: "POST", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "GET crm/deals/[dealId]/products", handler: h28, method: "GET", params: {"dealId": "deal1"}, ...org },
  { name: "POST crm/deals/[dealId]/products", handler: h29, method: "POST", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "PATCH crm/deals/[dealId]/products", handler: h30, method: "PATCH", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "DELETE crm/deals/[dealId]/products", handler: h31, method: "DELETE", params: {"dealId": "deal1"}, ...org },
  { name: "GET crm/deals/[dealId]/quote", handler: h32, method: "GET", params: {"dealId": "deal1"}, ...org },
  { name: "POST crm/deals/[dealId]/quote", handler: h33, method: "POST", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "PATCH crm/deals/[dealId]/quotes/[quoteId]", handler: h34, method: "PATCH", params: {"dealId": "deal1", "quoteId": "quote1"}, body: {}, ...org },
  { name: "DELETE crm/deals/[dealId]/quotes/[quoteId]", handler: h35, method: "DELETE", params: {"dealId": "deal1", "quoteId": "quote1"}, ...org },
  { name: "GET crm/deals/[dealId]/quotes", handler: h36, method: "GET", params: {"dealId": "deal1"}, ...org },
  { name: "GET crm/deals/[dealId]", handler: h37, method: "GET", params: {"dealId": "deal1"}, ...org },
  { name: "PATCH crm/deals/[dealId]", handler: h38, method: "PATCH", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "DELETE crm/deals/[dealId]", handler: h39, method: "DELETE", params: {"dealId": "deal1"}, ...org },
  { name: "PATCH crm/deals/[dealId]/stage", handler: h40, method: "PATCH", params: {"dealId": "deal1"}, body: {}, ...org },
  { name: "GET crm/deals/export", handler: h41, method: "GET", ...org },
  { name: "GET crm/deals", handler: h42, method: "GET", ...org },
  { name: "POST crm/deals", handler: h43, method: "POST", body: {}, ...org },
  { name: "PATCH crm/email-templates/[templateId]", handler: h44, method: "PATCH", params: {"templateId": "template1"}, body: {}, ...org },
  { name: "DELETE crm/email-templates/[templateId]", handler: h45, method: "DELETE", params: {"templateId": "template1"}, ...org },
  { name: "GET crm/email-templates", handler: h46, method: "GET", ...org },
  { name: "POST crm/email-templates", handler: h47, method: "POST", body: {}, ...org },
  { name: "GET crm/events-lite", handler: h48, method: "GET", ...org },
  { name: "POST crm/import/companies", handler: h49, method: "POST", body: {}, ...org },
  { name: "POST crm/import/contacts", handler: h50, method: "POST", body: {}, ...org },
  { name: "POST crm/import/deals", handler: h51, method: "POST", body: {}, ...org },
  { name: "GET crm/inbox/[threadId]", handler: h52, method: "GET", params: {"threadId": "thread1"}, ...org },
  { name: "GET crm/inbox/messages/[messageId]/attachments/[index]", handler: h53, method: "GET", params: {"messageId": "message1", "index": "index1"}, ...org },
  { name: "GET crm/inbox", handler: h54, method: "GET", ...org },
  { name: "PATCH crm/notes/[noteId]", handler: h55, method: "PATCH", params: {"noteId": "note1"}, body: {}, ...org },
  { name: "DELETE crm/notes/[noteId]", handler: h56, method: "DELETE", params: {"noteId": "note1"}, ...org },
  { name: "GET crm/notes", handler: h57, method: "GET", ...org },
  { name: "POST crm/notes", handler: h58, method: "POST", body: {}, ...org },
  { name: "GET crm/notifications", handler: h59, method: "GET", ...org },
  { name: "PATCH crm/notifications", handler: h60, method: "PATCH", body: {}, ...org },
  { name: "PATCH crm/pipeline-stages/[stageId]", handler: h61, method: "PATCH", params: {"stageId": "stage1"}, body: {}, ...org },
  { name: "DELETE crm/pipeline-stages/[stageId]", handler: h62, method: "DELETE", params: {"stageId": "stage1"}, ...org },
  { name: "GET crm/pipeline-stages", handler: h63, method: "GET", ...org },
  { name: "POST crm/pipeline-stages", handler: h64, method: "POST", body: {}, ...org },
  { name: "PATCH crm/pipeline-stages", handler: h65, method: "PATCH", body: {}, ...org },
  { name: "PATCH crm/products/[productId]", handler: h66, method: "PATCH", params: {"productId": "product1"}, body: {}, ...org },
  { name: "DELETE crm/products/[productId]", handler: h67, method: "DELETE", params: {"productId": "product1"}, ...org },
  { name: "GET crm/products", handler: h68, method: "GET", ...org },
  { name: "POST crm/products", handler: h69, method: "POST", body: {}, ...org },
  { name: "POST crm/purge", handler: h70, method: "POST", body: {}, ...org },
  { name: "GET crm/reports", handler: h71, method: "GET", ...org },
  { name: "GET crm/reps", handler: h72, method: "GET", ...org },
  { name: "GET crm/sponsor-email/recipients", handler: h73, method: "GET", ...org },
  { name: "POST crm/sponsor-email/send", handler: h74, method: "POST", body: {}, ...org },
  { name: "PATCH crm/tasks/[taskId]", handler: h75, method: "PATCH", params: {"taskId": "task1"}, body: {}, ...org },
  { name: "DELETE crm/tasks/[taskId]", handler: h76, method: "DELETE", params: {"taskId": "task1"}, ...org },
  { name: "GET crm/tasks", handler: h77, method: "GET", ...org },
  { name: "POST crm/tasks", handler: h78, method: "POST", body: {}, ...org },
];

describe("route status matrix: CRM", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("CRM", CASES)).toMatchFileSnapshot("./__snapshots__/crm.matrix.txt");
  });
});
