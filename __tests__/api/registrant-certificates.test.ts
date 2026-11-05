/**
 * A person's own certificates on /my-registration (Nov 4, 2026).
 *
 * The load-bearing rule is `isReleased`: the list and the download both go
 * through `findReleasedCertificates`, so a certificate that is not theirs, revoked, or still
 * sitting in a run the organiser has not sent is invisible AND undownloadable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLoad, mockRateLimit, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { issuedCertificate: { findMany: vi.fn() }, certificateIssueRunItem: { findMany: vi.fn() }, user: { findUnique: vi.fn() } },
  mockLoad: vi.fn(),
  mockRateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/certificates/pdf-loader", () => ({ loadCertificatePdfBytes: mockLoad }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));

import { GET } from "@/app/api/registrant/certificates/[certificateId]/download/route";
import { Prisma } from "@prisma/client";
import { certificateMeta, certificateTitle, cmeHoursOf, cmeTotals, findReleasedCertificates, isReleased, type EmailedRunItem } from "@/lib/registrant-certificates";

function get(certificateId = "cert1") {
  return GET(new Request("http://x"), { params: Promise.resolve({ certificateId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "Anna@Example.com", role: "REGISTRANT" } });
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSeconds: 0 });
  mockLoad.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
  mockDb.certificateIssueRunItem.findMany.mockResolvedValue([]);
  // A confirmed account, read from the database: the address comes from there, not the session.
  mockDb.user.findUnique.mockResolvedValue({ email: "Anna@Example.com", emailConfirmedAt: new Date() });
});

/** A released certificate row as findMany returns it (made directly, so released). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "cert1", serial: "MMF-ATT-007", pdfUrl: "/uploads/certificates/ev1/cert1.pdf", event: { id: "ev1" },
    eventId: "ev1", registrationId: "reg1", speakerId: null, certificateTemplateId: "tplA",
    issueRunItemId: null, lastResentAt: null, issueRunItem: null, ...over,
  };
}

type Facts = Parameters<typeof isReleased>[0];
const cert = (over: Partial<Facts> = {}): Facts => ({
  eventId: "ev1",
  registrationId: "reg1",
  speakerId: null,
  certificateTemplateId: "tplA",
  issueRunItemId: null,
  lastResentAt: null,
  issueRunItem: null,
  ...over,
});
const emailed = (over: Partial<EmailedRunItem> = {}): EmailedRunItem => ({
  registrationId: "reg1",
  speakerId: null,
  templateIds: ["tplA"],
  run: { eventId: "ev1", certificateTemplateId: null },
  ...over,
});
const unsentItem = (reissue = false) => ({ emailedAt: null, run: { reissue } });

describe("isReleased", () => {
  it("a run's certificate stays hidden while the run waits for review", () => {
    expect(isReleased(cert({ issueRunItemId: "itemA", issueRunItem: unsentItem() }), [])).toBe(false);
  });

  it("a certificate made directly from the detail sheet is released, issue-only included", () => {
    expect(isReleased(cert(), [])).toBe(true);
  });

  it("its own item emailed, or a resend since: released", () => {
    expect(isReleased(cert({ issueRunItemId: "itemA", issueRunItem: { emailedAt: new Date(), run: { reissue: false } } }), [])).toBe(true);
    expect(isReleased(cert({ issueRunItemId: "itemA", issueRunItem: unsentItem(), lastResentAt: new Date() }), [])).toBe(true);
  });

  it("REVIEW A: rendered by a cancelled run, then emailed by a later run that reused it", () => {
    // The reuse leaves both pointers on the cancelled run's unsent item.
    const c = cert({ issueRunItemId: "itemA", issueRunItem: unsentItem() });
    expect(isReleased(c, [emailed()])).toBe(true);
  });

  it("REVIEW B: a direct certificate stays released while a bulk reissue run is pending or cancelled", () => {
    expect(isReleased(cert({ issueRunItem: unsentItem(true) }), [])).toBe(true);
  });

  it("an original run's primary pointer on a legacy certificate still has to be emailed", () => {
    expect(isReleased(cert({ certificateTemplateId: null, issueRunItem: unsentItem(false) }), [])).toBe(false);
  });

  it("someone else's, another event's or another template's email does not release it", () => {
    const c = cert({ issueRunItemId: "itemA", issueRunItem: unsentItem() });
    expect(isReleased(c, [emailed({ registrationId: "reg2" })])).toBe(false);
    expect(isReleased(c, [emailed({ run: { eventId: "ev2", certificateTemplateId: null } })])).toBe(false);
    expect(isReleased(c, [emailed({ templateIds: ["tplB"] })])).toBe(false);
  });

  it("a speaker's certificate is matched on the speaker, and a single-template run on its template", () => {
    const c = cert({ registrationId: null, speakerId: "sp1", issueRunItemId: "itemA", issueRunItem: unsentItem() });
    expect(isReleased(c, [emailed({ registrationId: null, speakerId: "sp1", templateIds: [], run: { eventId: "ev1", certificateTemplateId: "tplA" } })])).toBe(true);
  });
});

describe("cmeHoursOf", () => {
  const base = { cmeHoursSnapshot: null, certificateTemplate: null, event: { cmeHours: null } } as unknown as Parameters<typeof cmeHoursOf>[0];
  it("the snapshot, else the template's hours, else the event's, as the worker snapshots", () => {
    expect(cmeHoursOf({ ...base, cmeHoursSnapshot: new Prisma.Decimal(6.5) } as typeof base)).toBe("6.5");
    expect(cmeHoursOf({ ...base, certificateTemplate: { cmeHours: new Prisma.Decimal(3) } } as typeof base)).toBe("3");
    expect(cmeHoursOf({ ...base, event: { cmeHours: new Prisma.Decimal(12) } } as typeof base)).toBe("12");
    expect(cmeHoursOf(base)).toBeNull();
  });
});

describe("who owns a certificate", () => {
  it("by account always; by email only once the account has confirmed that address", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([]);
    await findReleasedCertificates({ userId: "u1", email: "anna@example.com", confirmed: true });
    expect(mockDb.issuedCertificate.findMany.mock.calls[0][0].where).toMatchObject({
      revokedAt: null,
      pdfUrl: { not: null },
      OR: [
        { registration: { OR: [{ userId: "u1" }, { attendee: { email: { equals: "anna@example.com", mode: "insensitive" } } }] } },
        { speaker: { OR: [{ userId: "u1" }, { email: { equals: "anna@example.com", mode: "insensitive" } }] } },
      ],
    });
    // Unconfirmed: someone else's earlier registration on this address stays hidden.
    await findReleasedCertificates({ userId: "u1", email: "anna@example.com", confirmed: false });
    expect(mockDb.issuedCertificate.findMany.mock.calls[1][0].where.OR).toEqual([
      { registration: { userId: "u1" } },
      { speaker: { OR: [{ userId: "u1" }] } },
    ]);
    expect(mockDb.certificateIssueRunItem.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/registrant/certificates/[certificateId]/download", () => {
  it("refuses a signed-out request", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(mockDb.issuedCertificate.findMany).not.toHaveBeenCalled();
  });

  it("looks the one certificate up among the person's own, with the account's email lowercased", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([]);
    await get("cert9");
    const where = mockDb.issuedCertificate.findMany.mock.calls[0][0].where;
    expect(where.id).toBe("cert9");
    expect(JSON.stringify(where)).toContain("anna@example.com");
  });

  it("an unsent run certificate of their own is a 404, like someone else's", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([row({ issueRunItemId: "itemA", issueRunItem: { emailedAt: null, run: { reissue: false } } })]);
    expect((await get()).status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("someone else's or a revoked certificate is a logged 404 and no file is read", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([]);
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining(":not-found"), certificateId: "cert1" }));
  });

  it("streams the person's own PDF as a private attachment named by serial", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([row()]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Certificate-MMF-ATT-007.pdf"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockLoad).toHaveBeenCalledWith("/uploads/certificates/ev1/cert1.pdf", expect.objectContaining({ certificateId: "cert1", userId: "u1" }));
  });

  it("keeps the filename to safe characters", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([row({ serial: 'A"B\r\nC/..' })]);
    const res = await get();
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Certificate-ABC...pdf"');
  });

  it("is rate limited per person", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 90 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 90, limit: 60, windowSeconds: 3600 });
    expect(mockDb.issuedCertificate.findMany).not.toHaveBeenCalled();
  });

  it("a storage failure is a logged 500", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([row()]);
    mockLoad.mockRejectedValue(new Error("gone"));
    expect((await get()).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining(":failed") }));
  });
});

describe("GET /api/registrant/certificates", () => {
  async function list(query = "") {
    const { GET: listGet } = await import("@/app/api/registrant/certificates/route");
    return listGet(new Request(`http://x/api/registrant/certificates${query}`));
  }
  const full = (id: string, slug: string) =>
    row({
      id,
      type: "ATTENDANCE",
      serial: `S-${id}`,
      issuedAt: new Date("2026-11-04T08:00:00Z"),
      cmeHoursSnapshot: new Prisma.Decimal(6.5),
      certificateTemplate: { name: "Standard", role: null, cmeHours: null },
      event: { id: `ev-${slug}`, slug, cmeHours: null },
    });

  it("refuses a signed-out request", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await list()).status).toBe(401);
  });

  it("lists released certificates with a title and a meta line, narrowed to one event on request", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([full("a", "MEHF2027"), full("b", "hemnet2026")]);
    const all = (await (await list()).json()) as { certificates: { id: string }[] };
    expect(all.certificates.map((c) => c.id)).toEqual(["a", "b"]);

    const one = (await (await list("?event=MEHF2027")).json()) as { certificates: unknown[] };
    expect(one.certificates).toEqual([
      { id: "a", eventSlug: "MEHF2027", title: "Standard", meta: expect.stringMatching(/^Attendance · 6\.5 CME hours · No\. S-a · Issued /) },
    ]);
  });

  it("leaves out what is not released", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([
      { ...full("a", "MEHF2027"), issueRunItemId: "itemA", issueRunItem: { emailedAt: null, run: { reissue: false } } },
    ]);
    expect(((await (await list()).json()) as { certificates: unknown[] }).certificates).toEqual([]);
  });
});

describe("certificateTitle", () => {
  const t = (role: string | null, name: string | null, type = "ATTENDANCE") =>
    certificateTitle({ type, certificateTemplate: name === null && role === null ? null : { role, name, cmeHours: null } } as Parameters<typeof certificateTitle>[0]);

  it("the role, else the template's name, so two of one kind can be told apart", () => {
    expect(t("Speaker", "CME (Speaker)")).toBe("Speaker");
    expect(t(null, "CME (Speaker)")).toBe("CME (Speaker)");
    expect(t(null, "CME (Moderator)")).toBe("CME (Moderator)");
  });

  it("the kind when there is no template to name it", () => {
    expect(t(null, null)).toBe("Certificate of attendance");
    expect(t(null, null, "APPRECIATION")).toBe("Certificate of appreciation");
    expect(t("  ", "")).toBe("Certificate of attendance");
  });
});

describe("certificateMeta", () => {
  const meta = (template: { role: string | null; name: string } | null) =>
    certificateMeta({
      type: "ATTENDANCE",
      serial: "S1",
      issuedAt: new Date("2026-07-10T08:00:00Z"),
      cmeHoursSnapshot: null,
      certificateTemplate: template && { ...template, cmeHours: null },
      event: { cmeHours: null },
    } as unknown as Parameters<typeof certificateMeta>[0]);

  it("names the kind when the title is a template's name, not when the title already is the kind", () => {
    expect(meta({ role: null, name: "CME (Speaker)" })).toMatch(/^Attendance · No\. S1 · Issued /);
    expect(meta(null)).toMatch(/^No\. S1 · Issued /);
  });
});

describe("cmeTotals", () => {
  let n = 0;
  const cert = (hours: number | null, start: string, over: { type?: string; eventId?: string; tz?: string } = {}) =>
    ({
      type: over.type ?? "ATTENDANCE",
      cmeHoursSnapshot: hours === null ? null : new Prisma.Decimal(hours),
      certificateTemplate: null,
      event: { id: over.eventId ?? `ev${n++}`, startDate: new Date(start), timezone: over.tz ?? "Asia/Dubai", cmeHours: null },
    }) as unknown as Parameters<typeof cmeTotals>[0][number];
  const NOW = new Date("2026-11-04T08:00:00Z");

  it("sums attendance hours this year and in total, in exact tenths", () => {
    expect(cmeTotals([cert(0.5, "2026-03-01T06:00:00Z"), cert(0.5, "2026-04-01T06:00:00Z"), cert(0.5, "2026-05-01T06:00:00Z"), cert(8, "2025-06-01T06:00:00Z"), cert(null, "2026-06-01T06:00:00Z")], NOW, "Asia/Dubai"))
      .toEqual({ thisYear: 1.5, allTime: 9.5, year: "2026" });
    expect(cmeTotals([], NOW, "Asia/Dubai")).toEqual({ thisYear: 0, allTime: 0, year: "2026" });
  });

  it("counts an event once, at its largest, and never an appreciation certificate", () => {
    const certs = [
      cert(6, "2026-07-10T06:00:00Z", { eventId: "osh" }),
      cert(6, "2026-07-10T06:00:00Z", { eventId: "osh" }),
      cert(4, "2026-07-10T06:00:00Z", { eventId: "osh", type: "APPRECIATION" }),
    ];
    expect(cmeTotals(certs, NOW, "Asia/Dubai")).toMatchObject({ thisYear: 6, allTime: 6 });
  });

  it("takes the event's year in its own time zone", () => {
    // 00:00 on 1 January 2026 in Dubai is 20:00 on 31 December 2025 UTC.
    expect(cmeTotals([cert(3, "2025-12-31T20:00:00Z")], NOW, "Asia/Dubai")).toMatchObject({ thisYear: 3, allTime: 3 });
  });
});
