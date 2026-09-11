/**
 * {{rsvpButton}}: the personal RSVP link rendered as an email-safe button
 * (Sep 11, 2026, organiser request). The bare {{rsvpLink}} is a URL the
 * organiser has to wrap in their own markup, and the editor's link tool will
 * not accept a token as an href, so the practical result was a raw link
 * pasted into a sentence. This is the same pattern as {{paymentBlock}},
 * {{agreementBlock}} and {{calendarBlock}}: a pre-rendered block the organiser
 * drops into any template, resolved wherever {{rsvpLink}} is.
 *
 * Client-safe (no db, no Node imports): the two editors use the token
 * predicate to warn when a template carries neither token.
 */

import { escapeHtml } from "@/lib/html";

const RSVP_TOKEN_RE = /\{\{rsvp(?:Link|Button)\}\}/;

/** True when any part carries {{rsvpLink}} or {{rsvpButton}} exactly as renderTemplate matches them. */
export function templateUsesRsvpToken(...parts: Array<string | null | undefined>): boolean {
  return parts.some((p) => typeof p === "string" && RSVP_TOKEN_RE.test(p));
}

/**
 * The button block. Both strings are escaped here, so the block is safe to
 * render raw (it joins the raw-HTML key set like the other blocks). An empty
 * link renders nothing rather than a dead button.
 */
export function buildRsvpButton(opts: { rsvpLink: string; rsvpName: string }): { html: string; text: string } {
  const link = opts.rsvpLink.trim();
  if (!link) return { html: "", text: "" };
  const name = opts.rsvpName.trim();
  const label = "RSVP now";
  return {
    html:
      `<div style="text-align: center; margin: 24px 0 8px 0;">` +
      `<a href="${escapeHtml(link)}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">${label}</a>` +
      `</div>` +
      `<p style="color: #6b7280; font-size: 12px; text-align: center; margin: 0 0 16px 0;">` +
      `This link is personal to you${name ? ` for ${escapeHtml(name)}` : ""}; please do not forward it.` +
      `</p>`,
    text: `${label}${name ? ` (${name})` : ""}: ${link}`,
  };
}
