/**
 * The save-time token check (Sep 18, 2026).
 *
 * An organiser rewrote a live event's Survey Thank You and put
 * `{{certificateList}}` in it, a certificate-cover token the thank-you sender
 * does not fill. Since Sep 11 an email carrying an unresolved token is refused
 * rather than delivered with visible braces, so every thank-you on that event
 * failed for 100 minutes until someone looked. Preview did not catch it,
 * because preview supplies a sample value for that token on EVERY template and
 * rendered it perfectly.
 *
 * The check has to be precise or it is worse than nothing: a warning that
 * cries wolf gets ignored, and this one sits in front of organisers editing
 * live copy. Measured against all 745 templates on production before shipping,
 * it flagged exactly one, which carried two known typos already going out as
 * literal text. The cases below pin the three rules that got it there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BULK_BASE_VARIABLES,
  BULK_SPEAKER_VARIABLES,
  BULK_PRESENTER_VARIABLES,
  CUSTOM_TEMPLATE_VARIABLE_GROUPS,
  isUnlistedCustomTemplateToken,
  BULK_CONDITIONAL_VARIABLES,
  BULK_ABSTRACT_OWN_VARIABLES,
  BULK_ABSTRACT_AUTHOR_VARIABLES,
  EMAIL_TEMPLATE_SPECS,
  templateAllowedTokenKeys,
} from "@/lib/email-template-registry";
import { normalizeTemplateTokens, unknownTemplateTokens } from "@/lib/template-tokens";
import { EMAIL_TOKEN_MAP } from "@/lib/email-token-map";
import { everyAudienceTokenValues, speakerTokenValues } from "@/lib/email-token-values";
import { DEFAULT_TEMPLATES } from "@/lib/email";

const check = (slug: string, ...parts: Array<string | null | undefined>) =>
  unknownTemplateTokens(templateAllowedTokenKeys(slug), ...parts.map((p) => normalizeTemplateTokens(p ?? "")));

describe("the incident it exists to prevent", () => {
  it("flags a certificate token typed into the survey thank-you", () => {
    expect(check("survey-thankyou", "<p>{{certificateList}}</p>")).toEqual(["certificateList"]);
  });

  it("does not flag it on the certificate cover email, where it resolves", () => {
    expect(check("certificate-bundle-delivery", "<p>{{certificateList}}</p>")).toEqual([]);
  });

  it("flags the two typos that were live on production", () => {
    expect(check("speaker-invitation", "{{sessiondetails}} {{presentationtime}}")).toEqual([
      "sessiondetails",
      "presentationtime",
    ]);
    // ...while the correctly-spelled ones pass.
    expect(check("speaker-invitation", "{{sessionDetails}} {{presentationDetails}}")).toEqual([]);
  });
});

describe("precision: the rules that keep it from crying wolf", () => {
  it("allows the *Text mirror of an advertised block token", () => {
    // The plain-text half of a block is filled beside the HTML half and is
    // deliberately not advertised; 44 live templates use one.
    expect(check("speaker-invitation", "{{presentationDetailsText}}")).toEqual([]);
    expect(check("webinar-confirmation", "{{calendarBlockText}}")).toEqual([]);
  });

  it("allows what bulk fills for every recipient on a bulk-sent template", () => {
    // `registrationId` is set for every bulk recipient but is not in
    // event-reminder's own list; five live templates use it there.
    expect(check("event-reminder", "{{registrationId}}")).toEqual([]);
  });

  it("does NOT allow the bulk set on a template bulk never sends", () => {
    // The whole point: survey-thankyou is sent by the certificate worker, so a
    // bulk-only token is genuinely unfillable there. Were this to pass, the
    // check would have missed the incident above.
    expect(EMAIL_TEMPLATE_SPECS.find((t) => t.slug === "survey-thankyou")!.surfaces).not.toContain("bulk");
    expect(check("survey-thankyou", "{{presentationDetails}}")).toEqual(["presentationDetails"]);
  });

  it("the one reviewer email is sent by hand from the Reviewers page (Nov 10, 2026)", () => {
    const spec = (slug: string) => EMAIL_TEMPLATE_SPECS.find((t) => t.slug === slug);
    // Not automatic, and not a bulk email: adding a reviewer and assigning an abstract send nothing.
    expect(spec("reviewer-invitation")!.surfaces).toEqual(["console"]);
    expect(spec("reviewer-assignment")).toBeUndefined();
    expect(spec("reviewer-pool-invitation")).toBeUndefined();
    // The tokens its sender fills, the older two included: a copy saved before
    // {{portalAccess}} must not be flagged for tokens that still resolve.
    expect(check("reviewer-invitation", "{{portalAccess}} {{title}} {{email}} {{reviewLink}} {{setupLink}} {{expiresIn}} {{inviterName}}")).toEqual([]);
    // The abstracts are not listed in an email any more: My Reviews shows them.
    expect(check("reviewer-invitation", "{{abstractTitle}} {{presentationDetails}}")).toEqual(["abstractTitle", "presentationDetails"]);
  });

  it("allows the RSVP tokens, which bulk fills when an RSVP is chosen", () => {
    // Using one without choosing an RSVP is refused at enqueue with a message
    // naming the fix, so it is legitimate to write into a template.
    expect(check("custom-notification", "{{rsvpButton}} {{rsvpLink}} {{rsvpName}}")).toEqual([]);
  });

  it("judges a token the editor wrapped in markup by its name", () => {
    expect(check("survey-thankyou", "{{<span>certificateList</span>}}")).toEqual(["certificateList"]);
    expect(check("survey-thankyou", "{{<strong>firstName</strong>}}")).toEqual([]);
  });

  it("treats a custom slug as bulk-sent, which is the only way it can be sent", () => {
    expect(check("joining-instruction-delegate", "{{firstName}} {{eventName}} {{rsvpButton}}")).toEqual([]);
    expect(check("joining-instruction-delegate", "{{certificateList}}")).toEqual(["certificateList"]);
  });
});

describe("every built-in template passes its own check", () => {
  // A default body that used a token its sender does not fill would mean the
  // registry and the bodies disagree, and every organiser starting from that
  // default would see a warning they cannot act on.
  for (const t of DEFAULT_TEMPLATES) {
    it(`${t.slug}`, () => {
      expect(check(t.slug, t.subject, t.htmlContent, t.textContent)).toEqual([]);
    });
  }
});

describe("BULK_BASE_VARIABLES stays in step with the real sender", () => {
  // The list is the contract; the builders every sender spreads are the truth
  // (email-token-values.ts, since Nov 27, 2026; before that this read the
  // literal object out of bulk-email.ts). Dropping a key there silently turns
  // a working organiser template into a refused send, so ask the builders.
  const src = readFileSync(join(process.cwd(), "src/lib/bulk-email.ts"), "utf8");
  const person = { id: "reg-12345678", firstName: "Sara", lastName: "Khan", title: "DR" };
  const base = everyAudienceTokenValues({
    event: { name: "E", startDate: null, venue: null, address: null, city: null, country: null },
    person,
    organizer: { name: "O", email: "o@x.test", signature: null },
  });

  it("the bulk sender spreads the shared builders", () => {
    expect(src).toContain("...everyAudienceTokenValues({");
    expect(src).toContain("speakerTokenValues(await buildSpeakerEmailContext(eventId, recipient.id), recipient)");
  });

  it("every declared base key is still set for every bulk recipient", () => {
    const missing = BULK_BASE_VARIABLES.filter((k) => !(k in base));
    expect(missing).toEqual([]);
  });

  it("the conditional RSVP tokens are still assigned in the bulk sender", () => {
    for (const k of BULK_CONDITIONAL_VARIABLES) {
      expect(src).toContain(`vars.${k} =`);
    }
  });

  it("the presenter tokens are filled by the bulk sender through the shared helper, and a custom template may use them", () => {
    expect(src).toContain("resolvePresenterAgreementForSend(");
    const helper = readFileSync(join(process.cwd(), "src/lib/presenter-agreement-send.ts"), "utf8");
    for (const k of BULK_PRESENTER_VARIABLES) {
      expect(helper).toContain(`${k}: ""`);
      expect(templateAllowedTokenKeys("faculty-welcome")).toContain(k);
    }
  });

  it("the speaker-only tokens are set by the speaker builder, with or without a context, and a custom template may use them", () => {
    const speaker = speakerTokenValues(null, person);
    for (const k of BULK_SPEAKER_VARIABLES) {
      expect(speaker).toHaveProperty(k);
      expect(templateAllowedTokenKeys("faculty-welcome")).toContain(k);
    }
  });
});

describe("a saved template may name an abstract's tokens (Nov 20, 2026, review of c332aea6)", () => {
  // A send to abstract authors fills them, once per abstract. The editor used
  // to warn "sends using it will be refused" and the agent refused the save.
  it("accepts every abstract token in a custom template, and still flags them in a system template that is not about abstracts", () => {
    const custom = templateAllowedTokenKeys("abstract-not-accepted");
    for (const k of [...BULK_ABSTRACT_OWN_VARIABLES, ...BULK_ABSTRACT_AUTHOR_VARIABLES]) expect(custom).toContain(k);
    const confirmation = templateAllowedTokenKeys("registration-confirmation");
    for (const k of ["abstractNumber", "newStatus", "reviewNotes"]) expect(confirmation).not.toContain(k);
  });

  it("the two author tokens are assigned for every abstracts recipient in the bulk sender", () => {
    const sender = readFileSync(join(process.cwd(), "src/lib/bulk-email.ts"), "utf8");
    for (const k of BULK_ABSTRACT_AUTHOR_VARIABLES) expect(sender).toContain(`vars.${k} =`);
  });

  it("the email dialog names its abstracts audience to the preview and the count, a saved template as \"template\" with its slug", () => {
    const dialog = readFileSync(join(process.cwd(), "src/components/bulk-email-dialog.tsx"), "utf8");
    expect(dialog).toContain('emailType: isSavedTemplate ? "template" : emailType,');
    expect(dialog).toContain("{ recipientType: \"abstracts\", ...abstractAudience, templateSlug: savedTemplateSlug }");
    const preview = dialog.slice(dialog.indexOf("const handlePreview"), dialog.indexOf("const handleSend"));
    expect(preview).toContain("abstractAudience: {");
    expect(preview).toContain("emailType: abstractAudience.emailType,");
  });
});

describe("the custom template editor's grouped Variables panel (Sep 25, 2026)", () => {
  const listed = CUSTOM_TEMPLATE_VARIABLE_GROUPS.flatMap((g) => g.variables.map((v) => v.key));
  const allowed = templateAllowedTokenKeys("faculty-welcome");

  it("lists nothing the token check would refuse", () => {
    expect(listed.filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it("leaves out nothing the token check accepts, apart from the text mirrors and the payment block", () => {
    expect(allowed.filter((k) => !listed.includes(k) && !isUnlistedCustomTemplateToken(k))).toEqual([]);
  });

  it("lists each token once, and shows the speaker tokens a copy of the speaker invitation carries", () => {
    expect(new Set(listed).size).toBe(listed.length);
    const speaker = CUSTOM_TEMPLATE_VARIABLE_GROUPS.find((g) => g.label === "Sent to speakers")!.variables.map((v) => v.key);
    for (const k of ["speakerName", "presentationDetails", "moderatorDetails", "agreementBlock", "honorarium"]) expect(speaker).toContain(k);
  });
});

describe("the token map (Nov 27, 2026): what a saved template may use is what some send sets", () => {
  const allowed = templateAllowedTokenKeys("my-saved-template");
  const mapped = Object.keys(EMAIL_TOKEN_MAP);

  it("the editor accepts every token in the map", () => {
    expect(mapped.filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it("the editor accepts nothing the map does not have, apart from the automatic text mirrors", () => {
    expect(allowed.filter((k) => !k.endsWith("Text") && !mapped.includes(k))).toEqual([]);
  });
});
