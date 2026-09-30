/**
 * Event data export bundle (Sep 30, 2026): the existing exports are called as
 * the same user and zipped; a refused or failing area is listed, never fatal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";

const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock }));
const mockDb = vi.hoisted(() => ({ event: { findFirstOrThrow: vi.fn() }, rsvpCampaign: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const csv = (body: string) => new Response(body, { headers: { "content-type": "text/csv; charset=utf-8" } });
const json = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

const h = vi.hoisted(() => ({
  reg: vi.fn(), abs: vi.fn(), prop: vi.fn(), inv: vi.fn(), survey: vi.fn(), web: vi.fn(), reimb: vi.fn(), tg: vi.fn(), rsvp: vi.fn(),
}));
vi.mock("@/app/api/events/[eventId]/registrations/route", () => ({ GET: h.reg }));
vi.mock("@/app/api/events/[eventId]/abstracts/route", () => ({ GET: h.abs }));
vi.mock("@/app/api/events/[eventId]/session-proposals/route", () => ({ GET: h.prop }));
vi.mock("@/app/api/events/[eventId]/invoices/export/route", () => ({ GET: h.inv }));
vi.mock("@/app/api/events/[eventId]/survey/responses/export/route", () => ({ GET: h.survey }));
vi.mock("@/app/api/events/[eventId]/webinar/attendance/route", () => ({ GET: h.web }));
vi.mock("@/app/api/events/[eventId]/reimbursements/route", () => ({ GET: h.reimb }));
vi.mock("@/app/api/events/[eventId]/travel-grants/route", () => ({ GET: h.tg }));
vi.mock("@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route", () => ({ GET: h.rsvp }));

const sheets = vi.hoisted(() => ({
  eventSheet: vi.fn(),
  speakersSheet: vi.fn(),
  sessionSheets: vi.fn(),
  accommodationSheets: vi.fn(),
  registrationTypesSheet: vi.fn(),
  promoCodesSheet: vi.fn(),
  sponsorsSheet: vi.fn(),
}));
vi.mock("@/lib/event-export/sheets", () => sheets);

import { buildEventBundle, countCsvRecords } from "@/lib/event-export/bundle";

const origin = new Request("https://events.example.com/api/events/ev1/export-bundle", { headers: { "user-agent": "vitest", "x-forwarded-for": "1.2.3.4" } });
const s = (file: string, rows = 1) => ({ file, csv: "H\n" + "r\n".repeat(rows).trimEnd(), rows });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirstOrThrow.mockResolvedValue({ name: "Cardio 2027", slug: "cardio-2027", eventType: "CONFERENCE" });
  mockDb.rsvpCampaign.findMany.mockResolvedValue([{ id: "c1", name: "Gala Dinner" }]);
  for (const f of Object.values(h)) f.mockResolvedValue(csv("A,B\n1,2\n3,4"));
  sheets.eventSheet.mockResolvedValue(s("event.csv"));
  sheets.speakersSheet.mockResolvedValue(s("speakers.csv", 3));
  sheets.sessionSheets.mockResolvedValue([s("sessions.csv", 2), s("session-topics.csv", 0)]);
  sheets.accommodationSheets.mockResolvedValue([s("accommodation-bookings.csv"), s("hotels-and-rooms.csv")]);
  sheets.registrationTypesSheet.mockResolvedValue(s("registration-types.csv"));
  sheets.promoCodesSheet.mockResolvedValue(s("promo-codes.csv"));
  sheets.sponsorsSheet.mockResolvedValue(s("sponsors.csv"));
});

async function files(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  return { zip, names: Object.keys(zip.files).sort() };
}

describe("countCsvRecords", () => {
  it("counts records, not lines: a quoted cell may hold newlines", () => {
    expect(countCsvRecords('A,B\n1,"two\nlines"\n3,4')).toBe(2);
    expect(countCsvRecords("A,B\r\n1,2\r\n")).toBe(1);
    expect(countCsvRecords("A,B")).toBe(0);
    expect(countCsvRecords("")).toBe(0);
  });
});

describe("buildEventBundle", () => {
  it("zips every area plus a README, calling each existing export with its own query and params", async () => {
    const r = await buildEventBundle({ req: origin, eventId: "ev1", role: "ADMIN", userName: "Lina Saad" });
    const { names, zip } = await files(r.zip);
    expect(names).toEqual(
      expect.arrayContaining([
        "README.txt", "event.csv", "speakers.csv", "sessions.csv", "session-topics.csv", "registrations.csv", "abstracts.csv",
        "session-proposals.csv", "invoices.csv", "survey-responses.csv", "reimbursements.csv", "travel-grants.csv", "rsvp/01-gala-dinner.csv",
      ]),
    );
    // A conference has no webinar attendance file.
    expect(names).not.toContain("webinar-attendance.csv");
    expect(h.web).not.toHaveBeenCalled();
    expect(new URL(h.reg.mock.calls[0][0].url).search).toBe("?export=csv");
    expect(new URL(h.inv.mock.calls[0][0].url).search).toBe("?format=csv");
    // The caller's headers ride along, so the inner audit row keeps IP and agent.
    expect(h.reg.mock.calls[0][0].headers.get("user-agent")).toBe("vitest");
    expect(await h.rsvp.mock.calls[0][1].params).toEqual({ eventId: "ev1", campaignId: "c1" });
    expect(await zip.file("registrations.csv")!.async("string")).toBe("A,B\n1,2\n3,4");
    expect(r.filename).toMatch(/^cardio-2027-data-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(r.parts.find((p) => p.file === "registrations.csv")?.rows).toBe(2);
  });

  it("an area the role may not export is left out, with the reason in the README", async () => {
    h.inv.mockResolvedValue(json(403, "Forbidden"));
    h.survey.mockResolvedValue(json(404, "No survey is set up for this event."));
    const r = await buildEventBundle({ req: origin, eventId: "ev1", role: "ORGANIZER", userName: "x" });
    const { names, zip } = await files(r.zip);
    expect(names).not.toContain("invoices.csv");
    expect(names).not.toContain("survey-responses.csv");
    const readme = await zip.file("README.txt")!.async("string");
    expect(readme).toContain("Invoices: Not included: your role may not export this.");
    // The route's own full stop is not doubled.
    expect(readme).toContain("Survey responses: Not included: No survey is set up for this event.\n");
    expect(readme).not.toContain("..");
    expect(readme).toMatch(/registrations\.csv\s+2 rows/);
  });

  it("one failing area does not take down the rest", async () => {
    h.abs.mockRejectedValue(new Error("boom"));
    sheets.speakersSheet.mockRejectedValue(new Error("db down"));
    const r = await buildEventBundle({ req: origin, eventId: "ev1", role: "ADMIN", userName: "x" });
    const { names } = await files(r.zip);
    expect(names).toContain("registrations.csv");
    expect(names).not.toContain("abstracts.csv");
    expect(names).not.toContain("speakers.csv");
    expect(r.parts.filter((p) => p.skipped).map((p) => p.label).sort()).toEqual(["Abstracts", "Speakers"]);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "event-export:part-failed", file: "abstracts.csv" }));
  });

  it("a 200 that is not a spreadsheet is not written into the ZIP", async () => {
    h.tg.mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    const { names } = await files((await buildEventBundle({ req: origin, eventId: "ev1", role: "ADMIN", userName: "x" })).zip);
    expect(names).not.toContain("travel-grants.csv");
  });

  it("webinar and hybrid events include webinar attendance", async () => {
    mockDb.event.findFirstOrThrow.mockResolvedValue({ name: "W", slug: "w", eventType: "HYBRID" });
    const { names } = await files((await buildEventBundle({ req: origin, eventId: "ev1", role: "ADMIN", userName: "x" })).zip);
    expect(names).toContain("webinar-attendance.csv");
  });

  it("passes the caller's role to the sheets that hide money columns", async () => {
    await buildEventBundle({ req: origin, eventId: "ev1", role: "ORGANIZER", userName: "x" });
    for (const f of [sheets.speakersSheet, sheets.accommodationSheets, sheets.registrationTypesSheet, sheets.promoCodesSheet, sheets.eventSheet]) {
      expect(f).toHaveBeenCalledWith("ev1", "ORGANIZER");
    }
  });
});
