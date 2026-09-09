/**
 * `GET /api/events/[eventId]/abstracts?export=csv` (Sep 9, 2026).
 *
 * Owner: "abstracts can be exported by admins and organizers only". Export is
 * a NARROWER boundary than read: the list serves reviewers, submitters and
 * MEMBER; the file goes to SUPER_ADMIN / ADMIN / ORGANIZER and nobody else,
 * and every pull is audited with who and how many rows.
 *
 * MUTATION TO VERIFY AGAINST: drop the `denyReviewer` gate on the export
 * branch and the MEMBER / REVIEWER / SUBMITTER cases fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, recordExport } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
  recordExport: vi.fn(),
}));

vi.mock("next/server", () => {
  class NextResponse extends Response {
    static json(b: unknown, i?: { status?: number }) {
      return new NextResponse(JSON.stringify(b), {
        status: i?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/abstract-serial", async (orig) => ({
  ...(await orig<typeof import("@/lib/abstract-serial")>()),
  getNextAbstractSerialId: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/abstract-notifications", () => ({ sendAbstractSubmissionConfirmation: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(), getEventTemplate: vi.fn(), renderAndWrap: vi.fn() }));

import { GET } from "@/app/api/events/[eventId]/abstracts/route";

const EVENT = { id: "evt-1", organizationId: "org-1" };
const ROW = {
  id: "abs-1",
  serialId: 7,
  title: "Outcomes, revisited",
  status: "ACCEPTED",
  presentationType: "ORAL",
  specialty: "Cardiology",
  content: "Background.\nMethods: a \"cohort\" study.",
  coAuthors: [{ firstName: "Bo", lastName: "Li", jobTitle: "", organization: "Tawam", country: "United Arab Emirates" }],
  submittedAt: new Date("2026-09-01T10:00:00.000Z"),
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  speaker: { title: "DR", firstName: "Ana", lastName: "Silva", email: "ana@x.com", organization: "Cairo University", country: "Egypt" },
  theme: { name: "Heart failure" },
  subTheme: null,
  track: null,
  eventSession: null,
  submissions: [{ overallScore: 80 }, { overallScore: 70 }],
  _count: { reviewers: 2 },
};

const user = (role: string, organizationId: string | null = "org-1") => ({
  user: { id: `u-${role}`, role, organizationId },
});
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const req = (qs = "?export=csv") => new Request(`http://x/api/events/evt-1/abstracts${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstract.findMany.mockResolvedValue([ROW]);
});

describe("abstracts export: who may pull the file", () => {
  it.each([
    ["MEMBER", "org-1"],
    ["ONSITE", "org-1"],
    ["REVIEWER", null],
    ["SUBMITTER", null],
  ])("%s gets 403 and no query runs", async (role, org) => {
    mockAuth.mockResolvedValue(user(role, org));
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
    expect(recordExport).not.toHaveBeenCalled();
  });

  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER"])("%s gets the CSV, audited", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="abstracts-evt-1.csv"');
    expect(recordExport).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ entityType: "Abstract", eventId: "evt-1", organizationId: "org-1", role, rowCount: 1, format: "csv" }),
    );
  });
});

describe("abstracts export: the file", () => {
  it("carries the number, author, theme, co-authors, score and the body as one quoted cell", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    const text = await (await GET(req(), params)).text();
    // The body cell carries a newline, so split the header off rather than the text on "\n".
    const nl = text.indexOf("\n");
    const header = text.slice(0, nl);
    const line = text.slice(nl + 1);
    expect(header.startsWith("Abstract #,Title,Status,Presentation Type,Theme,Sub-theme,Track,Author,Email")).toBe(true);
    expect(line).toMatch(/^A-007,"Outcomes, revisited",ACCEPTED,ORAL,Heart failure,,,Dr\.? Ana Silva,ana@x\.com,Cairo University,Egypt,Cardiology/);
    expect(line).toContain("Bo Li (Tawam, United Arab Emirates)");
    expect(line).toContain("2026-09-01T10:00:00.000Z,2,75");
    // The body keeps its newline and its quotes inside ONE RFC 4180 cell.
    expect(line.endsWith('"Background.\nMethods: a ""cohort"" study."')).toBe(true);
  });

  it("takes the whole call for papers, not the list page's cap", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    await GET(req(), params);
    expect(mockDb.abstract.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5000 }));
  });

  it("without ?export the list is unchanged: JSON, capped at 200, and MEMBER may read it", async () => {
    mockAuth.mockResolvedValue(user("MEMBER"));
    const res = await GET(req(""), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(mockDb.abstract.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    expect(recordExport).not.toHaveBeenCalled();
  });
});
