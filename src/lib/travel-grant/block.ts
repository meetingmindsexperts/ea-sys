/**
 * The `{{travelGrantBlock}}` email variable.
 *
 * Pure. Modelled directly on `buildAgreementBlock()` in speaker-agreement.ts,
 * which already solves this exact problem for the speaker agreement.
 *
 * ## Why the organizer's message is INSIDE the block
 *
 * The agreement block is deliberately CTA-only, with its intro sentence living
 * in the email template around the token, because that is where an organizer
 * edits wording. This block is the opposite on purpose: the message is written
 * under Content -> Abstracts and rendered inside the block, because the block
 * is CONDITIONAL. An intro placed in the template would render for UAE-based
 * authors too, who get no button and no link, leaving them reading an offer
 * that then does not appear.
 *
 * ## Why there is no `{{travelGrantLink}}` token
 *
 * A bare-link token buys nothing the block does not already provide, and every
 * additional token is one more thing that can render as literal `{{...}}` text
 * in an event's saved template. One token, one contract.
 */

export type TravelGrantBlockStatus = "PENDING" | "CONSENTED" | "DECLINED";

const TRAVEL_GRANT_TOKEN_RE = /\{\{(travelGrantBlock|travelGrantBlockText)\}\}/;

/**
 * True when any part of a resolved template already references the block.
 *
 * This is the guard against the trap that has bitten this repo twice. Events
 * carry their OWN saved copy of `abstract-submission-confirmation` (the
 * templates list auto-seeds system defaults as editable rows), so adding the
 * token to the shipped default reaches none of them. The caller appends the
 * token when this returns false, rather than assuming the default is in play.
 */
export function templateUsesTravelGrantBlock(
  ...parts: Array<string | null | undefined>
): boolean {
  return parts.some((p) => !!p && TRAVEL_GRANT_TOKEN_RE.test(p));
}

/**
 * Render the block for one author.
 *
 * Four states, and three of them render NOTHING. That is the point: an author
 * who is not eligible must see no heading, no empty panel and no dead link, so
 * their confirmation email is byte-identical to what it is today.
 */
export function buildTravelGrantBlock(opts: {
  /** The author's personal consent URL. Empty or absent renders nothing. */
  link: string;
  /** Organizer copy from Content -> Abstracts. Rendered raw; organizer-authored. */
  messageHtml?: string | null;
  /** Current row status. Absent is treated as PENDING (a freshly minted row). */
  status?: TravelGrantBlockStatus | null;
}): { html: string; text: string } {
  // Already answered yes: acknowledge, never ask again. Mirrors the green
  // already-accepted note on the agreement block.
  if (opts.status === "CONSENTED") {
    return {
      html: `<p style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 12px 16px; color: #166534; font-size: 14px; margin: 20px 0;">&#10003; Your travel grant request has been received. We will be in touch about the outcome.</p>`,
      text: `Your travel grant request has been received. We will be in touch about the outcome.`,
    };
  }

  // Already answered no. Silence, so a second abstract does not re-ask.
  if (opts.status === "DECLINED") return { html: "", text: "" };

  if (!opts.link) return { html: "", text: "" };

  const message = (opts.messageHtml ?? "").trim();
  const messageHtml = message
    ? `<div style="margin: 0 0 16px 0; color: #374151; font-size: 14px;">${message}</div>`
    : "";

  return {
    html: `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      ${messageHtml}<div style="text-align: center;">
        <a href="${opts.link}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600;">Confirm your travel grant</a>
      </div>
      <p style="margin: 14px 0 0 0; color: #6b7280; font-size: 12px; text-align: center;">This link is unique to you.</p>
    </div>`,
    text: [
      stripHtmlToText(message),
      `Confirm your travel grant here (link unique to you):\n${opts.link}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * Minimal HTML-to-text for the plain-text alternative of the organizer's
 * message. Not a general-purpose converter: it only has to make a Tiptap
 * paragraph readable, and a plain-text part that is slightly rough is a far
 * smaller problem than one carrying raw tags.
 */
function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
