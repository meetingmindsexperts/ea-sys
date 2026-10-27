/**
 * cleanContactName() against the shapes the first Freshsales import actually
 * stored on prod (Oct 27, 2026: 601 stray-quote rows, 117 "Last, First",
 * 87 corporate tags, 377 email-as-name). Every input below is a real row.
 */
import { describe, it, expect } from "vitest";
import { cleanContactName, NEEDS_NAME_TAG, NOT_A_PERSON_TAG } from "@/crm/lib/contact-name";

const name = (f: string, l: string) => {
  const r = cleanContactName(f, l);
  return [r.firstName, r.lastName];
};

describe("cleanContactName", () => {
  it("leaves an ordinary name exactly as it is, casing and titles included", () => {
    expect(cleanContactName("Sara", "Khan")).toEqual({ firstName: "Sara", lastName: "Khan", qualityTags: [] });
    expect(name("ASMA AHMED BIN", "AMRO")).toEqual(["ASMA AHMED BIN", "AMRO"]);
    expect(name("Dr. Kamal", "Salahat")).toEqual(["Dr. Kamal", "Salahat"]);
    expect(name("Sean", "O'Brien")).toEqual(["Sean", "O'Brien"]);
  });

  it("strips stray quotes and flips an Outlook 'Last, First' name", () => {
    expect(name('"Al Qaidhi,', 'Khuwailid"')).toEqual(["Khuwailid", "Al Qaidhi"]);
    expect(name('"Salah,', 'Mustafa"')).toEqual(["Mustafa", "Salah"]);
    expect(name("“Hadeer", "Hany”")).toEqual(["Hadeer", "Hany"]);
  });

  it("removes corporate tags, including one split across both fields", () => {
    expect(name('"Mariappan, Munisamy [JNJAE', 'NON-J&J]"')).toEqual(["Munisamy", "Mariappan"]);
    expect(name('"Sharma, Vandana', '/IN/EXT"')).toEqual(["Vandana", "Sharma"]);
    expect(name('"Mewafi, Nada', '[SYNEU]"')).toEqual(["Nada", "Mewafi"]);
    expect(name('"Mejri, Yazid -', 'SSRH"')).toEqual(["Yazid", "Mejri"]);
    expect(name('"Saeedeh Abbas Parsaeian', '(AKI)"')).toEqual(["Saeedeh Abbas", "Parsaeian"]);
    expect(name('"Chris Provenzano', '(C)"')).toEqual(["Chris", "Provenzano"]);
    // The original boundary is kept when it survives the repair.
    expect(name('"Hani (C&I)', 'BI-AE-D"')).toEqual(["Hani", "BI-AE-D"]);
  });

  it("does not flip a company name that happens to contain a comma", () => {
    expect(name("Acme,", "Inc")).toEqual(["Acme,", "Inc"]);
    // A person + company is tagged and left as it came, never flipped.
    expect(cleanContactName("Stephanie Butler, Fierce Pharma", "Marketing")).toEqual({
      firstName: "Stephanie Butler, Fierce Pharma", lastName: "Marketing", qualityTags: [NOT_A_PERSON_TAG],
    });
    expect(name("W, Muscat Oman WD", "Leaders")).toEqual(["W, Muscat Oman WD", "Leaders"]);
  });

  it("cuts everything after a spaced dash, but keeps a hyphenated surname", () => {
    expect(name("Adelya Fatykhova - Millennium Place Mirdif -", "ADOS")).toEqual(["Adelya", "Fatykhova"]);
    expect(name("El-sayed Attia El-shandalaty, Dr.", "Ahmed")).toEqual(["Dr. Ahmed", "El-sayed Attia El-shandalaty"]);
  });

  it("drops a trailing credential instead of flipping on it", () => {
    expect(name("Dr. Hadi Mohamad Abu Rasheed, MD - Qatar Cancer", "Society")).toEqual(["Dr. Hadi Mohamad Abu", "Rasheed"]);
    expect(name("Rahman,", "Md")).toEqual(["Md", "Rahman"]);
  });

  it("an affiliation tail does not make a person a company, but an organisation stays one", () => {
    expect(cleanContactName("Salman Shalwani -", "Network")).toEqual({ firstName: "Salman", lastName: "Shalwani", qualityTags: [] });
    expect(cleanContactName("Society of Engineers -", "UAE")).toEqual({
      firstName: "Society of Engineers -", lastName: "UAE", qualityTags: [NOT_A_PERSON_TAG],
    });
    expect(cleanContactName("WHO_EPI-WIN Science", "(SKT)").qualityTags).toEqual([NOT_A_PERSON_TAG]);
  });

  it("removes a bare /IN suffix and backslash-escaped brackets", () => {
    expect(name("PATEL DHATRAKU, Lipika", "/IN")).toEqual(["Lipika", "PATEL DHATRAKU"]);
    expect(name("RBS \\(IIS\\) Jerjis", "Khan")).toEqual(["RBS Jerjis", "Khan"]);
  });

  it("review: suffixes and stacked or dotted credentials are never a first name", () => {
    expect(name("Smith,", "Jr.")).toEqual(["Smith,", "Jr."]);
    expect(name("Ahmed", "Ali, MD, PhD")).toEqual(["Ahmed", "Ali"]);
    expect(name("Ahmed", "Ali, M.D.")).toEqual(["Ahmed", "Ali"]);
  });

  it("review: an all-caps slashed name and a non-Latin bracket survive", () => {
    expect(name("Sara", "AL/SALEH")).toEqual(["Sara", "AL/SALEH"]);
    expect(name("Wei", "Zhang (张伟)")).toEqual(["Wei", "Zhang (张伟)"]);
  });

  it("review: surnames that are also ordinary words do not mark a person", () => {
    for (const l of ["Sales", "Batch", "Mailer"]) expect(cleanContactName("Anna", l).qualityTags).toEqual([]);
  });

  it("tags an email-as-name needs-name and does not guess a name from it", () => {
    expect(cleanContactName('"sandeep@alnawras.ae"', "sandeep@alnawras.ae")).toEqual({
      firstName: "sandeep@alnawras.ae", lastName: "sandeep@alnawras.ae", qualityTags: [NEEDS_NAME_TAG],
    });
    expect(cleanContactName("AIHC", "info@aihc.us").qualityTags).toEqual([NEEDS_NAME_TAG]);
  });

  it("tags likely non-people without changing them", () => {
    for (const [f, l] of [
      ["VITASHOW", "2026"], ["MSG_1266956107", "x"], ["The Box", "Team"],
      ["M&M", "Accountancy"], ["Global Health Week", "Vietnam"], ['"Teamwork.com"', "Teamwork.com"],
    ]) {
      const r = cleanContactName(f!, l!);
      expect(r.qualityTags, `${f} ${l}`).toEqual([NOT_A_PERSON_TAG]);
    }
    expect(cleanContactName("Nour", "MDC").qualityTags).toEqual([]);
  });

  it("returns blanks for a quotes-only cell so the caller rejects the row", () => {
    expect(cleanContactName('"', "Khan").firstName).toBe("");
  });
});
