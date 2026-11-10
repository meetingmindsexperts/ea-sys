import { escapeHtml } from "@/lib/html";

/**
 * `{{portalAccess}}`: how THIS reviewer gets into the review portal, written
 * by the system (owner, Nov 10, 2026: one reviewer email, not three).
 *
 * A template cannot hold an "if", and one email serves two people: a reviewer
 * whose account has no password yet, who must set one first, and one who can
 * already sign in (most reviewers are speakers with an account). The first
 * gets the set-password button and the portal button for later visits (the
 * setup link works once); the second gets the portal button only. The
 * organiser edits everything around this block.
 *
 * Leaf module: the sender (abstract-reviewer-notify.ts) and the preview's
 * sample (email.ts) both build the block here.
 */

/** How long a reviewer's set-password link works, and how the email says so. */
export const REVIEWER_SETUP_LINK_DAYS = 10;
export const REVIEWER_SETUP_EXPIRES_IN = `${REVIEWER_SETUP_LINK_DAYS} days`;

const BUTTON = "display: inline-block; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;";
const FILLED = `${BUTTON} background: #00aade; color: white;`;
const OUTLINE = `${BUTTON} background: #ffffff; color: #00aade; border: 1px solid #00aade;`;

function button(href: string, label: string, style: string): string {
  return `<div style="text-align: center; margin: 20px 0;"><a href="${escapeHtml(href)}" style="${style}">${label}</a></div>`;
}

export function reviewerPortalAccess(args: {
  /** The address the account is on: what they sign in with. */
  email: string;
  /** Sign in, then My Reviews. */
  reviewLink: string;
  /** The personal set-password link; null for an account that can already sign in. */
  setupLink: string | null;
}): { html: string; text: string } {
  const email = escapeHtml(args.email);
  if (!args.setupLink) {
    return {
      html: `<p>Enter the Reviewer Portal by signing in with ${email}:</p>${button(args.reviewLink, "REVIEWER PORTAL", FILLED)}`,
      text: `Enter the Reviewer Portal by signing in with ${args.email}:\n\nREVIEWER PORTAL: ${args.reviewLink}`,
    };
  }
  return {
    html:
      `<p>This is your first visit, so first set your password. This link works once, within ${REVIEWER_SETUP_EXPIRES_IN}.</p>` +
      button(args.setupLink, "SET YOUR PASSWORD", FILLED) +
      `<p>After that, enter the Reviewer Portal at any time by signing in with ${email}:</p>` +
      button(args.reviewLink, "REVIEWER PORTAL", OUTLINE),
    text:
      `This is your first visit, so first set your password. This link works once, within ${REVIEWER_SETUP_EXPIRES_IN}.\n\n` +
      `SET YOUR PASSWORD: ${args.setupLink}\n\n` +
      `After that, enter the Reviewer Portal at any time by signing in with ${args.email}:\n\n` +
      `REVIEWER PORTAL: ${args.reviewLink}`,
  };
}
