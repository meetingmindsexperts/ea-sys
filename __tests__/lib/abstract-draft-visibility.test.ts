import { describe, it, expect } from "vitest";
import { AbstractStatus } from "@prisma/client";
import { abstractListStatusFilter } from "@/lib/abstract-draft-visibility";

describe("abstractListStatusFilter", () => {
  describe("owning submitter (canSeeDrafts: true)", () => {
    it("no requested status → no status constraint (sees own drafts + everything)", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: true })).toBeUndefined();
      expect(abstractListStatusFilter({ canSeeDrafts: true, requestedStatus: null })).toBeUndefined();
    });

    it("explicit DRAFT → shows drafts", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: true, requestedStatus: AbstractStatus.DRAFT }))
        .toBe(AbstractStatus.DRAFT);
    });

    it("explicit non-draft status → that status", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: true, requestedStatus: AbstractStatus.SUBMITTED }))
        .toBe(AbstractStatus.SUBMITTED);
    });
  });

  describe("non-submitter — org/admin/reviewer/MCP (canSeeDrafts: false)", () => {
    it("no requested status → excludes drafts", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: false })).toEqual({ not: AbstractStatus.DRAFT });
    });

    it("explicit DRAFT request → empty set (never leaks drafts)", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: false, requestedStatus: AbstractStatus.DRAFT }))
        .toEqual({ in: [] });
    });

    it("explicit non-draft status → that status (already excludes drafts)", () => {
      expect(abstractListStatusFilter({ canSeeDrafts: false, requestedStatus: AbstractStatus.ACCEPTED }))
        .toBe(AbstractStatus.ACCEPTED);
    });

    it("every non-draft status is honored verbatim", () => {
      for (const s of Object.values(AbstractStatus)) {
        if (s === AbstractStatus.DRAFT) continue;
        expect(abstractListStatusFilter({ canSeeDrafts: false, requestedStatus: s })).toBe(s);
      }
    });
  });
});
