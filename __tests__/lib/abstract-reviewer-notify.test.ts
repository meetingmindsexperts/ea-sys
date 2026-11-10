/**
 * THE reviewer email (Nov 10, 2026: one template, not three). Sent only by
 * hand from the Reviewers page: the row's Send button and Send to all both
 * call sendReviewerInvitation.
 *
 * What differs per reviewer is {{portalAccess}}: an account with no password
 * yet gets a freshly minted set-password link, one that can already sign in
 * gets the portal button and NO link that could replace its password.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailSpy, speakerFindMany, userFindUnique, tokenDeleteMany, tokenCreate, logger } = vi.hoisted(() => ({
  sendEmailSpy: vi.fn(),
  speakerFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  tokenDeleteMany: vi.fn(),
  tokenCreate: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => {
  const verificationToken = { deleteMany: tokenDeleteMany, create: tokenCreate };
  return {
    db: {
      speaker: { findMany: speakerFindMany },
      user: { findUnique: userFindUnique },
      verificationToken,
      $transaction: (cb: (tx: unknown) => unknown) => cb({ verificationToken }),
    },
  };
});

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    sendEmail: sendEmailSpy,
    brandingCc: actual.brandingCc,
    getEventTemplate: vi.fn(),
    getDefaultTemplate: vi.fn(),
    renderAndWrap: vi.fn(actual.renderAndWrap),
    brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ hashVerificationToken: (t: string) => `hash:${t}` }));

import { inviterNameOf, reviewerSpeakerRecords, sendReviewerInvitation } from "@/lib/abstract-reviewer-notify";
import { getDefaultTemplate, getEventTemplate } from "@/lib/email";
import { DEFAULT_TEMPLATE_BODIES } from "@/lib/email-template-defaults";
import { EMAIL_TEMPLATE_SPECS } from "@/lib/email-template-registry";
import { REVIEWER_SETUP_LINK_DAYS } from "@/lib/reviewer-portal-access";
import { findUnresolvedTokens, UNRESOLVED_TOKENS_CODE } from "@/lib/template-tokens";

const DEFAULT = DEFAULT_TEMPLATE_BODIES["reviewer-invitation"];
const BRANDING = { eventName: "MedCon", emailCcAddresses: ["ops@example.com", "NEW@x.com"] };
/** An invited reviewer: no password yet. */
const NEW_REVIEWER = { id: "u1", firstName: "Dina", lastName: "Ortiz", email: "New@x.com", role: "REVIEWER", emailVerified: null };
/** A speaker with their own account, added as a reviewer: has a password, no emailVerified. */
const HAS_ACCOUNT = { id: "u2", firstName: "Sam", lastName: "Lee", email: "sam@x.com", role: "SUBMITTER", emailVerified: null };

const args = (reviewer: typeof NEW_REVIEWER) => ({
  eventId: "ev1",
  organizationId: "org1",
  eventName: "MedCon",
  eventSlug: "MEDCON",
  reviewer,
  organizationName: "Meeting Minds Experts",
  inviterName: "Sarah Ahmed",
  triggeredByUserId: "admin1",
});
const sent = () => sendEmailSpy.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailSpy.mockResolvedValue({ success: true });
  speakerFindMany.mockResolvedValue([]);
  userFindUnique.mockResolvedValue({ emailSignature: "<p>Sarah, Secretariat</p>" });
  vi.mocked(getEventTemplate).mockResolvedValue({ ...DEFAULT, branding: BRANDING });
});

describe("sendReviewerInvitation: a reviewer with no password yet", () => {
  it("mints a fresh set-password link, replacing any earlier one, and sends both buttons", async () => {
    expect(await sendReviewerInvitation(args(NEW_REVIEWER))).toEqual({ ok: true, kind: "setup" });

    // One address holds one invitation: the old token goes, a hashed one is stored.
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { identifier: "new@x.com" } });
    const stored = tokenCreate.mock.calls[0][0].data;
    expect(stored.identifier).toBe("new@x.com");
    expect(stored.token).toMatch(/^hash:[0-9a-f]{64}$/);
    // The link lasts exactly as long as the email says it does.
    const days = (stored.expires.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(REVIEWER_SETUP_LINK_DAYS - 0.1);
    expect(days).toBeLessThanOrEqual(REVIEWER_SETUP_LINK_DAYS);
    expect(sent().htmlContent).toContain(`within ${REVIEWER_SETUP_LINK_DAYS} days`);

    const raw = stored.token.slice("hash:".length);
    const link = `/accept-invitation?token=${raw}&amp;email=new%40x.com&amp;eventSlug=MEDCON`;
    expect(sent().htmlContent).toContain(link);
    expect(sent().htmlContent).toContain("SET YOUR PASSWORD");
    expect(sent().htmlContent).toContain("REVIEWER PORTAL");
    expect(sent().htmlContent).toContain("/login?callbackUrl=%2Fmy-reviews");
    // The text part gets plain lines, never the block's markup.
    expect(sent().textContent).toContain(`SET YOUR PASSWORD: `);
    expect(sent().textContent).toContain(`token=${raw}&email=new%40x.com`);
    expect(sent().textContent).not.toContain("<div");
    expect(sent().logContext).toMatchObject({ entityType: "USER", entityId: "u1", eventId: "ev1", templateSlug: "reviewer-invitation", triggeredByUserId: "admin1" });
    expect(sent().emailType).toBe("reviewer_invitation");
  });

  it("leaves nothing unresolved from the built-in wording, signed by whoever pressed Send", async () => {
    await sendReviewerInvitation(args(NEW_REVIEWER));
    expect(findUnresolvedTokens(sent().subject, sent().htmlContent, sent().textContent)).toEqual([]);
    expect(sent().subject).toBe("Invitation to review abstracts | MedCon");
    expect(sent().htmlContent).toContain("Sarah, Secretariat");
  });
});

describe("sendReviewerInvitation: a reviewer who can already sign in", () => {
  it("sends the portal button only, and mints NO link that could replace their password", async () => {
    expect(await sendReviewerInvitation(args(HAS_ACCOUNT))).toEqual({ ok: true, kind: "portal" });
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(tokenCreate).not.toHaveBeenCalled();
    expect(sent().htmlContent).toContain("REVIEWER PORTAL");
    expect(sent().htmlContent).toContain("signing in with sam@x.com");
    expect(sent().htmlContent).not.toContain("SET YOUR PASSWORD");
    expect(sent().htmlContent).not.toContain("accept-invitation");
    expect(sent().textContent).not.toContain("accept-invitation");
  });

  it("a copy saved before {{portalAccess}} still renders: its set-password button leads to the portal", async () => {
    vi.mocked(getEventTemplate).mockResolvedValue({
      subject: "Abstracts for Review | {{eventName}}",
      htmlContent: '<p>First, set your password, within {{expiresIn}}.</p><a href="{{setupLink}}">SET YOUR PASSWORD</a><a href="{{reviewLink}}">REVIEWER PORTAL</a>',
      textContent: "SET YOUR PASSWORD: {{setupLink}}",
      branding: BRANDING,
    });
    expect(await sendReviewerInvitation(args(HAS_ACCOUNT))).toEqual({ ok: true, kind: "portal" });
    expect(findUnresolvedTokens(sent().htmlContent, sent().textContent)).toEqual([]);
    expect(sent().htmlContent).not.toContain("accept-invitation");
    expect(sent().textContent).toContain("SET YOUR PASSWORD: http");
    expect(sent().textContent).toContain("/login?callbackUrl=%2Fmy-reviews");
  });
});

describe("sendReviewerInvitation: title, additional email and failures", () => {
  it("takes the title and the additional email from the reviewer's speaker record on the event", async () => {
    speakerFindMany.mockResolvedValue([{ userId: "u1", email: "new@x.com", title: "DR", additionalEmail: "assistant@x.com" }]);
    await sendReviewerInvitation(args(NEW_REVIEWER));
    expect(sent().htmlContent).toContain("Dear Dr. Ortiz,");
    // The event's Auto-CC (minus the reviewer's own address, whatever its case) plus the second inbox.
    expect(sent().cc.map((c: { email: string }) => c.email)).toEqual(["ops@example.com", "assistant@x.com"]);
    expect(sent().to).toEqual([{ email: "New@x.com", name: "Dina Ortiz" }]);
  });

  it("no speaker record: no title, and the email still goes", async () => {
    await sendReviewerInvitation(args(NEW_REVIEWER));
    expect(sent().htmlContent).toContain("Dear  Ortiz,");
  });

  it("falls back to the built-in wording when the event has no saved copy", async () => {
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getDefaultTemplate).mockReturnValue({ slug: "reviewer-invitation", name: "Reviewer Invitation", ...DEFAULT });
    expect(await sendReviewerInvitation(args(HAS_ACCOUNT))).toEqual({ ok: true, kind: "portal" });
    expect(getDefaultTemplate).toHaveBeenCalledWith("reviewer-invitation");
  });

  it("no template at all: refused BEFORE a link is minted, so the link they hold keeps working", async () => {
    vi.mocked(getEventTemplate).mockResolvedValue(null);
    vi.mocked(getDefaultTemplate).mockReturnValue(undefined);
    expect(await sendReviewerInvitation(args(NEW_REVIEWER))).toMatchObject({ ok: false, code: "NO_TEMPLATE" });
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitation:no-template" }));
  });

  it("a template fault reaches the organiser in its own words; a provider error does not", async () => {
    sendEmailSpy.mockResolvedValueOnce({ success: false, code: UNRESOLVED_TOKENS_CODE, error: "The template has an unknown token: {{deadline}}" });
    expect(await sendReviewerInvitation(args(HAS_ACCOUNT))).toEqual({ ok: false, code: "SEND_FAILED", message: "The template has an unknown token: {{deadline}}" });
    sendEmailSpy.mockResolvedValueOnce({ success: false, code: "PROVIDER", error: "SES: throttled (request id 123)" });
    expect(await sendReviewerInvitation(args(HAS_ACCOUNT))).toEqual({ ok: false, code: "SEND_FAILED", message: "The email could not be sent" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitation:send-failed", reviewerUserId: "u2" }));
  });

  it("never throws: a database error is a failed send, logged", async () => {
    tokenCreate.mockRejectedValueOnce(new Error("db down"));
    expect(await sendReviewerInvitation(args(NEW_REVIEWER))).toEqual({ ok: false, code: "SEND_FAILED", message: "The email could not be sent" });
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitation:send-error" }));
  });
});

describe("the built-in Reviewer Invitation", () => {
  const spec = EMAIL_TEMPLATE_SPECS.find((t) => t.slug === "reviewer-invitation")!;

  it("uses only tokens its sender fills, and gets in through {{portalAccess}}", () => {
    const allowed = new Set(spec.variables.map((v) => v.key));
    const used = findUnresolvedTokens(DEFAULT.subject, DEFAULT.htmlContent, DEFAULT.textContent);
    expect(used.filter((t) => !allowed.has(t))).toEqual([]);
    expect(DEFAULT.htmlContent).toContain("{{portalAccess}}");
    expect(DEFAULT.textContent).toContain("{{portalAccess}}");
    // One wording for both reviewers: nothing tells everyone to set a password.
    expect(DEFAULT.htmlContent).not.toMatch(/set your password/i);
    expect(spec.rawHtmlKeys).toEqual(["portalAccess"]);
    expect(spec.name).toBe("Reviewer Invitation");
  });
});

describe("reviewerSpeakerRecords", () => {
  it("prefers the linked record, and never takes one another account has claimed", async () => {
    speakerFindMany.mockResolvedValue([
      { userId: "someone-else", email: "new@x.com", title: "PROF", additionalEmail: "theirs@x.com" },
      { userId: null, email: "SAM@x.com", title: "MR", additionalEmail: null },
    ]);
    const records = await reviewerSpeakerRecords("ev1", [NEW_REVIEWER, HAS_ACCOUNT]);
    expect(records.get("u1")).toBeUndefined();
    expect(records.get("u2")).toEqual({ title: "MR", additionalEmail: null });
  });

  it("a failed lookup gives nothing and is logged", async () => {
    speakerFindMany.mockRejectedValue(new Error("db down"));
    expect((await reviewerSpeakerRecords("ev1", [NEW_REVIEWER])).size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-title:lookup-failed" }));
  });
});

describe("inviterNameOf", () => {
  it("is the full name, else the address, else a plain word", () => {
    expect(inviterNameOf({ firstName: "Sarah", lastName: "Ahmed", email: "s@x.com" })).toBe("Sarah Ahmed");
    expect(inviterNameOf({ firstName: "Sarah", email: "s@x.com" })).toBe("s@x.com");
    expect(inviterNameOf({})).toBe("A team member");
  });
});
