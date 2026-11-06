/**
 * The CRM reaches infrastructure only through its ports in
 * src/crm/integrations/ (CRM product review P1-8, Nov 6, 2026): storage,
 * documents (PDF + branding), accounting and events. A direct import of the
 * core module, or a direct db.event read, anywhere else in the CRM namespace
 * would quietly re-couple the business logic to EA-SYS's implementation.
 * Plus the ports' own small contracts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const core = vi.hoisted(() => ({
  uploadFile: vi.fn(async () => "/uploads/x"),
  readStoredFile: vi.fn(async () => Buffer.from("x")),
  deleteStoredFile: vi.fn(async () => undefined),
  loadLocalLogo: vi.fn(async () => Buffer.from("logo")),
  createEstimate: vi.fn(async () => ({ ok: true })),
  buildEstimateBody: vi.fn(() => ({ built: true })),
  findMany: vi.fn(async () => []),
}));
vi.mock("@/lib/storage", () => ({ uploadFile: core.uploadFile, readStoredFile: core.readStoredFile, deleteStoredFile: core.deleteStoredFile }));
vi.mock("@/lib/pdf/document-layout", async (orig) => ({ ...(await orig<object>()), loadLocalLogo: core.loadLocalLogo }));
vi.mock("@/lib/quickbooks/sales", async (orig) => ({ ...(await orig<object>()), createEstimate: core.createEstimate, buildEstimateBody: core.buildEstimateBody }));
vi.mock("@/lib/db", () => ({ db: { event: { findMany: core.findMany, findFirst: vi.fn() } } }));

import { crmStorage } from "@/crm/integrations/storage";
import { crmBranding } from "@/crm/integrations/documents";
import { crmAccounting } from "@/crm/integrations/accounting";
import { crmEvents } from "@/crm/integrations/events";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const ROOT = path.join(__dirname, "../..");
const CRM_DIRS = ["src/crm", "src/app/api/crm", "src/app/(dashboard)/crm"].map((d) => path.join(ROOT, d));
const PORTS = path.join(ROOT, "src/crm/integrations");

describe("the CRM goes through its ports", () => {
  it("no CRM file outside src/crm/integrations imports core storage, PDF layout or QuickBooks, or reads db.event", () => {
    const banned = [/from "@\/lib\/storage"/, /from "@\/lib\/upload-prefixes"/, /from "@\/lib\/pdf\//, /from "@\/lib\/quickbooks\//, /\bdb\.event\./];
    const offenders = CRM_DIRS.flatMap(files)
      .filter((f) => !f.startsWith(PORTS))
      // The quote layout itself is built on core's PDF primitives; it sits behind the renderer port.
      .filter((f) => !f.endsWith(path.join("src/crm/lib/quote-pdf.ts")))
      .filter((f) => banned.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("the default ports", () => {
  beforeEach(() => vi.clearAllMocks());

  it("storage keeps each kind under its own private prefix", async () => {
    await crmStorage.save("dealDocument", "d1", { buffer: Buffer.from("a"), filename: "q.pdf", mimeType: "application/pdf" });
    expect(core.uploadFile).toHaveBeenCalledWith(expect.any(Buffer), "q.pdf", "application/pdf", "crm-deal-docs/d1");
    await crmStorage.read("emailAttachment", "/uploads/crm-email-attachments/t1/x");
    expect(core.readStoredFile).toHaveBeenCalledWith("/uploads/crm-email-attachments/t1/x", expect.stringContaining("crm-email-attachments"));
    await crmStorage.remove("dealDocument", "/uploads/crm-deal-docs/d1/q.pdf");
    expect(core.deleteStoredFile).toHaveBeenCalledWith("/uploads/crm-deal-docs/d1/q.pdf", expect.stringContaining("crm-deal-docs"));
  });

  it("branding prints the company name (else the organisation's), its address and logo", async () => {
    const issuer = await crmBranding.issuer({
      name: "MMG", companyName: "Meeting Minds FZ-LLC", logo: "/uploads/logo.png",
      companyAddress: "Office 1", companyCity: "Dubai", companyState: null, companyZipCode: null, companyCountry: "UAE", taxId: "TRN1",
    });
    expect(issuer).toEqual({ name: "Meeting Minds FZ-LLC", addressLines: ["Office 1", "Dubai", "UAE"], taxId: "TRN1", logoBuffer: Buffer.from("logo") });
    expect(crmBranding.issuerName({ name: "MMG", companyName: null })).toBe("MMG");
  });

  it("accounting builds the Estimate body itself and passes the request id", async () => {
    await crmAccounting.createEstimate("org-1", { docNumber: "Q-1" } as never, "crmq-q-0");
    expect(core.buildEstimateBody).toHaveBeenCalledWith({ docNumber: "Q-1" });
    expect(core.createEstimate).toHaveBeenCalledWith("org-1", { built: true }, "crmq-q-0");
  });

  it("events offers only linkable events (no draft or cancelled), organisation-bound", async () => {
    await crmEvents.listLinkable("org-1");
    expect(core.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", status: { notIn: ["DRAFT", "CANCELLED"] } } }));
  });
});
