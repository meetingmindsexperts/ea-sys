/**
 * Adding members to an existing group (Phase 3b).
 *
 * The invoice decision is what these pin hardest, because getting it wrong
 * bills a company twice for the same person. One rule drives all four
 * situations: subtract whoever a SETTLED invoice already covers, cancel any
 * UNPAID invoice, bill the remainder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb, claimSeatsMock, claimEventSeatsMock, createGroupInvoiceMock,
  sendGroupInvoiceEmailMock, cancelInvoiceMock, sendMemberConfirmationMock,
  syncToContactMock, notifyMock,
} = vi.hoisted(() => ({
  mockDb: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    event: { findFirst: vi.fn() },
    ticketType: { findMany: vi.fn() },
    registration: { findFirst: vi.fn(), create: vi.fn() },
    registrationGroup: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn() },
    attendee: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  claimSeatsMock: vi.fn().mockResolvedValue(true),
  claimEventSeatsMock: vi.fn().mockResolvedValue(true),
  createGroupInvoiceMock: vi.fn(),
  sendGroupInvoiceEmailMock: vi.fn().mockResolvedValue(undefined),
  cancelInvoiceMock: vi.fn().mockResolvedValue({}),
  sendMemberConfirmationMock: vi.fn(),
  syncToContactMock: vi.fn().mockResolvedValue(undefined),
  notifyMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/registration-serial", () => {
  let n = 200;
  return { getNextSerialId: vi.fn().mockImplementation(async () => ++n) };
});
vi.mock("@/lib/registration-seat-db", () => ({
  claimSeats: claimSeatsMock,
  claimEventSeats: claimEventSeatsMock,
}));
vi.mock("@/services/billing-account-service", () => ({
  findOrCreateBillingAccount: vi.fn(),
}));
vi.mock("@/services/registration-service", () => ({
  CONFIRMATION_EVENT_SELECT: { id: true, name: true },
  sendRegistrationConfirmationEmail: sendMemberConfirmationMock,
}));
vi.mock("@/lib/invoice-service", () => ({
  createGroupInvoice: createGroupInvoiceMock,
  sendGroupInvoiceEmail: sendGroupInvoiceEmailMock,
  cancelInvoice: cancelInvoiceMock,
}));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: syncToContactMock }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifyMock }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue(null),
  renderAndWrap: vi.fn().mockReturnValue({ html: "", text: "" }),
  brandingFrom: vi.fn().mockReturnValue({}),
}));

import { addGroupMembers } from "@/services/group-registration-service";

const COORDINATOR = "user_coord";
const GROUP_ID = "grp_1";
const EVENT_ID = "evt_1";
const ORG_ID = "org_1";

/** Existing live members of the group before the add. */
function groupRow(
  registrations: Array<{ id: string; status: string }> = [
    { id: "reg_old_1", status: "CONFIRMED" },
    { id: "reg_old_2", status: "CONFIRMED" },
  ],
) {
  return {
    id: GROUP_ID,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    coordinatorEmail: "coord@acme.test",
    coordinatorName: "Coord Person",
    billingAccountId: "ba_1",
    payerReference: "PO-1",
    billingAccount: { id: "ba_1", name: "Acme Ltd" },
    registrations,
  };
}

function ticketType(overrides: Record<string, unknown> = {}) {
  return {
    id: "tt_1",
    name: "Physician",
    price: 100,
    currency: "USD",
    salesStart: null,
    salesEnd: null,
    requiresApproval: false,
    isFaculty: false,
    pricingTiers: [],
    ...overrides,
  };
}

function newMember(email = "new1@acme.test") {
  return {
    ticketTypeId: "tt_1",
    attendee: { firstName: "New", lastName: "Person", email },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimSeatsMock.mockResolvedValue(true);
  claimEventSeatsMock.mockResolvedValue(true);
  cancelInvoiceMock.mockResolvedValue({});
  sendGroupInvoiceEmailMock.mockResolvedValue(undefined);

  mockDb.registrationGroup.findFirst.mockResolvedValue(groupRow());
  mockDb.event.findFirst.mockResolvedValue({
    id: EVENT_ID,
    name: "Test Event",
    settings: { groupRegistration: { enabled: true, minMembers: 2, maxMembers: 10 } },
    emailFromAddress: null,
    emailFromName: null,
    taxRate: null,
  });
  mockDb.ticketType.findMany.mockResolvedValue([ticketType()]);
  // Branch on the QUERY SHAPE rather than call order: `mockResolvedValueOnce`
  // queues accumulate across beforeEach runs, so an order-based mock leaks a
  // stale value into a later test's duplicate check.
  mockDb.registration.findFirst.mockImplementation(
    async (args: { select?: Record<string, unknown> }) =>
      args?.select?.ticketType
        ? { ticketType: { currency: "USD" } } // group-currency probe
        : null, // duplicate probe: nobody already registered
  );
  mockDb.attendee.create.mockResolvedValue({ id: "att_new" });
  mockDb.registration.create.mockResolvedValue({ id: "reg_new_1", serialId: 201 });
  mockDb.invoice.findMany.mockResolvedValue([]);
  createGroupInvoiceMock.mockResolvedValue({ id: "inv_new", invoiceNumber: "INV-002" });
});

describe("addGroupMembers — access + guards", () => {
  it("a group the user does not coordinate is a 404-shaped miss, not a 403", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue(null);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: "someone_else",
      members: [newMember()],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("GROUP_NOT_FOUND");
    // Nothing was created for a group we don't own.
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("the ownership predicate binds coordinatorUserId, not organizationId", async () => {
    await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    const where = mockDb.registrationGroup.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: GROUP_ID, coordinatorUserId: COORDINATOR });
    // A REGISTRANT is org-null — scoping on org here would match nothing.
    expect(where).not.toHaveProperty("organizationId");
  });

  it("refuses to exceed the event's configured group cap, counting live members", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue(
      groupRow(
        Array.from({ length: 9 }, (_, i) => ({ id: `reg_${i}`, status: "CONFIRMED" })),
      ),
    );

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember("a@x.test"), newMember("b@x.test")],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("GROUP_SIZE_OUT_OF_BOUNDS");
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("a cancelled member frees their slot against the cap", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue(
      groupRow([
        ...Array.from({ length: 9 }, (_, i) => ({ id: `reg_${i}`, status: "CONFIRMED" })),
        { id: "reg_gone", status: "CANCELLED" },
      ]),
    );

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
  });

  it("rejects a person already registered for the event", async () => {
    mockDb.registration.findFirst.mockImplementation(
      async (args: { select?: Record<string, unknown> }) =>
        args?.select?.ticketType
          ? { ticketType: { currency: "USD" } }
          : { attendee: { email: "dupe@acme.test" } },
    );

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember("dupe@acme.test")],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ALREADY_REGISTERED");
  });

  it("refuses a registration type in a different currency from the group's", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([ticketType({ currency: "EUR" })]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MIXED_CURRENCY");
  });

  it("a sold-out seat rolls the whole addition back and raises no invoice", async () => {
    claimSeatsMock.mockResolvedValue(false);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("SOLD_OUT");
    expect(createGroupInvoiceMock).not.toHaveBeenCalled();
    expect(cancelInvoiceMock).not.toHaveBeenCalled();
  });
});

describe("addGroupMembers — which invoice gets raised", () => {
  it("no invoice yet (create-time failure): bills everyone, cancels nothing", async () => {
    mockDb.invoice.findMany.mockResolvedValue([]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    expect(cancelInvoiceMock).not.toHaveBeenCalled();
    expect(createGroupInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationIds: ["reg_old_1", "reg_old_2", "reg_new_1"],
      }),
    );
  });

  it("an UNPAID invoice is cancelled and reissued covering everyone", async () => {
    mockDb.invoice.findMany.mockResolvedValue([
      { id: "inv_old", status: "SENT", coveredRegistrationIds: ["reg_old_1", "reg_old_2"] },
    ]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.reissued).toBe(true);
    expect(cancelInvoiceMock).toHaveBeenCalledWith("inv_old", expect.any(Object));
    expect(createGroupInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationIds: ["reg_old_1", "reg_old_2", "reg_new_1"],
      }),
    );
  });

  it("a PAID invoice is never cancelled; the new arrivals get their own invoice", async () => {
    mockDb.invoice.findMany.mockResolvedValue([
      { id: "inv_paid", status: "PAID", coveredRegistrationIds: ["reg_old_1", "reg_old_2"] },
    ]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.reissued).toBe(false);
    expect(cancelInvoiceMock).not.toHaveBeenCalled();
    // ONLY the new person — billing reg_old_* again would charge Acme twice.
    expect(createGroupInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ registrationIds: ["reg_new_1"] }),
    );
  });

  it("with a PAID and an UNPAID invoice, the paid people are never re-billed", async () => {
    mockDb.registrationGroup.findFirst.mockResolvedValue(
      groupRow([
        { id: "reg_paid", status: "CONFIRMED" },
        { id: "reg_unpaid", status: "CONFIRMED" },
      ]),
    );
    mockDb.invoice.findMany.mockResolvedValue([
      { id: "inv_paid", status: "PAID", coveredRegistrationIds: ["reg_paid"] },
      { id: "inv_open", status: "OVERDUE", coveredRegistrationIds: ["reg_unpaid"] },
    ]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    // Only the unpaid one is cancelled.
    expect(cancelInvoiceMock).toHaveBeenCalledTimes(1);
    expect(cancelInvoiceMock).toHaveBeenCalledWith("inv_open", expect.any(Object));
    // The settled person is excluded; the unpaid one and the newcomer are billed.
    const billed = createGroupInvoiceMock.mock.calls[0][0].registrationIds;
    expect(billed).toEqual(["reg_unpaid", "reg_new_1"]);
    expect(billed).not.toContain("reg_paid");
  });

  it("a legacy PAID invoice with no recorded coverage still shields its members", async () => {
    // Pre-dates coveredRegistrationIds — empty means "everyone who existed
    // then", i.e. the members present before this add.
    mockDb.invoice.findMany.mockResolvedValue([
      { id: "inv_legacy", status: "PAID", coveredRegistrationIds: [] },
    ]);

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    expect(createGroupInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ registrationIds: ["reg_new_1"] }),
    );
  });

  it("an invoice failure is isolated — the members stand and admins are alerted", async () => {
    createGroupInvoiceMock.mockRejectedValue(new Error("pdf exploded"));

    const res = await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.addedCount).toBe(1);
      expect(res.result.invoiceNumber).toBeNull();
    }
    expect(notifyMock).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ title: expect.stringContaining("invoice") }),
    );
  });
});

describe("addGroupMembers — member rows", () => {
  it("new members inherit the group's payer and are never dunned individually", async () => {
    await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
    });

    const data = mockDb.registration.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      groupId: GROUP_ID,
      createdSource: "GROUP_REGISTER",
      paymentStatus: "UNPAID",
      billingAccountId: "ba_1",
      payerReference: "PO-1",
    });

    // Confirmation says "covered by the payer" instead of offering Pay Now.
    expect(sendMemberConfirmationMock).toHaveBeenCalledWith(
      expect.objectContaining({ coveredByGroupPayerName: "Acme Ltd" }),
    );
  });

  it("records who added whom, for the audit trail", async () => {
    await addGroupMembers({
      groupId: GROUP_ID,
      coordinatorUserId: COORDINATOR,
      members: [newMember()],
      requestIp: "203.0.113.9",
    });

    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "RegistrationGroup",
          entityId: GROUP_ID,
          userId: COORDINATOR,
          ipAddress: "203.0.113.9",
          changes: expect.objectContaining({ addedCount: 1 }),
        }),
      }),
    );
  });
});
