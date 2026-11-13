/**
 * The event's My Details form opens filled with what the person already gave
 * (owner, Nov 10, 2026): their account's details, then their speaker records
 * on other events. Offered for EMPTY fields only, and never written here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadOwnDetailSources, loadRegistrantScope, warn } = vi.hoisted(() => ({
  loadOwnDetailSources: vi.fn(),
  loadRegistrantScope: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/registrant-access", () => ({ loadRegistrantScope }));
vi.mock("@/lib/own-details-sources", () => ({ loadOwnDetailSources }));

import { pickSuggestions, suggestSpeakerDetails } from "@/lib/submitter-profile-suggestions";
import { DEFAULT_PERSON_FIELD_RULES } from "@/lib/person-fields";

const blank = {
  title: null, role: null, specialty: null, customSpecialty: null, organization: null, jobTitle: null,
  phone: null, city: null, state: null, zipCode: null, country: null, bio: null,
};
const account = {
  ...blank, firstName: "A", lastName: "B", title: "DR", role: "PHARMA", specialty: "Cardiology", organization: "Acme",
  jobTitle: "Lead", phone: "+971 50 000 0000", city: "Dubai", country: "United Arab Emirates",
};
const args = { userId: "u1", eventId: "ev1", sessionTokenVersion: 3, current: blank, rules: DEFAULT_PERSON_FIELD_RULES };

const scope = { userId: "u1", email: "a@b.co", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  loadRegistrantScope.mockResolvedValue(scope);
  loadOwnDetailSources.mockResolvedValue([account]);
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
  it("offers what the shared rule holds, asked for THIS person and every event but this one", async () => {
    loadOwnDetailSources.mockResolvedValue([account, { ...blank, organization: "Old employer", bio: "Twenty years in haematology." }]);

    const got = await suggestSpeakerDetails(args);

    expect(got).toEqual({
      title: "DR", role: "PHARMA", specialty: "Cardiology", organization: "Acme", jobTitle: "Lead",
      phone: "+971 50 000 0000", city: "Dubai", country: "United Arab Emirates", bio: "Twenty years in haematology.",
    });
    expect(loadRegistrantScope).toHaveBeenCalledWith("u1", { sessionTokenVersion: 3 });
    expect(loadOwnDetailSources).toHaveBeenCalledWith({ userId: "u1", scope, exceptEventId: "ev1" });
  });

  it("a complete profile is asked nothing and offered nothing", async () => {
    const complete = { ...blank, role: "PHARMA", specialty: "Cardiology", organization: "Acme", jobTitle: "Lead", phone: "1", city: "Dubai", country: "UAE", bio: "Bio" };
    expect(await suggestSpeakerDetails({ ...args, current: complete })).toEqual({});
    expect(loadOwnDetailSources).not.toHaveBeenCalled();
  });

  it("a profile complete by the ORGANISATION's rules is asked nothing, though it has no specialty", async () => {
    const noSpecialty = { ...blank, role: "PHARMA", organization: "Acme", jobTitle: "Lead", phone: "1", city: "Dubai", country: "UAE", bio: "Bio" };
    const specialtyOff = { ...DEFAULT_PERSON_FIELD_RULES, specialty: { shown: false, required: false } };
    expect(await suggestSpeakerDetails({ ...args, current: noSpecialty, rules: specialtyOff })).toEqual({});
    expect(loadOwnDetailSources).not.toHaveBeenCalled();
  });

  it("a failed lookup is logged and the form opens empty, as before", async () => {
    loadOwnDetailSources.mockRejectedValue(new Error("db down"));
    expect(await suggestSpeakerDetails(args)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "submitter-profile:suggestions-failed", userId: "u1", eventId: "ev1" }));
  });
});
