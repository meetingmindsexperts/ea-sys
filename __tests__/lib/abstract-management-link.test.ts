/**
 * The "View Your Abstract" destination, and the drift guard for it.
 *
 * The two senders in abstract-notifications.ts had drifted: the status-update
 * email used the branded event login while the submission confirmation
 * hardcoded the INTERNAL staff sign-in, so a submitter clicking a button
 * labelled "View Your Abstract" landed on an unbranded staff screen and, if
 * they signed in, on the events list rather than their abstract. Same defect
 * fixed for session proposals on Aug 6, 2026; abstracts were missed.
 *
 * The last test is the one that matters: it asserts BOTH senders emit the
 * same link for the same slug. A future edit to one alone fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, renderSpy } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn().mockResolvedValue(undefined),
  renderSpy: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    slug: "tpl",
    subject: "s",
    htmlContent: "h",
    textContent: "t",
  }),
  renderAndWrap: renderSpy,
  getAbstractStatusInfo: vi.fn().mockReturnValue({ label: "Accepted", message: "m", color: "#000" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  brandingCc: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db", () => ({
  db: {
    abstract: {
      findUnique: vi.fn().mockResolvedValue({
        presentationType: "ORAL",
        coAuthors: null,
        theme: { name: "Cardiology" },
      }),
    },
  },
}));

import {
  buildAbstractManagementLink,
  sendAbstractSubmissionConfirmation,
  notifyAbstractStatusChange,
} from "@/lib/abstract-notifications";

const APP = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";

const speaker = { id: "sp1", email: "author@x.com", firstName: "Jane", lastName: "Doe" };

/** The managementLink handed to the template renderer by the last send. */
function renderedLink(): string {
  const vars = renderSpy.mock.calls.at(-1)?.[1] as Record<string, string>;
  return vars.managementLink;
}

beforeEach(() => vi.clearAllMocks());

describe("buildAbstractManagementLink", () => {
  it("points at the branded event login, on the named abstracts branch", () => {
    // ?redirect=abstracts is a NAMED branch of /e/[slug]/login: it routes a
    // SUBMITTER to My Details and fails safe for anyone else. A bare path
    // would lose that routing.
    expect(buildAbstractManagementLink("medcon-2026")).toBe(
      `${APP}/e/medcon-2026/login?redirect=abstracts`,
    );
  });

  it("falls back to the internal login rather than minting /e//login", () => {
    // A broken /e//login is worse than the staff login it falls back to.
    for (const slug of [null, undefined, ""]) {
      const link = buildAbstractManagementLink(slug);
      expect(link).toBe(`${APP}/login?callbackUrl=${encodeURIComponent("/events")}`);
      expect(link).not.toContain("/e//");
    }
  });
});

describe("the submission confirmation email", () => {
  it("sends the submitter to the branded event login, not the staff one", async () => {
    // The regression: this used to be /login?callbackUrl=/events while the
    // email around it read "your personal access link to manage your
    // submission".
    await sendAbstractSubmissionConfirmation({
      eventId: "ev1",
      eventName: "MedCon",
      eventSlug: "medcon-2026",
      abstractId: "ab1",
      abstractTitle: "Novel Therapy",
      serialId: 7,
      speaker,
    });

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(renderedLink()).toBe(`${APP}/e/medcon-2026/login?redirect=abstracts`);
  });

  it("still sends when the slug is missing, using the fallback", async () => {
    // A missing slug must degrade the link, never skip the email.
    await sendAbstractSubmissionConfirmation({
      eventId: "ev1",
      eventName: "MedCon",
      eventSlug: null,
      abstractId: "ab1",
      abstractTitle: "Novel Therapy",
      serialId: 7,
      speaker,
    });

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(renderedLink()).toBe(`${APP}/login?callbackUrl=${encodeURIComponent("/events")}`);
  });
});

describe("both abstract emails agree", () => {
  it("emits an identical management link for the same event", async () => {
    await sendAbstractSubmissionConfirmation({
      eventId: "ev1",
      eventName: "MedCon",
      eventSlug: "medcon-2026",
      abstractId: "ab1",
      abstractTitle: "Novel Therapy",
      serialId: 7,
      speaker,
    });
    const fromConfirmation = renderedLink();

    await notifyAbstractStatusChange({
      eventId: "ev1",
      eventName: "MedCon",
      eventSlug: "medcon-2026",
      abstractId: "ab1",
      abstractTitle: "Novel Therapy",
      previousStatus: "SUBMITTED",
      newStatus: "ACCEPTED",
      reviewNotes: null,
      reviewScore: null,
      speaker,
    });
    const fromStatusChange = renderedLink();

    expect(fromConfirmation).toBe(fromStatusChange);
    expect(fromConfirmation).toBe(`${APP}/e/medcon-2026/login?redirect=abstracts`);
  });
});
