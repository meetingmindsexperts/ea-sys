/**
 * planOwnerAssignments(): Freshsales "Sales owner" → CRM account / contact
 * owners. Freshsales wins over an existing owner (owner, Oct 27 2026); an owner
 * with no EA-SYS user is skipped and counted, never guessed.
 */
import { describe, it, expect } from "vitest";
import { planOwnerAssignments, readOwnerRows } from "@/crm/lib/freshsales-owner-assign";

const HEADERS = ["Type", "Freshsales id", "Sales owner"];

describe("readOwnerRows", () => {
  it("refuses a file without the three columns", () => {
    expect(readOwnerRows(["Type", "Id"], [])).toEqual({ error: expect.stringMatching(/Sales owner/) });
  });

  it("keeps account and contact rows with an id and an owner", () => {
    expect(
      readOwnerRows(HEADERS, [["account", "1", "Sohail Qureshi"], ["Contact", "2", "Saleh"], ["deal", "3", "X"], ["contact", "4", ""]]),
    ).toEqual([
      { type: "account", externalId: "1", ownerName: "Sohail Qureshi" },
      { type: "contact", externalId: "2", ownerName: "Saleh" },
    ]);
  });
});

describe("planOwnerAssignments", () => {
  const users: Record<string, string> = { "Sohail Qureshi": "u-sohail", "Saleh Mahmoud": "u-saleh" };
  const resolve = (name: string) => users[name] ?? null;
  const records = new Map([
    ["1", { id: "r1", ownerId: null }],
    ["2", { id: "r2", ownerId: "u-saleh" }],
    ["3", { id: "r3", ownerId: "u-sohail" }],
    ["4", { id: "r4", ownerId: null }],
  ]);

  it("assigns, replaces (Freshsales wins), skips correct ones and unmatched owners", () => {
    const rows = readOwnerRows(HEADERS, [
      ["contact", "1", "Sohail Qureshi"], // assign
      ["contact", "2", "Sohail Qureshi"], // replace Saleh
      ["contact", "3", "Sohail Qureshi"], // already right
      ["contact", "4", "Lina Alaa Eldin"], // no EA-SYS user
      ["contact", "9", "Sohail Qureshi"], // not in EA-SYS
      ["contact", "1", "Sohail Qureshi"], // repeated row
    ]);
    if ("error" in rows) throw new Error(rows.error);
    const plan = planOwnerAssignments(rows, records, resolve);
    expect(plan.writes).toEqual([
      { id: "r1", ownerId: "u-sohail", previousOwnerId: null },
      { id: "r2", ownerId: "u-sohail", previousOwnerId: "u-saleh" },
    ]);
    expect(plan.alreadyOwned).toBe(1);
    expect(plan.unmatchedOwners).toEqual(new Map([["Lina Alaa Eldin", 1]]));
    expect(plan.missingRecords).toBe(1);
  });
});
