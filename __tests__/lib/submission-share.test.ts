/**
 * The shared submission view's rules (Sep 29, 2026; docs/SUBMISSION_SHARE_PLAN.md).
 * The guarantee under test: a field the organiser has not switched on is ABSENT
 * from the projected row, and DRAFT / WITHDRAWN can never be shown.
 */
import { describe, it, expect } from "vitest";
import {
  SHARE_FIELDS,
  SHARE_KINDS,
  contactFieldKeys,
  defaultShareConfig,
  effectiveFields,
  effectiveStatuses,
  projectAbstract,
  projectProposal,
  speakerSelect,
  validateShareConfig,
  type AbstractShareRow,
  type ProposalShareRow,
  type SharedItem,
} from "@/lib/submission-share";

const speaker = {
  title: "DR",
  firstName: "Amal",
  lastName: "Haddad",
  organization: "Tawam Hospital",
  jobTitle: "Consultant",
  country: "United Arab Emirates",
  email: "amal@example.com",
  additionalEmail: "amal.alt@example.com",
  phone: "+971500000000",
};

const abstractRow: AbstractShareRow = {
  serialId: 7,
  title: "Heart failure in the young",
  content: "Background. Methods. Results.",
  status: "ACCEPTED",
  presentationType: "ORAL",
  specialty: "Cardiology",
  coAuthors: [{ firstName: "Sara", lastName: "Khan", organization: "Cleveland Clinic", country: "UAE" }],
  submittedAt: new Date("2026-09-01T10:00:00Z"),
  theme: { name: "Cardiology" },
  subTheme: { name: "Heart failure" },
  track: { name: "Main hall" },
  speaker,
};

const proposalRow: ProposalShareRow = {
  serialId: 3,
  title: "A workshop on echo",
  description: "Hands-on.",
  status: "SUBMITTED",
  proposedFormat: "WORKSHOP",
  durationMinutes: 90,
  submittedAt: null,
  createdAt: new Date("2026-09-02T10:00:00Z"),
  theme: { name: "Imaging" },
  speaker,
};

/** Which projected keys each catalogue field writes. */
const FIELD_TO_KEYS: Record<string, (keyof SharedItem)[]> = {
  content: ["body"],
  description: ["body"],
  theme: ["theme"],
  track: ["track"],
  presentationType: ["presentationType"],
  specialty: ["specialty"],
  format: ["format"],
  duration: ["duration"],
  status: ["status"],
  submittedAt: ["submittedAt"],
  authorName: ["authorName"],
  authorAffiliation: ["authorAffiliation"],
  authorCountry: ["authorCountry"],
  coAuthors: ["coAuthors"],
  authorEmail: ["authorEmail"],
  authorAdditionalEmail: ["authorAdditionalEmail"],
  authorPhone: ["authorPhone"],
};

function project(kind: (typeof SHARE_KINDS)[number], on: Set<string>): SharedItem {
  return kind === "ABSTRACTS" ? projectAbstract(abstractRow, on) : projectProposal(proposalRow, on);
}

describe("projection", () => {
  it("with nothing switched on, only number and title leave the server", () => {
    for (const kind of SHARE_KINDS) {
      expect(Object.keys(project(kind, new Set())).sort()).toEqual(["number", "title"]);
    }
  });

  it("each field writes its own key and nothing else (every field, both kinds)", () => {
    for (const kind of SHARE_KINDS) {
      for (const f of SHARE_FIELDS[kind]) {
        const keys = Object.keys(project(kind, new Set([f.key]))).sort();
        expect(keys, `${kind}.${f.key}`).toEqual(["number", "title", ...FIELD_TO_KEYS[f.key]].sort());
      }
    }
  });

  it("with everything but contact switched on, no email or phone appears anywhere in the output", () => {
    for (const kind of SHARE_KINDS) {
      const on = new Set(SHARE_FIELDS[kind].filter((f) => f.group !== "contact").map((f) => f.key));
      const json = JSON.stringify(project(kind, on));
      expect(json).not.toContain("example.com");
      expect(json).not.toContain("+971");
    }
  });

  it("formats what it shows", () => {
    const a = projectAbstract(abstractRow, new Set(["theme", "authorName", "authorAffiliation", "coAuthors", "presentationType"]));
    expect(a.number).toBe("A-007");
    expect(a.theme).toBe("Cardiology › Heart failure");
    expect(a.authorAffiliation).toBe("Consultant, Tawam Hospital");
    expect(a.coAuthors).toEqual(["Sara Khan, Cleveland Clinic, UAE"]);
    expect(a.presentationType).toBe("Oral");
    const p = projectProposal(proposalRow, new Set(["duration", "submittedAt"]));
    expect(p.number).toBe("S-003");
    expect(p.duration).toBe("90 minutes");
    expect(p.submittedAt).toBe("2026-09-02T10:00:00.000Z");
  });
});

describe("speakerSelect", () => {
  it("names a contact column only when its field is on", () => {
    expect(speakerSelect(new Set(["authorName"]))).not.toHaveProperty("email");
    expect(speakerSelect(new Set(["authorName"]))).not.toHaveProperty("phone");
    expect(speakerSelect(new Set(["authorName"]))).not.toHaveProperty("additionalEmail");
    const all = speakerSelect(new Set(["authorEmail", "authorAdditionalEmail", "authorPhone"]));
    expect(all).toMatchObject({ email: true, additionalEmail: true, phone: true });
  });
});

describe("configuration", () => {
  it("defaults leave contact details off and Rejected unticked", () => {
    for (const kind of SHARE_KINDS) {
      const d = defaultShareConfig(kind);
      for (const c of contactFieldKeys(kind)) expect(d.fields).not.toContain(c);
    }
    expect(defaultShareConfig("ABSTRACTS").statuses).not.toContain("REJECTED");
    expect(defaultShareConfig("SESSION_PROPOSALS").statuses).toEqual(["SUBMITTED"]);
  });

  it("refuses DRAFT, WITHDRAWN, unknown statuses and unknown fields rather than dropping them", () => {
    expect(validateShareConfig("ABSTRACTS", { statuses: ["DRAFT"], fields: [] })).toMatchObject({ ok: false, code: "UNKNOWN_STATUS" });
    expect(validateShareConfig("SESSION_PROPOSALS", { statuses: ["WITHDRAWN"], fields: [] })).toMatchObject({ ok: false, code: "UNKNOWN_STATUS" });
    expect(validateShareConfig("ABSTRACTS", { statuses: ["ACCEPTED"], fields: ["reviewScore"] })).toMatchObject({ ok: false, code: "UNKNOWN_FIELD" });
    // A proposal field is not an abstract field.
    expect(validateShareConfig("ABSTRACTS", { statuses: ["ACCEPTED"], fields: ["duration"] })).toMatchObject({ ok: false, code: "UNKNOWN_FIELD" });
    expect(validateShareConfig("ABSTRACTS", { statuses: [], fields: [] })).toMatchObject({ ok: false, code: "NO_STATUS" });
    expect(validateShareConfig("ABSTRACTS", { statuses: ["ACCEPTED", "ACCEPTED"], fields: ["content", "content"] })).toEqual({ ok: true, statuses: ["ACCEPTED"], fields: ["content"] });
  });

  it("re-filters at read time, so a stored DRAFT or stray field never reaches the query", () => {
    expect(effectiveStatuses("ABSTRACTS", ["DRAFT", "WITHDRAWN", "ACCEPTED"])).toEqual(["ACCEPTED"]);
    expect([...effectiveFields("SESSION_PROPOSALS", ["description", "reviewScore", "content"])]).toEqual(["description"]);
  });

  it("no reviewer data is in the catalogue at all", () => {
    for (const kind of SHARE_KINDS) {
      for (const f of SHARE_FIELDS[kind]) expect(f.key.toLowerCase()).not.toMatch(/review|score|comment/);
    }
  });
});
