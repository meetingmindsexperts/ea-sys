/**
 * THE SAVED-TEMPLATE TRAP.
 *
 * Events carry their OWN materialised copy of `abstract-submission-confirmation`
 * (the templates list GET auto-seeds system defaults as editable rows). On the
 * day this shipped, 24 events on production already held one. So adding
 * {{travelGrantBlock}} to the SHIPPED DEFAULT template reaches none of them:
 * every one of those events would have kept sending the old body, silently, and
 * every eligible author on them would never have seen the offer.
 *
 * This has already happened twice in this repo, to the presenter quote block
 * (Aug 11) and to the RSVP {{itemWord}} token. The fix both times was to append
 * the token when the RESOLVED template lacks it. This suite is that fix's guard.
 *
 * MUTATION TO VERIFY AGAINST: delete the `tplForSend` append in
 * abstract-notifications.ts. The first test then fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { renderAndWrap, getEventTemplate, sendEmail, abstractFindUnique, tgFindUnique, tgCreate } =
  vi.hoisted(() => ({
    renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
    getEventTemplate: vi.fn(),
    sendEmail: vi.fn().mockResolvedValue({ success: true }),
    abstractFindUnique: vi.fn(),
    tgFindUnique: vi.fn(),
    tgCreate: vi.fn(),
  }));

vi.mock("@/lib/email", () => ({
  sendEmail,
  getEventTemplate,
  getDefaultTemplate: vi.fn().mockReturnValue(null),
  renderAndWrap,
  getAbstractStatusInfo: vi.fn(),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/db", () => ({
  db: {
    abstract: { findUnique: abstractFindUnique },
    travelGrant: { findUnique: tgFindUnique, create: tgCreate, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import { sendAbstractSubmissionConfirmation } from "@/lib/abstract-notifications";

/** A template an organizer saved BEFORE travel grant existed: no token anywhere. */
const SAVED_TEMPLATE_WITHOUT_TOKEN = {
  slug: "abstract-submission-confirmation",
  subject: "Abstract received",
  htmlContent: "<p>Thanks {{lastName}}</p>",
  textContent: "Thanks {{lastName}}",
  branding: { eventName: "MedCon" },
};

const params = {
  eventId: "ev1",
  organizationId: "org1",
  eventName: "MedCon",
  eventSlug: "medcon",
  abstractId: "ab1",
  abstractTitle: "A Study",
  serialId: 7,
  speaker: { id: "sp1", firstName: "Ana", lastName: "Silva", email: "ana@x.com", additionalEmail: null, title: null },
};

function abstractRow(country: string | null, settings: unknown = { travelGrant: { enabled: true, homeCountries: ["AE"] } }) {
  return {
    presentationType: "ORAL",
    coAuthors: null,
    theme: null,
    speaker: { country },
    event: { settings, travelGrantMessageHtml: "<p>We help with travel.</p>" },
  };
}

const renderedTemplate = () => renderAndWrap.mock.calls[0][0] as { htmlContent: string; textContent: string };

beforeEach(() => {
  vi.clearAllMocks();
  renderAndWrap.mockReturnValue({ subject: "s", html: "h", text: "t" });
  sendEmail.mockResolvedValue({ success: true });
  getEventTemplate.mockResolvedValue(SAVED_TEMPLATE_WITHOUT_TOKEN);
  tgFindUnique.mockResolvedValue(null);
  tgCreate.mockResolvedValue({ token: "tok123", status: "PENDING" });
});

describe("the saved-template trap", () => {
  it("APPENDS the token to a saved template that does not have it", async () => {
    abstractFindUnique.mockReturnValue({ catch: () => Promise.resolve(abstractRow("Oman")) });

    const ok = await sendAbstractSubmissionConfirmation(params);
    expect(ok).toBe(true);

    const tpl = renderedTemplate();
    expect(tpl.htmlContent).toContain("{{travelGrantBlock}}");
    expect(tpl.textContent).toContain("{{travelGrantBlockText}}");
    // The organizer's own body is preserved, not replaced.
    expect(tpl.htmlContent).toContain("Thanks {{lastName}}");
  });

  it("leaves a template that ALREADY has the token untouched, so it cannot render twice", async () => {
    getEventTemplate.mockResolvedValue({
      ...SAVED_TEMPLATE_WITHOUT_TOKEN,
      htmlContent: "<p>Hi</p>{{travelGrantBlock}}<p>Bye</p>",
      textContent: "Hi\n{{travelGrantBlockText}}\nBye",
    });
    abstractFindUnique.mockReturnValue({ catch: () => Promise.resolve(abstractRow("Oman")) });

    await sendAbstractSubmissionConfirmation(params);

    const tpl = renderedTemplate();
    expect(tpl.htmlContent.match(/\{\{travelGrantBlock\}\}/g)).toHaveLength(1);
    expect(tpl.textContent.match(/\{\{travelGrantBlockText\}\}/g)).toHaveLength(1);
  });

  it("does NOT append for a UAE author, so their email is unchanged", async () => {
    abstractFindUnique.mockReturnValue({
      catch: () => Promise.resolve(abstractRow("United Arab Emirates")),
    });

    await sendAbstractSubmissionConfirmation(params);

    const tpl = renderedTemplate();
    expect(tpl.htmlContent).toBe(SAVED_TEMPLATE_WITHOUT_TOKEN.htmlContent);
    expect(tpl.textContent).toBe(SAVED_TEMPLATE_WITHOUT_TOKEN.textContent);
  });

  it("does NOT append when the feature is switched off", async () => {
    abstractFindUnique.mockReturnValue({ catch: () => Promise.resolve(abstractRow("Oman", {})) });

    await sendAbstractSubmissionConfirmation(params);

    expect(renderedTemplate().htmlContent).toBe(SAVED_TEMPLATE_WITHOUT_TOKEN.htmlContent);
    expect(tgCreate).not.toHaveBeenCalled();
  });

  it("passes the rendered block through as a variable, not as a literal token", async () => {
    abstractFindUnique.mockReturnValue({ catch: () => Promise.resolve(abstractRow("Oman")) });

    await sendAbstractSubmissionConfirmation(params);

    const vars = renderAndWrap.mock.calls[0][1] as Record<string, string>;
    expect(vars.travelGrantBlock).toContain("/e/medcon/travel-grant/tok123");
    expect(vars.travelGrantBlockText).toContain("/e/medcon/travel-grant/tok123");
  });

  it("still sends the confirmation when travel grant blows up entirely", async () => {
    tgFindUnique.mockRejectedValue(new Error("pool exhausted"));
    abstractFindUnique.mockReturnValue({ catch: () => Promise.resolve(abstractRow("Oman")) });

    const ok = await sendAbstractSubmissionConfirmation(params);

    expect(ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(renderedTemplate().htmlContent).toBe(SAVED_TEMPLATE_WITHOUT_TOKEN.htmlContent);
  });
});
