/**
 * {{eventDate}} in the registration confirmation is a DATE, in the EVENT's zone.
 *
 * Organizer report: a confirmation for the EHS conference read "which will be
 * held from Friday, October 2, 2026 at 04:00 AM". Two faults in one formatter,
 * and the second is the dangerous one:
 *
 *   1. It appended hour+minute to a token every template uses as a date. An
 *      event-level clock is meaningless on a multi-day conference — the real
 *      per-day times live on the agenda — which is why the same line was pulled
 *      from the public event pages in July.
 *
 *   2. It passed no `timeZone`, so it rendered in the SERVER's zone (UTC in
 *      production). That is how an 08:00 Dubai start (stored 04:00Z) printed as
 *      "04:00 AM" — and, worse, it silently moves the DATE for any event
 *      starting before 04:00 Dubai.
 *
 * These drive the REAL sender against a mocked transport. A test that
 * re-implemented the formatter would only prove the test's own copy works.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sesSendMock } = vi.hoisted(() => ({ sesSendMock: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email-log", () => ({ logEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/quote-pdf", () => ({
  generateQuotePDF: vi.fn(async () => Buffer.from("%PDF-quote")),
  buildQuotePDFFromRegistration: vi.fn(),
}));
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sesSendMock;
    get config() {
      return { credentials: async () => ({ accessKeyId: "AKIATEST" }) };
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { sendRegistrationConfirmation } from "@/lib/email";

/** The real EHS event: 08:00 Dubai on 2 Oct, stored as 04:00Z. */
const EHS = {
  to: "delegate@hospital.org",
  firstName: "Jane",
  lastName: "Doe",
  eventName: "EHS International Mental Health Conference 2026",
  eventSlug: "ehs-2026",
  eventDate: new Date("2026-10-02T04:00:00.000Z"),
  eventTimezone: "Asia/Dubai",
  eventVenue: "Intercontinental Festival City",
  eventCity: "Dubai",
  ticketType: "Physician",
  registrationId: "reg_1",
  serialId: 7,
  qrCode: "1234567890",
  // No organizationName, so no quote attaches and the body arrives as plain
  // HTML rather than raw MIME (see the sibling suppress-pay-now suite).
};

function renderedHtml(): string {
  expect(sesSendMock).toHaveBeenCalled();
  const input = sesSendMock.mock.calls[0][0].input as {
    Content?: { Simple?: { Body?: { Html?: { Data?: string } } } };
  };
  const html = input.Content?.Simple?.Body?.Html?.Data;
  expect(html, "expected a Simple (unattached) email").toBeTruthy();
  return html as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  sesSendMock.mockResolvedValue({ MessageId: "m1" });
});

describe("{{eventDate}} carries no time", () => {
  it("renders the date alone", async () => {
    await sendRegistrationConfirmation(EHS);
    expect(renderedHtml()).toContain("Friday, October 2, 2026");
  });

  it("does NOT print the 04:00 AM the organizer reported", async () => {
    await sendRegistrationConfirmation(EHS);
    const html = renderedHtml();
    expect(html).not.toContain("04:00");
    // ...and the clock-shape check, WITHOUT which this assertion is a trap.
    // "04:00" is the string a UTC machine produces; a developer laptop set to
    // Asia/Dubai renders the same instant as "08:00 AM" and the literal check
    // above passes against the very bug it exists to catch. Verified by
    // mutation: restoring the old formatter fails this only because of the
    // line below.
    expect(html).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  it("prints no clock at all, whatever the start time", async () => {
    // Machine-independent guard for the general case: any "HH:MM AM/PM" next
    // to the date is the defect coming back, in any runtime timezone.
    await sendRegistrationConfirmation({
      ...EHS,
      eventDate: new Date("2026-10-02T13:30:00.000Z"),
    });
    expect(renderedHtml()).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });
});

describe("{{eventDate}} is the event's calendar day, not the server's", () => {
  it("names the correct day for an early-morning start", async () => {
    // 02:00 on 3 Oct in Dubai is 22:00Z on 2 Oct. Rendered in UTC — which is
    // what production runs as — this said "October 2" and told every delegate
    // the wrong day.
    //
    // Note this case only DISCRIMINATES on a runner whose own zone is not
    // Dubai (CI is UTC; a local laptop set to Dubai passes it either way). The
    // machine-independent guard for this property is the Europe/London case
    // below, which differs from both UTC and Dubai.
    await sendRegistrationConfirmation({
      ...EHS,
      eventDate: new Date("2026-10-02T22:00:00.000Z"),
      eventTimezone: "Asia/Dubai",
    });
    expect(renderedHtml()).toContain("October 3, 2026");
  });

  it("honours a non-Dubai event timezone", async () => {
    // 20:00Z on 1 Oct is still 1 Oct in London but already 2 Oct in Dubai —
    // so this pins that the EVENT's zone is used, not a hardcoded default.
    await sendRegistrationConfirmation({
      ...EHS,
      eventDate: new Date("2026-10-01T20:00:00.000Z"),
      eventTimezone: "Europe/London",
    });
    expect(renderedHtml()).toContain("October 1, 2026");
  });

  it("falls back to Asia/Dubai when the event has no timezone set", async () => {
    await sendRegistrationConfirmation({
      ...EHS,
      eventDate: new Date("2026-10-02T22:00:00.000Z"),
      eventTimezone: null,
    });
    expect(renderedHtml()).toContain("October 3, 2026");
  });
});
