/**
 * Per-event payer rollup.
 *
 * The three rules worth pinning, because each one is a way to tell a company
 * the wrong thing about its own money: paid comes from PAYMENTS (a group is
 * one payment for many people), receipts are not additional demands for money,
 * and mixed currencies are never summed.
 */
import { describe, it, expect } from "vitest";
import { buildPayerEventBreakdown, paymentEventId } from "@/lib/payer-breakdown";

const EV = { id: "ev1", name: "Cardiology 2027" };

function reg(id: string, eventId = EV.id, eventName = EV.name) {
  return { id, event: { id: eventId, name: eventName } };
}

function invoice(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv1",
    invoiceNumber: "INV-001",
    type: "INVOICE",
    status: "SENT",
    total: 1000,
    currency: "USD",
    issueDate: new Date("2026-08-01"),
    dueDate: null,
    paidDate: null,
    eventId: EV.id,
    groupId: null,
    registrationId: "r1",
    ...over,
  } as never;
}

function payment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pay1",
    amount: 1000,
    refundedAmount: 0,
    currency: "USD",
    groupId: null,
    registration: { eventId: EV.id },
    group: null,
    ...over,
  } as never;
}

const base = {
  registrations: [],
  invoices: [],
  payments: [],
  attachedEvents: [],
};

describe("paymentEventId", () => {
  it("resolves a GROUP payment via the group, not the registration", () => {
    // A group payment has registrationId null by design — one charge, N people.
    expect(
      paymentEventId(payment({ registration: null, group: { eventId: "evG" } })),
    ).toBe("evG");
  });

  it("resolves a single-registration payment via the registration", () => {
    expect(paymentEventId(payment())).toBe(EV.id);
  });

  it("returns null when a payment hangs off neither", () => {
    expect(paymentEventId(payment({ registration: null, group: null }))).toBeNull();
  });
});

describe("buildPayerEventBreakdown — money", () => {
  it("outstanding is what was invoiced minus credits minus what was paid", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [invoice({ total: 1000 })],
      payments: [payment({ amount: 400 })],
    });

    expect(row.totals).toMatchObject({
      currency: "USD",
      invoiced: 1000,
      credited: 0,
      paid: 400,
      outstanding: 600,
    });
  });

  it("a CANCELLED invoice is not money owed", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [
        invoice({ id: "a", total: 1000, status: "CANCELLED" }),
        invoice({ id: "b", invoiceNumber: "INV-002", total: 250 }),
      ],
    });

    expect(row.totals.invoiced).toBe(250);
    expect(row.totals.outstanding).toBe(250);
  });

  it("a RECEIPT is not an additional demand for money", () => {
    // A receipt records a payment already counted; adding it would double the
    // amount the company appears to owe.
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [
        invoice({ total: 500 }),
        invoice({ id: "rc", invoiceNumber: "REC-001", type: "RECEIPT", total: 500, status: "PAID" }),
      ],
      payments: [payment({ amount: 500 })],
    });

    expect(row.totals.invoiced).toBe(500);
    expect(row.totals.paid).toBe(500);
    expect(row.totals.outstanding).toBe(0);
  });

  it("a credit note reduces what is owed", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [
        invoice({ total: 1000 }),
        invoice({ id: "cn", invoiceNumber: "CN-001", type: "CREDIT_NOTE", total: 200 }),
      ],
    });

    expect(row.totals.credited).toBe(200);
    expect(row.totals.outstanding).toBe(800);
  });

  it("paid is net of refunds, and the refund is reported separately", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [invoice({ total: 1000 })],
      payments: [payment({ amount: 1000, refundedAmount: 300 })],
    });

    expect(row.totals.paid).toBe(700);
    expect(row.totals.refunded).toBe(300);
    expect(row.totals.outstanding).toBe(300);
  });

  it("ONE group payment covering many people counts once, in full", () => {
    // The under-reporting trap: three members, one charge. Summing
    // per-registration would show a third of what the company actually paid.
    const [row] = buildPayerEventBreakdown({
      ...base,
      registrations: [reg("r1"), reg("r2"), reg("r3")],
      invoices: [invoice({ total: 3000, registrationId: null, groupId: "g1" })],
      payments: [
        payment({ amount: 3000, registration: null, group: { eventId: EV.id }, groupId: "g1" }),
      ],
    });

    expect(row.totals.paid).toBe(3000);
    expect(row.totals.outstanding).toBe(0);
    expect(row.registrations).toHaveLength(3);
  });

  it("over-collection surfaces as a negative balance rather than being hidden", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [invoice({ total: 500 })],
      payments: [payment({ amount: 800 })],
    });

    expect(row.totals.outstanding).toBe(-300);
  });

  it("refuses to sum across currencies", () => {
    const [row] = buildPayerEventBreakdown({
      ...base,
      invoices: [
        invoice({ total: 1000, currency: "USD" }),
        invoice({ id: "b", invoiceNumber: "INV-002", total: 900, currency: "EUR" }),
      ],
    });

    expect(row.totals.mixedCurrency).toBe(true);
    expect(row.totals.invoiced).toBeNull();
    expect(row.totals.outstanding).toBeNull();
    expect(row.totals.currency).toBeNull();
  });
});

describe("buildPayerEventBreakdown — grouping", () => {
  it("splits registrations, invoices and payments by event", () => {
    const rows = buildPayerEventBreakdown({
      ...base,
      registrations: [reg("r1"), reg("r2", "ev2", "Nephrology 2027")],
      invoices: [
        invoice({ total: 100 }),
        invoice({ id: "i2", invoiceNumber: "INV-002", total: 700, eventId: "ev2" }),
      ],
      payments: [
        payment({ amount: 100 }),
        payment({ id: "p2", amount: 700, registration: { eventId: "ev2" } }),
      ],
      attachedEvents: [
        { eventId: EV.id, event: { ...EV, startDate: "2027-01-10", status: "PUBLISHED" } },
        { eventId: "ev2", event: { id: "ev2", name: "Nephrology 2027", startDate: "2027-03-01", status: "PUBLISHED" } },
      ],
    });

    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.eventId, r]));
    expect(byId[EV.id].totals.invoiced).toBe(100);
    expect(byId["ev2"].totals.invoiced).toBe(700);
    expect(byId["ev2"].registrations.map((r) => r.id)).toEqual(["r2"]);
  });

  it("an attached event with nothing on it still shows, flagged and sorted last", () => {
    const rows = buildPayerEventBreakdown({
      ...base,
      registrations: [reg("r1")],
      invoices: [invoice()],
      attachedEvents: [
        { eventId: EV.id, event: { ...EV, startDate: "2027-01-10", status: "PUBLISHED" } },
        { eventId: "ev9", event: { id: "ev9", name: "Future Event", startDate: "2028-01-01", status: "DRAFT" } },
      ],
    });

    // Newer start date, but no activity — must not bury the event that owes money.
    expect(rows.map((r) => r.eventId)).toEqual([EV.id, "ev9"]);
    expect(rows[1].attachedOnly).toBe(true);
    expect(rows[1].totals.invoiced).toBe(0);
  });

  it("an invoice for an event the payer is no longer attached to is still counted", () => {
    // Detaching a payer must never make historical money disappear.
    const rows = buildPayerEventBreakdown({
      ...base,
      invoices: [invoice({ total: 1000, eventId: "ev-old" })],
      attachedEvents: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("ev-old");
    expect(rows[0].totals.invoiced).toBe(1000);
  });
});
