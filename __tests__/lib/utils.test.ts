import { describe, it, expect } from "vitest";
import {
  cn,
  slugify,
  normalizeTag,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatTime,
  formatDateRange,
  formatDateLong,
  formatPersonName,
  getTitleLabel,
  generateQRCode,
} from "@/lib/utils";

// ── cn (tailwind class merge) ──────────────────────────────────────────────

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4");
  });

  it("deduplicates conflicting tailwind classes", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("filters falsy values", () => {
    expect(cn("base", false && "hidden", "active")).toBe("base active");
  });

  it("handles undefined and null", () => {
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });
});

// ── slugify ────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts basic text to slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(slugify("Event #1 @ Dubai!")).toBe("event-1-dubai");
  });

  it("collapses multiple spaces and hyphens", () => {
    expect(slugify("a   b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify(" -hello- ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles underscores", () => {
    expect(slugify("snake_case_name")).toBe("snake-case-name");
  });
});

// ── normalizeTag ───────────────────────────────────────────────────────────

describe("normalizeTag", () => {
  it("converts to title case", () => {
    expect(normalizeTag("machine learning")).toBe("Machine Learning");
  });

  it("collapses extra whitespace", () => {
    expect(normalizeTag("  hello   world  ")).toBe("Hello World");
  });

  it("handles all caps", () => {
    expect(normalizeTag("AI RESEARCH")).toBe("Ai Research");
  });

  it("handles single word", () => {
    expect(normalizeTag("cardiology")).toBe("Cardiology");
  });

  it("preserves already normalized text", () => {
    expect(normalizeTag("Data Science")).toBe("Data Science");
  });
});

// ── formatCurrency ─────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("formats USD by default", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });

  it("formats EUR", () => {
    expect(formatCurrency(1000, "EUR")).toBe("€1,000.00");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats large numbers", () => {
    expect(formatCurrency(1000000)).toBe("$1,000,000.00");
  });
});

// ── formatDate (Dubai UTC+4) ───────────────────────────────────────────────

describe("formatDate", () => {
  it("formats a UTC date to Dubai date", () => {
    // UTC 00:00 + 4h = 4:00 AM same day in Dubai
    expect(formatDate(new Date("2026-01-25T00:00:00Z"))).toBe("Jan 25, 2026");
  });

  it("handles day rollover at UTC boundary", () => {
    // UTC 21:00 Dec 31 + 4h = 01:00 Jan 1 in Dubai
    expect(formatDate(new Date("2025-12-31T21:00:00Z"))).toBe("Jan 1, 2026");
  });

  it("accepts string input", () => {
    expect(formatDate("2026-06-15T12:00:00Z")).toBe("Jun 15, 2026");
  });
});

// ── formatDateTime (Dubai UTC+4, with GST) ─────────────────────────────────

describe("formatDateTime", () => {
  it("formats UTC to Dubai datetime with GST", () => {
    // UTC 10:30 + 4h = 14:30 = 2:30 PM GST
    expect(formatDateTime(new Date("2026-01-25T10:30:00Z"))).toBe(
      "Jan 25, 2026, 2:30 PM GST"
    );
  });

  it("formats midnight UTC to 4 AM GST", () => {
    expect(formatDateTime(new Date("2026-01-25T00:00:00Z"))).toBe(
      "Jan 25, 2026, 4:00 AM GST"
    );
  });

  it("formats noon UTC to 4 PM GST", () => {
    expect(formatDateTime(new Date("2026-01-25T12:00:00Z"))).toBe(
      "Jan 25, 2026, 4:00 PM GST"
    );
  });
});

// ── formatTime (Dubai UTC+4, with GST) ─────────────────────────────────────

describe("formatTime", () => {
  it("formats UTC to Dubai time with GST", () => {
    // UTC 10:30 + 4h = 2:30 PM
    expect(formatTime(new Date("2026-01-25T10:30:00Z"))).toBe("2:30 PM GST");
  });

  it("formats AM time", () => {
    // UTC 02:00 + 4h = 6:00 AM
    expect(formatTime(new Date("2026-01-25T02:00:00Z"))).toBe("6:00 AM GST");
  });

  it("formats 12 PM noon in Dubai", () => {
    // UTC 08:00 + 4h = 12:00 PM
    expect(formatTime(new Date("2026-01-25T08:00:00Z"))).toBe("12:00 PM GST");
  });

  it("formats 12 AM midnight in Dubai", () => {
    // UTC 20:00 + 4h = 00:00 = 12:00 AM next day
    expect(formatTime(new Date("2026-01-25T20:00:00Z"))).toBe("12:00 AM GST");
  });
});

// ── formatDateRange ────────────────────────────────────────────────────────

describe("formatDateRange", () => {
  it("formats a range of different dates", () => {
    expect(
      formatDateRange("2026-01-25T10:00:00Z", "2026-01-27T10:00:00Z")
    ).toBe("Jan 25, 2026 - Jan 27, 2026");
  });

  it("returns single date when start and end are the same day", () => {
    expect(
      formatDateRange("2026-01-25T02:00:00Z", "2026-01-25T18:00:00Z")
    ).toBe("Jan 25, 2026");
  });
});

// ── formatDateLong ─────────────────────────────────────────────────────────

describe("formatDateLong", () => {
  it("formats with day of week", () => {
    // Jan 25, 2026 is a Sunday
    expect(formatDateLong(new Date("2026-01-25T10:00:00Z"))).toBe(
      "Sunday, January 25, 2026"
    );
  });

  it("formats another day of week correctly", () => {
    // Feb 26, 2026 is a Thursday
    expect(formatDateLong(new Date("2026-02-26T10:00:00Z"))).toBe(
      "Thursday, February 26, 2026"
    );
  });
});

// ── formatPersonName ───────────────────────────────────────────────────────

describe("formatPersonName", () => {
  it("formats with DR title", () => {
    expect(formatPersonName("DR", "John", "Smith")).toBe("Dr. John Smith");
  });

  it("formats with MR title", () => {
    expect(formatPersonName("MR", "John", "Smith")).toBe("Mr. John Smith");
  });

  it("formats with PROF title", () => {
    expect(formatPersonName("PROF", "Jane", "Doe")).toBe("Prof. Jane Doe");
  });

  it("formats without title (null)", () => {
    expect(formatPersonName(null, "Jane", "Doe")).toBe("Jane Doe");
  });

  it("formats without title (undefined)", () => {
    expect(formatPersonName(undefined, "Jane", "Doe")).toBe("Jane Doe");
  });

  it("handles OTHER title (empty prefix)", () => {
    expect(formatPersonName("OTHER", "Jane", "Doe")).toBe("Jane Doe");
  });

  it("handles unknown title value", () => {
    expect(formatPersonName("UNKNOWN", "Jane", "Doe")).toBe("Jane Doe");
  });
});

// ── getTitleLabel ──────────────────────────────────────────────────────────

describe("getTitleLabel", () => {
  it("returns Dr. for DR", () => {
    expect(getTitleLabel("DR")).toBe("Dr.");
  });

  it("returns Mr. for MR", () => {
    expect(getTitleLabel("MR")).toBe("Mr.");
  });

  it("returns Prof. for PROF", () => {
    expect(getTitleLabel("PROF")).toBe("Prof.");
  });

  it("returns empty for null", () => {
    expect(getTitleLabel(null)).toBe("");
  });

  it("returns empty for undefined", () => {
    expect(getTitleLabel(undefined)).toBe("");
  });

  it("returns empty for OTHER", () => {
    expect(getTitleLabel("OTHER")).toBe("");
  });

  it("returns empty for unknown value", () => {
    expect(getTitleLabel("DOCTOR")).toBe("");
  });
});

// ── generateQRCode ─────────────────────────────────────────────────────────

describe("generateQRCode", () => {
  it("starts with QR- prefix", () => {
    expect(generateQRCode()).toMatch(/^QR-/);
  });

  it("contains a timestamp component", () => {
    const qr = generateQRCode();
    const parts = qr.split("-");
    const timestamp = Number(parts[1]);
    expect(timestamp).toBeGreaterThan(0);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("generates unique codes", () => {
    const codes = new Set(Array.from({ length: 10 }, () => generateQRCode()));
    expect(codes.size).toBe(10);
  });
});
