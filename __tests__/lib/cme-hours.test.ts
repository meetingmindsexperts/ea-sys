/**
 * CME hours to two decimals (owner, Nov 12, 2026: "cme should handle 2 digits
 * 3.75 or 5.25"). One rule for every door, and the certificate prints what was
 * entered.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { CME_HOURS_MAX, cmeHoursField, formatCmeHours, isValidCmeHours } from "@/lib/certificates/cme-hours";
import { mergeBody, resolveTokens } from "@/lib/certificates/template";
import type { CertificateData } from "@/lib/certificates/types";

describe("isValidCmeHours", () => {
  it("takes whole hours, one decimal and two decimals", () => {
    for (const ok of [0, 1, 18, 5.5, 3.75, 5.25, 1.15, 0.01, 12.05, 999.99, CME_HOURS_MAX]) {
      expect(isValidCmeHours(ok), String(ok)).toBe(true);
    }
  });

  it("refuses a third decimal instead of letting the database round it", () => {
    for (const bad of [3.755, 0.001, 5.2501, 999.991]) expect(isValidCmeHours(bad), String(bad)).toBe(false);
  });

  it("refuses what is out of range or not a number", () => {
    for (const bad of [-0.25, 1000, 999.995, Number.NaN, Number.POSITIVE_INFINITY, "3.75", null, undefined]) {
      expect(isValidCmeHours(bad), String(bad)).toBe(false);
    }
  });
});

describe("cmeHoursField (the request schema every door uses)", () => {
  it("accepts 3.75 and 5.25, refuses 3.755 and 1000 with the one message", () => {
    expect(cmeHoursField.safeParse(3.75).success).toBe(true);
    expect(cmeHoursField.safeParse(5.25).success).toBe(true);
    for (const bad of [3.755, 1000, -1]) {
      const res = cmeHoursField.safeParse(bad);
      expect(res.success).toBe(false);
      expect(JSON.stringify(res.error?.issues)).toContain("at most two decimal places");
    }
    expect(cmeHoursField.nullable().optional().safeParse(null).success).toBe(true);
  });
});

describe("formatCmeHours (the {{cmeHours}} token)", () => {
  it("prints up to two decimals with no trailing zeros", () => {
    expect(formatCmeHours(3.75)).toBe("3.75");
    expect(formatCmeHours(5.25)).toBe("5.25");
    expect(formatCmeHours(5.5)).toBe("5.5");
    expect(formatCmeHours(18)).toBe("18");
    expect(formatCmeHours(18.0)).toBe("18");
    expect(formatCmeHours(0)).toBe("0");
    expect(formatCmeHours(null)).toBe("");
    expect(formatCmeHours(undefined)).toBe("");
  });

  it("3.75 is no longer printed as 3.8", () => {
    expect(formatCmeHours(3.75)).not.toBe("3.8");
  });
});

describe("the three columns hold two decimals", () => {
  const schema = readFileSync("prisma/models/core.prisma", "utf8") + readFileSync("prisma/models/engagement.prisma", "utf8");

  it("Event.cmeHours, CertificateTemplate.cmeHours and IssuedCertificate.cmeHoursSnapshot are DECIMAL(5,2)", () => {
    const columns = [...schema.matchAll(/^\s*(cmeHours|cmeHoursSnapshot)\s+Decimal\?\s+@db\.Decimal\((\d+),\s*(\d+)\)/gm)];
    expect(columns).toHaveLength(3);
    for (const [, , precision, scale] of columns) expect([precision, scale]).toEqual(["5", "2"]);
  });

  it("no door keeps its own limit: the old 999 and 999.9 caps on hours are gone", () => {
    for (const file of [
      "src/app/api/events/[eventId]/certificates/settings/route.ts",
      "src/app/api/events/[eventId]/certificates/templates/route.ts",
      "src/app/api/events/[eventId]/certificates/templates/[templateId]/route.ts",
      "src/lib/agent/register-mcp-tools.ts",
      "src/lib/agent/tools/certificates.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/(cmeHours|hours)[^\n]*(999\.9\b|max\(999\))/);
      expect(source, file).toMatch(/cmeHoursField|isValidCmeHours/);
    }
  });
});

describe("a certificate prints the hours as entered", () => {
  const data = (eventHours: number | null, templateHours?: number): CertificateData => ({
    type: "ATTENDANCE",
    serial: "T-ATT-0001",
    issuedAt: new Date("2026-11-12T09:00:00Z"),
    recipient: { title: "Dr.", firstName: "Sample", lastName: "Attendee", fullName: "Dr. Sample Attendee" },
    event: {
      name: "A meeting",
      startDate: new Date("2026-11-12T00:00:00Z"),
      endDate: new Date("2026-11-12T00:00:00Z"),
      venue: "Venue",
      city: "Dubai",
      country: "United Arab Emirates",
      organizationName: "Organiser",
      cmeHours: eventHours,
      accreditations: [],
    },
    extras: { type: "ATTENDANCE" },
    template: templateHours === undefined ? {} : { cmeHours: templateHours },
  });

  it("{{cmeHours}} is 3.75 for an event awarded 3.75, in the token and in merged text", () => {
    expect(resolveTokens(data(3.75)).cmeHours).toBe("3.75");
    expect(mergeBody("awarded {{cmeHours}} CME hours", data(5.25))).toBe("awarded 5.25 CME hours");
  });

  it("a template's own hours still win over the event's, with their decimals", () => {
    expect(resolveTokens(data(18, 3.75)).cmeHours).toBe("3.75");
    expect(resolveTokens(data(18)).cmeHours).toBe("18");
    expect(resolveTokens(data(null)).cmeHours).toBe("");
  });
});
