/**
 * The HONORARIUM_SET audit row (speaker-honorarium route) carries the agreed
 * fee in its before/after. The Activity timeline is readable by the desk
 * population (MEMBER / ONSITE / WEBINARS), who can view finance but are
 * OUTSIDE the reimbursement boundary, so the row is dropped, not merely
 * un-diffed, unless the caller may manage reimbursements (Sep 3, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    issuedCertificate: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    speakerReimbursement: { findUnique: vi.fn() },
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/email-log", () => ({ getEmailLogsFor: vi.fn(async () => []) }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { buildSpeakerActivity } from "@/lib/activity-feed";

const AUDITS = [
  {
    id: "a-hon",
    action: "HONORARIUM_SET",
    ipAddress: "10.0.0.1",
    createdAt: new Date("2026-09-03T10:00:00Z"),
    changes: { source: "rest", before: null, after: { amount: 1500, currency: "USD" } },
    user: { firstName: "Org", lastName: "Aniser" },
  },
  {
    id: "a-upd",
    action: "UPDATE",
    ipAddress: null,
    createdAt: new Date("2026-09-03T09:00:00Z"),
    changes: { before: { phone: "1" }, after: { phone: "2" } },
    user: { firstName: "Org", lastName: "Aniser" },
  },
];

const speaker = { id: "spk1", sourceRegistrationId: null, email: "spk@x.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.issuedCertificate.findMany.mockResolvedValue([]);
  mockDb.auditLog.findMany.mockResolvedValue(AUDITS);
  mockDb.speakerReimbursement.findUnique.mockResolvedValue(null);
  mockDb.registration.findFirst.mockResolvedValue(null); // no linked registration
});

describe("buildSpeakerActivity: the HONORARIUM_SET row follows the reimbursement boundary", () => {
  it("is DROPPED for a finance-capable caller outside the boundary (MEMBER / ONSITE / WEBINARS)", async () => {
    const { items } = await buildSpeakerActivity("evt1", speaker, "org1", true, false);
    expect(items.map((i) => i.id)).toEqual(["audit:a-upd"]);
    expect(JSON.stringify(items)).not.toContain("1500");
  });

  it("is KEPT, with its before → after diff, inside the boundary", async () => {
    const { items } = await buildSpeakerActivity("evt1", speaker, "org1", true, true);
    expect(items.map((i) => i.id)).toEqual(["audit:a-hon", "audit:a-upd"]);
    const hon = items.find((i) => i.id === "audit:a-hon");
    expect(hon?.kind === "audit" && hon.action).toBe("HONORARIUM_SET");
  });

  it("defaults CLOSED when the caller omits the flag", async () => {
    const { items } = await buildSpeakerActivity("evt1", speaker, "org1", true);
    expect(items.map((i) => i.id)).toEqual(["audit:a-upd"]);
  });
});
