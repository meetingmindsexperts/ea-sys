/**
 * Every Survey Invitation carries the recipient's personal link.
 *
 * The case that produced this (Sep 17, 2026): an organizer replaced the saved
 * template's `{{surveyLink}}` with the event's shareable URL, so a send that
 * minted a personal token per recipient delivered the shared link instead.
 */
import { describe, it, expect } from "vitest";
import {
  ensurePersonalSurveyLink,
  surveyLinkWasRepaired,
} from "@/lib/survey/invitation-link";

const OMAN_HTML =
  '<p>Dear {{title}} {{lastName}},</p><p><a href="https://events.meetingmindsgroup.com/e/OOPVF2026/survey?share=9f2c1b7e4d" style="background:#00aade">Take the survey</a></p>';

describe("ensurePersonalSurveyLink", () => {
  it("turns a pasted shareable URL into the personal link, in place (the production case)", () => {
    const { template, repair } = ensurePersonalSurveyLink({
      subject: "Your Insights Matter",
      htmlContent: OMAN_HTML,
      textContent: "Take the survey: {{surveyLink}}",
    });
    expect(template.htmlContent).toContain('<a href="{{surveyLink}}" style="background:#00aade">Take the survey</a>');
    expect(template.htmlContent).not.toContain("share=");
    // In place: no second button appended beside the organizer's own.
    expect(template.htmlContent.match(/\{\{surveyLink\}\}/g)).toHaveLength(1);
    expect(repair).toEqual({ replacedShareLinks: 1, appendedHtmlButton: false, appendedTextLink: false });
    // Everything else on the template is kept.
    expect(template.subject).toBe("Your Insights Matter");
  });

  it("replaces a shareable URL with no origin, and one in the plain-text part", () => {
    const { template, repair } = ensurePersonalSurveyLink({
      htmlContent: '<a href="/e/conf-2026/survey?share=abc">Survey</a>',
      textContent: "Open https://x.example/e/conf-2026/survey?share=abc to answer.",
    });
    expect(template.htmlContent).toBe('<a href="{{surveyLink}}">Survey</a>');
    expect(template.textContent).toBe("Open {{surveyLink}} to answer.");
    expect(repair.replacedShareLinks).toBe(2);
  });

  it("appends a Take the survey button when the HTML has no link at all", () => {
    const { template, repair } = ensurePersonalSurveyLink({
      htmlContent: "<p>Please give us your feedback.</p>",
      textContent: null,
    });
    expect(template.htmlContent).toContain('href="{{surveyLink}}"');
    expect(template.htmlContent).toContain("Take the survey");
    expect(template.textContent).toContain("{{surveyLink}}");
    expect(repair).toMatchObject({ appendedHtmlButton: true, appendedTextLink: true });
    expect(surveyLinkWasRepaired(repair)).toBe(true);
  });

  it("leaves a correct template untouched", () => {
    const tpl = {
      htmlContent: '<a href="{{surveyLink}}">Take the survey</a>',
      textContent: "Survey: {{surveyLink}}",
    };
    const { template, repair } = ensurePersonalSurveyLink(tpl);
    expect(template.htmlContent).toBe(tpl.htmlContent);
    expect(template.textContent).toBe(tpl.textContent);
    expect(surveyLinkWasRepaired(repair)).toBe(false);
  });

  it("does not touch other survey URLs, such as a personal token link someone pasted", () => {
    const html = '<a href="https://x.example/e/conf/survey?token=abc">x</a> {{surveyLink}}';
    const { template } = ensurePersonalSurveyLink({ htmlContent: html, textContent: "{{surveyLink}}" });
    expect(template.htmlContent).toBe(html);
  });
});
