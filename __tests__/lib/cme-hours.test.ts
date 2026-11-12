/**
 * CME hours to two decimals (owner, Nov 12, 2026: "cme should handle 2 digits
 * 3.75 or 5.25"). One rule for every door, and the certificate prints what was
 * entered.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const { mockDb } = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  });
  return { mockDb: { certificateTemplate: model(), event: model(), auditLog: model() } };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));

import { CME_HOURS_MAX, cmeHoursField, formatCmeHours, isValidCmeHours } from "@/lib/certificates/cme-hours";
import { mergeBody, resolveTokens } from "@/lib/certificates/template";
import { CERTIFICATE_EXECUTORS } from "@/lib/agent/tools/certificates";
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

  it("the tolerance forgives floating point only: any real extra digit is refused, however small", () => {
    for (const bad of [3.759, 3.751, 3.7501, 3.75001, 3.75000001, 1e-7, 1e-9, 0.005]) {
      expect(isValidCmeHours(bad), String(bad)).toBe(false);
    }
  });

  it("every hundredth from 0 to 999.99 is accepted, and prints as itself", () => {
    for (let hundredths = 0; hundredths <= 99999; hundredths++) {
      const value = hundredths / 100;
      if (!isValidCmeHours(value)) throw new Error(`refused ${value}`);
      if (Number(formatCmeHours(value)) !== value) throw new Error(`printed ${value} as ${formatCmeHours(value)}`);
    }
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

  it("the schema the agent's tool list is generated from still shows the range and says two decimals", () => {
    const schema = z.toJSONSchema(cmeHoursField) as { type?: string; minimum?: number; maximum?: number; description?: string };
    expect(schema).toMatchObject({ type: "number", minimum: 0, maximum: 999.99 });
    expect(schema.description).toContain("two decimal");
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

  it("rounds to two decimals what arithmetic left inexact, so a certificate never prints a float's tail", () => {
    expect(formatCmeHours(0.1 + 0.2)).toBe("0.3");
    expect(formatCmeHours(1.1 + 2.65)).toBe("3.75");
    expect(formatCmeHours(3.7500000001)).toBe("3.75");
    expect(formatCmeHours(18.004)).toBe("18");
  });
});

describe("the three columns hold two decimals", () => {
  const schema = readFileSync("prisma/models/core.prisma", "utf8") + readFileSync("prisma/models/engagement.prisma", "utf8");

  it("Event.cmeHours, CertificateTemplate.cmeHours and IssuedCertificate.cmeHoursSnapshot are DECIMAL(5,2)", () => {
    const columns = [...schema.matchAll(/^\s*(cmeHours|cmeHoursSnapshot)\s+Decimal\?\s+@db\.Decimal\((\d+),\s*(\d+)\)/gm)];
    expect(columns).toHaveLength(3);
    for (const [, , precision, scale] of columns) expect([precision, scale]).toEqual(["5", "2"]);
  });

  it("every request schema for hours is the shared field: none declares its own number", () => {
    // file -> how many `cmeHours:` / `hours:` schema lines it must have, all of them cmeHoursField.
    const doors: Record<string, number> = {
      "src/app/api/events/[eventId]/certificates/settings/route.ts": 2,
      "src/app/api/events/[eventId]/certificates/templates/route.ts": 1,
      "src/app/api/events/[eventId]/certificates/templates/[templateId]/route.ts": 1,
      "src/lib/agent/register-mcp-tools.ts": 4,
    };
    for (const [file, expected] of Object.entries(doors)) {
      const source = readFileSync(file, "utf8");
      const schemaLines = source.split("\n").filter((line) => /^\s*(cmeHours|hours):\s*(z\.|cmeHoursField)/.test(line));
      expect(schemaLines, file).toHaveLength(expected);
      for (const line of schemaLines) expect(line, file).toMatch(/:\s*cmeHoursField\.(nullable\(\)\.)?optional\(\),/);
    }
  });
});

describe("the agent's three tools refuse a third decimal before touching the database", () => {
  const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1" } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.certificateTemplate.findFirst.mockResolvedValue({ id: "t1" });
  });

  it("update_cme_settings: the event's hours, and an accrediting body's hours", async () => {
    const tool = CERTIFICATE_EXECUTORS.update_cme_settings;
    expect(await tool({ cmeHours: 3.755 }, ctx)).toMatchObject({ code: "INVALID_FIELD", error: expect.stringContaining("two decimal") });
    expect(await tool({ cmeHours: 1000 }, ctx)).toMatchObject({ code: "INVALID_FIELD" });
    expect(
      await tool({ accreditations: [{ body: "DHA", reference: "REF-1", hours: 5.255 }] }, ctx),
    ).toMatchObject({ code: "INVALID_FIELD", error: expect.stringContaining("two decimal") });
    expect(mockDb.event.update).not.toHaveBeenCalled();
    expect(mockDb.event.updateMany).not.toHaveBeenCalled();
  });

  it("create_certificate_template and update_certificate_template: a template's own hours", async () => {
    const created = await CERTIFICATE_EXECUTORS.create_certificate_template(
      { name: "CME", category: "ATTENDANCE", cmeHours: 3.755 },
      ctx,
    );
    expect(created).toMatchObject({ code: "INVALID_FIELD", error: expect.stringContaining("two decimal") });
    const updated = await CERTIFICATE_EXECUTORS.update_certificate_template({ templateId: "t1", cmeHours: 5.255 }, ctx);
    expect(updated).toMatchObject({ code: "INVALID_FIELD", error: expect.stringContaining("two decimal") });
    expect(mockDb.certificateTemplate.create).not.toHaveBeenCalled();
    expect(mockDb.certificateTemplate.update).not.toHaveBeenCalled();
    expect(mockDb.certificateTemplate.updateMany).not.toHaveBeenCalled();
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
