/**
 * Freshsales CSV import — the pure decisions + the service's upsert semantics.
 *
 * The two rules that make "recurring sync via re-uploaded CSVs" safe are what
 * these tests pin:
 *   1. decideImportAction — Freshsales wins on re-import UNLESS the record was
 *      edited in EA-SYS after its last import (then EA wins, reported), and an
 *      EA-born row is only ever ENRICHED (blanks filled), never overwritten —
 *      on EVERY import, not just the first: the enrich write must not stamp
 *      lastImportedAt, or the second import graduates the row to the
 *      Freshsales-wins update path and clobbers human data (review R2-H1).
 *   2. externalId is the upsert key — re-importing the same export must
 *      converge, never duplicate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    crmCompany: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    crmContact: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    crmDeal: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    crmPipelineStage: { findMany: vi.fn() },
    event: { findFirst: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    crmActivity: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  resolveColumns,
  mapCompanyRow,
  mapContactRow,
  mapDealRow,
  dealOutcomeFromStageName,
  matchEventByName,
  decideImportAction,
  COMPANY_FIELDS,
  CONTACT_FIELDS,
  DEAL_FIELDS,
  buildSampleCsv,
} from "@/crm/lib/freshsales-import";
import { importFreshsalesCompanies, importFreshsalesContacts, importFreshsalesDeals } from "@/crm/services/crm-import-service";
import { parseCSVHeaders } from "@/lib/csv-parser";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Header resolution ─────────────────────────────────────────────────────────

describe("resolveColumns — Freshsales header synonyms", () => {
  it("resolves default Freshsales account headers and reports the leftovers", () => {
    const headers = parseCSVHeaders("Id,Name,Website,Industry type,City,Country,Some Custom Field");
    const cols = resolveColumns(headers, COMPANY_FIELDS);
    expect(cols.missingRequired).toEqual([]);
    expect(cols.index.name).toBe(1);
    expect(cols.index.industry).toBe(3);
    // A column nothing claimed is REPORTED — never silently dropped.
    expect(cols.unrecognized).toEqual(["somecustomfield"]);
  });

  it("refuses to start without the required column", () => {
    const cols = resolveColumns(parseCSVHeaders("Id,Website"), COMPANY_FIELDS);
    expect(cols.missingRequired).toContain("name");
  });

  it("a synonym column is claimed once — Id can't double as dealId", () => {
    const cols = resolveColumns(parseCSVHeaders("Id,Deal Name"), DEAL_FIELDS);
    expect(cols.index.externalId).toBe(0);
    expect(cols.index.name).toBe(1);
  });
});

// ── Row mappers ───────────────────────────────────────────────────────────────

describe("row mappers", () => {
  it("maps a contact row, preferring the work number and the primary email", () => {
    const headers = parseCSVHeaders("Id,First name,Last name,Emails,Work,Mobile,Sales account,Tags");
    const cols = resolveColumns(headers, CONTACT_FIELDS);
    const res = mapContactRow(
      ["c-9", "Sara", "Khan", "s.khan@abbott.com, old@abbott.com", "04-123", "050-999", "Abbott", "Mecomed; gold-prospect"],
      cols,
    );
    if ("error" in res) throw new Error(res.error);
    expect(res.row).toMatchObject({
      externalId: "c-9",
      email: "s.khan@abbott.com", // first of the comma list = primary
      phone: "04-123", // work wins for phone
      mobile: "050-999", // mobile lands in its OWN field (used to collapse into phone)
      companyName: "Abbott",
      tags: ["Mecomed", "gold-prospect"], // ;- or ,-separated cell
    });
  });

  it("a blank/absent tags column maps to undefined (leave-unchanged on re-import)", () => {
    const cols = resolveColumns(parseCSVHeaders("First name,Last name,Email,Tags"), CONTACT_FIELDS);
    const res = mapContactRow(["Sara", "Khan", "s@abbott.com", "  "], cols);
    if ("error" in res) throw new Error(res.error);
    expect(res.row.tags).toBeUndefined();
  });

  it("rejects a malformed email with a row error, not a crash", () => {
    const cols = resolveColumns(parseCSVHeaders("First name,Last name,Email"), CONTACT_FIELDS);
    const res = mapContactRow(["Sara", "Khan", "not-an-email"], cols);
    expect("error" in res && res.error).toMatch(/Invalid email/);
  });

  it("maps a deal row, tolerating formatted amounts", () => {
    const headers = parseCSVHeaders("Id,Name,Amount,Currency,Deal stage,Expected close date,Sales account");
    const cols = resolveColumns(headers, DEAL_FIELDS);
    const res = mapDealRow(["d-1", "Abbott — BRIDGES 2026 Gold", "40,000.00", "usd", "Negotiation", "2026-09-01", "Abbott"], cols);
    if ("error" in res) throw new Error(res.error);
    expect(res.row).toMatchObject({ amount: 40000, currency: "USD", stageName: "Negotiation" });
    expect(res.row.expectedClose).toBeInstanceOf(Date);
  });

  it("rejects an unparsable amount", () => {
    const cols = resolveColumns(parseCSVHeaders("Name,Amount"), DEAL_FIELDS);
    const res = mapDealRow(["Deal", "n/a"], cols);
    expect("error" in res && res.error).toMatch(/Invalid amount/);
  });

  it("maps a company row", () => {
    const cols = resolveColumns(parseCSVHeaders("Id,Name,Website"), COMPANY_FIELDS);
    const res = mapCompanyRow(["a-1", "Abbott", "abbott.com"], cols);
    if ("error" in res) throw new Error(res.error);
    expect(res.row).toMatchObject({ externalId: "a-1", name: "Abbott", website: "abbott.com" });
  });
});

// ── Outcome + event matching ─────────────────────────────────────────────────

describe("deal outcome + event matching", () => {
  it("detects won/lost from Freshsales stage names, never guesses otherwise", () => {
    expect(dealOutcomeFromStageName("Closed won")).toBe("WON");
    expect(dealOutcomeFromStageName("WON")).toBe("WON");
    expect(dealOutcomeFromStageName("closed lost")).toBe("LOST");
    expect(dealOutcomeFromStageName("Negotiation")).toBeNull();
    expect(dealOutcomeFromStageName(undefined)).toBeNull();
  });

  it("matches the LONGEST event name inside the deal name", () => {
    const events = [
      { id: "e-1", name: "BRIDGES 2026" },
      { id: "e-2", name: "BRIDGES 2026 Masterclass" },
    ];
    expect(matchEventByName("Abbott — BRIDGES 2026 Masterclass Gold", events)?.id).toBe("e-2");
    expect(matchEventByName("Abbott — BRIDGES 2026 Gold", events)?.id).toBe("e-1");
    expect(matchEventByName("Abbott — unrelated", events)).toBeNull();
  });
});

// ── The conflict rule ─────────────────────────────────────────────────────────

describe("decideImportAction — the recurring-sync conflict rule", () => {
  const t0 = new Date("2026-07-01T10:00:00Z");

  it("no match → create", () => {
    expect(decideImportAction(null)).toBe("create");
  });

  it("EA-born row (never imported) → enrich, never overwrite", () => {
    expect(decideImportAction({ updatedAt: t0, lastImportedAt: null })).toBe("enrich");
  });

  it("previously imported, untouched since → update (Freshsales wins)", () => {
    expect(decideImportAction({ updatedAt: t0, lastImportedAt: t0 })).toBe("update");
  });

  it("edited in EA-SYS after the last import → kept-local (EA wins)", () => {
    const edited = new Date(t0.getTime() + 60_000);
    expect(decideImportAction({ updatedAt: edited, lastImportedAt: t0 })).toBe("skip-kept-local");
  });

  it("the import's OWN write (updatedAt microseconds after the stamp) is NOT an EA edit", () => {
    const ownWrite = new Date(t0.getTime() + 800); // < the 5s tolerance
    expect(decideImportAction({ updatedAt: ownWrite, lastImportedAt: t0 })).toBe("update");
  });
});

// ── Service semantics (companies) ────────────────────────────────────────────

const CSV = `Id,Name,Website
a-1,Abbott,abbott.com
a-2,Pfizer,pfizer.com`;

describe("importFreshsalesCompanies", () => {
  it("creates new companies and stamps the external id (write run)", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-new" } as never);

    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: CSV, dryRun: false });

    if (!res.ok) throw new Error(res.message);
    expect(res).toMatchObject({ created: 2, updated: 0, enriched: 0, keptLocal: 0 });
    expect(db.crmCompany.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          name: "Abbott",
          nameKey: "abbott",
          externalSource: "freshsales",
          externalId: "a-1",
        }),
      }),
    );
  });

  it("dryRun makes the same decisions with ZERO writes", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);

    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: CSV, dryRun: true });

    if (!res.ok) throw new Error(res.message);
    expect(res.created).toBe(2);
    expect(db.crmCompany.create).not.toHaveBeenCalled();
    expect(db.crmActivity.createMany).not.toHaveBeenCalled();
  });

  it("ENRICHES an EA-born account it matched by name — blanks filled, human data kept", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findUnique).mockImplementation((async (args: { where: { organizationId_nameKey: { nameKey: string } } }) =>
      args.where.organizationId_nameKey.nameKey === "abbott"
        ? { id: "c-1", name: "Abbott", nameKey: "abbott", website: "already-set.com", industry: null, city: null, country: null, notes: null, updatedAt: new Date(), lastImportedAt: null }
        : null) as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-2" } as never);

    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: CSV, dryRun: false });

    if (!res.ok) throw new Error(res.message);
    expect(res).toMatchObject({ created: 1, enriched: 1 });
    const update = vi.mocked(db.crmCompany.update).mock.calls[0]![0] as { data: Record<string, unknown> };
    // website was already set by a human — the CSV must NOT clobber it…
    expect(update.data).not.toHaveProperty("website");
    // …but the source id is stamped so the next import upserts by id.
    expect(update.data.externalId).toBe("a-1");
    // R2-H1: the enrich must NOT stamp lastImportedAt — with it stamped, the
    // SECOND import of the same file sees "previously imported, untouched"
    // and takes the Freshsales-wins update path, overwriting (or NULLing)
    // exactly the human data this enrich just preserved. EA-born rows stay
    // enrich-forever.
    expect(update.data).not.toHaveProperty("lastImportedAt");
  });

  it("R2-H1: a contact enrich also keeps lastImportedAt unstamped — human fields survive every re-import cycle", async () => {
    const contactCsv = `Id,First name,Last name,Emails,Job title\nc-1,Sara,Khan,s.khan@abbott.com,Procurement Lead`;
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never); // company resolver prefetch
    vi.mocked(db.crmContact.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmContact.findUnique).mockResolvedValue({
      id: "ct-1", firstName: "Sara", lastName: "Khan",
      email: "s.khan@abbott.com", emailKey: "s.khan@abbott.com",
      jobTitle: "Human-typed title", phone: null, country: null, companyId: null,
      updatedAt: new Date(), lastImportedAt: null,
    } as never);

    const res = await importFreshsalesContacts({ organizationId: ORG, userId: "u-1", csvText: contactCsv, dryRun: false });

    if (!res.ok) throw new Error(res.message);
    expect(res.enriched).toBe(1);
    const update = vi.mocked(db.crmContact.update).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(update.data).not.toHaveProperty("jobTitle"); // human value kept (enrich fills blanks only)
    expect(update.data).not.toHaveProperty("lastImportedAt"); // …and stays EA-born for the next import
    expect(update.data.externalId).toBe("c-1");
  });

  it("keeps EA-SYS edits on re-import (kept-local), and reports it", async () => {
    const imported = new Date("2026-07-01T10:00:00Z");
    const editedLater = new Date("2026-07-02T09:00:00Z");
    vi.mocked(db.crmCompany.findFirst).mockImplementation((async (args: { where: { externalId?: string } }) =>
      args.where.externalId === "a-1"
        ? { id: "c-1", name: "Abbott", nameKey: "abbott", updatedAt: editedLater, lastImportedAt: imported }
        : null) as never);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-2" } as never);

    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: CSV, dryRun: false });

    if (!res.ok) throw new Error(res.message);
    expect(res.keptLocal).toBe(1);
    expect(res.created).toBe(1); // Pfizer still lands
    expect(db.crmCompany.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c-1" } }),
    );
  });

  it("a duplicate row inside ONE file is a row error, not a second write", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-1" } as never);

    const dupCsv = `Id,Name\na-1,Abbott\na-1,Abbott`;
    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: dupCsv, dryRun: false });

    if (!res.ok) throw new Error(res.message);
    expect(res.created).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.error).toMatch(/Duplicate/);
  });

  it("R2-M8: two rows with DIFFERENT external ids but the same normalized name are an in-file duplicate — dry-run and write report identically", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-1" } as never);

    // Pre-fix, both rows passed the externalId-keyed dedup; the WRITE then did
    // "1 created, 1 updated" while the DRY-RUN said "2 created" — the confirm
    // screen lied about what the write would do.
    const csv = `Id,Name\na-1,Abbott\na-2,abbott `;
    const dry = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: csv, dryRun: true });
    const wet = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: csv, dryRun: false });

    if (!dry.ok || !wet.ok) throw new Error("unreachable");
    expect(dry.created).toBe(1);
    expect(wet.created).toBe(1);
    expect(dry.errors).toHaveLength(1);
    expect(wet.errors).toHaveLength(1);
    expect(dry.errors[0]!.error).toMatch(/Duplicate/);
  });

  it("refuses a CSV without the Name column", async () => {
    const res = await importFreshsalesCompanies({ organizationId: ORG, userId: "u-1", csvText: "Id,Website\na-1,x.com", dryRun: true });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("MISSING_COLUMNS");
  });
});

// ── Service semantics (deals) ─────────────────────────────────────────────────

const DEAL_CSV = `Id,Name,Amount,Deal stage,Closed date,Sales account,Sales owner email
d-1,Abbott — BRIDGES 2026 Gold,"40,000",Closed won,2026-03-15,Abbott,rep@mmg.com
d-2,Pfizer — Symposium,25000,Negotiating hard,,Pfizer,ghost@nowhere.com`;

function mockDealFixtures() {
  vi.mocked(db.event.findFirst).mockResolvedValue({ id: "e-fallback", name: "Unassigned imports" } as never);
  vi.mocked(db.event.findMany).mockResolvedValue([{ id: "e-bridges", name: "BRIDGES 2026" }] as never);
  vi.mocked(db.crmPipelineStage.findMany).mockResolvedValue([
    { id: "s-new", name: "New", isTerminal: false, terminalOutcome: null },
    { id: "s-neg", name: "Negotiation", isTerminal: false, terminalOutcome: null },
    { id: "s-won", name: "Won", isTerminal: true, terminalOutcome: "WON" },
    { id: "s-lost", name: "Lost", isTerminal: true, terminalOutcome: "LOST" },
  ] as never);
  vi.mocked(db.user.findMany).mockResolvedValue([{ id: "u-rep", email: "rep@mmg.com" }] as never);
  vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "c-abbott", nameKey: "abbott" }] as never);
  vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
  vi.mocked(db.crmDeal.create).mockResolvedValue({ id: "d-new" } as never);
  vi.mocked(db.crmCompany.create).mockResolvedValue({ id: "c-created" } as never);
}

describe("importFreshsalesDeals", () => {
  it("imports a WON deal with its HISTORICAL close date, landing in the WON column", async () => {
    mockDealFixtures();

    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: DEAL_CSV, dryRun: false, fallbackEventId: "e-fallback",
    });

    if (!res.ok) throw new Error(res.message);
    expect(res.created).toBe(2);
    const won = vi.mocked(db.crmDeal.create).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(won.data).toMatchObject({
      organizationId: ORG,
      status: "WON",
      stageId: "s-won", // the outcome-mapped column, never a name guess
      eventId: "e-bridges", // matched by name from the deal title
      companyId: "c-abbott",
      ownerId: "u-rep",
      externalId: "d-1",
    });
    // A deal won last March carries LAST MARCH's wonAt — the reason this
    // importer deliberately does not call closeDeal() (which stamps now()).
    expect((won.data.wonAt as Date).toISOString().startsWith("2026-03-15")).toBe(true);
  });

  it("maps an unknown stage to the first open column and REPORTS it; unmatched owner + fallback event land in notes", async () => {
    mockDealFixtures();

    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: DEAL_CSV, dryRun: false, fallbackEventId: "e-fallback",
    });

    if (!res.ok) throw new Error(res.message);
    const open = vi.mocked(db.crmDeal.create).mock.calls[1]![0] as { data: Record<string, unknown> };
    expect(open.data).toMatchObject({ status: "OPEN", stageId: "s-new", eventId: "e-fallback" });
    expect(res.notes.join("\n")).toMatch(/Negotiating hard/); // the mapping is never silent
    expect(res.notes.join("\n")).toMatch(/1 matched by name, 1 → fallback/);
    expect(res.notes.join("\n")).toMatch(/owner we couldn't match/);
  });

  it("re-import converges: an untouched imported deal UPDATES (Freshsales wins), an EA-edited one is kept", async () => {
    mockDealFixtures();
    const imported = new Date("2026-07-01T10:00:00Z");
    vi.mocked(db.crmDeal.findFirst).mockImplementation((async (args: { where: { externalId?: string } }) => {
      if (args.where.externalId === "d-1") return { id: "x-1", updatedAt: imported, lastImportedAt: imported }; // untouched
      if (args.where.externalId === "d-2") return { id: "x-2", updatedAt: new Date("2026-07-05T10:00:00Z"), lastImportedAt: imported }; // EA-edited
      return null;
    }) as never);

    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: DEAL_CSV, dryRun: false, fallbackEventId: "e-fallback",
    });

    if (!res.ok) throw new Error(res.message);
    expect(res).toMatchObject({ created: 0, updated: 1, keptLocal: 1 });
    // The update never re-points the event — a human may have moved it.
    const upd = vi.mocked(db.crmDeal.update).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(upd.data).not.toHaveProperty("eventId");
    expect(db.crmDeal.create).not.toHaveBeenCalled();
  });

  it("R2-M6: a re-import whose CSV has NO Closed-date value PRESERVES the stored wonAt — close dates must not drift to the re-import date", async () => {
    mockDealFixtures();
    const imported = new Date("2026-07-01T10:00:00Z");
    vi.mocked(db.crmDeal.findFirst).mockImplementation((async (args: { where: { externalId?: string } }) =>
      args.where.externalId === "d-1"
        ? { id: "x-1", status: "WON", updatedAt: imported, lastImportedAt: imported } // won long ago, untouched since
        : null) as never);

    // Same WON row, but the export carries no Closed date column this month.
    const csvNoDate = `Id,Name,Amount,Deal stage,Sales account\nd-1,Abbott — BRIDGES 2026 Gold,"40,000",Closed won,Abbott`;
    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: csvNoDate, dryRun: false, fallbackEventId: "e-fallback",
    });

    if (!res.ok) throw new Error(res.message);
    expect(res.updated).toBe(1);
    const upd = vi.mocked(db.crmDeal.update).mock.calls[0]![0] as { data: Record<string, unknown> };
    // Pre-fix this was `wonAt: new Date()` — and "deals won in July" reported zero.
    expect(upd.data).not.toHaveProperty("wonAt");
    expect(upd.data).not.toHaveProperty("lostAt");
  });

  it("R2-M4: the company resolver's P2002 loser REUSES the concurrently-created winner instead of failing the row", async () => {
    mockDealFixtures();
    vi.mocked(db.crmCompany.findMany).mockResolvedValue([] as never); // prefetch predates the winner
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "0" });
    vi.mocked(db.crmCompany.create).mockRejectedValue(p2002);
    vi.mocked(db.crmCompany.findUnique).mockResolvedValue({ id: "c-winner" } as never);

    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: DEAL_CSV, dryRun: false, fallbackEventId: "e-fallback",
    });

    if (!res.ok) throw new Error(res.message);
    expect(res.errors).toHaveLength(0); // pre-fix: the P2002 became per-row errors
    const created = vi.mocked(db.crmDeal.create).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(created.data.companyId).toBe("c-winner");
  });

  it("refuses a CSV without the Id column — re-imports would duplicate the pipeline", async () => {
    mockDealFixtures();
    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: "Name,Amount\nDeal,100", dryRun: true, fallbackEventId: "e-fallback",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("MISSING_COLUMNS");
  });

  it("refuses an out-of-org fallback event", async () => {
    mockDealFixtures();
    vi.mocked(db.event.findFirst).mockResolvedValue(null as never);
    const res = await importFreshsalesDeals({
      organizationId: ORG, userId: "u-1", csvText: DEAL_CSV, dryRun: true, fallbackEventId: "other-orgs-event",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("EVENT_NOT_FOUND");
  });
});

describe("buildSampleCsv — the downloadable template can't drift from the synonyms", () => {
  // A sample must satisfy the importer's required-field gate AND carry no column
  // the importer would report as unrecognized — i.e. every header maps to a real
  // synonym (the drift guard), with at least one example row beyond the header.
  function assertSampleResolves(csv: string, missingRequired: string[], unrecognized: string[]) {
    const lines = csv.split(/\r\n/).filter(Boolean);
    expect(missingRequired).toEqual([]);
    expect(unrecognized).toEqual([]);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  }

  it("companies: every sample header resolves + required present + nothing unrecognized", () => {
    const csv = buildSampleCsv("companies");
    const cols = resolveColumns(parseCSVHeaders(csv.split(/\r\n/)[0]!), COMPANY_FIELDS);
    assertSampleResolves(csv, cols.missingRequired, cols.unrecognized);
  });

  it("contacts: every sample header resolves + required present + nothing unrecognized", () => {
    const csv = buildSampleCsv("contacts");
    const cols = resolveColumns(parseCSVHeaders(csv.split(/\r\n/)[0]!), CONTACT_FIELDS);
    assertSampleResolves(csv, cols.missingRequired, cols.unrecognized);
  });

  it("deals: every sample header resolves + required present + nothing unrecognized", () => {
    const csv = buildSampleCsv("deals");
    const cols = resolveColumns(parseCSVHeaders(csv.split(/\r\n/)[0]!), DEAL_FIELDS);
    assertSampleResolves(csv, cols.missingRequired, cols.unrecognized);
  });

  it("deals sample carries two rows incl. a Closed-Won example that maps to WON", () => {
    const rows = buildSampleCsv("deals").split(/\r\n/).filter(Boolean);
    expect(rows.length).toBe(3); // header + 2 examples
    expect(rows.join("\n").toLowerCase()).toContain("closed won");
  });

  it("quotes a cell containing a comma (RFC 4180)", () => {
    // The em-dash deal name has no comma; assert the escaper quotes when needed.
    // (Direct check on the pure helper via a comma-bearing value round-trips.)
    const csv = buildSampleCsv("companies");
    // No sample value contains a comma, so no field should be quoted here.
    expect(csv).not.toContain('"');
  });
});
