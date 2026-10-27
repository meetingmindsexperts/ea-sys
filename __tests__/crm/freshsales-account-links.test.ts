/**
 * planAccountLinks(): the contact → account backfill from Freshsales'
 * Account_contacts.csv. Primary wins, the file wins over an existing link
 * (owner, Oct 27 2026), and anything unresolved is reported, never guessed.
 */
import { describe, it, expect } from "vitest";
import { planAccountLinks, readAccountContactRows } from "@/crm/lib/freshsales-account-links";

const HEADERS = ["Id", "Sales Account id", "Contact id", "Is Primary"];
const rows = (...r: Array<[string, string, string]>) =>
  readAccountContactRows(HEADERS, r.map(([a, c, p]) => ["x", a, c, p]));

describe("readAccountContactRows", () => {
  it("refuses a file without the three columns", () => {
    expect(readAccountContactRows(["Id", "Contact id"], [])).toEqual({ error: expect.stringMatching(/Sales Account id/) });
  });

  it("reads the Freshsales export shape and drops blank ids", () => {
    expect(rows(["a1", "c1", "true"], ["", "c2", "true"])).toEqual([
      { accountExternalId: "a1", contactExternalId: "c1", isPrimary: true },
    ]);
  });
});

describe("planAccountLinks", () => {
  const contacts = new Map([
    ["c1", { id: "ct1", companyId: null }],
    ["c2", { id: "ct2", companyId: "co-old" }],
    ["c3", { id: "ct3", companyId: "co1" }],
    ["c4", { id: "ct4", companyId: null }],
  ]);
  const accounts = new Map([["a1", { id: "co1" }], ["a2", { id: "co2" }]]);

  it("links, moves, skips correct links and reports what it cannot resolve", () => {
    const parsed = rows(
      ["a1", "c1", "true"], // link
      ["a2", "c2", "true"], // move (the file wins)
      ["a1", "c3", "true"], // already right
      ["a9", "c4", "true"], // account not in EA-SYS
      ["a1", "c9", "true"], // contact not in EA-SYS
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = planAccountLinks(parsed, contacts, accounts);
    expect(plan.writes).toEqual([
      { contactId: "ct1", companyId: "co1", previousCompanyId: null },
      { contactId: "ct2", companyId: "co2", previousCompanyId: "co-old" },
    ]);
    expect(plan.alreadyLinked).toBe(1);
    expect(plan.missingAccount).toEqual(["a9"]);
    expect(plan.missingContact).toEqual(["c9"]);
  });

  it("uses the primary account for a contact with two, and reports one with none", () => {
    const parsed = rows(["a2", "c1", "false"], ["a1", "c1", "true"], ["a1", "c4", "false"]);
    if ("error" in parsed) throw new Error(parsed.error);
    const plan = planAccountLinks(parsed, contacts, accounts);
    expect(plan.writes).toEqual([{ contactId: "ct1", companyId: "co1", previousCompanyId: null }]);
    expect(plan.noPrimary).toEqual(["c4"]);
  });
});
