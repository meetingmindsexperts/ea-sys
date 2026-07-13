/**
 * computeAuditDiffs + auditSubjectName — the "what actually changed / who was it
 * about" layer behind an audit row.
 *
 * The diff logic used to live inside the server-only activity-feed builder. The
 * org-wide Activity feed is a client component and could not reach it, so it
 * rendered "Registration updated" forty times with no indication of what moved.
 * Extracting it to a client-safe module fixed that — but it also moved a
 * SECURITY rule (barcodes must never be rendered into an edit history) into a
 * module a client can import, so that rule is pinned here.
 */
import { describe, it, expect } from "vitest";
import { computeAuditDiffs } from "@/lib/activity-diff";
import { auditSubjectName } from "@/components/activity/audit-log-display";

const upd = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
  before,
  after,
});

describe("computeAuditDiffs", () => {
  it("reports only the fields that actually changed", () => {
    const diffs = computeAuditDiffs(
      upd(
        { status: "CONFIRMED", badgeType: "Delegate", notes: "x" },
        { status: "CHECKED_IN", badgeType: "Delegate", notes: "x" },
      ),
      true,
    );
    expect(diffs).toEqual([
      { field: "Status", before: "CONFIRMED", after: "CHECKED_IN" },
    ]);
  });

  it("descends one level into the nested attendee", () => {
    const diffs = computeAuditDiffs(
      upd(
        { attendee: { phone: "+971 1", firstName: "Jane" } },
        { attendee: { phone: "+971 2", firstName: "Jane" } },
      ),
      true,
    );
    expect(diffs).toEqual([
      { field: "Attendee: Phone", before: "+971 1", after: "+971 2" },
    ]);
  });

  it("NEVER renders a door credential, even to a finance-capable admin", () => {
    // qrCode is the entry barcode; dtcmBarcode is the Dubai DTCM credential.
    // Full-row audit snapshots contain both, so a barcode correction would
    // otherwise print the before → after straight into the feed. This is the
    // July-11 barcode-visibility boundary, and it does not bend for ADMIN.
    const diffs = computeAuditDiffs(
      upd(
        { qrCode: "OLD-QR", dtcmBarcode: "OLD-DTCM", status: "CONFIRMED" },
        { qrCode: "NEW-QR", dtcmBarcode: "NEW-DTCM", status: "CONFIRMED" },
      ),
      true, // canViewFinance — deliberately the most privileged case
    );
    expect(diffs).toEqual([]);
    expect(JSON.stringify(diffs)).not.toMatch(/QR|DTCM/);
  });

  it("strips money from the diff for a non-finance viewer", () => {
    const withFinance = computeAuditDiffs(
      upd({ originalPrice: 100, status: "A" }, { originalPrice: 250, status: "B" }),
      true,
    );
    const without = computeAuditDiffs(
      upd({ originalPrice: 100, status: "A" }, { originalPrice: 250, status: "B" }),
      false,
    );
    expect(withFinance.some((d) => d.field === "Original price")).toBe(true);
    expect(without.some((d) => d.field === "Original price")).toBe(false);
    expect(without.some((d) => d.field === "Status")).toBe(true); // the rest survives
  });

  it("drops bookkeeping noise (ids, timestamps)", () => {
    const diffs = computeAuditDiffs(
      upd(
        { id: "a", updatedAt: "t1", eventId: "e1", city: "Dubai" },
        { id: "a", updatedAt: "t2", eventId: "e1", city: "Abu Dhabi" },
      ),
      true,
    );
    expect(diffs).toEqual([{ field: "City", before: "Dubai", after: "Abu Dhabi" }]);
  });

  it("returns [] for shapes that are not a before/after pair", () => {
    // Deletes, bulk summaries and config rows carry other shapes. An empty
    // array means "nothing renderable", not an error — the row still shows its
    // description, just without change chips.
    expect(computeAuditDiffs({ deleted: { id: "x" } }, true)).toEqual([]);
    expect(computeAuditDiffs({ bulk: true, count: 12 }, true)).toEqual([]);
    expect(computeAuditDiffs(null, true)).toEqual([]);
    expect(computeAuditDiffs("nonsense", true)).toEqual([]);
  });

  it("renders empty and boolean values legibly rather than dumping raw JS", () => {
    const diffs = computeAuditDiffs(
      upd({ notes: "", isActive: false }, { notes: "Hello", isActive: true }),
      true,
    );
    expect(diffs).toContainEqual({ field: "Notes", before: "—", after: "Hello" });
    expect(diffs).toContainEqual({ field: "Is active", before: "No", after: "Yes" });
  });
});

describe("auditSubjectName", () => {
  const base = { action: "UPDATE", entityType: "Registration", entityId: "r1", user: null };

  it("names the person behind a registration row (via the nested attendee)", () => {
    expect(
      auditSubjectName({
        ...base,
        changes: upd({ attendee: { firstName: "Jane", lastName: "Doe" } }, { attendee: { firstName: "Jane", lastName: "Roe" } }),
      }),
    ).toBe("Jane Roe"); // prefers `after` — the state we moved to
  });

  it("names a speaker (name is inline, not on an attendee)", () => {
    expect(
      auditSubjectName({
        ...base,
        entityType: "Speaker",
        changes: upd({ firstName: "Ada", lastName: "Lovelace" }, { firstName: "Ada", lastName: "Lovelace" }),
      }),
    ).toBe("Ada Lovelace");
  });

  it("falls back to `before` for a delete, where there is no `after`", () => {
    expect(
      auditSubjectName({
        ...base,
        action: "DELETE",
        changes: { before: { firstName: "Gone", lastName: "Person" } },
      }),
    ).toBe("Gone Person");
  });

  it("falls back to email when no name is recorded", () => {
    expect(
      auditSubjectName({ ...base, changes: upd({}, { email: "x@y.com" }) }),
    ).toBe("x@y.com");
  });

  it("returns null when the blob carries no identity (so the UI omits it)", () => {
    expect(auditSubjectName({ ...base, changes: { bulk: true, count: 30 } })).toBeNull();
    expect(auditSubjectName({ ...base, changes: {} })).toBeNull();
  });
});
