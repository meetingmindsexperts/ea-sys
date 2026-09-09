/**
 * Server-side audience count for abstract bulk sends (review HIGH 1, Sep 9, 2026).
 *
 * THE INVARIANT: the number the dialog shows is computed by the resolver's own
 * `where` and dedup, so count == send even for the rows staff cannot list
 * (drafts). Pinned by asserting the exact `where` the count issues for each
 * type, which is what the send issues too.
 *
 * MUTATIONS TO VERIFY AGAINST:
 *   - Build the count's where separately from the send's -> the reminder-where
 *     test fails the day the two drift.
 *   - Drop the lowercase in abstractAuthorKey -> the dedup test fails.
 *   - Drop assertAbstractTypeStatus from the count -> the INVALID_FILTER test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { auth, eventFindFirst, abstractFindMany, warn } = vi.hoisted(() => ({
  auth: vi.fn(),
  eventFindFirst: vi.fn(),
  abstractFindMany: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db: { event: { findFirst: eventFindFirst }, abstract: { findMany: abstractFindMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/events/[eventId]/emails/audience-count/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (qs: string) => new Request(`https://events.example.com/api/events/ev1/emails/audience-count?${qs}`);
const row = (id: string, email: string) => ({ id, speaker: { email } });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  eventFindFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  abstractFindMany.mockResolvedValue([]);
});

describe("access", () => {
  it("401s without a session", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(req("recipientType=abstracts&emailType=custom"), params)).status).toBe(401);
  });
  it("refuses MEMBER, the enqueue route's own boundary", async () => {
    auth.mockResolvedValue({ user: { id: "u2", role: "MEMBER", organizationId: "org1" } });
    expect((await GET(req("recipientType=abstracts&emailType=custom"), params)).status).toBe(403);
    expect(abstractFindMany).not.toHaveBeenCalled();
  });
  it("404s an event the caller cannot reach", async () => {
    eventFindFirst.mockResolvedValue(null);
    expect((await GET(req("recipientType=abstracts&emailType=custom"), params)).status).toBe(404);
  });
  it("400s any audience other than abstracts (the others count client-side)", async () => {
    const res = await GET(req("recipientType=registrations&emailType=custom"), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("UNSUPPORTED");
  });
});

describe("count == send", () => {
  it("a reminder counts DRAFT authors with the resolver's own where, which the list the dialog holds can never show", async () => {
    abstractFindMany.mockResolvedValue([row("d1", "dan@x.com"), row("d2", "dan@x.com"), row("d3", "eve@x.com")]);
    const res = await GET(req("recipientType=abstracts&emailType=abstract-reminder"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: "DRAFT" });
  });

  it("a confirmation counts one per abstract, excluding drafts and withdrawals by default", async () => {
    abstractFindMany.mockResolvedValue([row("a", "jane@x.com"), row("b", "jane@x.com")]);
    const res = await GET(req("recipientType=abstracts&emailType=abstract-confirmation"), params);
    expect((await res.json()).count).toBe(2);
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: { notIn: ["DRAFT", "WITHDRAWN"] } });
  });

  it("a custom email dedupes authors case-insensitively, as the send now does", async () => {
    abstractFindMany.mockResolvedValue([row("a", "jane@x.com"), row("b", "JANE@x.com "), row("c", "al@x.com")]);
    const res = await GET(req("recipientType=abstracts&emailType=custom"), params);
    expect((await res.json()).count).toBe(2);
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({ eventId: "ev1" });
  });

  it("ticked ids restrict the count inside the type's scope, exactly like recipientIds on the send", async () => {
    abstractFindMany.mockResolvedValue([row("a", "jane@x.com")]);
    const res = await GET(req("recipientType=abstracts&emailType=abstract-decision&recipientIds=a,b"), params);
    expect((await res.json()).count).toBe(1);
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({
      eventId: "ev1",
      id: { in: ["a", "b"] },
      status: { in: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"] },
    });
  });

  it("an explicit status replaces the default scope", async () => {
    abstractFindMany.mockResolvedValue([]);
    await GET(req("recipientType=abstracts&emailType=abstract-confirmation&status=ACCEPTED"), params);
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: "ACCEPTED" });
  });

  it("refuses a status the type cannot send with the precheck's INVALID_FILTER, so it never shows a number the send would refuse", async () => {
    const res = await GET(req("recipientType=abstracts&emailType=abstract-reminder&status=ACCEPTED"), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FILTER");
    expect(abstractFindMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_FILTER" }), "audience-count:invalid-filter");
  });
});
