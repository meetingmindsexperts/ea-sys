/**
 * The badge preview's exhibitor options (Oct 20, 2026, review L1). `ex` carries
 * the on-screen exhibitor switches: "off" turns the exhibitor badge off, a
 * comma list is the switched-on keys (empty = all off, NOT "use the saved
 * set"), and no `ex` keeps what was saved. `as=exhibitor` previews an
 * exhibitor's badge. Asserts on what reaches the renderer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockGenerate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  mockGenerate: vi.fn(async () => Buffer.from("%PDF")),
}));

vi.mock("next/server", () => ({
  NextResponse: class {
    status: number;
    constructor(_body: unknown, init?: { status?: number }) { this.status = init?.status ?? 200; }
    static json(body: unknown, init?: { status?: number }) { return { status: init?.status ?? 200, json: async () => body }; }
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "evt-1" } }),
}));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: () => ({ allowed: true }),
}));
vi.mock("@/lib/badge-pdf", () => ({ generateBadgePDF: mockGenerate }));

import { GET } from "@/app/api/events/[eventId]/registrations/badges/preview/route";
import type { BadgeLayout } from "@/lib/badge-layout";
import type { BadgeRegistration } from "@/lib/badge-pdf";

const SAVED_EXHIBITOR = { name: true, organization: true, country: true, barcode: false, registrationNumber: true, badgeType: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "evt-1",
    badgeVerticalOffset: 0,
    requiresDtcmBarcode: false,
    settings: { badge: { exhibitorFields: SAVED_EXHIBITOR } },
  });
});

async function preview(query: string) {
  const res = await GET(new Request(`http://x/preview?${query}`), { params: Promise.resolve({ eventId: "evt-1" }) });
  expect(res.status).toBe(200);
  const [regs, layout] = mockGenerate.mock.calls[0] as unknown as [BadgeRegistration[], BadgeLayout];
  return { sample: regs[0], layout };
}

describe("badge preview: exhibitor options", () => {
  it("no ex keeps the saved exhibitor switches", async () => {
    const { layout } = await preview("");
    expect(layout.exhibitorFields).toMatchObject({ organization: true, barcode: false });
  });

  it("ex=off turns the exhibitor badge off", async () => {
    const { layout } = await preview("ex=off");
    expect(layout.exhibitorFields).toBeNull();
  });

  it("an empty ex means every exhibitor switch off, not the saved set", async () => {
    const { layout } = await preview("ex=");
    expect(layout.exhibitorFields).toMatchObject({
      name: false, organization: false, country: false, barcode: false, registrationNumber: false, badgeType: false,
    });
  });

  it("a list switches on exactly those keys", async () => {
    const { layout } = await preview("ex=name,barcode");
    expect(layout.exhibitorFields).toMatchObject({ name: true, barcode: true, organization: false, country: false });
  });

  it("as=exhibitor previews an exhibitor; without it, a delegate", async () => {
    expect((await preview("as=exhibitor")).sample.badgeType).toBe("EXHIBITOR");
    mockGenerate.mockClear();
    expect((await preview("")).sample.badgeType).toBe("DELEGATE");
  });
});
