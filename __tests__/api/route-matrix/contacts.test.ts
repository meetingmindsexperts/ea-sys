/**
 * Route status matrix, domain 11 of the Phase 2 sweep: the organisation's
 * contact store (list and create, a contact, its email change, bulk tags, the
 * tag list, export, CSV import and the EventsAir import). These routes are not
 * under an event, so each case runs once per caller (`perEvent: false`), and
 * most take an API key as well as a session (`getOrgContext`). Recorded on the
 * unswept code (Oct 5, 2026); the sweep onto `requirePermission` must leave it
 * byte for byte unchanged except where a change is intended and reviewed. See
 * ./harness.ts for what a cell means.
 *
 * Every network call fails here (`fetch` is stubbed to throw), so the
 * EventsAir import cannot reach EventsAir.
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
import { GET as listGET, POST as createPOST } from "@/app/api/contacts/route";
import { GET as detailGET, PUT as detailPUT, DELETE as detailDELETE } from "@/app/api/contacts/[contactId]/route";
import { PATCH as emailPATCH } from "@/app/api/contacts/[contactId]/email/route";
import { PATCH as bulkTagsPATCH } from "@/app/api/contacts/bulk-tags/route";
import { GET as tagsGET } from "@/app/api/contacts/tags/route";
import { GET as exportGET } from "@/app/api/contacts/export/route";
import { POST as importPOST } from "@/app/api/contacts/import/route";
import { POST as eventsAirPOST } from "@/app/api/contacts/import-eventsair/route";

const contact = { contactId: "ct1" };
const org = { perEvent: false } as const;

const CASES: HandlerCase[] = [
  { name: "GET contacts", handler: listGET, method: "GET", ...org },
  { name: "POST contacts", handler: createPOST, method: "POST", body: { email: "new@test.local", firstName: "New", lastName: "Contact" }, ...org },
  { name: "GET contacts/[contactId]", handler: detailGET, method: "GET", params: contact, ...org },
  { name: "PUT contacts/[contactId]", handler: detailPUT, method: "PUT", params: contact, body: { firstName: "Renamed" }, ...org },
  { name: "DELETE contacts/[contactId]", handler: detailDELETE, method: "DELETE", params: contact, ...org },
  { name: "PATCH contacts/[contactId]/email", handler: emailPATCH, method: "PATCH", params: contact, body: { newEmail: "moved@test.local" }, ...org },
  { name: "PATCH contacts/bulk-tags", handler: bulkTagsPATCH, method: "PATCH", body: { contactIds: ["ct1"], addTags: ["vip"] }, ...org },
  { name: "GET contacts/tags", handler: tagsGET, method: "GET", ...org },
  { name: "GET contacts/export", handler: exportGET, method: "GET", ...org },
  { name: "POST contacts/import (JSON, not multipart)", handler: importPOST, method: "POST", body: {}, ...org },
  { name: "POST contacts/import-eventsair", handler: eventsAirPOST, method: "POST", body: { eventsAirEventId: "ea1" }, ...org },
];

describe("route status matrix: contacts", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("contacts", CASES)).toMatchFileSnapshot("./__snapshots__/contacts.matrix.txt");
  });
});
