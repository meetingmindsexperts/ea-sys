/**
 * Covered-by-group money gates (group review H1/H2/M6/B1, Aug 6 2026).
 *
 * The contract: a group member's fee is owed by the COMPANY on the
 * consolidated invoice — no surface may collect or chase it individually.
 * These pins cover the shared predicates + the export row builder so the
 * next audience/export change can't silently re-admit group members.
 */
import { describe, it, expect } from "vitest";
import { excludesGroupMembers } from "@/lib/bulk-email-audience";
import {
  buildInvoiceCsv,
  buildInvoiceQuickBooksCsv,
  exportBillTo,
  type InvoiceExportRow,
} from "@/lib/invoice-export";

describe("excludesGroupMembers (H2)", () => {
  it("payment-reminder excludes group members — unconditionally", () => {
    expect(excludesGroupMembers("payment-reminder")).toBe(true);
  });
  it.each(["confirmation", "reminder", "custom", "certificate", "survey-invitation", undefined])(
    "other types (%s) do not exclude",
    (t) => {
      expect(excludesGroupMembers(t)).toBe(false);
    },
  );
});

const GROUP_ROW: InvoiceExportRow = {
  invoiceNumber: "EV-INV-002",
  type: "INVOICE",
  status: "SENT",
  issueDate: new Date("2026-08-06"),
  dueDate: null,
  paidDate: null,
  subtotal: 350,
  discountAmount: 0,
  taxRate: 5,
  taxAmount: 17.5,
  total: 367.5,
  currency: "USD",
  event: { name: "BigSky 2027", city: "Fujairah" },
  group: {
    coordinatorName: "Layla Hassan",
    coordinatorEmail: "layla@corp.com",
    billingAccount: {
      name: "Gulf Heart Institute",
      email: "finance@corp.com",
      address: "SZR 12",
      city: "Dubai",
      country: "AE",
    },
  },
  registration: null,
};

const SINGLE_ROW: InvoiceExportRow = {
  ...GROUP_ROW,
  invoiceNumber: "EV-INV-001",
  group: null,
  registration: {
    billingAddress: null,
    billingCity: null,
    billingState: null,
    billingZipCode: null,
    billingCountry: null,
    ticketType: { name: "Physician" },
    pricingTier: { name: "Early Bird" },
    attendee: {
      title: "DR", firstName: "Huda", lastName: "Saleh", email: "huda@x.com",
      city: "Dubai", state: null, zipCode: null, country: "AE",
    },
  },
};

describe("invoice export with group invoices (B1 — the regression that 500'd)", () => {
  it("exportBillTo: payer for group rows, attendee for single rows", () => {
    expect(exportBillTo(GROUP_ROW)).toEqual({ name: "Gulf Heart Institute", email: "finance@corp.com" });
    expect(exportBillTo(SINGLE_ROW)).toEqual({ name: "Huda Saleh", email: "huda@x.com" });
  });

  it("plain CSV renders BOTH row kinds without throwing", () => {
    const csv = buildInvoiceCsv([SINGLE_ROW, GROUP_ROW]);
    expect(csv).toContain("Gulf Heart Institute");
    expect(csv).toContain("Huda Saleh");
    expect(csv).toContain("EV-INV-002");
  });

  it("QuickBooks CSV renders group rows with the payer address + consolidated line desc", () => {
    const csv = buildInvoiceQuickBooksCsv([SINGLE_ROW, GROUP_ROW]);
    expect(csv).toContain("Gulf Heart Institute");
    expect(csv).toContain("Group Registration");
    expect(csv).toContain("Physician - Early Bird");
    expect(csv).toContain("SZR 12");
  });
});
