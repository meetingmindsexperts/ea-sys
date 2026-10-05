/**
 * Route status matrix, domain 15 of the Phase 2 sweep, part B: the team list,
 * inviting a user, and reading, editing and removing one. The rules are dense
 * here (an ORGANIZER may only create and remove ONSITE accounts; anyone edits
 * their own name; HR access and procurement grants are SUPER_ADMIN only;
 * nobody deactivates or deletes themselves), so the cases cover each one.
 * Recorded on the unswept code (Oct 5, 2026); the sweep onto
 * `requirePermission` must leave it byte for byte unchanged except where a
 * change is intended and reviewed. See ./harness.ts for what a cell means.
 *
 * Changes re-recorded on purpose (Oct 5, 2026):
 *  - the team list and a colleague's record need `users.read` (SUPER_ADMIN,
 *    ADMIN, ORGANIZER, MEMBER; owner): ONSITE, WEBINARS, CRM_USER and HR_USER
 *    read them before, and an outside identity could open another account's
 *    record. Everyone still reads their OWN record (the profile page).
 *  - the platform operator gets a clean 403 instead of reaching invite, edit
 *    and delete with no organisation (a 500 from the write before).
 *
 * Fixture rows are on, so a user looked up by id resolves to the matching
 * caller's account (u-member, u-onsite). The email sender is mocked: an
 * invitation cannot leave the test.
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

import { domainMatrix, useFixtureRows, type HandlerCase } from "./harness";
import { GET as listGET, POST as invitePOST } from "@/app/api/organization/users/route";
import { GET as userGET, PUT as userPUT, DELETE as userDELETE } from "@/app/api/organization/users/[userId]/route";

const org = { perEvent: false } as const;
const member = { userId: "u-member" };
const onsite = { userId: "u-onsite" };
const invite = (role: string) => ({ email: `new-${role.toLowerCase()}@test.local`, firstName: "New", lastName: "Person", role });

const CASES: HandlerCase[] = [
  { name: "GET organization/users", handler: listGET, method: "GET", ...org },
  { name: "POST organization/users (invite ONSITE)", handler: invitePOST, method: "POST", body: invite("ONSITE"), ...org },
  { name: "POST organization/users (invite ADMIN)", handler: invitePOST, method: "POST", body: invite("ADMIN"), ...org },
  { name: "GET organization/users/[userId] (u-member)", handler: userGET, method: "GET", params: member, ...org },
  { name: "PUT organization/users/[userId] (u-member, name)", handler: userPUT, method: "PUT", params: member, body: { firstName: "Renamed" }, ...org },
  { name: "PUT organization/users/[userId] (u-onsite, name)", handler: userPUT, method: "PUT", params: onsite, body: { firstName: "Renamed" }, ...org },
  { name: "PUT organization/users/[userId] (u-member, role)", handler: userPUT, method: "PUT", params: member, body: { role: "ORGANIZER" }, ...org },
  { name: "PUT organization/users/[userId] (u-member, hrAccess)", handler: userPUT, method: "PUT", params: member, body: { hrAccess: true }, ...org },
  {
    name: "PUT organization/users/[userId] (u-member, procurement grant)",
    handler: userPUT,
    method: "PUT",
    params: member,
    body: { procurementRequest: true },
    ...org,
  },
  { name: "PUT organization/users/[userId] (u-member, deactivate)", handler: userPUT, method: "PUT", params: member, body: { deactivated: true }, ...org },
  { name: "DELETE organization/users/[userId] (u-onsite)", handler: userDELETE, method: "DELETE", params: onsite, ...org },
  { name: "DELETE organization/users/[userId] (u-member)", handler: userDELETE, method: "DELETE", params: member, ...org },
];

describe("route status matrix: organisation users (part B)", () => {
  beforeAll(() => {
    useFixtureRows();
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
    vi.stubEnv("HR_MODULE_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    useFixtureRows(false);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("organisation users (part B)", CASES)).toMatchFileSnapshot("./__snapshots__/org-users.matrix.txt");
  });
});
