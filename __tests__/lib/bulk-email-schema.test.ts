/**
 * bulkEmailSchema contract for the saved-custom-template send path.
 *
 * A "template" send carries the slug in filters.templateSlug so it survives the
 * schedule → worker round trip. The schema's superRefine enforces that the slug
 * is present, so a malformed payload is rejected before a ScheduledEmail row is
 * ever written (by either the immediate or the schedule route).
 */
import { describe, it, expect } from "vitest";
import { bulkEmailSchema } from "@/lib/bulk-email";

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
});
