/**
 * saveRoleAnswers (step 1d of docs/ORG_FIELDS_PLAN.md), with the database
 * stood in for: a rename is refused while the contacts feed is connected
 * (review of a7e87df6: the feed keeps the old name on every row it holds, so
 * Mailchimp lists would split), allowed where none runs; a stale save and the
 * removal of an answer a record holds are refused; only the role list is
 * written, the rest of the settings kept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, feed } = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    organization: { update: vi.fn() },
    contact: { groupBy: vi.fn() },
    attendee: { groupBy: vi.fn() },
    speaker: { groupBy: vi.fn() },
  },
  feed: { connected: true },
}));

vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn(() => Promise.resolve()) } },
  tenantTransaction: (run: (t: typeof tx) => unknown) => run(tx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/contacts-central-sync", () => ({ isCentralSyncConfigured: () => feed.connected }));

import { saveRoleAnswers } from "@/services/person-field-service";
import { defaultPersonFields } from "@/lib/person-fields";

const NINE = defaultPersonFields().role.options.map(({ key, label, retired }) => ({ key, label, retired }));
const base = { organizationId: "org1", actorUserId: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  feed.connected = true;
  delete process.env.TENANCY_ENFORCE_HOST;
  tx.$queryRaw.mockResolvedValue([{ settings: { otherSetting: 1, personFields: { specialty: { enabled: false, required: false } } } }]);
  for (const t of [tx.contact, tx.attendee, tx.speaker]) t.groupBy.mockResolvedValue([]);
});

describe("saveRoleAnswers", () => {
  it("refuses a rename while the contacts feed is connected, and writes nothing", async () => {
    const answers = NINE.map((a) => (a.key === "PHARMA" ? { ...a, label: "Pharmaceutical industry" } : a));
    const result = await saveRoleAnswers({ ...base, answers, expected: { answers: NINE } });
    expect(result).toMatchObject({ ok: false, code: "RENAME_NOT_ALLOWED" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("adds and retires while the feed is connected, keeping every other setting", async () => {
    const answers = [...NINE.map((a) => (a.key === "RESIDENT" ? { ...a, retired: true } : a)), { label: "Engineer", retired: false }];
    const result = await saveRoleAnswers({ ...base, answers, expected: { answers: NINE } });
    expect(result.ok).toBe(true);
    const written = tx.organization.update.mock.calls[0][0].data.settings;
    expect(written.otherSetting).toBe(1);
    expect(written.personFields.specialty).toEqual({ enabled: false, required: false });
    expect(written.personFields.role.options.at(-1)).toEqual({ key: "ENGINEER", label: "Engineer", retired: false });
    expect(written.personFields.role.options.find((o: { key: string }) => o.key === "RESIDENT").retired).toBe(true);
  });

  it("renames where no feed runs, under the same key", async () => {
    feed.connected = false;
    const answers = NINE.map((a) => (a.key === "PHARMA" ? { ...a, label: "Pharmaceutical industry" } : a));
    const result = await saveRoleAnswers({ ...base, answers, expected: { answers: NINE } });
    expect(result).toMatchObject({ ok: true, relabelled: ["PHARMA"] });
  });

  it("refuses a save made from an older copy of the list", async () => {
    const stale = NINE.map((a) => (a.key === "PHARMA" ? { ...a, label: "Old name" } : a));
    const result = await saveRoleAnswers({ ...base, answers: NINE, expected: { answers: stale } });
    expect(result).toMatchObject({ ok: false, code: "LIST_CHANGED" });
  });

  it("refuses removing an answer a record holds, and says how many", async () => {
    tx.contact.groupBy.mockResolvedValue([{ role: "SPEAKER", _count: { _all: 3 } }]);
    tx.speaker.groupBy.mockResolvedValue([{ role: "SPEAKER", _count: { _all: 2 } }]);
    const result = await saveRoleAnswers({ ...base, answers: NINE.filter((a) => a.key !== "SPEAKER"), expected: { answers: NINE } });
    expect(result).toMatchObject({ ok: false, code: "ANSWER_IN_USE", inUse: [{ answer: "Speaker", records: 5 }] });
    expect(tx.contact.groupBy.mock.calls[0][0].where).toMatchObject({ organizationId: "org1", role: { in: ["SPEAKER"] } });
  });
});
