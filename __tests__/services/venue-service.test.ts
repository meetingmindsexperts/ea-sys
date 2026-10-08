/**
 * venue-service createReport (review L10): a report is stored first and stays
 * stored when the email fails; the email's HTML is escaped; the reporter is
 * the caller, never the body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSend, log } = vi.hoisted(() => ({
  mockDb: { venueReport: { create: vi.fn() } },
  mockSend: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => mockSend(...a) }));
vi.mock("@/lib/logger", () => ({ apiLogger: log }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));

import { createReport, VENUE_SAFETY_INBOX } from "@/services/venue-service";

const caller = { organizationId: "org-1", eventId: "evt-1", userId: "u-1" };
const info = { eventName: "EHC 2026", reporterName: "Wren" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.venueReport.create.mockResolvedValue({ id: "rep-1" });
  mockSend.mockResolvedValue({ success: true });
});

describe("createReport", () => {
  it("stores the report under the caller and emails the safety inbox, escaped", async () => {
    const res = await createReport(caller, { reason: "Offensive language", by: "spoof", note: "<img src=x onerror=alert(1)>", who: { name: "<b>Peer</b>" }, said: [{ t: 1, text: "<script>x</script>" }] }, info);
    expect(res).toEqual({ ok: true });
    expect(mockDb.venueReport.create.mock.calls[0][0].data).toMatchObject({ eventId: "evt-1", organizationId: "org-1", reporterId: "u-1", data: { by: "u-1" } });
    const mail = mockSend.mock.calls[0][0];
    expect(mail.to).toEqual([{ email: VENUE_SAFETY_INBOX }]);
    expect(mail.htmlContent).not.toMatch(/<(img|b|script)\b/);
    expect(mail.htmlContent).toContain("&lt;img src=x");
    expect(mail.textContent).toContain('"<script>x</script>"'); // the peer's line reaches the email (review M2)
  });

  it("keeps the report when the email fails, and logs the failure", async () => {
    mockSend.mockRejectedValue(new Error("SES down"));
    expect(await createReport(caller, { reason: "Something else" }, info)).toEqual({ ok: true });
    expect(mockDb.venueReport.create).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "venue-service:report-email-failed", reportId: "rep-1" }));
  });

  it("refuses a reason the page does not offer, storing and sending nothing", async () => {
    expect(await createReport(caller, { reason: "Spam" }, info)).toMatchObject({ ok: false, code: "INVALID_REPORT" });
    expect(mockDb.venueReport.create).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
