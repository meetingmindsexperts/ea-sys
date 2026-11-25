/**
 * The invitee page's question, the line under it, and the thank-you shown once they have answered
 * (Nov 25, 2026; owner: "give text boxes for organizer to add" them, "thank you text also"). The
 * organiser's own words when they wrote some (`RsvpCampaign.questionText` / `questionHelpText` /
 * `thankYouText`); otherwise the built-in wording. The question and its line follow the RSVP's
 * shape: one option or several, pick one or pick many.
 *
 * Client-safe on purpose (rsvp.ts imports Node's crypto, which must never reach a browser bundle):
 * the invitee's page renders from here and the console shows the same built-in wording as its
 * boxes' placeholders, so the words are written in this file and nowhere else.
 */

export const RSVP_QUESTION_MAX = 200;
export const RSVP_QUESTION_HELP_MAX = 500;
export const RSVP_THANK_YOU_MAX = 1000;

export function defaultRsvpQuestion(manyItems: boolean, single: boolean): string {
  if (!manyItems) return "Will you be attending?";
  return single ? "Which one will you attend?" : "Which of these will you attend?";
}

export function defaultRsvpQuestionHelp(manyItems: boolean, single: boolean): string {
  if (!manyItems) return "Tick the box if you\u2019ll join, or choose \u201CI won\u2019t be able to attend\u201D below.";
  return single
    ? "Choose one option, or select \u201CI won\u2019t be able to attend\u201D below."
    : "Tick everything you\u2019ll join, or choose \u201CI won\u2019t be able to attend\u201D below.";
}

/**
 * The message under "Thank you, {name}!" once the invitee has answered. One message for a yes and
 * for a no: an organiser's own words should read well for both.
 */
export function defaultRsvpThankYou(campaignName: string): string {
  return `Your response to ${campaignName} has been recorded. You can revisit this link to change it any time before the deadline.`;
}

export interface RsvpQuestionWording {
  questionText?: string | null;
  questionHelpText?: string | null;
  thankYouText?: string | null;
}

export function rsvpQuestionText(campaign: RsvpQuestionWording, manyItems: boolean, single: boolean): string {
  return campaign.questionText?.trim() || defaultRsvpQuestion(manyItems, single);
}

export function rsvpQuestionHelpText(campaign: RsvpQuestionWording, manyItems: boolean, single: boolean): string {
  return campaign.questionHelpText?.trim() || defaultRsvpQuestionHelp(manyItems, single);
}

export function rsvpThankYouText(campaign: RsvpQuestionWording & { name: string }): string {
  return campaign.thankYouText?.trim() || defaultRsvpThankYou(campaign.name);
}

/** A name that already opens with a title ("Dr. Hadeel Ammar", "Prof Ali"): typed that way by hand. */
const NAME_OPENS_WITH_TITLE = /^(dr|prof|professor|mr|mrs|ms|miss)\b\.?\s/i;

/**
 * The thank-you's greeting name: the person's title, when the event knows one, before their name.
 * Never twice: an invitee typed in as "Dr. Hadeel Ammar" keeps exactly that (review of 3b8d4f365).
 */
export function rsvpGreetingName(titleLabel: string | null | undefined, name: string): string {
  const title = titleLabel?.trim();
  if (!title || NAME_OPENS_WITH_TITLE.test(name.trim())) return name.trim();
  return `${title} ${name.trim()}`;
}
