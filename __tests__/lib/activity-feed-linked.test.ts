/**
 * Counterpart resolvers shared by the activity feed AND the issued-
 * certificates card — a speaker's companion registration (and vice-versa)
 * so a person's FULL cert set shows on either detail surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const registrationFindFirst = vi.fn();
const speakerFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    registration: { findFirst: (...a: unknown[]) => registrationFindFirst(...a) },
    speaker: { findFirst: (...a: unknown[]) => speakerFindFirst(...a) },
  },
}));
vi.mock("@/lib/email-log", () => ({ getEmailLogsFor: vi.fn(async () => []) }));

import { resolveLinkedRegistration, resolveLinkedSpeaker } from "@/lib/activity-feed";

beforeEach(() => {
  registrationFindFirst.mockReset();
  speakerFindFirst.mockReset();
});

describe("resolveLinkedRegistration (speaker → registration)", () => {
  it("prefers the sourceRegistrationId pointer (no DB lookup)", async () => {
    const res = await resolveLinkedRegistration("evt_1", {
      sourceRegistrationId: "reg_ptr",
      email: "a@x.com",
    });
    expect(res).toEqual({ id: "reg_ptr", linkedBy: "pointer" });
    expect(registrationFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to an email match when no pointer", async () => {
    registrationFindFirst.mockResolvedValue({ id: "reg_email" });
    const res = await resolveLinkedRegistration("evt_1", {
      sourceRegistrationId: null,
      email: "a@x.com",
    });
    expect(res).toEqual({ id: "reg_email", linkedBy: "email" });
  });

  it("returns null when no pointer and no email match", async () => {
    registrationFindFirst.mockResolvedValue(null);
    expect(
      await resolveLinkedRegistration("evt_1", { sourceRegistrationId: null, email: "a@x.com" }),
    ).toBeNull();
  });

  it("returns null when no pointer and no email", async () => {
    expect(
      await resolveLinkedRegistration("evt_1", { sourceRegistrationId: null, email: null }),
    ).toBeNull();
    expect(registrationFindFirst).not.toHaveBeenCalled();
  });
});

describe("resolveLinkedSpeaker (registration → speaker)", () => {
  it("prefers the sourceRegistrationId pointer", async () => {
    speakerFindFirst.mockResolvedValueOnce({ id: "spk_ptr" });
    const res = await resolveLinkedSpeaker("evt_1", { id: "reg_1", attendeeEmail: "a@x.com" });
    expect(res).toEqual({ id: "spk_ptr", linkedBy: "pointer" });
    // only the pointer query ran
    expect(speakerFindFirst).toHaveBeenCalledTimes(1);
  });

  it("falls back to an email match when no pointer", async () => {
    speakerFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "spk_email" });
    const res = await resolveLinkedSpeaker("evt_1", { id: "reg_1", attendeeEmail: "a@x.com" });
    expect(res).toEqual({ id: "spk_email", linkedBy: "email" });
    expect(speakerFindFirst).toHaveBeenCalledTimes(2);
  });

  it("returns null when no pointer and no email match", async () => {
    speakerFindFirst.mockResolvedValue(null);
    expect(
      await resolveLinkedSpeaker("evt_1", { id: "reg_1", attendeeEmail: "a@x.com" }),
    ).toBeNull();
  });

  it("returns null when no pointer and no attendee email", async () => {
    speakerFindFirst.mockResolvedValueOnce(null);
    expect(await resolveLinkedSpeaker("evt_1", { id: "reg_1", attendeeEmail: null })).toBeNull();
    expect(speakerFindFirst).toHaveBeenCalledTimes(1);
  });
});
