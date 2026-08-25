/**
 * Client-safe constants and the submit contract for the public consent form.
 *
 * Pure: zod plus one HTML string. The public page is a client component, so
 * nothing here may import `db` or a Node built-in.
 */
import { z } from "zod";

/**
 * Shown on the consent form when the organizer has written nothing under
 * Content -> Abstracts.
 *
 * It says out loud that the AUTHOR'S declaration governs eligibility. That is
 * not boilerplate: we route on the country recorded on their profile, which is
 * a proxy for residency and can be wrong in both directions. Making the tick
 * the operative statement means the person who actually knows is the one
 * asserting it, and it is why decision D1 kept the confirmation wording
 * explicit rather than reducing this to a bare "yes please".
 */
export const DEFAULT_TRAVEL_GRANT_TERMS_HTML = `
<p>We offer a limited number of travel grants to help authors travelling from
outside the United Arab Emirates to attend and present in person.</p>
<p>By confirming below you are telling us that:</p>
<ul>
  <li>You are <strong>not a resident of the United Arab Emirates</strong>.</li>
  <li>You would like to be considered for a travel grant.</li>
  <li>The details you have given us are accurate to the best of your knowledge.</li>
</ul>
<p><strong>Confirming does not award you a grant.</strong> It records that you are
eligible and interested. Grants are limited, decided by the organising committee,
and you will be contacted separately about the outcome. Your own declaration
above is what determines eligibility.</p>
`.trim();

export const TRAVEL_GRANT_DECISIONS = ["consent", "decline"] as const;
export type TravelGrantDecision = (typeof TRAVEL_GRANT_DECISIONS)[number];

/**
 * The submit contract.
 *
 * A DECLINE needs nothing beyond the decision: asking someone to tick a box and
 * sign their name in order to say "no thank you" is friction that produces
 * abandoned forms rather than recorded declines, and a recorded decline is
 * exactly what stops the organizer chasing them.
 *
 * A CONSENT requires both the explicit tick and a typed signature, because
 * together they are the record that this person asserted their own eligibility.
 */
export const travelGrantSubmitSchema = z
  .object({
    decision: z.enum(TRAVEL_GRANT_DECISIONS),
    confirmedNotUaeResident: z.boolean().optional(),
    signedName: z.string().trim().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision !== "consent") return;
    if (v.confirmedNotUaeResident !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmedNotUaeResident"],
        message: "Please confirm you are not a UAE resident.",
      });
    }
    if (!v.signedName || v.signedName.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signedName"],
        message: "Please type your full name as a signature.",
      });
    }
  });

export type TravelGrantSubmit = z.infer<typeof travelGrantSubmitSchema>;
