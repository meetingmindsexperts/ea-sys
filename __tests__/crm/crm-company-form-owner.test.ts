/**
 * The account form sends an owner only from the edit form (create has no owner
 * field), and "Unassigned" becomes null (Oct 27, 2026).
 */
import { describe, it, expect } from "vitest";
import { crmCompanyFormPayload, crmCompanyToForm, emptyCrmCompanyForm } from "@/crm/components/crm-company-form-fields";
import { NO_OWNER } from "@/crm/components/crm-contact-form-fields";

describe("crmCompanyFormPayload owner", () => {
  it("create (no owner field) sends no ownerId at all", () => {
    expect(crmCompanyFormPayload({ ...emptyCrmCompanyForm(), name: "Abbott" })).not.toHaveProperty("ownerId");
  });

  it("edit sends the owner, and Unassigned as null", () => {
    const form = crmCompanyToForm({ name: "Abbott", owner: { id: "u-1" } });
    expect(crmCompanyFormPayload(form).ownerId).toBe("u-1");
    expect(crmCompanyFormPayload({ ...form, ownerId: NO_OWNER }).ownerId).toBeNull();
    expect(crmCompanyToForm({ name: "Abbott", owner: null }).ownerId).toBe(NO_OWNER);
  });
});
