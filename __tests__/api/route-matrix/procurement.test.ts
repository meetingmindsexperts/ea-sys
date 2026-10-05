/**
 * Route status matrix, domain 18 of the Phase 2 sweep: procurement (every
 * route under /api/procurement and /api/integrations, with the module flag on; generated one case per exported handler with fixture ids
 * for the path parameters and an empty body, so a write shows its gate and
 * then its validation). Recorded on the unswept code (Oct 5, 2026); the sweep
 * of the procurement predicates onto `can()` must leave it byte for byte
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
import { GET as h1 } from "@/app/api/integrations/quickbooks/callback/route";
import { GET as h2 } from "@/app/api/integrations/quickbooks/chart/route";
import { GET as h3 } from "@/app/api/integrations/quickbooks/connect/route";
import { GET as h4, PUT as h5, DELETE as h6 } from "@/app/api/integrations/quickbooks/credentials/route";
import { GET as h7, DELETE as h8 } from "@/app/api/integrations/quickbooks/route";
import { POST as h9 } from "@/app/api/integrations/quickbooks/test/route";
import { GET as h10, PUT as h11 } from "@/app/api/procurement/approval-chain/route";
import { POST as h12 } from "@/app/api/procurement/approvals/[requestId]/decide/route";
import { GET as h13 } from "@/app/api/procurement/approvals/route";
import { GET as h14 } from "@/app/api/procurement/budgets/[budgetId]/activity/route";
import { POST as h15 } from "@/app/api/procurement/budgets/[budgetId]/decide/route";
import { GET as h16 } from "@/app/api/procurement/budgets/[budgetId]/export/route";
import { PATCH as h17, DELETE as h18 } from "@/app/api/procurement/budgets/[budgetId]/lines/[lineId]/route";
import { POST as h19 } from "@/app/api/procurement/budgets/[budgetId]/lines/route";
import { POST as h20 } from "@/app/api/procurement/budgets/[budgetId]/reallocate/route";
import { PATCH as h21, DELETE as h22 } from "@/app/api/procurement/budgets/[budgetId]/revenue/[lineId]/route";
import { GET as h23, POST as h24 } from "@/app/api/procurement/budgets/[budgetId]/revenue/route";
import { GET as h25, PATCH as h26, DELETE as h27 } from "@/app/api/procurement/budgets/[budgetId]/route";
import { POST as h28 } from "@/app/api/procurement/budgets/[budgetId]/submit/route";
import { POST as h29 } from "@/app/api/procurement/budgets/[budgetId]/transition/route";
import { POST as h30 } from "@/app/api/procurement/budgets/[budgetId]/versions/route";
import { GET as h31, POST as h32 } from "@/app/api/procurement/budgets/route";
import { PATCH as h33 } from "@/app/api/procurement/categories/[categoryId]/route";
import { GET as h34, POST as h35 } from "@/app/api/procurement/categories/route";
import { POST as h36 } from "@/app/api/procurement/commitments/[commitmentId]/cancel/route";
import { POST as h37 } from "@/app/api/procurement/commitments/[commitmentId]/confirm-receipt/route";
import { GET as h38 } from "@/app/api/procurement/commitments/[commitmentId]/pdf/route";
import { POST as h39 } from "@/app/api/procurement/commitments/[commitmentId]/receive/route";
import { GET as h40 } from "@/app/api/procurement/commitments/[commitmentId]/route";
import { POST as h41 } from "@/app/api/procurement/commitments/[commitmentId]/send/route";
import { POST as h42 } from "@/app/api/procurement/commitments/[commitmentId]/undo-receipt/route";
import { GET as h43 } from "@/app/api/procurement/commitments/route";
import { PATCH as h44 } from "@/app/api/procurement/products/[productId]/route";
import { POST as h45 } from "@/app/api/procurement/products/import/route";
import { GET as h46, POST as h47 } from "@/app/api/procurement/products/route";
import { POST as h48 } from "@/app/api/procurement/requests/[requestId]/amend/route";
import { POST as h49 } from "@/app/api/procurement/requests/[requestId]/order/route";
import { POST as h50, GET as h51, DELETE as h52 } from "@/app/api/procurement/requests/[requestId]/quotes/[quoteId]/file/route";
import { DELETE as h53 } from "@/app/api/procurement/requests/[requestId]/quotes/[quoteId]/route";
import { POST as h54 } from "@/app/api/procurement/requests/[requestId]/quotes/route";
import { GET as h55, PATCH as h56 } from "@/app/api/procurement/requests/[requestId]/route";
import { POST as h57 } from "@/app/api/procurement/requests/[requestId]/submit/route";
import { POST as h58 } from "@/app/api/procurement/requests/[requestId]/transition/route";
import { GET as h59 } from "@/app/api/procurement/requests/budget-check/route";
import { GET as h60, POST as h61 } from "@/app/api/procurement/requests/route";
import { POST as h62 } from "@/app/api/procurement/suppliers/[supplierId]/decide/route";
import { GET as h63, PATCH as h64 } from "@/app/api/procurement/suppliers/[supplierId]/route";
import { GET as h65 } from "@/app/api/procurement/suppliers/export/route";
import { POST as h66 } from "@/app/api/procurement/suppliers/import/route";
import { GET as h67, POST as h68 } from "@/app/api/procurement/suppliers/route";
import { PATCH as h69, DELETE as h70 } from "@/app/api/procurement/templates/[templateId]/lines/[lineId]/route";
import { POST as h71 } from "@/app/api/procurement/templates/[templateId]/lines/route";
import { PATCH as h72 } from "@/app/api/procurement/templates/[templateId]/route";
import { GET as h73, POST as h74 } from "@/app/api/procurement/templates/route";

const org = { perEvent: false } as const;
// Some handlers take a NextRequest; the harness passes a plain Request, so a
// status of 0 marks one that threw past its own catch (alike on both sides).
// The callers carry roles only, no procurement grants or custom keys:
// system-roles-parity.test.ts pins every grant combination to the keys.

const CASES: HandlerCase[] = [
  { name: "GET integrations/quickbooks/callback", handler: h1 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "GET integrations/quickbooks/chart", handler: h2 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "GET integrations/quickbooks/connect", handler: h3 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "GET integrations/quickbooks/credentials", handler: h4 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "PUT integrations/quickbooks/credentials", handler: h5 as unknown as HandlerCase["handler"], method: "PUT", body: {}, ...org },
  { name: "DELETE integrations/quickbooks/credentials", handler: h6 as unknown as HandlerCase["handler"], method: "DELETE", ...org },
  { name: "GET integrations/quickbooks", handler: h7 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "DELETE integrations/quickbooks", handler: h8 as unknown as HandlerCase["handler"], method: "DELETE", ...org },
  { name: "POST integrations/quickbooks/test", handler: h9 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET procurement/approval-chain", handler: h10 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "PUT procurement/approval-chain", handler: h11 as unknown as HandlerCase["handler"], method: "PUT", body: {}, ...org },
  { name: "POST procurement/approvals/[requestId]/decide", handler: h12 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "GET procurement/approvals", handler: h13 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "GET procurement/budgets/[budgetId]/activity", handler: h14 as unknown as HandlerCase["handler"], method: "GET", params: {"budgetId": "budget1"}, ...org },
  { name: "POST procurement/budgets/[budgetId]/decide", handler: h15 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "GET procurement/budgets/[budgetId]/export", handler: h16 as unknown as HandlerCase["handler"], method: "GET", params: {"budgetId": "budget1"}, ...org },
  { name: "PATCH procurement/budgets/[budgetId]/lines/[lineId]", handler: h17 as unknown as HandlerCase["handler"], method: "PATCH", params: {"budgetId": "budget1", "lineId": "line1"}, body: {}, ...org },
  { name: "DELETE procurement/budgets/[budgetId]/lines/[lineId]", handler: h18 as unknown as HandlerCase["handler"], method: "DELETE", params: {"budgetId": "budget1", "lineId": "line1"}, ...org },
  { name: "POST procurement/budgets/[budgetId]/lines", handler: h19 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "POST procurement/budgets/[budgetId]/reallocate", handler: h20 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "PATCH procurement/budgets/[budgetId]/revenue/[lineId]", handler: h21 as unknown as HandlerCase["handler"], method: "PATCH", params: {"budgetId": "budget1", "lineId": "line1"}, body: {}, ...org },
  { name: "DELETE procurement/budgets/[budgetId]/revenue/[lineId]", handler: h22 as unknown as HandlerCase["handler"], method: "DELETE", params: {"budgetId": "budget1", "lineId": "line1"}, ...org },
  { name: "GET procurement/budgets/[budgetId]/revenue", handler: h23 as unknown as HandlerCase["handler"], method: "GET", params: {"budgetId": "budget1"}, ...org },
  { name: "POST procurement/budgets/[budgetId]/revenue", handler: h24 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "GET procurement/budgets/[budgetId]", handler: h25 as unknown as HandlerCase["handler"], method: "GET", params: {"budgetId": "budget1"}, ...org },
  { name: "PATCH procurement/budgets/[budgetId]", handler: h26 as unknown as HandlerCase["handler"], method: "PATCH", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "DELETE procurement/budgets/[budgetId]", handler: h27 as unknown as HandlerCase["handler"], method: "DELETE", params: {"budgetId": "budget1"}, ...org },
  { name: "POST procurement/budgets/[budgetId]/submit", handler: h28 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "POST procurement/budgets/[budgetId]/transition", handler: h29 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "POST procurement/budgets/[budgetId]/versions", handler: h30 as unknown as HandlerCase["handler"], method: "POST", params: {"budgetId": "budget1"}, body: {}, ...org },
  { name: "GET procurement/budgets", handler: h31 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/budgets", handler: h32 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "PATCH procurement/categories/[categoryId]", handler: h33 as unknown as HandlerCase["handler"], method: "PATCH", params: {"categoryId": "category1"}, body: {}, ...org },
  { name: "GET procurement/categories", handler: h34 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/categories", handler: h35 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "POST procurement/commitments/[commitmentId]/cancel", handler: h36 as unknown as HandlerCase["handler"], method: "POST", params: {"commitmentId": "commitment1"}, body: {}, ...org },
  { name: "POST procurement/commitments/[commitmentId]/confirm-receipt", handler: h37 as unknown as HandlerCase["handler"], method: "POST", params: {"commitmentId": "commitment1"}, body: {}, ...org },
  { name: "GET procurement/commitments/[commitmentId]/pdf", handler: h38 as unknown as HandlerCase["handler"], method: "GET", params: {"commitmentId": "commitment1"}, ...org },
  { name: "POST procurement/commitments/[commitmentId]/receive", handler: h39 as unknown as HandlerCase["handler"], method: "POST", params: {"commitmentId": "commitment1"}, body: {}, ...org },
  { name: "GET procurement/commitments/[commitmentId]", handler: h40 as unknown as HandlerCase["handler"], method: "GET", params: {"commitmentId": "commitment1"}, ...org },
  { name: "POST procurement/commitments/[commitmentId]/send", handler: h41 as unknown as HandlerCase["handler"], method: "POST", params: {"commitmentId": "commitment1"}, body: {}, ...org },
  { name: "POST procurement/commitments/[commitmentId]/undo-receipt", handler: h42 as unknown as HandlerCase["handler"], method: "POST", params: {"commitmentId": "commitment1"}, body: {}, ...org },
  { name: "GET procurement/commitments", handler: h43 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "PATCH procurement/products/[productId]", handler: h44 as unknown as HandlerCase["handler"], method: "PATCH", params: {"productId": "product1"}, body: {}, ...org },
  { name: "POST procurement/products/import", handler: h45 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET procurement/products", handler: h46 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/products", handler: h47 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "POST procurement/requests/[requestId]/amend", handler: h48 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "POST procurement/requests/[requestId]/order", handler: h49 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "POST procurement/requests/[requestId]/quotes/[quoteId]/file", handler: h50 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1", "quoteId": "quote1"}, body: {}, ...org },
  { name: "GET procurement/requests/[requestId]/quotes/[quoteId]/file", handler: h51 as unknown as HandlerCase["handler"], method: "GET", params: {"requestId": "request1", "quoteId": "quote1"}, ...org },
  { name: "DELETE procurement/requests/[requestId]/quotes/[quoteId]/file", handler: h52 as unknown as HandlerCase["handler"], method: "DELETE", params: {"requestId": "request1", "quoteId": "quote1"}, ...org },
  { name: "DELETE procurement/requests/[requestId]/quotes/[quoteId]", handler: h53 as unknown as HandlerCase["handler"], method: "DELETE", params: {"requestId": "request1", "quoteId": "quote1"}, ...org },
  { name: "POST procurement/requests/[requestId]/quotes", handler: h54 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "GET procurement/requests/[requestId]", handler: h55 as unknown as HandlerCase["handler"], method: "GET", params: {"requestId": "request1"}, ...org },
  { name: "PATCH procurement/requests/[requestId]", handler: h56 as unknown as HandlerCase["handler"], method: "PATCH", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "POST procurement/requests/[requestId]/submit", handler: h57 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "POST procurement/requests/[requestId]/transition", handler: h58 as unknown as HandlerCase["handler"], method: "POST", params: {"requestId": "request1"}, body: {}, ...org },
  { name: "GET procurement/requests/budget-check", handler: h59 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "GET procurement/requests", handler: h60 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/requests", handler: h61 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "POST procurement/suppliers/[supplierId]/decide", handler: h62 as unknown as HandlerCase["handler"], method: "POST", params: {"supplierId": "supplier1"}, body: {}, ...org },
  { name: "GET procurement/suppliers/[supplierId]", handler: h63 as unknown as HandlerCase["handler"], method: "GET", params: {"supplierId": "supplier1"}, ...org },
  { name: "PATCH procurement/suppliers/[supplierId]", handler: h64 as unknown as HandlerCase["handler"], method: "PATCH", params: {"supplierId": "supplier1"}, body: {}, ...org },
  { name: "GET procurement/suppliers/export", handler: h65 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/suppliers/import", handler: h66 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET procurement/suppliers", handler: h67 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/suppliers", handler: h68 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "PATCH procurement/templates/[templateId]/lines/[lineId]", handler: h69 as unknown as HandlerCase["handler"], method: "PATCH", params: {"templateId": "template1", "lineId": "line1"}, body: {}, ...org },
  { name: "DELETE procurement/templates/[templateId]/lines/[lineId]", handler: h70 as unknown as HandlerCase["handler"], method: "DELETE", params: {"templateId": "template1", "lineId": "line1"}, ...org },
  { name: "POST procurement/templates/[templateId]/lines", handler: h71 as unknown as HandlerCase["handler"], method: "POST", params: {"templateId": "template1"}, body: {}, ...org },
  { name: "PATCH procurement/templates/[templateId]", handler: h72 as unknown as HandlerCase["handler"], method: "PATCH", params: {"templateId": "template1"}, body: {}, ...org },
  { name: "GET procurement/templates", handler: h73 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST procurement/templates", handler: h74 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
];

describe("route status matrix: procurement", () => {
  beforeAll(() => {
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("procurement", CASES)).toMatchFileSnapshot("./__snapshots__/procurement.matrix.txt");
  });
});
