/**
 * The event's My Details form opens filled with what the person already gave
 * (owner, Nov 10, 2026): their account's details, then their speaker records
 * on other events. Offered for EMPTY fields only, and never written here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, loadRegistrantScope, readAccountDetails, warn } = vi.hoisted(() => ({
  db: { speaker: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() } },
  loadRegistrantScope: vi.fn(),
  readAccountDetails: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/registrant-access", () => ({ loadRegistrantScope }));
vi.mock("@/lib/registrant-details", () => ({ readAccountDetails }));

import { pickSuggestions, suggestSpeakerDetails } from "@/lib/submitter-profile-suggestions";

const blank = {
  title: null, role: null, specialty: null, customSpecialty: null, organization: null, jobTitle: null,
  phone: null, city: null, state: null, zipCode: null, country: null, bio: null,
};
const account = {
  ...blank, firstName: "A", lastName: "B", title: "DR", role: "PHARMA", specialty: "Cardiology", organization: "Acme",
  jobTitle: "Lead", phone: "+971 50 000 0000", city: "Dubai", country: "United Arab Emirates",
};
const args = { userId: "u1", eventId: "ev1", sessionTokenVersion: 3, current: blank };

beforeEach(() => {
  vi.clearAllMocks();
  loadRegistrantScope.mockResolvedValue({ userId: "u1", email: "a@b.co", confirmed: true });
  readAccountDetails.mockResolvedValue({ details: account, source: "registration" });
  db.speaker.findMany.mockResolvedValue([]);
});

describe("pickSuggestions", () => {
  it("fills only the empty fields, and the first source with a value wins", () => {
    const got = pickSuggestions(
      { ...blank, organization: "Mine", phone: "  " },
      [{ organization: "Theirs", phone: " 111 ", city: "" }, { phone: "222", city: "Doha", bio: "Second" }],
    );
    expect(got).toEqual({ phone: "111", city: "Doha", bio: "Second" });
  });

  it("a written in specialty travels only with the Others of the same source", () => {
    expect(pickSuggestions(blank, [{ specialty: "Others", customSpecialty: "Sleep medicine" }]))
      .toEqual({ specialty: "Others", customSpecialty: "Sleep medicine" });
    // Cardiology from the first source must not pick up the second's write in.
    expect(pickSuggestions(blank, [{ specialty: "Cardiology" }, { specialty: "Others", customSpecialty: "Sleep medicine" }]))
      .toEqual({ specialty: "Cardiology" });
    // The speaker already chose a specialty: nothing about it is suggested.
    expect(pickSuggestions({ ...blank, specialty: "Others" }, [{ specialty: "Others", customSpecialty: "Sleep medicine" }]))
      .toEqual({});
  });
});

describe("suggestSpeakerDetails", () => {
  it("offers the account's details, then the bio from the person's other speaker records", async () => {
    db.speaker.findMany.mockResolvedValue([{ ...blank, organization: "Old employer", bio: "Twenty years in haematology." }]);

    const got = await suggestSpeakerDetails(args);

    expect(got).toEqual({
      title: "DR", role: "PHARMA", specialty: "Cardiology", organization: "Acme", jobTitle: "Lead",
      phone: "+971 50 000 0000", city: "Dubai", country: "United Arab Emirates", bio: "Twenty years in haematology.",
    });
    // Their OWN records only, and never this event's.
    expect(db.speaker.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", eventId: { not: "ev1" } });
    expect(loadRegistrantScope).toHaveBeenCalledWith("u1", { sessionTokenVersion: 3 });
  });

  it("writes nothing", async () => {
    await suggestSpeakerDetails(args);
    expect(db.speaker.update).not.toHaveBeenCalled();
    expect(db.speaker.updateMany).not.toHaveBeenCalled();
  });

  it("a complete profile is asked nothing and offered nothing", async () => {
    const complete = { ...blank, role: "PHARMA", specialty: "Cardiology", organization: "Acme", jobTitle: "Lead", phone: "1", city: "Dubai", country: "UAE", bio: "Bio" };
    expect(await suggestSpeakerDetails({ ...args, current: complete })).toEqual({});
    expect(db.speaker.findMany).not.toHaveBeenCalled();
    expect(readAccountDetails).not.toHaveBeenCalled();
  });

  it("an account that no longer exists still gets the other speaker records", async () => {
    loadRegistrantScope.mockResolvedValue(null);
    db.speaker.findMany.mockResolvedValue([{ ...blank, city: "Muscat" }]);
    expect(await suggestSpeakerDetails(args)).toEqual({ city: "Muscat" });
  });

  it("a failed lookup is logged and the form opens empty, as before", async () => {
    db.speaker.findMany.mockRejectedValue(new Error("db down"));
    expect(await suggestSpeakerDetails(args)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "submitter-profile:suggestions-failed", userId: "u1", eventId: "ev1" }));
  });
});
