/**
 * sendEmail → logEmail attachment-name passthrough (Aug 3, 2026).
 *
 * The EmailLog row must record WHICH files rode on a send (the organizer's
 * "payment received doesn't show the invoice/receipt were sent" gap) — and it
 * must be captured at the sendEmail choke point so every caller (payment
 * docs, quote PDFs, agreements, certificates, bulk attachments) is covered
 * with zero per-caller wiring. Pins: names logged on SUCCESS and on FAILURE
 * (a failed send still shows what it TRIED to attach), [] when none.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { logEmailSpy, sesSendMock } = vi.hoisted(() => ({
  logEmailSpy: vi.fn(async () => undefined),
  sesSendMock: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email-log", () => ({
  logEmail: logEmailSpy,
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

import { sendEmail } from "@/lib/email";

const BASE = {
  to: [{ email: "jane@x.com", name: "Jane" }],
  subject: "Payment Confirmation",
  htmlContent: "<p>hi</p>",
};

async function lastLoggedRow() {
  // logEmail is fire-and-forget (void) — flush microtasks before asserting.
  await new Promise((r) => setTimeout(r, 0));
  expect(logEmailSpy).toHaveBeenCalled();
  const lastCall = logEmailSpy.mock.calls.at(-1) as unknown as unknown[];
  return lastCall[0] as { status: string; attachmentNames?: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendEmail — attachmentNames reach the EmailLog row", () => {
  it("SENT row carries the attachment filenames (invoice + receipt case)", async () => {
    sesSendMock.mockResolvedValue({ MessageId: "m1" });
    const res = await sendEmail({
      ...BASE,
      attachments: [
        { name: "INV-2026-001.pdf", content: "aGk=", contentType: "application/pdf" },
        { name: "REC-2026-001.pdf", content: "aGk=", contentType: "application/pdf" },
      ],
    });
    expect(res.success).toBe(true);
    const row = await lastLoggedRow();
    expect(row.status).toBe("SENT");
    expect(row.attachmentNames).toEqual(["INV-2026-001.pdf", "REC-2026-001.pdf"]);
  });

  it("FAILED row still records what it TRIED to attach", async () => {
    sesSendMock.mockRejectedValue(new Error("MessageRejected"));
    const res = await sendEmail({
      ...BASE,
      attachments: [{ name: "agreement-dr-jane.pdf", content: "aGk=", contentType: "application/pdf" }],
    });
    expect(res.success).toBe(false);
    const row = await lastLoggedRow();
    expect(row.status).toBe("FAILED");
    expect(row.attachmentNames).toEqual(["agreement-dr-jane.pdf"]);
  });

  it("no attachments ⇒ empty list, never undefined", async () => {
    sesSendMock.mockResolvedValue({ MessageId: "m2" });
    await sendEmail({ ...BASE });
    const row = await lastLoggedRow();
    expect(row.attachmentNames).toEqual([]);
  });
});

/**
 * The "forgot logContext" warning must keep meaning "someone forgot".
 *
 * Two senders legitimately have no entity: the admin alert and the daily health
 * digest go to operators about the platform itself, not to a person with a
 * detail sheet. Before `noEntityContext` both took this warning on every send,
 * which was worst on the admin-alert path: an alert about a problem wrote a
 * warning about itself, onto the very log surface the alert points you at.
 *
 * Asserted in both directions, because a flag that silences too much is the
 * failure mode here: the warning's whole value is catching a real omission.
 */
describe("noEntityContext: declaring an entity-less send", () => {
  const warnedAboutContext = async () => {
    const { apiLogger } = await import("@/lib/logger");
    return (apiLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => JSON.stringify(c[0] ?? "").includes("without logContext"),
    );
  };

  it("still warns when logContext was simply forgotten", async () => {
    sesSendMock.mockResolvedValue({ MessageId: "m1" });
    await sendEmail({ ...BASE });
    expect(await warnedAboutContext()).toBe(true);
  });

  it("stays silent when the omission is declared deliberate", async () => {
    sesSendMock.mockResolvedValue({ MessageId: "m2" });
    await sendEmail({ ...BASE, noEntityContext: true });
    expect(await warnedAboutContext()).toBe(false);
  });

  it("still writes the EmailLog row either way; silence is not skipping", async () => {
    sesSendMock.mockResolvedValue({ MessageId: "m3" });
    await sendEmail({ ...BASE, noEntityContext: true });
    const row = await lastLoggedRow();
    expect(row.status).toBe("SENT");
  });
});
