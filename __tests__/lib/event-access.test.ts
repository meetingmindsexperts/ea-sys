import { describe, it, expect } from "vitest";
import { buildEventAccessWhere } from "@/lib/event-access";

describe("buildEventAccessWhere", () => {
  // ── ADMIN (org-bound) ────────────────────────────────────────────────

  // ── ORGANIZER (org-bound, same as admin) ─────────────────────────────

  // ── REVIEWER (org-independent) ───────────────────────────────────────

  // Staff no longer come through here (custom roles Phase 6): their lookups ask
  // a permission. A staff role that reaches this predicate gets no events.
  it("gives staff roles no events (fail closed)", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER"]) {
      expect(buildEventAccessWhere({ id: "u1", role, organizationId: "org-1" }, "evt-1")).toEqual({ id: { in: [] } });
    }
  });

  describe("REVIEWER role", () => {
    it("returns settings-scoped query without eventId", () => {
      const result = buildEventAccessWhere({
        id: "reviewer-1",
        role: "REVIEWER",
        organizationId: null,
      });
      expect(result).toEqual({
        settings: { path: ["reviewerUserIds"], array_contains: "reviewer-1" },
      });
    });

    it("returns settings + event scoped query with eventId", () => {
      const result = buildEventAccessWhere(
        { id: "reviewer-1", role: "REVIEWER", organizationId: null },
        "evt-3"
      );
      expect(result).toEqual({
        id: "evt-3",
        settings: { path: ["reviewerUserIds"], array_contains: "reviewer-1" },
      });
    });

    it("does NOT include organizationId", () => {
      const result = buildEventAccessWhere({
        id: "reviewer-1",
        role: "REVIEWER",
        organizationId: null,
      });
      expect(result).not.toHaveProperty("organizationId");
    });
  });

  // ── SUBMITTER (org-independent) ──────────────────────────────────────

  describe("SUBMITTER role", () => {
    it("returns speaker-scoped query without eventId", () => {
      const result = buildEventAccessWhere({
        id: "submitter-1",
        role: "SUBMITTER",
        organizationId: null,
      });
      expect(result).toEqual({
        speakers: { some: { userId: "submitter-1" } },
      });
    });

    it("returns speaker + event scoped query with eventId", () => {
      const result = buildEventAccessWhere(
        { id: "submitter-1", role: "SUBMITTER", organizationId: null },
        "evt-4"
      );
      expect(result).toEqual({
        id: "evt-4",
        speakers: { some: { userId: "submitter-1" } },
      });
    });

    it("does NOT include organizationId", () => {
      const result = buildEventAccessWhere({
        id: "submitter-1",
        role: "SUBMITTER",
        organizationId: null,
      });
      expect(result).not.toHaveProperty("organizationId");
    });
  });

  // ── ONSITE (org-bound + per-event assignment) ───────────────────────

  // ── SUPER_ADMIN (falls through to org-bound default) ─────────────────

});
