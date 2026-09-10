import { describe, expect, it } from "vitest";
import {
  abstractToDocxEntry,
  coAuthorsLine,
  exportSubtitle,
  proposalToDocxEntry,
  type AbstractDocxRow,
  type ProposalDocxRow,
} from "@/lib/submission-docx-export";

/** Field lookup by label — the mappers always emit the full set, empty or not. */
function field(entry: { fields: { label: string; value: string }[] }, label: string): string {
  return entry.fields.find((f) => f.label === label)?.value ?? "<missing>";
}

const speaker = {
  title: "DR",
  firstName: "Amal",
  lastName: "Haddad",
  organization: "Tawam Hospital",
  country: "United Arab Emirates",
};

const abstract: AbstractDocxRow = {
  serialId: 7,
  title: "Effect of X on Y",
  content: "Background.\nMethods.",
  presentationType: "ORAL_POSTER",
  coAuthors: [
    { firstName: "Sara", lastName: "Khan", organization: "Cleveland Clinic", country: "UAE" },
    { firstName: "Omar", lastName: "Ali", organization: "", country: "Saudi Arabia" },
  ],
  theme: { name: "Cardiology" },
  subTheme: { name: "Heart failure" },
  speaker,
};

const proposal: ProposalDocxRow = {
  serialId: 3,
  title: "Hands-on echo",
  description: "A practical session.",
  durationMinutes: 45,
  proposedFormat: "WORKSHOP",
  theme: { name: "Imaging" },
  speaker,
};

describe("abstractToDocxEntry", () => {
  it("puts the number and title in the heading", () => {
    expect(abstractToDocxEntry(abstract).heading).toBe("A-007  Effect of X on Y");
  });

  it("shows the sub-theme under its theme when one is set", () => {
    expect(field(abstractToDocxEntry(abstract), "Theme")).toBe("Cardiology › Heart failure");
  });

  it("shows the theme alone when there is no sub-theme", () => {
    expect(field(abstractToDocxEntry({ ...abstract, subTheme: null }), "Theme")).toBe("Cardiology");
  });

  it("names the presenting author with organisation and country", () => {
    expect(field(abstractToDocxEntry(abstract), "Presenting Author")).toBe(
      "Dr. Amal Haddad, Tawam Hospital, United Arab Emirates",
    );
  });

  it("keeps the author line readable when affiliation is missing", () => {
    const bare = { ...abstract, speaker: { ...speaker, organization: null, country: null } };
    expect(field(abstractToDocxEntry(bare), "Presenting Author")).toBe("Dr. Amal Haddad");
  });

  it("lists co-authors with their affiliation, skipping the parts that are blank", () => {
    expect(field(abstractToDocxEntry(abstract), "Co-authors")).toBe(
      "Sara Khan, Cleveland Clinic, UAE; Omar Ali, Saudi Arabia",
    );
  });

  it("renders the presentation type as its label, never the raw enum", () => {
    // "ORAL_POSTER" on a page an organiser hands to a committee reads as a bug.
    expect(field(abstractToDocxEntry(abstract), "Presentation Type")).toBe("Oral or Poster");
  });

  it("leaves every optional line empty rather than inventing a value", () => {
    const bare: AbstractDocxRow = {
      serialId: null,
      title: "Untitled",
      content: "",
      presentationType: null,
      coAuthors: null,
      theme: null,
      subTheme: null,
      speaker: null,
    };
    const entry = abstractToDocxEntry(bare);
    expect(entry.heading).toBe("—  Untitled");
    expect(field(entry, "Theme")).toBe("");
    expect(field(entry, "Presenting Author")).toBe("");
    expect(field(entry, "Co-authors")).toBe("");
    expect(field(entry, "Presentation Type")).toBe("");
  });

  it("carries the abstract body through untouched", () => {
    expect(abstractToDocxEntry(abstract).body).toBe("Background.\nMethods.");
  });
});

describe("proposalToDocxEntry", () => {
  it("puts the proposal number and title in the heading", () => {
    expect(proposalToDocxEntry(proposal).heading).toBe("S-003  Hands-on echo");
  });

  it("labels the person a proposer and shows duration and format", () => {
    const entry = proposalToDocxEntry(proposal);
    expect(field(entry, "Proposer")).toBe("Dr. Amal Haddad, Tawam Hospital, United Arab Emirates");
    expect(field(entry, "Duration")).toBe("45 minutes");
    expect(field(entry, "Format")).toBe("Workshop");
  });

  it("omits duration and format when the proposer left them blank", () => {
    const entry = proposalToDocxEntry({ ...proposal, durationMinutes: null, proposedFormat: null });
    expect(field(entry, "Duration")).toBe("");
    expect(field(entry, "Format")).toBe("");
  });

  it("carries the description through as the body", () => {
    expect(proposalToDocxEntry(proposal).body).toBe("A practical session.");
  });
});

describe("coAuthorsLine", () => {
  it("is empty when there are no co-authors", () => {
    expect(coAuthorsLine(null)).toBe("");
    expect(coAuthorsLine([])).toBe("");
  });

  it("ignores a malformed payload instead of throwing", () => {
    // coAuthors is a Json column, so a hand-edited row can hold anything.
    expect(coAuthorsLine("not an array")).toBe("");
    expect(coAuthorsLine({ firstName: "Solo" })).toBe("");
  });
});

describe("exportSubtitle", () => {
  it("counts and dates the export", () => {
    expect(exportSubtitle(14, "abstract", new Date("2026-09-10T09:00:00Z"))).toBe(
      "14 abstracts · Exported 10 September 2026",
    );
  });

  it("uses the singular for one row", () => {
    expect(exportSubtitle(1, "session proposal", new Date("2026-09-10T09:00:00Z"))).toBe(
      "1 session proposal · Exported 10 September 2026",
    );
  });
});
