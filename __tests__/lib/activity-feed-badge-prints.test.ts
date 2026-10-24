/**
 * Badge prints on a registration's activity timeline (owner, Oct 24, 2026).
 * One audit row is written per print run, naming every registration printed
 * in `changes.registrationIds`, so the feed finds them by membership in that
 * list (not by entityId): the first is "printed", later ones "reprinted",
 * each with who printed it and the batch it was in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const auditFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { findMany: (...a: unknown[]) => auditFindMany(...a) },
    registration: { findFirst: vi.fn(async () => null) },
    speaker: { findFirst: vi.fn(async () => null) },
    issuedCertificate: { findMany: vi.fn(async () => []) },
    speakerReimbursement: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/email-log", () => ({ getEmailLogsFor: vi.fn(async () => []) }));

import { buildRegistrationActivity } from "@/lib/activity-feed";

const print = (id: string, at: string, count: number, who: string) => ({
  id,
  createdAt: new Date(at),
  ipAddress: "10.0.0.1",
  changes: { count, all: false, registrationIds: ["reg-1"] },
  user: { firstName: who, lastName: null },
  action: "BADGE_PRINTED",
});

beforeEach(() => {
  auditFindMany.mockReset();
  // Badge prints come oldest first; every other audit query returns nothing.
  auditFindMany.mockImplementation(async (args: { where: { action?: string } }) =>
    args.where.action === "BADGE_PRINTED" ? [print("p1", "2026-10-24T06:15:00Z", 48, "Sara"), print("p2", "2026-10-25T07:00:00Z", 1, "Omar")] : [],
  );
});

describe("badge prints on a registration's timeline", () => {
  it("asks for the event's print runs that name this registration", async () => {
    await buildRegistrationActivity("evt-1", { id: "reg-1", attendeeEmail: null }, "org-1", true);
    const call = auditFindMany.mock.calls.find(([a]) => a.where.action === "BADGE_PRINTED")![0];
    expect(call.where).toEqual({ eventId: "evt-1", action: "BADGE_PRINTED", changes: { path: ["registrationIds"], array_contains: ["reg-1"] } });
  });

  it("shows the first as printed and the next as reprinted, with who and the batch", async () => {
    const { items } = await buildRegistrationActivity("evt-1", { id: "reg-1", attendeeEmail: null }, "org-1", true);
    const prints = items.filter((i) => i.action?.startsWith("BADGE_"));
    // Newest first, as the whole timeline is.
    expect(prints.map((p) => [p.action, p.actor, p.detail])).toEqual([
      ["BADGE_REPRINTED", "Omar", "Printed on its own"],
      ["BADGE_PRINTED", "Sara", "One of 48 badges printed together"],
    ]);
    expect(prints.every((p) => p.source === "registration" && !p.diffs)).toBe(true);
  });
});
