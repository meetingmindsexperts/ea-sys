/**
 * Public doc links (Sep 25, 2026): the rules in src/lib/public-docs.ts. Only
 * an existing HTML doc can be made public, keyed by the path the reader
 * resolves; nothing is public where the deployment does not enable doc links;
 * every switch is audited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRead } = vi.hoisted(() => ({
  mockDb: {
    publicDoc: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockRead: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/docs-fs", () => ({ readDocFile: mockRead }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { isDocPublic, listPublicDocPaths, setDocPublic } from "@/lib/public-docs";

const HTML = { path: "docs/WEBINAR_EVENTS.html", content: "<h1/>", type: "html", size: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_DOC_LINKS_ENABLED", "true");
  mockDb.auditLog.create.mockResolvedValue({});
  mockRead.mockResolvedValue(HTML);
});

describe("public docs", () => {
  it("makes a doc public under the path the reader resolved, and audits who did it", async () => {
    expect(await setDocPublic({ path: "docs/WEBINAR_EVENTS.html", makePublic: true, userId: "op1" })).toEqual({ ok: true, path: "docs/WEBINAR_EVENTS.html", public: true });
    expect(mockDb.publicDoc.upsert).toHaveBeenCalledWith({ where: { path: "docs/WEBINAR_EVENTS.html" }, update: {}, create: { path: "docs/WEBINAR_EVENTS.html", sharedByUserId: "op1" } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "op1", action: "SHARE", entityType: "PublicDoc", entityId: "docs/WEBINAR_EVENTS.html" }) });
  });

  it("resolves a short path the way the shared link does and stores the resolved one, so both URLs match one row", async () => {
    mockRead.mockImplementation(async (p: string) => (p === "docs/WEBINAR_EVENTS.html" ? HTML : null));
    expect(await setDocPublic({ path: "WEBINAR_EVENTS.html", makePublic: true, userId: "op1" })).toMatchObject({ ok: true, path: "docs/WEBINAR_EVENTS.html" });
    expect(mockDb.publicDoc.upsert.mock.calls[0][0].where).toEqual({ path: "docs/WEBINAR_EVENTS.html" });
  });

  it("makes it private again by deleting the row, audited as UNSHARE", async () => {
    await setDocPublic({ path: "docs/WEBINAR_EVENTS.html", makePublic: false, userId: "op1" });
    expect(mockDb.publicDoc.deleteMany).toHaveBeenCalledWith({ where: { path: "docs/WEBINAR_EVENTS.html" } });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("UNSHARE");
  });

  it("refuses markdown, a missing file and a traversal attempt, writing nothing", async () => {
    mockRead.mockResolvedValueOnce({ ...HTML, path: "docs/ROLLBACK.md", type: "markdown" });
    expect(await setDocPublic({ path: "docs/ROLLBACK.md", makePublic: true, userId: "op1" })).toMatchObject({ ok: false, code: "NOT_HTML" });
    mockRead.mockResolvedValueOnce(null);
    expect(await setDocPublic({ path: "docs/NOPE.html", makePublic: true, userId: "op1" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    mockRead.mockRejectedValueOnce(new Error("traversal"));
    expect(await setDocPublic({ path: "../.env", makePublic: true, userId: "op1" })).toMatchObject({ ok: false, code: "INVALID_PATH" });
    expect(mockDb.publicDoc.upsert).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("does nothing, and reports nothing public, where the deployment does not enable doc links", async () => {
    vi.stubEnv("ADMIN_DOC_LINKS_ENABLED", "");
    expect(await setDocPublic({ path: "docs/WEBINAR_EVENTS.html", makePublic: true, userId: "op1" })).toMatchObject({ ok: false, code: "DISABLED" });
    mockDb.publicDoc.findUnique.mockResolvedValue({ path: "docs/WEBINAR_EVENTS.html" });
    expect(await isDocPublic("docs/WEBINAR_EVENTS.html")).toBe(false);
    expect(await listPublicDocPaths()).toEqual([]);
    expect(mockDb.publicDoc.findUnique).not.toHaveBeenCalled();
  });

  it("reads a public row where enabled", async () => {
    mockDb.publicDoc.findUnique.mockResolvedValueOnce({ path: "docs/WEBINAR_EVENTS.html" }).mockResolvedValueOnce(null);
    expect(await isDocPublic("docs/WEBINAR_EVENTS.html")).toBe(true);
    expect(await isDocPublic("docs/SYSTEM_DESIGN.html")).toBe(false);
  });
});
