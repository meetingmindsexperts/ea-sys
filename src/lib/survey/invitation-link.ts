/**
 * Every Survey Invitation carries the recipient's PERSONAL survey link.
 *
 * WHY THIS EXISTS (Sep 17, 2026). An organizer edited an event's saved
 * survey-invitation template and replaced the button's `{{surveyLink}}` with
 * the event's shareable link (`/e/{slug}/survey?share=…`), pasted by hand. The
 * send still minted a personal token per recipient, but the email carried the
 * shared URL, so no one received a personal link. The shareable link has since
 * been retired, which turns any copy of it into a dead URL.
 *
 * A saved template is the organizer's own copy (the default is only a seed),
 * so fixing the default reaches nobody who already edited theirs. The repair
 * therefore runs on the template at send and preview time:
 *
 *   1. Any shareable survey URL in the body, whatever its host or slug,
 *      becomes `{{surveyLink}}`, so a pasted link becomes the personal one in
 *      the place the organizer put it.
 *   2. If the HTML still has no `{{surveyLink}}`, a "Take the survey" button is
 *      appended; if the plain-text part has none, a line is appended.
 *   3. A `{{surveyLink}}` shown as TEXT becomes a "Take the survey" button
 *      (owner decision, Sep 17, 2026): the live templates printed the raw
 *      address in a sentence ("{{surveyLink}} (do not share this link)"), a
 *      long URL instead of something to click. That covers a bare token in a
 *      paragraph and a link whose visible text is just the token. A token in
 *      an attribute (`href="{{surveyLink}}"`) stays an address. Nothing is
 *      converted when the email already has a button to the survey (a link
 *      to `{{surveyLink}}` with a background), because that is the default
 *      template's shape: a button, then "Or copy this link: {{surveyLink}}"
 *      as a fallback address. 24 of the 27 saved copies on production carry
 *      that line, and converting it would give them two buttons.
 *
 * The stored template is never rewritten. Pure and client-safe.
 */

import { normalizeTemplateTokens } from "@/lib/template-tokens";

/** A shareable-survey URL with or without an origin, in HTML or plain text. */
const SHARE_SURVEY_URL_RE =
  /(?:https?:\/\/[^\s"'<>]+)?\/e\/[^\s"'<>/?#]+\/survey\?share=[^\s"'<>]*/g;

const SURVEY_LINK_TOKEN = "{{surveyLink}}";

/** The button. `{{surveyLink}}` sits in the href, so the renderer fills each person's link. */
const SURVEY_BUTTON_HTML =
  '<a href="{{surveyLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">Take the survey</a>';

const PERSONAL_BUTTON_HTML = `<p style="text-align: center; margin: 24px 0;">
  ${SURVEY_BUTTON_HTML}
</p>`;

/** One <a>…</a> element. Email bodies do not nest anchors. */
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_IS_SURVEY_LINK_RE = /\bhref\s*=\s*["']\{\{surveyLink\}\}["']/i;
const STYLE_HAS_BACKGROUND_RE = /\bstyle\s*=\s*["'][^"']*\bbackground/i;

export interface SurveyTemplateParts {
  htmlContent: string;
  /** Null on a stored row with no plain-text part. */
  textContent: string | null;
}

export interface SurveyLinkRepair {
  /** Shareable URLs replaced by the personal link, across HTML and text. */
  replacedShareLinks: number;
  appendedHtmlButton: boolean;
  appendedTextLink: boolean;
  /** Links shown as text that now render as a button (step 3, by design). */
  buttonizedLinks: number;
}

function hasSurveyButton(html: string): boolean {
  for (const match of html.matchAll(ANCHOR_RE)) {
    const attrs = match[1];
    if (HREF_IS_SURVEY_LINK_RE.test(attrs) && STYLE_HAS_BACKGROUND_RE.test(attrs)) return true;
  }
  return false;
}

function visibleText(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, "").replace(/&nbsp;|\u00a0/g, " ").trim();
}

function buttonizeSurveyLinks(html: string): { html: string; count: number } {
  if (!html.includes(SURVEY_LINK_TOKEN) || hasSurveyButton(html)) return { html, count: 0 };

  let count = 0;
  // Text between tags only, so a token inside an attribute is never touched.
  const inText = (segment: string) =>
    segment
      .split(/(<[^>]*>)/)
      .map((part, i) => {
        if (i % 2 === 1 || !part.includes(SURVEY_LINK_TOKEN)) return part;
        const pieces = part.split(SURVEY_LINK_TOKEN);
        count += pieces.length - 1;
        return pieces.join(SURVEY_BUTTON_HTML);
      })
      .join("");

  let out = "";
  let last = 0;
  for (const match of html.matchAll(ANCHOR_RE)) {
    const [whole, attrs, inner] = match;
    const start = match.index ?? 0;
    out += inText(html.slice(last, start));
    if (HREF_IS_SURVEY_LINK_RE.test(attrs) && visibleText(inner) === SURVEY_LINK_TOKEN) {
      out += SURVEY_BUTTON_HTML;
      count += 1;
    } else {
      // Any other link stays as written; a token in its text is left alone so
      // a button is never nested inside a link.
      out += whole;
    }
    last = start + whole.length;
  }
  out += inText(html.slice(last));
  return { html: out, count };
}

export function ensurePersonalSurveyLink<T extends SurveyTemplateParts>(
  template: T,
): { template: T; repair: SurveyLinkRepair } {
  let replacedShareLinks = 0;
  const swap = (content: string) =>
    content.replace(SHARE_SURVEY_URL_RE, () => {
      replacedShareLinks += 1;
      return SURVEY_LINK_TOKEN;
    });

  // Collapse editor-mangled tokens first ({{<span>surveyLink</span>}}), the
  // same normalization the renderer applies, so the checks below see them.
  let htmlContent = swap(normalizeTemplateTokens(template.htmlContent ?? ""));
  let textContent = swap(normalizeTemplateTokens(template.textContent ?? ""));

  const appendedHtmlButton = !htmlContent.includes(SURVEY_LINK_TOKEN);
  if (appendedHtmlButton) htmlContent = `${htmlContent}\n${PERSONAL_BUTTON_HTML}`;

  const buttonized = buttonizeSurveyLinks(htmlContent);
  htmlContent = buttonized.html;

  const appendedTextLink = !textContent.includes(SURVEY_LINK_TOKEN);
  if (appendedTextLink) textContent = `${textContent}\n\nTake the survey: ${SURVEY_LINK_TOKEN}`;

  return {
    // Spread keeps every other field (subject, slug, branding…) of the caller's type.
    template: { ...template, htmlContent, textContent } as T,
    repair: { replacedShareLinks, appendedHtmlButton, appendedTextLink, buttonizedLinks: buttonized.count },
  };
}

/**
 * True when the repair changed anything worth telling the organizer about.
 * Turning a text link into a button is the intended rendering, not a fault in
 * the template, so it does not count.
 */
export function surveyLinkWasRepaired(repair: SurveyLinkRepair): boolean {
  return repair.replacedShareLinks > 0 || repair.appendedHtmlButton || repair.appendedTextLink;
}
