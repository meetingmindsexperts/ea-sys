import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A speaker's reimbursement document opens in the browser, or downloads with
 * one click (?download=1, Nov 19, 2026), from the same authed route.
 */

const { mockAuth, mockFindDoc } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockFindDoc: vi.fn() }));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: { speakerReimbursementDocument: { findFirst: (...a: unknown[]) => mockFindDoc(...a) } } }));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: async () => ({ id: "ev1", organizationId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: () => ({ ok: true, eventWhere: {} }) }));
vi.mock("@/lib/storage", () => ({ readStoredFile: async () => Buffer.from("%PDF-1.4") }));

import { GET } from "@/app/api/events/[eventId]/reimbursements/[reimbursementId]/documents/[documentId]/route";

const params = Promise.resolve({ eventId: "ev1", reimbursementId: "r1", documentId: "d1" });
const call = (query = "") => GET(new Request(`http://localhost/x${query}`), { params });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockFindDoc.mockResolvedValue({ url: "/uploads/reimbursements/2026/11/a.pdf", filename: "Taxi receipt.pdf", mimeType: "application/pdf" });
});

describe("reimbursement document", () => {
  it("opens in the browser by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="Taxi receipt.pdf"/);
  });

  it("downloads with ?download=1", async () => {
    const res = await call("?download=1");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="Taxi receipt.pdf"/);
  });

  it("keeps a non-English name for the browser, and a header-safe plain one", async () => {
    mockFindDoc.mockResolvedValue({ url: "/uploads/reimbursements/2026/11/b.pdf", filename: 'إيصال "1".pdf', mimeType: "application/pdf" });
    const value = (await call("?download=1")).headers.get("Content-Disposition") ?? "";
    expect(value).toContain("filename*=UTF-8''");
    expect(value).not.toMatch(/filename="[^"]*"[^;]*"/);
  });

  it("cuts a long name by character, so an emoji at the cut does not fail the download", async () => {
    mockFindDoc.mockResolvedValue({ url: "/uploads/reimbursements/2026/11/c.pdf", filename: `${"a".repeat(119)}😀 receipt.pdf`, mimeType: "application/pdf" });
    const res = await call("?download=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("%F0%9F%98%80");
  });
});
