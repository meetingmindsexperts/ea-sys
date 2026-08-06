/**
 * Abstract-themes GET — org-null read access (Aug 6, 2026 warning-triage fix).
 *
 * The regression class this pins: the July 24 `requireOrgId` sweep 403'd
 * org-null SUBMITTERs on this GET, leaving the abstract form's theme picker
 * empty on themed events (confirmed live on MEHF 2027, 12 themes). The GET
 * now authorizes via buildEventAccessWhere (the session-proposal-themes
 * pattern): a LINKED submitter reads the list, a stranger 404s, and theme
 * WRITES stay org-staff only.
 *
 * denyReviewer + buildEventAccessWhere run REAL — the tests pin the actual
 * boundary, not a mock of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstractTheme: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: () => null, set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from "@/app/api/events/[eventId]/abstract-themes/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/events/ev1/abstract-themes", {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

const ADMIN = { user: { id: "u-admin", role: "ADMIN", organizationId: "org1" } };
const SUBMITTER = { user: { id: "u-sub", role: "SUBMITTER", organizationId: null } };
const REVIEWER = { user: { id: "u-rev", role: "REVIEWER", organizationId: null } };
const MEMBER = { user: { id: "u-mem", role: "MEMBER", organizationId: "org1" } };

const EVENT = { id: "ev1", organizationId: "org1" };
const THEMES = [{ id: "th1", name: "Heart Failure", sortOrder: 0, _count: { abstracts: 2 } }];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstractTheme.findMany.mockResolvedValue(THEMES);
});

describe("GET /abstract-themes — org-null read access", () => {
  it("a linked SUBMITTER reads the theme list (the form's theme picker) — never 403", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(THEMES);
    // Access resolved via the submitter's speaker linkage, NOT requireOrgId.
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ speakers: { some: { userId: "u-sub" } } }),
      }),
    );
  });

  it("a pool REVIEWER reads the theme list too", async () => {
    mockAuth.mockResolvedValue(REVIEWER);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
  });

  it("an UNLINKED submitter 404s (buildEventAccessWhere finds no event)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(404);
    expect(mockDb.abstractTheme.findMany).not.toHaveBeenCalled();
  });

  it("org staff keep reading (ADMIN, org-scoped where)", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org1" }),
      }),
    );
  });

  it("unauthenticated stays 401", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(401);
  });
});

describe("POST /abstract-themes — writes stay org-staff", () => {
  it("SUBMITTER cannot create a theme (requireOrgId still guards the POST)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await POST(req("POST", { name: "New Theme" }), params);
    expect(res.status).toBe(403);
    expect(mockDb.abstractTheme.create).not.toHaveBeenCalled();
  });

  it("MEMBER cannot create a theme (denyReviewer)", async () => {
    mockAuth.mockResolvedValue(MEMBER);
    const res = await POST(req("POST", { name: "New Theme" }), params);
    expect(res.status).toBe(403);
    expect(mockDb.abstractTheme.create).not.toHaveBeenCalled();
  });

  it("ADMIN creates a theme (unchanged)", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    mockDb.abstractTheme.findFirst.mockResolvedValue({ sortOrder: 1 });
    mockDb.abstractTheme.create.mockResolvedValue({ id: "th2", name: "New Theme", sortOrder: 2 });
    const res = await POST(req("POST", { name: "New Theme" }), params);
    expect(res.status).toBe(201);
    expect(mockDb.abstractTheme.create.mock.calls[0][0].data.organizationId).toBe("org1");
  });
});
