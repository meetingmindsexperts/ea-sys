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
import { DEFAULT_TEMPLATES } from "@/lib/email";

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
    expect(repair).toEqual({
      replacedShareLinks: 1,
      appendedHtmlButton: false,
      appendedTextLink: false,
      buttonizedLinks: 0,
    });
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
    expect(template.htmlContent).toContain('<a href="https://x.example/e/conf/survey?token=abc">x</a>');
  });
});

// A {{surveyLink}} shown as text renders as a button (owner decision, Sep 17,
// 2026). The fixtures are the shapes saved on production that day.
const BUTTON_RE = /<a href="\{\{surveyLink\}\}" style="display: inline-block; background: #00aade;[^"]*">Take the survey<\/a>/g;

describe("ensurePersonalSurveyLink: the link as a button", () => {
  it("turns a bare {{surveyLink}} in a sentence into a button (the Oman template)", () => {
    const html =
      '<p>Please <a href="https://events.meetingmindsgroup.com/e/OOPVF2026/survey?share=fa70" style="color: rgb(0, 170, 222); text-decoration: underline;"><u>click here</u></a> or copy and paste the following link.</p>' +
      "<p>{{surveyLink}} (do not share this link as it's linked to your profile)</p>";
    const { template, repair } = ensurePersonalSurveyLink({ htmlContent: html, textContent: null });

    expect(template.htmlContent.match(BUTTON_RE)).toHaveLength(1);
    expect(template.htmlContent).toContain("(do not share this link as it's linked to your profile)</p>");
    // The "click here" text link now points at the personal link and stays a text link.
    expect(template.htmlContent).toContain('<a href="{{surveyLink}}" style="color: rgb(0, 170, 222); text-decoration: underline;"><u>click here</u></a>');
    expect(repair.buttonizedLinks).toBe(1);
  });

  it("turns a link whose visible text is the address into a button (the CADF template)", () => {
    const html =
      '<p><a target="_blank" href="https://events.meetingmindsgroup.com/e/osh-mm-june2026/survey?share=bb18" style="color: rgb(0, 170, 222);"><u>https://events.meetingmindsgroup.com/e/osh-mm-june2026/survey?share=bb18</u></a> (do not share this link)</p>';
    const { template, repair } = ensurePersonalSurveyLink({ htmlContent: html, textContent: null });

    expect(template.htmlContent.match(BUTTON_RE)).toHaveLength(1);
    // No link is left wrapping the button, and no raw address is shown.
    expect(template.htmlContent).not.toContain("<u>");
    expect(template.htmlContent.match(/<a /g)).toHaveLength(1);
    expect(repair.buttonizedLinks).toBe(1);
  });

  it("leaves the default template at one button: its copy-this-link line stays an address", () => {
    const html = DEFAULT_TEMPLATES.find((t) => t.slug === "survey-invitation")!.htmlContent;
    const { template, repair } = ensurePersonalSurveyLink({ htmlContent: html, textContent: null });

    expect(template.htmlContent).toBe(html);
    expect(repair.buttonizedLinks).toBe(0);
  });

  it("never touches a token inside an attribute", () => {
    const html = '<p><a href="{{surveyLink}}">Open the form</a></p><img alt="{{surveyLink}}" src="x.png">';
    const { template } = ensurePersonalSurveyLink({ htmlContent: html, textContent: null });
    expect(template.htmlContent).toBe(html);
  });

  it("recognises a token the editor split with markup", () => {
    const { template } = ensurePersonalSurveyLink({
      htmlContent: "<p>{{<span>surveyLink</span>}}</p>",
      textContent: null,
    });
    expect(template.htmlContent.match(BUTTON_RE)).toHaveLength(1);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const first = ensurePersonalSurveyLink({ htmlContent: "<p>Here: {{surveyLink}}</p>", textContent: null });
    const second = ensurePersonalSurveyLink(first.template);
    expect(second.template.htmlContent).toBe(first.template.htmlContent);
    expect(second.repair.buttonizedLinks).toBe(0);
  });

  it("does not report a button conversion as a broken template", () => {
    const { repair } = ensurePersonalSurveyLink({
      htmlContent: "<p>{{surveyLink}}</p>",
      textContent: "{{surveyLink}}",
    });
    expect(repair.buttonizedLinks).toBe(1);
    expect(surveyLinkWasRepaired(repair)).toBe(false);
  });
});
