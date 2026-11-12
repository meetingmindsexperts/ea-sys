/**
 * The one-off script that leaves an event with one Faculty type (owner, Nov
 * 12, 2026). Which type is kept, and when a type is left alone, are the two
 * decisions the dry run prints and the write follows.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("../../src/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import { chooseKeeper, donorBlocks, type FacultyTypeInfo } from "../../scripts/merge-faculty-types";

const type = (id: string, over: Partial<FacultyTypeInfo> = {}): FacultyTypeInfo => ({
  id, name: "Faculty", createdAt: new Date("2026-07-06T00:00:00Z"), isActive: true, soldCount: 0, registrations: 0, ...over,
});

describe("chooseKeeper", () => {
  it("keeps the type most people are on: GCC Hub's 37 over its 6", () => {
    const july = type("july", { registrations: 37, soldCount: 34 });
    const october = type("october", { name: "Faculty.", registrations: 6, createdAt: new Date("2026-10-15T00:00:00Z") });
    expect(chooseKeeper([october, july]).id).toBe("july");
  });

  it("keeps HEMNET's seven, not the older type that is empty and switched off", () => {
    const empty = type("empty", { isActive: false, createdAt: new Date("2026-07-01T00:00:00Z") });
    const used = type("used", { registrations: 7, createdAt: new Date("2026-07-08T00:00:00Z") });
    expect(chooseKeeper([empty, used]).id).toBe("used");
  });

  it("on a tie keeps the active one, then the oldest", () => {
    const offOld = type("off-old", { isActive: false, createdAt: new Date("2026-01-01T00:00:00Z") });
    const onNew = type("on-new", { createdAt: new Date("2026-09-01T00:00:00Z") });
    const onOld = type("on-old", { createdAt: new Date("2026-03-01T00:00:00Z") });
    expect(chooseKeeper([offOld, onNew]).id).toBe("on-new");
    expect(chooseKeeper([onNew, onOld, offOld]).id).toBe("on-old");
  });

  it("keeps the one the operator names, and refuses a name that is not one of them", () => {
    const a = type("a", { registrations: 9 });
    const b = type("b");
    expect(chooseKeeper([a, b], "b").id).toBe("b");
    expect(() => chooseKeeper([a, b], "elsewhere")).toThrow(/not a Faculty type of this event/);
  });
});

describe("donorBlocks", () => {
  const none = { ratesInUse: 0, promoCodes: 0, shareLinks: 0, scheduledEmails: 0, inEventSettings: false };

  it("lets a type go when nothing else points at it", () => {
    expect(donorBlocks(none)).toEqual([]);
  });

  it.each([
    [{ ratesInUse: 2 }, /priced on one of its rates/],
    [{ promoCodes: 1 }, /promo code/],
    [{ shareLinks: 1 }, /shared registration view/],
    [{ scheduledEmails: 3 }, /scheduled email/],
    [{ inEventSettings: true }, /event's settings/],
  ])("leaves it when %j", (over, wording) => {
    const blocks = donorBlocks({ ...none, ...over });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(wording);
  });
});

describe("the write", () => {
  const src = readFileSync(join(process.cwd(), "scripts/merge-faculty-types.ts"), "utf8");

  it("moves, counts, renames, deletes and records in one transaction, and deletes only an empty type", () => {
    const merge = src.slice(src.indexOf("async function mergeDonor"), src.indexOf("/** Plan, print and"));
    expect(merge).toContain("db.$transaction(");
    const order = ["tx.registration.updateMany(", "soldCount: { increment: fresh.soldCount }", "tx.attendee.updateMany(", "tx.registration.count(", "tx.ticketType.delete(", "tx.auditLog.create("];
    const at = order.map((step) => merge.indexOf(step));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(merge).toMatch(/if \(left > 0\) throw new Error/);
  });

  it("changes nothing on a registration but its type", () => {
    expect(src).toContain("data: { ticketTypeId: keeper.id }");
    expect(src).not.toMatch(/paymentStatus|status:\s*"|badgeType|qrCode/);
  });

  it("is a dry run unless --write is passed, and sends no email", () => {
    expect(src).toContain("if (!write) continue;");
    expect(src).not.toMatch(/sendEmail|sendRegistration/);
  });
});
