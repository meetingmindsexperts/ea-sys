/**
 * saveFieldLabels (step 1d of docs/ORG_FIELDS_PLAN.md), with the database
 * stood in for. A save names only the field it renames (review of 24f390fb:
 * each field's card saves its own name, and a save that carried both was
 * refused as stale right after the other card had saved, or would have put
 * the other name back); the stale check is that field's alone; no two of
 * Title, Role and Specialty may read the same, judged against what is stored;
 * only the `label` key is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx } = vi.hoisted(() => ({ tx: { $queryRaw: vi.fn(), organization: { update: vi.fn() } } }));

vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn(() => Promise.resolve()) } },
  tenantTransaction: (run: (t: typeof tx) => unknown) => run(tx),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/contacts-central-sync", () => ({ isCentralSyncConfigured: () => false }));

import { saveFieldLabels } from "@/services/person-field-service";

const base = { organizationId: "org1", actorUserId: "u1" };
const stored = (personFields: unknown) => tx.$queryRaw.mockResolvedValue([{ settings: { otherSetting: 1, personFields } }]);
const written = () => tx.organization.update.mock.calls[0][0].data.settings;

beforeEach(() => {
  vi.clearAllMocks();
  stored({ specialty: { enabled: false, required: false } });
});

describe("saveFieldLabels", () => {
  it("renames one field and writes only its label, keeping its switches and every other setting", async () => {
    const result = await saveFieldLabels({ ...base, labels: { specialty: "Area" }, expected: { specialty: "Specialty" } });
    expect(result).toEqual({ ok: true, labels: { role: "Role", specialty: "Area" } });
    expect(written().otherSetting).toBe(1);
    expect(written().personFields.specialty).toEqual({ enabled: false, required: false, label: "Area" });
    // The field that was not renamed is not written at all: its name keeps following the default.
    expect(written().personFields.role).toBeUndefined();
  });

  it("saves one field after the other card has saved the other (the two cards never trip each other)", async () => {
    // Role was just renamed by its own card; this browser's Specialty card still began from "Specialty".
    stored({ role: { label: "Profession" } });
    const result = await saveFieldLabels({ ...base, labels: { specialty: "Area" }, expected: { specialty: "Specialty" } });
    expect(result).toEqual({ ok: true, labels: { role: "Profession", specialty: "Area" } });
    expect(written().personFields.role).toEqual({ label: "Profession" });
  });

  it("refuses a save begun from an older name of the same field", async () => {
    stored({ role: { label: "Profession" } });
    const result = await saveFieldLabels({ ...base, labels: { role: "Occupation" }, expected: { role: "Role" } });
    expect(result).toMatchObject({ ok: false, code: "LABELS_CHANGED" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("refuses a name another of the three fields already has, against what is stored", async () => {
    stored({ role: { label: "Profession" } });
    for (const name of ["profession", "Títle", " TITLE "]) {
      const result = await saveFieldLabels({ ...base, labels: { specialty: name }, expected: { specialty: "Specialty" } });
      expect(result, name).toMatchObject({ ok: false, code: "INVALID_LABEL" });
    }
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("refuses another field's usual name even after that field was renamed away, and so a swap", async () => {
    stored({ specialty: { label: "Area" } });
    // Exports keep the heading "Specialty" for the field the screen now calls Area.
    expect(await saveFieldLabels({ ...base, labels: { role: "Specialty" }, expected: { role: "Role" } })).toMatchObject({ ok: false, code: "INVALID_LABEL" });
    stored({});
    expect(
      await saveFieldLabels({ ...base, labels: { role: "Specialty", specialty: "Role" }, expected: { role: "Role", specialty: "Specialty" } }),
    ).toMatchObject({ ok: false, code: "INVALID_LABEL" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("keeps a field's own saved answers when only its name changes", async () => {
    const options = [{ key: "DEV", label: "Developer", retired: false }, { key: "OPS", label: "Operations", retired: true }];
    stored({ role: { enabled: true, required: false, label: "Job", options, allowOther: false } });
    const result = await saveFieldLabels({ ...base, labels: { role: "Profession" }, expected: { role: "Job" } });
    expect(result).toMatchObject({ ok: true, labels: { role: "Profession" } });
    expect(written().personFields.role).toEqual({ enabled: true, required: false, label: "Profession", options, allowOther: false });
  });

  it("refuses a blank, over-long or letterless name, and a save that names no field", async () => {
    for (const labels of [{ role: "  " }, { role: "x".repeat(61) }, { role: "---" }, {}]) {
      const result = await saveFieldLabels({ ...base, labels, expected: { role: "Role" } });
      expect(result, JSON.stringify(labels)).toMatchObject({ ok: false, code: "INVALID_LABEL" });
    }
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
