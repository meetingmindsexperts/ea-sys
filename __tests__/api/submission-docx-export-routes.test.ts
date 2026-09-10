/**
 * `?export=docx` on the abstracts and session-proposals GETs (Sep 10, 2026,
 * organiser request: "export all abstracts into a Word document, and session
 * proposals into a Word document").
 *
 * Word is a second output FORMAT on the calls that already serve the CSV, so
 * the properties worth pinning are the ones that would let the two drift:
 *   - the same staff-only boundary (MEMBER / ONSITE / REVIEWER / SUBMITTER 403,
 *     and no query runs for a refused caller);
 *   - the same row cap as the CSV, so "all abstracts" is not silently truncated;
 *   - a real .docx body, not a JSON error saved under a .docx name;
 *   - an audit row carrying `format: "docx"`.
 *
 * MUTATION TO VERIFY AGAINST: drop `wantsDocx` from the export gate and the
 * four refusal cases fail on each route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import PizZip from "pizzip";

const { mockDb, mockAuth, recordExport } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn() },
    sessionProposal: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  recordExport: vi.fn(),
}));

// A real Response subclass: the point of these tests is to read the BYTES back,
// which a string-bodied fake could not carry.
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
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_o: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/abstract-notifications", () => ({ sendAbstractSubmissionConfirmation: vi.fn() }));
vi.mock("@/lib/session-proposal-notify", () => ({ notifySessionProposalSubmitted: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(), getEventTemplate: vi.fn(), renderAndWrap: vi.fn() }));
vi.mock("@/lib/abstract-serial", async (orig) => ({
  ...(await orig<typeof import("@/lib/abstract-serial")>()),
  getNextAbstractSerialId: vi.fn(),
}));
vi.mock("@/lib/session-proposal-serial", async (orig) => ({
  ...(await orig<typeof import("@/lib/session-proposal-serial")>()),
  getNextSessionProposalSerialId: vi.fn(),
}));

import { GET as ABSTRACTS_GET } from "@/app/api/events/[eventId]/abstracts/route";
import { GET as PROPOSALS_GET } from "@/app/api/events/[eventId]/session-proposals/route";

const EVENT = { id: "evt-1", name: "Middle East Heart Failure 2027", organizationId: "org-1" };

const SPEAKER = {
  title: "DR",
  firstName: "Ana",
  lastName: "Silva",
  email: "ana@x.com",
  additionalEmail: null,
  organization: "Tawam Hospital",
  country: "United Arab Emirates",
};

const ABSTRACT_ROW = {
  id: "abs-1",
  serialId: 7,
  title: "Outcomes & <5 mm lesions",
  status: "ACCEPTED",
  presentationType: "ORAL_POSTER",
  specialty: "Cardiology",
  content: "Background paragraph.\nMethods paragraph.",
  coAuthors: [{ firstName: "Bo", lastName: "Li", jobTitle: "", organization: "Tawam", country: "UAE" }],
  submittedAt: new Date("2026-09-01T10:00:00.000Z"),
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  speaker: SPEAKER,
  theme: { name: "Heart failure" },
  subTheme: { name: "Acute" },
  track: null,
  eventSession: null,
  submissions: [{ overallScore: 80 }],
  _count: { reviewers: 1 },
};

const PROPOSAL_ROW = {
  id: "sp-1",
  serialId: 3,
  title: "Hands-on echo",
  description: "A practical session.",
  status: "SUBMITTED",
  durationMinutes: 45,
  proposedFormat: "WORKSHOP",
  submittedAt: new Date("2026-09-01T10:00:00.000Z"),
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  speaker: { ...SPEAKER, id: "spk-1", userId: null, sourceRegistrationId: null, sourceRegistration: null },
  theme: { name: "Imaging" },
};

const user = (role: string, organizationId: string | null = "org-1") => ({
  user: { id: `u-${role}`, role, organizationId },
});

const abstractsParams = { params: Promise.resolve({ eventId: "evt-1" }) };
const proposalsParams = { params: Promise.resolve({ eventId: "evt-1" }) };

const abstractsReq = (qs = "?export=docx") =>
  new Request(`http://x/api/events/evt-1/abstracts${qs}`);
const proposalsReq = (qs = "?export=docx") =>
  new Request(`http://x/api/events/evt-1/session-proposals${qs}`);

/** Read the Word package back the way the organiser's Word does. */
async function documentXml(res: Response): Promise<string> {
  const zip = new PizZip(Buffer.from(await res.arrayBuffer()));
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("word/document.xml missing — the response was not a .docx");
  return file.asText();
}

const REFUSED: [string, string | null][] = [
  ["MEMBER", "org-1"],
  ["ONSITE", "org-1"],
  ["REVIEWER", null],
  ["SUBMITTER", null],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstract.findMany.mockResolvedValue([ABSTRACT_ROW]);
  mockDb.sessionProposal.findMany.mockResolvedValue([PROPOSAL_ROW]);
});

describe("abstracts ?export=docx", () => {
  it.each(REFUSED)("%s gets 403 and no query runs", async (role, org) => {
    mockAuth.mockResolvedValue(user(role, org));
    const res = await ABSTRACTS_GET(abstractsReq(), abstractsParams);
    expect(res.status).toBe(403);
    expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
    expect(recordExport).not.toHaveBeenCalled();
  });

  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER"])("%s gets a Word file, audited", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await ABSTRACTS_GET(abstractsReq(), abstractsParams);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.headers.get("Content-Disposition")).toContain('filename="abstracts-evt-1.docx"');
    expect(recordExport).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        entityType: "Abstract",
        eventId: "evt-1",
        organizationId: "org-1",
        role,
        rowCount: 1,
        format: "docx",
      }),
    );
  });

  it("writes the organiser's four lines plus the body into a real .docx", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    const xml = await documentXml(await ABSTRACTS_GET(abstractsReq(), abstractsParams));

    expect(xml).toContain("Middle East Heart Failure 2027 — Abstracts");
    expect(xml).toContain("1 abstract · Exported");
    expect(xml).toContain("A-007");
    // The title's & and < survive as entities rather than corrupting the package.
    expect(xml).toContain("Outcomes &amp; &lt;5 mm lesions");
    expect(xml).toContain("Heart failure › Acute");
    expect(xml).toContain("Dr. Ana Silva, Tawam Hospital, United Arab Emirates");
    expect(xml).toContain("Bo Li, Tawam, UAE");
    expect(xml).toContain("Oral or Poster");
    expect(xml).toContain("Background paragraph.");
    expect(xml).toContain("Methods paragraph.");
  });

  it("takes the whole call for papers, the same cap as the CSV", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    await ABSTRACTS_GET(abstractsReq(), abstractsParams);
    expect(mockDb.abstract.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5000 }));
  });

  it("leaves the JSON list untouched: MEMBER still reads it, capped at 200", async () => {
    mockAuth.mockResolvedValue(user("MEMBER"));
    const res = await ABSTRACTS_GET(abstractsReq(""), abstractsParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(mockDb.abstract.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    expect(recordExport).not.toHaveBeenCalled();
  });
});

describe("session proposals ?export=docx", () => {
  it.each(REFUSED)("%s gets 403 and no query runs", async (role, org) => {
    mockAuth.mockResolvedValue(user(role, org));
    const res = await PROPOSALS_GET(proposalsReq(), proposalsParams);
    expect(res.status).toBe(403);
    expect(mockDb.sessionProposal.findMany).not.toHaveBeenCalled();
    expect(recordExport).not.toHaveBeenCalled();
  });

  it.each(["SUPER_ADMIN", "ADMIN", "ORGANIZER"])("%s gets a Word file, audited", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await PROPOSALS_GET(proposalsReq(), proposalsParams);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="session-proposals-evt-1.docx"',
    );
    expect(recordExport).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        entityType: "SessionProposal",
        eventId: "evt-1",
        organizationId: "org-1",
        role,
        rowCount: 1,
        format: "docx",
      }),
    );
  });

  it("shows duration and format where an abstract shows presentation type", async () => {
    mockAuth.mockResolvedValue(user("ORGANIZER"));
    const xml = await documentXml(await PROPOSALS_GET(proposalsReq(), proposalsParams));

    expect(xml).toContain("Middle East Heart Failure 2027 — Session Proposals");
    expect(xml).toContain("S-003");
    expect(xml).toContain("Hands-on echo");
    expect(xml).toContain("Imaging");
    expect(xml).toContain("Proposer: ");
    expect(xml).toContain("45 minutes");
    expect(xml).toContain("Workshop");
    expect(xml).toContain("A practical session.");
  });

  it("takes the export cap, not the list page's 500 (the CSV truncated silently before)", async () => {
    mockAuth.mockResolvedValue(user("ADMIN"));
    await PROPOSALS_GET(proposalsReq(), proposalsParams);
    expect(mockDb.sessionProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5000 }),
    );
    vi.clearAllMocks();
    mockDb.event.findFirst.mockResolvedValue(EVENT);
    mockDb.sessionProposal.findMany.mockResolvedValue([PROPOSAL_ROW]);
    mockAuth.mockResolvedValue(user("ADMIN"));
    await PROPOSALS_GET(proposalsReq(""), proposalsParams);
    expect(mockDb.sessionProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });
});
