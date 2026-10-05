/**
 * Route status matrix, domain 17 of the Phase 2 sweep: HR (every route
 * under /api/hr, with the HR module flag on; generated one case per exported handler with fixture ids
 * for the path parameters and an empty body, so a write shows its gate and
 * then its validation). Recorded on the unswept code (Oct 5, 2026); the sweep
 * of `denyNonHr` onto `can()` must leave it byte for byte
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
import { DELETE as h1 } from "@/app/api/hr/attendance-rules/[ruleId]/route";
import { GET as h2, POST as h3 } from "@/app/api/hr/attendance-rules/route";
import { GET as h4, PUT as h5, DELETE as h6 } from "@/app/api/hr/attendance/route";
import { GET as h7 } from "@/app/api/hr/balances/[employeeId]/route";
import { POST as h8 } from "@/app/api/hr/employees/[employeeId]/exit/route";
import { PATCH as h9 } from "@/app/api/hr/employees/[employeeId]/route";
import { GET as h10, POST as h11 } from "@/app/api/hr/employees/route";
import { DELETE as h12 } from "@/app/api/hr/holidays/[holidayId]/route";
import { GET as h13, POST as h14 } from "@/app/api/hr/holidays/route";
import { GET as h15 } from "@/app/api/hr/leave-codes/route";
import { POST as h16 } from "@/app/api/hr/leave-year/roll/route";
import { GET as h17 } from "@/app/api/hr/summary/route";

const org = { perEvent: false } as const;
// Some HR handlers take a NextRequest; the harness passes a plain Request, so
// a status of 0 marks one that threw past its own catch (recorded alike on
// both sides of the sweep).

const CASES: HandlerCase[] = [
  { name: "DELETE hr/attendance-rules/[ruleId]", handler: h1 as unknown as HandlerCase["handler"], method: "DELETE", params: {"ruleId": "rule1"}, ...org },
  { name: "GET hr/attendance-rules", handler: h2 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST hr/attendance-rules", handler: h3 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET hr/attendance", handler: h4 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "PUT hr/attendance", handler: h5 as unknown as HandlerCase["handler"], method: "PUT", body: {}, ...org },
  { name: "DELETE hr/attendance", handler: h6 as unknown as HandlerCase["handler"], method: "DELETE", ...org },
  { name: "GET hr/balances/[employeeId]", handler: h7 as unknown as HandlerCase["handler"], method: "GET", params: {"employeeId": "employee1"}, ...org },
  { name: "POST hr/employees/[employeeId]/exit", handler: h8 as unknown as HandlerCase["handler"], method: "POST", params: {"employeeId": "employee1"}, body: {}, ...org },
  { name: "PATCH hr/employees/[employeeId]", handler: h9 as unknown as HandlerCase["handler"], method: "PATCH", params: {"employeeId": "employee1"}, body: {}, ...org },
  { name: "GET hr/employees", handler: h10 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST hr/employees", handler: h11 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "DELETE hr/holidays/[holidayId]", handler: h12 as unknown as HandlerCase["handler"], method: "DELETE", params: {"holidayId": "holiday1"}, ...org },
  { name: "GET hr/holidays", handler: h13 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST hr/holidays", handler: h14 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET hr/leave-codes", handler: h15 as unknown as HandlerCase["handler"], method: "GET", ...org },
  { name: "POST hr/leave-year/roll", handler: h16 as unknown as HandlerCase["handler"], method: "POST", body: {}, ...org },
  { name: "GET hr/summary", handler: h17 as unknown as HandlerCase["handler"], method: "GET", ...org },
];

describe("route status matrix: HR", () => {
  beforeAll(() => {
    vi.stubEnv("HR_MODULE_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("HR", CASES)).toMatchFileSnapshot("./__snapshots__/hr.matrix.txt");
  });
});
