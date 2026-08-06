/**
 * Per-event rollup for a payer (BillingAccount): who they cover at each event,
 * what was invoiced, and what has actually been paid.
 *
 * Pure — no DB, no Prisma types — so the money rules are unit-testable on
 * their own. The route does the querying and hands the rows in.
 *
 * The three rules that are easy to get wrong:
 *
 *  1. PAID comes from PAYMENTS, not from invoice status or from summing
 *     registrations. A group is settled by ONE payment covering N members, so
 *     a per-registration sum under-reports it badly, and "the invoice says
 *     PAID" tells you nothing about a partial refund since.
 *
 *  2. RECEIPTs are excluded from "invoiced". A receipt is a record OF a
 *     payment, not an additional demand for money — counting it would double
 *     everything a company has actually settled.
 *
 *  3. Mixed currencies are never summed. If an event somehow carries two
 *     currencies for one payer, the totals are reported as null with
 *     `mixedCurrency: true`, rather than printing a number that means nothing.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

export interface PayerInvoiceRow {
  id: string;
  invoiceNumber: string;
  type: string; // InvoiceType
  status: string; // InvoiceStatus
  total: unknown; // Decimal
  currency: string;
  issueDate: Date | string;
  dueDate: Date | string | null;
  paidDate: Date | string | null;
  eventId: string;
  groupId: string | null;
  registrationId: string | null;
}

export interface PayerPaymentRow {
  id: string;
  amount: unknown; // Decimal
  refundedAmount: unknown; // Decimal
  currency: string;
  groupId: string | null;
  registration: { eventId: string } | null;
  group: { eventId: string } | null;
}

export interface PayerRegistrationRow {
  id: string;
  event: { id: string; name: string } | null;
  [key: string]: unknown;
}

export interface PayerAttachedEventRow {
  eventId: string;
  event: { id: string; name: string; startDate: Date | string; status: string } | null;
}

export interface PayerEventTotals {
  currency: string | null;
  mixedCurrency: boolean;
  /** Σ non-cancelled INVOICE totals. Receipts excluded (see rule 2). */
  invoiced: number | null;
  /** Σ non-cancelled CREDIT_NOTE totals. */
  credited: number | null;
  /** Σ (payment amount − refunded), i.e. money actually retained. */
  paid: number | null;
  refunded: number | null;
  /** invoiced − credited − paid. Negative means over-collected. */
  outstanding: number | null;
}

export interface PayerEventBreakdown {
  eventId: string;
  eventName: string;
  eventStartDate: Date | string | null;
  eventStatus: string | null;
  /** True when the payer is attached to the event but has nothing on it yet. */
  attachedOnly: boolean;
  registrations: PayerRegistrationRow[];
  invoices: PayerInvoiceRow[];
  totals: PayerEventTotals;
}

/** The event a payment belongs to, whichever side it hangs off. */
export function paymentEventId(p: PayerPaymentRow): string | null {
  return p.group?.eventId ?? p.registration?.eventId ?? null;
}

export function buildPayerEventBreakdown(input: {
  registrations: PayerRegistrationRow[];
  invoices: PayerInvoiceRow[];
  payments: PayerPaymentRow[];
  attachedEvents: PayerAttachedEventRow[];
}): PayerEventBreakdown[] {
  const { registrations, invoices, payments, attachedEvents } = input;

  type Bucket = {
    eventId: string;
    eventName: string;
    eventStartDate: Date | string | null;
    eventStatus: string | null;
    registrations: PayerRegistrationRow[];
    invoices: PayerInvoiceRow[];
    payments: PayerPaymentRow[];
  };
  const byEvent = new Map<string, Bucket>();

  const bucket = (eventId: string, name?: string): Bucket => {
    const existing = byEvent.get(eventId);
    if (existing) {
      // A later source may know the name when an earlier one didn't.
      if (name && !existing.eventName) existing.eventName = name;
      return existing;
    }
    const created: Bucket = {
      eventId,
      eventName: name ?? "",
      eventStartDate: null,
      eventStatus: null,
      registrations: [],
      invoices: [],
      payments: [],
    };
    byEvent.set(eventId, created);
    return created;
  };

  // Attachments first: they carry the richest event metadata, and an attached
  // event with no activity should still appear (that IS the answer to "what
  // is this payer covering here?" — nothing yet).
  for (const a of attachedEvents) {
    const b = bucket(a.eventId, a.event?.name);
    b.eventStartDate = a.event?.startDate ?? null;
    b.eventStatus = a.event?.status ?? null;
  }
  for (const r of registrations) {
    if (!r.event) continue;
    bucket(r.event.id, r.event.name).registrations.push(r);
  }
  for (const inv of invoices) {
    bucket(inv.eventId).invoices.push(inv);
  }
  for (const p of payments) {
    const eventId = paymentEventId(p);
    if (!eventId) continue;
    bucket(eventId).payments.push(p);
  }

  const rows: PayerEventBreakdown[] = [];
  for (const b of byEvent.values()) {
    const liveInvoices = b.invoices.filter((i) => i.status !== "CANCELLED");

    const currencies = new Set<string>([
      ...liveInvoices.map((i) => i.currency),
      ...b.payments.map((p) => p.currency),
    ]);
    const mixedCurrency = currencies.size > 1;
    const currency = currencies.size === 1 ? [...currencies][0] : null;

    let totals: PayerEventTotals;
    if (mixedCurrency) {
      totals = {
        currency: null, mixedCurrency: true,
        invoiced: null, credited: null, paid: null, refunded: null, outstanding: null,
      };
    } else {
      const invoiced = round2(
        liveInvoices
          .filter((i) => i.type === "INVOICE")
          .reduce((s, i) => s + num(i.total), 0),
      );
      const credited = round2(
        liveInvoices
          .filter((i) => i.type === "CREDIT_NOTE")
          .reduce((s, i) => s + num(i.total), 0),
      );
      const refunded = round2(
        b.payments.reduce((s, p) => s + num(p.refundedAmount), 0),
      );
      const paid = round2(
        b.payments.reduce((s, p) => s + num(p.amount) - num(p.refundedAmount), 0),
      );
      totals = {
        currency,
        mixedCurrency: false,
        invoiced,
        credited,
        paid,
        refunded,
        outstanding: round2(invoiced - credited - paid),
      };
    }

    rows.push({
      eventId: b.eventId,
      eventName: b.eventName || "Untitled event",
      eventStartDate: b.eventStartDate,
      eventStatus: b.eventStatus,
      attachedOnly: b.registrations.length === 0 && b.invoices.length === 0,
      registrations: b.registrations,
      invoices: b.invoices,
      totals,
    });
  }

  // Events with activity first, then by start date (newest first), so a payer
  // with many attachments doesn't bury the ones that actually owe money.
  return rows.sort((a, z) => {
    if (a.attachedOnly !== z.attachedOnly) return a.attachedOnly ? 1 : -1;
    const at = a.eventStartDate ? new Date(a.eventStartDate).getTime() : 0;
    const zt = z.eventStartDate ? new Date(z.eventStartDate).getTime() : 0;
    return zt - at;
  });
}
