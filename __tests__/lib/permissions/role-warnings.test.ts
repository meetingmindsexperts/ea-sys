/** The role editor's warnings before save (custom roles plan §8.3). */
import { describe, it, expect } from "vitest";
import { roleWarnings } from "@/lib/permissions/role-warnings";

const codes = (grants: Parameters<typeof roleWarnings>[0]) => roleWarnings(grants).map((w) => w.code);

describe("role warnings", () => {
  it("say nothing about a plain reading role", () => {
    expect(codes([{ permission: "registrations.read", scope: "ALL" }, { permission: "crm.read", scope: null }])).toEqual([]);
  });

  it("flag what cannot easily be undone", () => {
    expect(codes([{ permission: "payments.refund", scope: "ALL" }, { permission: "creditNotes.issue", scope: "ALL" }])).toContain("SENSITIVE");
  });

  it("flag exporting while seeing money or barcodes", () => {
    expect(codes([{ permission: "registrations.export", scope: "ALL" }, { permission: "finance.view", scope: null }])).toContain("EXPORT_WITH_FIELDS");
    expect(codes([{ permission: "registrations.export", scope: "ASSIGNED" }, { permission: "finance.view", scope: null }])).not.toContain("EXPORT_WITH_FIELDS");
  });

  it("flag a refund that could never complete", () => {
    expect(codes([{ permission: "payments.refund", scope: "ALL" }])).toContain("REFUND_WITHOUT_CREDIT_NOTE");
  });

  it("flag a desk action without the registrations it acts on, at the same scope", () => {
    expect(codes([{ permission: "registrations.checkin", scope: "ASSIGNED" }])).toContain("DESK_WITHOUT_READ");
    expect(codes([{ permission: "registrations.checkin", scope: "ALL" }, { permission: "registrations.read", scope: "ASSIGNED" }])).toContain("DESK_WITHOUT_READ");
    expect(codes([{ permission: "registrations.checkin", scope: "ASSIGNED" }, { permission: "registrations.read", scope: "ASSIGNED" }])).not.toContain("DESK_WITHOUT_READ");
    expect(codes([{ permission: "registrations.checkin", scope: "WEBINAR" }, { permission: "registrations.read", scope: "ALL" }])).not.toContain("DESK_WITHOUT_READ");
  });
});
