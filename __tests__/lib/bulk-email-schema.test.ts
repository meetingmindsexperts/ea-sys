/**
 * bulkEmailSchema contract for the saved-custom-template send path.
 *
 * A "template" send carries the slug in filters.templateSlug so it survives the
 * schedule → worker round trip. The schema's superRefine enforces that the slug
 * is present, so a malformed payload is rejected before a ScheduledEmail row is
 * ever written (by either the immediate or the schedule route).
 */
import { describe, it, expect } from "vitest";
import { bulkEmailSchema, parsePaymentStatusFilter } from "@/lib/bulk-email";

const base = {
  recipientType: "registrations" as const,
  emailType: "template" as const,
};

describe("bulkEmailSchema — template send", () => {
  it("accepts a template send with filters.templateSlug", () => {
    const r = bulkEmailSchema.safeParse({
      ...base,
      filters: { templateSlug: "vip-welcome" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a template send with no filters at all", () => {
    const r = bulkEmailSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.flatten())).toContain("templateSlug");
    }
  });

  it("rejects a template send when filters omit templateSlug", () => {
    const r = bulkEmailSchema.safeParse({
      ...base,
      filters: { status: "CONFIRMED" },
    });
    expect(r.success).toBe(false);
  });

  it("does NOT require templateSlug for non-template types", () => {
    const r = bulkEmailSchema.safeParse({
      recipientType: "speakers",
      emailType: "invitation",
    });
    expect(r.success).toBe(true);
  });

  it("still accepts templateSlug alongside other filters", () => {
    const r = bulkEmailSchema.safeParse({
      ...base,
      filters: { templateSlug: "sponsor-thank-you", status: "CHECKED_IN" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a comma-separated multi-value paymentStatus filter", () => {
    const r = bulkEmailSchema.safeParse({
      recipientType: "registrations",
      emailType: "confirmation",
      filters: { paymentStatus: "PAID,COMPLIMENTARY,INCLUSIVE" },
    });
    expect(r.success).toBe(true);
  });
});

describe("bulkEmailSchema — certificate send", () => {
  const certBase = {
    recipientType: "registrations" as const,
    emailType: "certificate" as const,
  };

  it("accepts a certificate send with filters.certificateTemplateIds", () => {
    const r = bulkEmailSchema.safeParse({
      ...certBase,
      filters: { certificateTemplateIds: ["tpl-1", "tpl-2"] },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a certificate send with no filters at all", () => {
    const r = bulkEmailSchema.safeParse(certBase);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.flatten())).toContain("certificateTemplateIds");
    }
  });

  it("rejects a certificate send with an empty template list", () => {
    const r = bulkEmailSchema.safeParse({
      ...certBase,
      filters: { certificateTemplateIds: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects more than 5 templates", () => {
    const r = bulkEmailSchema.safeParse({
      ...certBase,
      filters: { certificateTemplateIds: ["a", "b", "c", "d", "e", "f"] },
    });
    expect(r.success).toBe(false);
  });

  it("does NOT require certificateTemplateIds for other types", () => {
    const r = bulkEmailSchema.safeParse({
      recipientType: "registrations",
      emailType: "confirmation",
    });
    expect(r.success).toBe(true);
  });

  it("accepts the speakers recipient type for certificate sends", () => {
    const r = bulkEmailSchema.safeParse({
      recipientType: "speakers",
      emailType: "certificate",
      filters: { certificateTemplateIds: ["tpl-1"] },
    });
    expect(r.success).toBe(true);
  });
});

describe("parsePaymentStatusFilter", () => {
  it("parses a single value", () => {
    expect(parsePaymentStatusFilter("PAID")).toEqual(["PAID"]);
  });

  it("parses a comma-separated multi-value list", () => {
    expect(parsePaymentStatusFilter("PAID,COMPLIMENTARY,INCLUSIVE")).toEqual([
      "PAID",
      "COMPLIMENTARY",
      "INCLUSIVE",
    ]);
  });

  it("trims whitespace and drops blanks + invalid values", () => {
    expect(parsePaymentStatusFilter("PAID, , JUNK ,UNPAID")).toEqual(["PAID", "UNPAID"]);
  });

  it("returns [] for undefined, empty, or \"all\" (no filter)", () => {
    expect(parsePaymentStatusFilter(undefined)).toEqual([]);
    expect(parsePaymentStatusFilter("")).toEqual([]);
    expect(parsePaymentStatusFilter("all")).toEqual([]);
  });
});
