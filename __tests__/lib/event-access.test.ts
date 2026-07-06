import { describe, it, expect } from "vitest";
import { buildEventAccessWhere } from "@/lib/event-access";

describe("buildEventAccessWhere", () => {
  // ── ADMIN (org-bound) ────────────────────────────────────────────────

  describe("ADMIN role", () => {
    it("returns org-scoped query without eventId", () => {
      const result = buildEventAccessWhere({
        id: "user-1",
        role: "ADMIN",
        organizationId: "org-123",
      });
      expect(result).toEqual({ organizationId: "org-123" });
    });

    it("returns org + event scoped query with eventId", () => {
      const result = buildEventAccessWhere(
        { id: "user-1", role: "ADMIN", organizationId: "org-123" },
        "evt-1"
      );
      expect(result).toEqual({ id: "evt-1", organizationId: "org-123" });
    });
  });

  // ── ORGANIZER (org-bound, same as admin) ─────────────────────────────

  describe("ORGANIZER role", () => {
    it("returns org-scoped query without eventId", () => {
      const result = buildEventAccessWhere({
        id: "user-2",
        role: "ORGANIZER",
        organizationId: "org-456",
      });
      expect(result).toEqual({ organizationId: "org-456" });
    });

    it("returns org + event scoped query with eventId", () => {
      const result = buildEventAccessWhere(
        { id: "user-2", role: "ORGANIZER", organizationId: "org-456" },
        "evt-2"
      );
      expect(result).toEqual({ id: "evt-2", organizationId: "org-456" });
    });
  });

  // ── REVIEWER (org-independent) ───────────────────────────────────────

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

  describe("ONSITE role", () => {
    it("scopes by org AND onsiteUserIds assignment (no eventId)", () => {
      const result = buildEventAccessWhere({
        id: "onsite-1",
        role: "ONSITE",
        organizationId: "org-1",
      });
      expect(result).toEqual({
        organizationId: "org-1",
        settings: { path: ["onsiteUserIds"], array_contains: "onsite-1" },
      });
    });

    it("scopes by org + event + assignment (with eventId)", () => {
      const result = buildEventAccessWhere(
        { id: "onsite-1", role: "ONSITE", organizationId: "org-1" },
        "evt-9"
      );
      expect(result).toEqual({
        id: "evt-9",
        organizationId: "org-1",
        settings: { path: ["onsiteUserIds"], array_contains: "onsite-1" },
      });
    });

    it("keeps the org filter (does NOT match another org's events by id alone)", () => {
      const result = buildEventAccessWhere({
        id: "onsite-1",
        role: "ONSITE",
        organizationId: "org-1",
      });
      expect(result).toHaveProperty("organizationId", "org-1");
    });

    it("is NOT the org-wide default (must carry the onsiteUserIds assignment gate)", () => {
      const result = buildEventAccessWhere({
        id: "onsite-1",
        role: "ONSITE",
        organizationId: "org-1",
      });
      expect(result).toHaveProperty("settings");
    });
  });

  // ── SUPER_ADMIN (falls through to org-bound default) ─────────────────

  describe("SUPER_ADMIN role", () => {
    it("returns org-scoped query", () => {
      const result = buildEventAccessWhere({
        id: "user-sa",
        role: "SUPER_ADMIN",
        organizationId: "org-789",
      });
      expect(result).toEqual({ organizationId: "org-789" });
    });
  });
});
