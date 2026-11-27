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

import { EMAIL_TEMPLATE_SPECS, templateAllowedTokenKeys } from "@/lib/email-template-registry";
import { normalizeTemplateTokens, unknownTemplateTokens } from "@/lib/template-tokens";
import { ABSTRACT_OWN_TOKEN_KEYS, CUSTOM_TEMPLATE_VARIABLE_GROUPS, EMAIL_TOKEN_MAP, type EmailToken } from "@/lib/email-token-map";
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

describe("the shared builders the senders spread (email-token-values.ts)", () => {
  // Since Nov 27, 2026 the token map is the contract and the drift tests send
  // every mapped token to every audience; what is pinned here is the wiring.
  const src = readFileSync(join(process.cwd(), "src/lib/bulk-email.ts"), "utf8");
  const person = { id: "reg-12345678", firstName: "Sara", lastName: "Khan", title: "DR" };
  const tokensOf = (pred: (t: EmailToken) => boolean) =>
    (Object.entries(EMAIL_TOKEN_MAP) as Array<[string, EmailToken]>).filter(([, t]) => pred(t)).map(([k]) => k);

  it("the bulk sender spreads them", () => {
    expect(src).toContain("...everyAudienceTokenValues({");
    expect(src).toContain("Object.assign(vars, speakerTokenValues(ctx, recipient));");
  });

  it("the base builder returns only mapped tokens that every audience gets", () => {
    const base = everyAudienceTokenValues({
      event: { name: "E", startDate: null, venue: null, address: null, city: null, country: null },
      person,
      organizer: { name: "O", email: "o@x.test", signature: null },
    });
    const everyAudience = tokensOf((t) => t.audiences === "all");
    expect(Object.keys(base).filter((k) => !everyAudience.includes(k))).toEqual([]);
  });

  it("the presenter tokens are filled by the bulk sender through the shared helper, and a custom template may use them", () => {
    expect(src).toContain("resolvePresenterAgreementForSend(");
    const helper = readFileSync(join(process.cwd(), "src/lib/presenter-agreement-send.ts"), "utf8");
    const presenter = tokensOf((t) => t.group === "presenter");
    expect(presenter).toHaveLength(2);
    for (const k of presenter) {
      expect(helper).toContain(`${k}: ""`);
      expect(templateAllowedTokenKeys("faculty-welcome")).toContain(k);
    }
  });

  it("the speaker-only tokens are set by the speaker builder, with or without a context, and a custom template may use them", () => {
    const speaker = speakerTokenValues(null, person);
    const speakerOnly = tokensOf((t) => t.audiences !== "all" && t.audiences.length === 1 && t.audiences[0] === "speakers");
    expect(speakerOnly).toHaveLength(3);
    for (const k of speakerOnly) {
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
    expect(ABSTRACT_OWN_TOKEN_KEYS).toHaveLength(10);
    for (const k of [...ABSTRACT_OWN_TOKEN_KEYS, "authorName", "managementLink"]) expect(custom).toContain(k);
    const confirmation = templateAllowedTokenKeys("registration-confirmation");
    for (const k of ["abstractNumber", "newStatus", "reviewNotes"]) expect(confirmation).not.toContain(k);
  });

  it("the two author tokens are assigned for every abstracts recipient in the bulk sender", () => {
    const sender = readFileSync(join(process.cwd(), "src/lib/bulk-email.ts"), "utf8");
    for (const k of ["authorName", "managementLink"]) expect(sender).toContain(`vars.${k} =`);
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

  it("leaves out only what the map does not advertise: the text mirrors, the Pay Now block, the typed subject and message, the travel grant block", () => {
    expect(allowed.filter((k) => !listed.includes(k)).sort()).toEqual([
      "agreementBlockText", "entryBarcodeText", "message", "moderatorDetailsText", "paymentBlock",
      "presentationDetailsText", "subject", "travelGrantBlock", "travelGrantBlockText",
    ]);
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

  it("the editor accepts exactly the map for a saved template: no guessed text mirrors", () => {
    expect([...allowed].sort()).toEqual([...mapped].sort());
    expect(allowed).not.toContain("firstNameText");
  });

  it("a built-in template sent from Communications still gets what every bulk send sets, and the text mirrors of its own blocks", () => {
    const invitation = templateAllowedTokenKeys("speaker-invitation");
    for (const k of ["firstName", "presentationDetails", "honorarium", "rsvpButton", "presentationDetailsText"]) expect(invitation).toContain(k);
    for (const k of ["subject", "message", "amount", "abstractTitle", "reviewLink"]) expect(invitation).not.toContain(k);
  });
});
