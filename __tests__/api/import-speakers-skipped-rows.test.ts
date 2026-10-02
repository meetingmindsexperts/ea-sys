/**
 * Speaker CSV import names the rows it skips (Oct 2, 2026). An organiser
 * imported 30 speakers, saw "27 created (3 skipped)" and had no way to tell
 * which three; the result now lists each skipped row with its reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger, mockUpdateSpeaker } = vi.hoisted(() => ({
  mockUpdateSpeaker: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn(), createMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } }) }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/speaker-companion", () => ({ ensureCompanionsForSpeakerEmails: vi.fn(async () => undefined) }));
vi.mock("@/lib/contact-sync", () => ({ syncManyToContacts: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/services/speaker-service", () => ({ updateSpeaker: (...a: unknown[]) => mockUpdateSpeaker(...a) }));

import { POST } from "@/app/api/events/[eventId]/import/speakers/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };

function csvRequest(csv: string, updateExisting = false): Request {
  const fd = new FormData();
  fd.append("file", new File([csv], "speakers.csv", { type: "text/csv" }));
  if (updateExisting) fd.append("updateExisting", "true");
  return new Request("http://localhost/api/events/ev1/import/speakers", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.speaker.findMany.mockResolvedValue([{ email: "Existing@Example.com" }]);
  mockDb.speaker.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("speaker CSV import: skipped rows", () => {
  it("names each skipped row and why: already a speaker, or repeated in the file", async () => {
    const csv = [
      "email,firstName,lastName",
      "new@example.com,Nadia,New", // row 2: created
      "existing@example.com,Eli,Existing", // row 3: already a speaker
      "NEW@example.com,Nadia,Again", // row 4: repeat of row 2
    ].join("\n");
    const body = await (await POST(csvRequest(csv), params)).json();
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(2);
    expect(body.skippedRows).toEqual([
      "Row 3: existing@example.com is already a speaker on this event",
      "Row 4: new@example.com appears earlier in this file (row 2)",
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Import skipped rows", skippedRows: body.skippedRows }),
    );
  });

  it("lists skipped rows even when nothing new was created", async () => {
    const body = await (
      await POST(csvRequest("email,firstName,lastName\nexisting@example.com,Eli,Existing"), params)
    ).json();
    expect(body.created).toBe(0);
    expect(body.skippedRows).toEqual(["Row 2: existing@example.com is already a speaker on this event"]);
    expect(mockDb.speaker.createMany).not.toHaveBeenCalled();
  });

  it("keeps errors separate from skips", async () => {
    const body = await (await POST(csvRequest("email,firstName,lastName\n,No,Email"), params)).json();
    expect(body.errors).toEqual(["Row 2: missing required fields (email, firstName, lastName)"]);
    expect(body.skippedRows).toEqual([]);
  });
});

describe("speaker CSV import: update-or-create (Oct 2, 2026)", () => {
  const EXISTING = {
    id: "sp-1", email: "existing@example.com", firstName: "Eli", lastName: "Existing", title: null, role: null,
    organization: "Old Hospital", jobTitle: "Cardiologist", phone: null, bio: "Old bio", city: null, state: null,
    zipCode: null, country: null, specialty: null, registrationType: null, website: null, additionalEmail: null,
    status: "CONFIRMED", tags: ["faculty"],
  };

  beforeEach(() => {
    mockDb.speaker.findMany.mockResolvedValue([EXISTING]);
    mockUpdateSpeaker.mockResolvedValue({ ok: true, speaker: {}, companionCascade: null });
  });

  it("updates only the filled cells that differ, keeps empty ones, adds tags", async () => {
    const csv = "email,firstName,lastName,organization,jobTitle,bio,tags\nexisting@example.com,Eli,Existing,New Clinic,Cardiologist,,committee";
    const body = await (await POST(csvRequest(csv, true), params)).json();
    expect(mockUpdateSpeaker).toHaveBeenCalledWith(
      expect.objectContaining({
        speakerId: "sp-1",
        eventId: "ev1",
        fields: { organization: "New Clinic", tags: ["faculty", "committee"] },
      }),
    );
    expect(body).toEqual(expect.objectContaining({ created: 0, updated: 1, unchanged: 0, skipped: 0 }));
    expect(body.updatedRows).toEqual(["Row 2: existing@example.com updated (organisation, tags (+committee))"]);
  });

  it("re-importing the same values changes nothing and calls no update", async () => {
    const csv = "email,firstName,lastName,organization\nexisting@example.com,Eli,Existing,Old Hospital";
    const body = await (await POST(csvRequest(csv, true), params)).json();
    expect(mockUpdateSpeaker).not.toHaveBeenCalled();
    expect(body).toEqual(expect.objectContaining({ updated: 0, unchanged: 1, skipped: 0 }));
  });

  it("an empty status cell never resets a confirmed speaker to invited", async () => {
    const csv = "email,firstName,lastName,status,jobTitle\nexisting@example.com,Eli,Existing,,Head of Cardiology";
    await POST(csvRequest(csv, true), params);
    expect(mockUpdateSpeaker.mock.calls[0][0].fields).toEqual({ jobTitle: "Head of Cardiology" });
  });

  it("with the option off, existing speakers are skipped as before", async () => {
    const csv = "email,firstName,lastName,organization\nexisting@example.com,Eli,Existing,New Clinic";
    const body = await (await POST(csvRequest(csv, false), params)).json();
    expect(mockUpdateSpeaker).not.toHaveBeenCalled();
    expect(body.skippedRows).toEqual(["Row 2: existing@example.com is already a speaker on this event"]);
  });

  it("a failed update is reported as a row error", async () => {
    mockUpdateSpeaker.mockResolvedValue({ ok: false, code: "UNKNOWN", message: "boom" });
    const csv = "email,firstName,lastName,organization\nexisting@example.com,Eli,Existing,New Clinic";
    const body = await (await POST(csvRequest(csv, true), params)).json();
    expect(body.errors).toEqual(["Row 2: could not update existing@example.com (boom)"]);
    expect(body.updated).toBe(0);
  });
});

