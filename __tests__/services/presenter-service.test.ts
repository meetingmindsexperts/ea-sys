/**
 * "Make presenters" from the abstracts side (owner, Nov 20, 2026; plan step 4):
 * it finds each ACCEPTED abstract's author's live registration and runs the
 * general bulk action on those rows. Nothing new happens in it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { abstractFindMany, registrationFindMany, bulkSpy, logger } = vi.hoisted(() => ({
  abstractFindMany: vi.fn(),
  registrationFindMany: vi.fn(),
  bulkSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: { abstract: { findMany: abstractFindMany }, registration: { findMany: registrationFindMany }, speaker: { findMany: vi.fn() } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/services/registration-bulk-service", () => ({ bulkUpdateRegistrations: bulkSpy, MAX_BULK_REGISTRATION_UPDATES: 500 }));

import { makePresenters } from "@/services/presenter-service";

const input = (abstractIds: string[]) => ({ eventId: "ev1", organizationId: "org1", actorUserId: "u1", abstractIds, source: "rest" as const });
const accepted = (id: string, email: string, sourceRegistrationId: string | null = null) => ({ id, speaker: { email, sourceRegistrationId } });

beforeEach(() => {
  vi.clearAllMocks();
  registrationFindMany.mockResolvedValue([
    { id: "reg-linked", attendee: { email: "linked@x.com" } },
    { id: "reg-by-address", attendee: { email: "Late@X.com" } },
    { id: "reg-paid", attendee: { email: "paid@x.com" } },
  ]);
  bulkSpy.mockResolvedValue({ ok: true, changed: ["reg-linked", "reg-by-address"], unchanged: [], skipped: [], remaining: [] });
});

describe("makePresenters", () => {
  it("only ACCEPTED abstracts on the event are read, and their authors' registrations get the one bulk action", async () => {
    abstractFindMany.mockResolvedValue([accepted("a1", "linked@x.com", "reg-linked"), accepted("a2", "late@x.com")]);
    const result = await makePresenters(input(["a1", "a2", "a-rejected"]));
    expect(abstractFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["a1", "a2", "a-rejected"] }, eventId: "ev1", status: "ACCEPTED" });
    // Live registrations only.
    expect(registrationFindMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", status: { not: "CANCELLED" } });
    expect(bulkSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "ev1", actorUserId: "u1", registrationIds: ["reg-linked", "reg-by-address"], paymentStatus: "COMPLIMENTARY", badgeType: "Presenter",
    }));
    expect(result).toMatchObject({ ok: true, made: ["a1", "a2"], already: [], skipped: [], noRegistration: [], notAccepted: ["a-rejected"] });
  });

  it("an author with no live registration is named, and nobody is made free for them", async () => {
    abstractFindMany.mockResolvedValue([accepted("a1", "nobody@x.com"), accepted("a2", "gone@x.com", "reg-cancelled")]);
    const result = await makePresenters(input(["a1", "a2"]));
    expect(result).toMatchObject({ ok: true, made: [], noRegistration: ["a1", "a2"] });
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "make-presenters:no-registration", abstractIds: ["a1", "a2"] }));
  });

  it("one author with two accepted abstracts is one registration, and both abstracts are answered", async () => {
    abstractFindMany.mockResolvedValue([accepted("a1", "linked@x.com", "reg-linked"), accepted("a2", "linked@x.com", "reg-linked")]);
    bulkSpy.mockResolvedValue({ ok: true, changed: ["reg-linked"], unchanged: [], skipped: [], remaining: [] });
    const result = await makePresenters(input(["a1", "a2"]));
    expect(bulkSpy.mock.calls[0][0].registrationIds).toEqual(["reg-linked"]);
    expect(result).toMatchObject({ ok: true, made: ["a1", "a2"] });
  });

  it("a registration with money on it is reported as skipped with the bulk action's own reason, never as made", async () => {
    abstractFindMany.mockResolvedValue([accepted("a1", "paid@x.com")]);
    // The badge was set (changed) and the payment status refused (skipped).
    bulkSpy.mockResolvedValue({
      ok: true, changed: ["reg-paid"], unchanged: [], remaining: [],
      skipped: [{ registrationId: "reg-paid", part: "paymentStatus", code: "HAS_MONEY", message: "Has a payment on it." }],
    });
    const result = await makePresenters(input(["a1"]));
    expect(result).toMatchObject({ ok: true, made: [], skipped: [{ abstractId: "a1", part: "paymentStatus", code: "HAS_MONEY", message: "Has a payment on it." }] });
  });

  it("already Complimentary with the badge is 'already'; what was not reached comes back to send again", async () => {
    abstractFindMany.mockResolvedValue([accepted("a1", "linked@x.com", "reg-linked"), accepted("a2", "late@x.com")]);
    bulkSpy.mockResolvedValue({ ok: true, changed: [], unchanged: ["reg-linked"], skipped: [], remaining: ["reg-by-address"] });
    expect(await makePresenters(input(["a1", "a2"]))).toMatchObject({ ok: true, already: ["a1"], remaining: ["a2"] });
  });

  it("refuses nothing to do and too many, passes the bulk action's refusal on, and never throws", async () => {
    expect(await makePresenters(input([]))).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
    expect(await makePresenters(input(Array.from({ length: 501 }, (_, i) => `a${i}`)))).toMatchObject({ ok: false, code: "TOO_MANY" });
    abstractFindMany.mockResolvedValue([accepted("a1", "linked@x.com", "reg-linked")]);
    bulkSpy.mockResolvedValueOnce({ ok: false, code: "UNKNOWN", message: "no" });
    expect(await makePresenters(input(["a1"]))).toMatchObject({ ok: false, code: "UNKNOWN" });
    abstractFindMany.mockRejectedValueOnce(new Error("db down"));
    expect(await makePresenters(input(["a1"]))).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "make-presenters:failed" }));
  });
});
