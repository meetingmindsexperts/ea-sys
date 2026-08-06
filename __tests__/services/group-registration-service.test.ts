/**
 * Group-registration service (Phase 1, Aug 6, 2026) — the create transaction.
 *
 * What matters here: the enablement/bounds/duplicate/faculty/sales gates, the
 * all-or-nothing seat claims (SOLD_OUT / EVENT_FULL roll the WHOLE group
 * back), the member-row shape (groupId + GROUP_REGISTER + UNPAID + payer +
 * live-tier originalPrice + coordinator userId linking), and the post-commit
 * contract (invoice failure is isolated + admin-notified; members get the
 * covered-by confirmation, never Pay Now).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb, claimSeatsMock, claimEventSeatsMock, findOrCreatePayerMock,
  sendMemberConfirmationMock, createGroupInvoiceMock, sendGroupInvoiceEmailMock,
  syncToContactMock, notifyMock, sendEmailMock,
} = vi.hoisted(() => ({
  mockDb: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    event: { findFirst: vi.fn() },
    ticketType: { findMany: vi.fn() },
    eventBillingAccount: { upsert: vi.fn().mockResolvedValue({}) },
    registration: { findFirst: vi.fn(), create: vi.fn() },
    registrationGroup: { create: vi.fn() },
    attendee: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  claimSeatsMock: vi.fn().mockResolvedValue(true),
  claimEventSeatsMock: vi.fn().mockResolvedValue(true),
  findOrCreatePayerMock: vi.fn(),
  sendMemberConfirmationMock: vi.fn(),
  createGroupInvoiceMock: vi.fn(),
  sendGroupInvoiceEmailMock: vi.fn().mockResolvedValue(undefined),
  syncToContactMock: vi.fn().mockResolvedValue(undefined),
  notifyMock: vi.fn().mockResolvedValue(undefined),
  sendEmailMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown, opts?: unknown) => {
    (globalThis as Record<string, unknown>).__lastTxOpts = opts;
    return fn(mockDb);
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/registration-serial", () => {
  let n = 100;
  return { getNextSerialId: vi.fn().mockImplementation(async () => ++n) };
});
vi.mock("@/lib/registration-seat-db", () => ({
  claimSeats: claimSeatsMock,
  claimEventSeats: claimEventSeatsMock,
}));
vi.mock("@/services/billing-account-service", () => ({
  findOrCreateBillingAccount: findOrCreatePayerMock,
}));
vi.mock("@/services/registration-service", () => ({
  CONFIRMATION_EVENT_SELECT: { id: true, name: true },
  sendRegistrationConfirmationEmail: sendMemberConfirmationMock,
}));
vi.mock("@/lib/invoice-service", () => ({
  createGroupInvoice: createGroupInvoiceMock,
  sendGroupInvoiceEmail: sendGroupInvoiceEmailMock,
}));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: syncToContactMock }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifyMock }));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailMock,
  brandingFrom: (b: { emailFromAddress?: string | null; emailFromName?: string | null }) =>
    b.emailFromAddress ? { email: b.emailFromAddress, name: b.emailFromName || undefined } : undefined,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    slug: "group-registration-confirmation",
    name: "Group Registration Confirmation",
    subject: "Group Registration Received - {{eventName}}",
    htmlContent: "<p>{{coordinatorName}} {{memberSummary}} {{totalAmount}}</p>",
    textContent: "{{coordinatorName}} {{memberSummaryText}} {{totalAmount}}",
  }),
  renderAndWrap: (
    tpl: { subject: string; htmlContent: string; textContent: string },
    vars: Record<string, string | number>,
  ) => {
    const sub = (x: string) => x.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
    return { subject: sub(tpl.subject), htmlContent: sub(tpl.htmlContent), textContent: sub(tpl.textContent) };
  },
}));

import { createGroupRegistration } from "@/services/group-registration-service";

const EVENT = {
  id: "ev1",
  name: "BigSky 2027",
  slug: "BIGSKY2027",
  startDate: new Date("2027-03-01"),
  venue: "Expo",
  city: "Dubai",
  taxRate: 5,
  taxLabel: "VAT",
  organizationId: "org1",
  settings: { groupRegistration: { enabled: true, minMembers: 2, maxMembers: 10 } },
};

const FUTURE = new Date(Date.now() + 30 * 86400_000);
const PAST = new Date(Date.now() - 30 * 86400_000);

const PHYSICIAN_TYPE = {
  id: "tt-phys",
  name: "Physician",
  price: 200,
  currency: "USD",
  quantity: 100,
  soldCount: 0,
  salesStart: null,
  salesEnd: null,
  requiresApproval: false,
  isFaculty: false,
  pricingTiers: [
    {
      id: "tier-early", name: "Early Bird", price: 100, currency: "USD",
      quantity: 999999, soldCount: 0, isActive: true,
      salesStart: PAST, salesEnd: FUTURE, sortOrder: 0,
    },
  ],
};
const NURSE_TYPE = {
  id: "tt-nurse", name: "Nurse", price: 80, currency: "USD",
  quantity: 100, soldCount: 0, salesStart: null, salesEnd: null,
  requiresApproval: false, isFaculty: false, pricingTiers: [],
};

const member = (email: string, ticketTypeId = "tt-phys") => ({
  ticketTypeId,
  attendee: {
    firstName: "A", lastName: "B", email,
    organization: "Clinic", jobTitle: "Doc", phone: "1", city: "Dubai",
    country: "AE", role: "PHYSICIAN", specialty: "Cardiology",
  },
});

const BASE_INPUT = {
  eventId: "ev1",
  organizationId: "org1",
  coordinatorUserId: "u-coord",
  coordinator: { name: "Sarah M", email: "sarah@corp.com" },
  coordinatorAttending: true,
  payer: { name: "Cleveland Clinic" },
  payerReference: "PO-9",
  members: [member("sarah@corp.com"), member("b@corp.com", "tt-nurse")],
  requestIp: "1.2.3.4",
};

beforeEach(() => {
  vi.clearAllMocks();
  claimSeatsMock.mockResolvedValue(true);
  claimEventSeatsMock.mockResolvedValue(true);
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.ticketType.findMany.mockResolvedValue([PHYSICIAN_TYPE, NURSE_TYPE]);
  mockDb.eventBillingAccount.upsert.mockResolvedValue({});
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.registrationGroup.create.mockResolvedValue({ id: "grp1" });
  let a = 0;
  mockDb.attendee.create.mockImplementation(async () => ({ id: `att-${++a}` }));
  let r = 0;
  mockDb.registration.create.mockImplementation(async ({ data }: { data: { serialId: number } }) => ({
    id: `reg-${++r}`,
    serialId: data.serialId,
  }));
  mockDb.auditLog.create.mockResolvedValue({});
  findOrCreatePayerMock.mockResolvedValue({
    ok: true,
    billingAccount: { id: "ba1", name: "Cleveland Clinic" },
    reused: false,
    flaggedReview: false,
  });
  createGroupInvoiceMock.mockResolvedValue({ id: "inv1", invoiceNumber: "BS-INV-001" });
});

describe("createGroupRegistration — gates", () => {
  it("GROUP_DISABLED when the event hasn't enabled groups", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: {} });
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "GROUP_DISABLED" });
  });

  it("GROUP_SIZE_OUT_OF_BOUNDS below the organizer's min", async () => {
    const res = await createGroupRegistration({ ...BASE_INPUT, members: [member("solo@x.com")] });
    expect(res).toMatchObject({ ok: false, code: "GROUP_SIZE_OUT_OF_BOUNDS" });
  });

  it("DUPLICATE_IN_GROUP on a repeated email (case-insensitive)", async () => {
    const res = await createGroupRegistration({
      ...BASE_INPUT,
      members: [member("dup@x.com"), member("DUP@x.com", "tt-nurse")],
    });
    expect(res).toMatchObject({ ok: false, code: "DUPLICATE_IN_GROUP" });
  });

  it("TICKET_TYPE_IS_FACULTY refuses the hidden companion type", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([{ ...PHYSICIAN_TYPE, isFaculty: true }, NURSE_TYPE]);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "TICKET_TYPE_IS_FACULTY" });
  });

  it("SALES_ENDED — public semantics, no staff override on this path", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([
      { ...PHYSICIAN_TYPE, salesEnd: PAST, pricingTiers: [] },
      NURSE_TYPE,
    ]);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "SALES_ENDED" });
  });

  it("ALREADY_REGISTERED when a member email holds a live registration", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ attendee: { email: "b@corp.com" } });
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "ALREADY_REGISTERED" });
    expect(mockDb.registration.create).not.toHaveBeenCalled();
  });

  it("SOLD_OUT when a type's bulk claim fails — nothing else is created", async () => {
    claimSeatsMock.mockResolvedValueOnce(false);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "SOLD_OUT" });
    expect(createGroupInvoiceMock).not.toHaveBeenCalled();
    expect(sendMemberConfirmationMock).not.toHaveBeenCalled();
  });

  it("EVENT_FULL when the event-wide cap refuses the whole group", async () => {
    claimEventSeatsMock.mockResolvedValue(false);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "EVENT_FULL" });
  });
});

describe("createGroupRegistration — review-fix pins (Aug 6)", () => {
  it("MIXED_CURRENCY: types in different currencies are refused (M3)", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([
      PHYSICIAN_TYPE,
      { ...NURSE_TYPE, currency: "AED" },
    ]);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res).toMatchObject({ ok: false, code: "MIXED_CURRENCY" });
  });

  it("H3: the tx takes the per-coordinator advisory lock before the dup check", async () => {
    await createGroupRegistration(BASE_INPUT);
    expect(mockDb.$queryRaw).toHaveBeenCalled();
    const call = mockDb.$queryRaw.mock.calls[0];
    // Tagged-template call: strings + the lock key value.
    expect(JSON.stringify(call)).toContain("pg_advisory_xact_lock");
    expect(JSON.stringify(call)).toContain("group-register:ev1:sarah@corp.com");
  });

  it("M5: the tx runs with an explicit 30s timeout", async () => {
    await createGroupRegistration(BASE_INPUT);
    expect((globalThis as Record<string, unknown>).__lastTxOpts).toMatchObject({ timeout: 30_000 });
  });

  it("M9: the existing-registration dup check compares emails case-insensitively", async () => {
    await createGroupRegistration(BASE_INPUT);
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"insensitive"');
  });
});

describe("createGroupRegistration — happy path", () => {
  it("creates group + members with the full row contract", async () => {
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Group row: org stamped, payer bound, coordinator snapshots.
    const groupData = mockDb.registrationGroup.create.mock.calls[0][0].data;
    expect(groupData).toMatchObject({
      eventId: "ev1",
      organizationId: "org1",
      coordinatorUserId: "u-coord",
      coordinatorEmail: "sarah@corp.com",
      billingAccountId: "ba1",
      payerReference: "PO-9",
    });

    // Seat claims: one per distinct type + one event-wide for the total.
    expect(claimSeatsMock).toHaveBeenCalledWith(expect.anything(), { kind: "ticketType", id: "tt-phys" }, 1);
    expect(claimSeatsMock).toHaveBeenCalledWith(expect.anything(), { kind: "ticketType", id: "tt-nurse" }, 1);
    expect(claimEventSeatsMock).toHaveBeenCalledWith(expect.anything(), "ev1", 2);

    // Member rows: groupId + GROUP_REGISTER + UNPAID + payer + live-tier price.
    const rows = mockDb.registration.create.mock.calls.map((c) => c[0].data);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        groupId: "grp1",
        createdSource: "GROUP_REGISTER",
        paymentStatus: "UNPAID",
        billingAccountId: "ba1",
        payerReference: "PO-9",
        organizationId: "org1",
      });
      expect(row.qrCode).toBeTruthy();
    }
    // Coordinator's own row links their account; the other member is account-less.
    expect(rows[0].userId).toBe("u-coord");
    expect(rows[1].userId).toBeNull();
    // Live tier price for Physician (Early Bird 100, not base 200); Nurse base 80.
    expect(rows[0].originalPrice).toBe(100);
    expect(rows[0].pricingTierId).toBe("tier-early");
    expect(rows[1].originalPrice).toBe(80);
    expect(rows[1].pricingTierId).toBeNull();

    expect(res.group.subtotal).toBe(180);
    expect(res.group.invoiceNumber).toBe("BS-INV-001");

    // Members get the covered-by confirmation (never Pay Now).
    expect(sendMemberConfirmationMock).toHaveBeenCalledTimes(2);
    for (const call of sendMemberConfirmationMock.mock.calls) {
      expect(call[0].coveredByGroupPayerName).toBe("Cleveland Clinic");
    }
    // Coordinator summary email fired.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // Payer attached to the event.
    expect(mockDb.eventBillingAccount.upsert).toHaveBeenCalled();
    // Contact sync per member.
    expect(syncToContactMock).toHaveBeenCalledTimes(2);
  });

  it("invoice failure is ISOLATED: group stands, admins are alerted, invoiceNumber null", async () => {
    createGroupInvoiceMock.mockRejectedValue(new Error("numbering down"));
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.group.invoiceNumber).toBeNull();
    expect(notifyMock).toHaveBeenCalledWith(
      "ev1",
      expect.objectContaining({ title: expect.stringContaining("Group invoice could not be created") }),
    );
  });

  it("a requiresApproval type puts that member in PENDING (public-register parity)", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([
      PHYSICIAN_TYPE,
      { ...NURSE_TYPE, requiresApproval: true },
    ]);
    const res = await createGroupRegistration(BASE_INPUT);
    expect(res.ok).toBe(true);
    const rows = mockDb.registration.create.mock.calls.map((c) => c[0].data);
    expect(rows[0].status).toBe("CONFIRMED");
    expect(rows[1].status).toBe("PENDING");
  });
});
