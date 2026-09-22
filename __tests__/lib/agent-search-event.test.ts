/**
 * search_event finds a full name (red-team round, September 22, 2026).
 * The executor matched the whole query against each field separately, so
 * "Ahmed Mansour" matched neither the first-name column nor the surname
 * column and the agent told the person the speaker did not exist. Every
 * word must now match one of the person fields; one word is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), findUnique: vi.fn() },
    registration: { findMany: vi.fn() },
    speaker: { findMany: vi.fn() },
    abstract: { findMany: vi.fn() },
    contact: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { personSearchTokens } from "@/lib/agent/tools/_shared";
import { collectToolsForActor } from "@/lib/agent/tool-registry";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ organizationId: "org" });
  for (const m of [mockDb.registration, mockDb.speaker, mockDb.abstract, mockDb.contact]) m.findMany.mockResolvedValue([]);
});

describe("personSearchTokens", () => {
  it("splits a full name into words and drops honorifics and stray punctuation", () => {
    expect(personSearchTokens("Dr. Ahmed Mansour")).toEqual(["Ahmed", "Mansour"]);
    expect(personSearchTokens("Prof Nadia Farouk,")).toEqual(["Nadia", "Farouk"]);
    expect(personSearchTokens("  Haddad ")).toEqual(["Haddad"]);
    expect(personSearchTokens("omar.haddad@test.local")).toEqual(["omar.haddad@test.local"]);
  });

  it("keeps a query that is nothing but an honorific, and caps the word count", () => {
    expect(personSearchTokens("Dr")).toEqual(["Dr"]);
    expect(personSearchTokens("a b c d e f g h")).toHaveLength(6);
  });
});

async function search(query: string) {
  const tool = collectToolsForActor({
    organizationId: "org",
    actor: { userId: "u1", role: "ADMIN", fromApiKey: false },
    source: "agent",
  }).find((t) => t.name === "search_event")!;
  return tool.run({ eventId: "ev1", query });
}

describe("search_event", () => {
  it("requires every word to match one of the person fields, so a full name spans two columns", async () => {
    const res = await search("Dr. Ahmed Mansour");
    expect(res.isError).toBe(false);
    const where = mockDb.speaker.findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR).toContainEqual({ firstName: { contains: "Ahmed", mode: "insensitive" } });
    expect(where.AND[1].OR).toContainEqual({ lastName: { contains: "Mansour", mode: "insensitive" } });
    expect(JSON.stringify(where)).not.toContain("Dr");
    // Registrations: the same word clauses, and the whole query still tried as a tag.
    const reg = mockDb.registration.findMany.mock.calls[0][0].where;
    expect(reg.OR).toHaveLength(2);
    expect(reg.OR[0].AND).toHaveLength(2);
    expect(reg.OR[1]).toEqual({ attendee: { tags: { has: "Dr. Ahmed Mansour" } } });
    const abs = mockDb.abstract.findMany.mock.calls[0][0].where;
    expect(abs.AND).toHaveLength(2);
    const contact = mockDb.contact.findMany.mock.calls[0][0].where;
    expect(contact.AND).toHaveLength(2);
    expect(contact.eventIds).toEqual({ has: "ev1" });
  });

  it("a one-word query is one clause, as before", async () => {
    await search("Haddad");
    const where = mockDb.speaker.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0].OR).toContainEqual({ lastName: { contains: "Haddad", mode: "insensitive" } });
  });
});
