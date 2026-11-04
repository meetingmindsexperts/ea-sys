/**
 * The details a signed-in person's next registration form starts from: their
 * latest registration's personal fields, and never billing, IDs or money.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { registration: { findFirst: vi.fn() } },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));

import { GET } from "@/app/api/registrant/profile/route";

async function get() {
  const res = await GET(new Request("http://x"));
  return { status: res.status, body: (await res.json()) as { profile?: Record<string, unknown> | null; error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "Anna@Example.com", role: "REGISTRANT" } });
});

describe("GET /api/registrant/profile", () => {
  it("refuses a signed-out request", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("returns null when the person has no registration", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await get()).body).toEqual({ profile: null });
  });

  it("reads the latest registration found by account or by email", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ attendee: { firstName: "Anna", country: "Oman" } });
    const r = await get();
    expect(r.body.profile).toEqual({ firstName: "Anna", country: "Oman" });
    const args = mockDb.registration.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ OR: [{ userId: "u1" }, { attendee: { email: "anna@example.com" } }] });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("selects personal fields only: no billing, IDs, document, additional email or money", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    await get();
    const args = mockDb.registration.findFirst.mock.calls[0][0];
    expect(Object.keys(args.select)).toEqual(["attendee"]);
    const fields = Object.keys(args.select.attendee.select);
    for (const never of ["email", "additionalEmail", "memberId", "studentId", "studentIdExpiry", "associationName", "photo", "customFields", "tags"]) {
      expect(fields).not.toContain(never);
    }
    expect(fields).toEqual(expect.arrayContaining(["firstName", "lastName", "organization", "phone", "country", "specialty"]));
  });
});
