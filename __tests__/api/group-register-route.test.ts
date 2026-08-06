/**
 * Public group-register route (Phase 1, Aug 6, 2026) — the door.
 *
 * Pins: enablement 403, coordinator-attending consistency 400s, the
 * existing-account bad-credentials 401 (abstract-start pattern), new-account
 * creation → service receives the userId, service error-code → HTTP status
 * mapping, and the 201 success shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const { mockDb, createGroupMock, notifyMock, sendVerifyMock } = vi.hoisted(() => ({
  mockDb: {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    event: { findFirst: vi.fn() },
  },
  createGroupMock: vi.fn(),
  notifyMock: vi.fn().mockResolvedValue(undefined),
  sendVerifyMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: () => null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: vi.fn(async (_req: unknown, slug: string) => ({ slug })),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/email-verification", () => ({ sendEmailVerification: sendVerifyMock }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifyMock }));
vi.mock("@/services/group-registration-service", () => ({
  createGroupRegistration: createGroupMock,
}));

import { POST } from "@/app/api/public/events/[slug]/group-register/route";

const params = { params: Promise.resolve({ slug: "BIGSKY2027" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/public/events/BIGSKY2027/group-register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const EVENT = {
  id: "ev1",
  name: "BigSky 2027",
  organizationId: "org1",
  slug: "BIGSKY2027",
  settings: { groupRegistration: { enabled: true, minMembers: 2, maxMembers: 10 } },
};

const memberAttendee = (email: string) => ({
  firstName: "A", lastName: "B", email,
  organization: "Clinic", jobTitle: "Doc", phone: "1", city: "Dubai",
  country: "AE", role: "PHYSICIAN", specialty: "Cardiology",
});

const BODY = {
  coordinator: {
    firstName: "Sarah", lastName: "M", email: "sarah@corp.com",
    password: "password123", attending: true,
  },
  payer: { name: "Cleveland Clinic" },
  members: [
    { ticketTypeId: "tt1", attendee: memberAttendee("sarah@corp.com") },
    { ticketTypeId: "tt1", attendee: memberAttendee("b@corp.com") },
  ],
};

const GROUP_OK = {
  ok: true,
  group: {
    groupId: "grp1", billingAccountId: "ba1", memberCount: 2,
    subtotal: 200, currency: "USD", invoiceNumber: "BS-INV-001",
    members: [
      { registrationId: "r1", serialId: 101, email: "sarah@corp.com", firstName: "Sarah", lastName: "M", ticketTypeName: "Physician", price: 100 },
      { registrationId: "r2", serialId: 102, email: "b@corp.com", firstName: "A", lastName: "B", ticketTypeName: "Physician", price: 100 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.user.create.mockResolvedValue({ id: "u-new" });
  mockDb.user.update.mockResolvedValue({});
  createGroupMock.mockResolvedValue(GROUP_OK);
});

describe("POST /group-register — gates", () => {
  it("403 GROUP_DISABLED when the event hasn't enabled groups", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: {} });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GROUP_DISABLED");
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("403 REGISTRATION_CLOSED when the master switch is off", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT,
      settings: { ...EVENT.settings, registrationOpen: false },
    });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("REGISTRATION_CLOSED");
  });

  it("400 COORDINATOR_MEMBER_MISSING — attending but not in the member list", async () => {
    const body = { ...BODY, members: [
      { ticketTypeId: "tt1", attendee: memberAttendee("x@corp.com") },
      { ticketTypeId: "tt1", attendee: memberAttendee("y@corp.com") },
    ]};
    const res = await POST(req(body), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("COORDINATOR_MEMBER_MISSING");
  });

  it("400 COORDINATOR_MEMBER_CONFLICT — not attending but listed as a member", async () => {
    const body = { ...BODY, coordinator: { ...BODY.coordinator, attending: false } };
    const res = await POST(req(body), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("COORDINATOR_MEMBER_CONFLICT");
  });

  it("400 on a member missing the required public field-set", async () => {
    const bad = { ...BODY, members: [
      BODY.members[0],
      { ticketTypeId: "tt1", attendee: { ...memberAttendee("b@corp.com"), organization: "" } },
    ]};
    const res = await POST(req(bad), params);
    expect(res.status).toBe(400);
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("404 when the event doesn't resolve", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(404);
  });
});

describe("POST /group-register — coordinator account", () => {
  it("401 BAD_CREDENTIALS for an existing account with the wrong password", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "u1",
      passwordHash: await bcrypt.hash("other-password", 4),
      termsAcceptedAt: new Date(),
    });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("BAD_CREDENTIALS");
    expect(createGroupMock).not.toHaveBeenCalled();
  });

  it("existing account + correct password → service gets that userId", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "u-existing",
      passwordHash: await bcrypt.hash("password123", 4),
      termsAcceptedAt: new Date(),
    });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(201);
    expect(createGroupMock.mock.calls[0][0].coordinatorUserId).toBe("u-existing");
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("new email → REGISTRANT account created (org-null for external) + service gets the id", async () => {
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(201);
    const created = mockDb.user.create.mock.calls[0][0].data;
    expect(created.role).toBe("REGISTRANT");
    expect(created.organizationId).toBeNull();
    expect(createGroupMock.mock.calls[0][0].coordinatorUserId).toBe("u-new");
  });
});

describe("POST /group-register — service mapping", () => {
  it("maps SOLD_OUT to 409", async () => {
    createGroupMock.mockResolvedValue({ ok: false, code: "SOLD_OUT", message: "sold out" });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(409);
  });

  it("maps GROUP_SIZE_OUT_OF_BOUNDS to 400 with meta", async () => {
    createGroupMock.mockResolvedValue({
      ok: false, code: "GROUP_SIZE_OUT_OF_BOUNDS", message: "too big",
      meta: { minMembers: 2, maxMembers: 10 },
    });
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(400);
    expect((await res.json()).meta.maxMembers).toBe(10);
  });

  it("201 success shape: groupId + invoiceNumber + per-member serials", async () => {
    const res = await POST(req(BODY), params);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      groupId: "grp1",
      memberCount: 2,
      invoiceNumber: "BS-INV-001",
    });
    expect(body.members[0].serialId).toBe(101);
  });
});
