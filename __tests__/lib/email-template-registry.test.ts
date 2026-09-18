/**
 * The email-template registry: the derivations reproduce what the hand-copied
 * lists said on September 18, 2026, and the contract a template's body makes
 * with its sender is checked here rather than in an organizer's inbox.
 *
 * The literal expectations below ARE the previous hand lists (the dialog's
 * four option arrays, the five type-to-slug maps, the Settings short list,
 * the raw-key set). They are pinned so that turning them into derivations
 * changed nothing an operator sees, and so that a future registry edit that
 * would silently drop an option or a raw key fails here first.
 */
import { describe, it, expect } from "vitest";
import {
  SYSTEM_TEMPLATE_SLUG_LIST,
  EMAIL_TEMPLATE_REGISTRY,
  EMAIL_TEMPLATE_SPECS,
  GLOBAL_RAW_HTML_KEYS,
  CORE_TEMPLATE_SLUGS,
  BULK_EMAIL_TEMPLATE_SLUGS,
  bulkTemplateSlugFor,
  bulkEmailTypeOptionsFor,
  singleSendSlugFor,
  singleSendTypesFor,
  templateDescription,
  isSystemTemplateSlug,
} from "@/lib/email-template-registry";
import { DEFAULT_TEMPLATE_BODIES } from "@/lib/email-template-defaults";
import { DEFAULT_TEMPLATES, TEMPLATE_VARIABLES, GLOBAL_EVENT_VARIABLES, renderTemplate } from "@/lib/email";
import { SYSTEM_TEMPLATE_SLUGS } from "@/lib/email-template-slugs";

const TOKEN_RE = /\{\{(\w+)\}\}/g;
const tokensIn = (...parts: string[]) => {
  const out = new Set<string>();
  for (const p of parts) for (const m of p.matchAll(TOKEN_RE)) out.add(m[1]!);
  return out;
};

describe("registry shape", () => {
  it("holds 35 system templates, each with a body and a spec under its own slug", () => {
    expect(SYSTEM_TEMPLATE_SLUG_LIST).toHaveLength(35);
    for (const slug of SYSTEM_TEMPLATE_SLUG_LIST) {
      expect(EMAIL_TEMPLATE_REGISTRY[slug].slug).toBe(slug);
      expect(DEFAULT_TEMPLATE_BODIES[slug].subject.length).toBeGreaterThan(0);
      expect(DEFAULT_TEMPLATE_BODIES[slug].htmlContent.length).toBeGreaterThan(0);
      expect(EMAIL_TEMPLATE_REGISTRY[slug].description.length).toBeGreaterThan(0);
    }
    expect(new Set(SYSTEM_TEMPLATE_SLUG_LIST).size).toBe(35);
  });

  it("derives DEFAULT_TEMPLATES, TEMPLATE_VARIABLES and the client-safe slug set from the registry, in seed order", () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.slug)).toEqual([...SYSTEM_TEMPLATE_SLUG_LIST]);
    expect(DEFAULT_TEMPLATES[0]).toMatchObject({ slug: "registration-confirmation", name: "Registration Confirmation" });
    expect(Object.keys(TEMPLATE_VARIABLES).sort()).toEqual([...SYSTEM_TEMPLATE_SLUG_LIST].sort());
    expect([...SYSTEM_TEMPLATE_SLUGS].sort()).toEqual([...SYSTEM_TEMPLATE_SLUG_LIST].sort());
    expect(isSystemTemplateSlug("speaker-invitation")).toBe(true);
    expect(isSystemTemplateSlug("joining-instructions")).toBe(false);
  });

  it("every template advertises a variable list now (the nine that had none are covered)", () => {
    for (const slug of ["abstract-reminder", "webinar-confirmation", "webinar-reminder-24h", "webinar-reminder-1h", "webinar-live-now", "webinar-thank-you", "webinar-panelist-invitation", "survey-invitation", "survey-thankyou"] as const) {
      expect(EMAIL_TEMPLATE_REGISTRY[slug].variables.length, slug).toBeGreaterThan(0);
    }
  });
});

describe("the body-to-contract check", () => {
  it("every token a default body uses is one its template advertises, a global event token, or a text-part mirror", () => {
    const globals = new Set(GLOBAL_EVENT_VARIABLES.map((v) => v.key));
    const misses: string[] = [];
    for (const t of EMAIL_TEMPLATE_SPECS) {
      const body = DEFAULT_TEMPLATE_BODIES[t.slug];
      const advertised = new Set(t.variables.map((v) => v.key));
      for (const tok of tokensIn(body.subject, body.htmlContent, body.textContent)) {
        if (advertised.has(tok) || globals.has(tok)) continue;
        // The plain-text part mirrors a block token as `<token>Text`; the
        // editor never shows it and the senders fill it beside the block.
        if (tok.endsWith("Text") && (advertised.has(tok.slice(0, -4)) || GLOBAL_RAW_HTML_KEYS.includes(tok.slice(0, -4)))) continue;
        misses.push(`${t.slug}: {{${tok}}}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("every raw HTML key a template declares is a token its own body or a global block uses", () => {
    for (const t of EMAIL_TEMPLATE_SPECS) {
      const body = DEFAULT_TEMPLATE_BODIES[t.slug];
      const toks = tokensIn(body.subject, body.htmlContent, body.textContent);
      for (const key of t.rawHtmlKeys) {
        // taxBlock is built by the Stripe webhook for a saved template that
        // adds it; the default body does not carry it.
        if (key === "taxBlock") continue;
        expect(toks.has(key), `${t.slug} declares raw ${key}`).toBe(true);
      }
    }
  });
});

describe("the derived raw-key set", () => {
  it("is exactly the set the hand list held on September 18, 2026", () => {
    const derived = new Set([...GLOBAL_RAW_HTML_KEYS, ...EMAIL_TEMPLATE_SPECS.flatMap((t) => t.rawHtmlKeys)]);
    expect([...derived].sort()).toEqual(
      [
        "paymentBlock", "rsvpButton", "receiptBlock", "taxBlock", "presentationDetails", "memberSummary",
        "moderatorDetails", "agreementBlock", "travelGrantBlock", "passcodeBlock", "recordingBlock",
        "calendarBlock", "entryBarcode", "organizerSignature", "reviewNotes", "claimSummary", "presenterFeeBlock",
      ].sort(),
    );
    // And the renderer honours it without a caller opting in.
    expect(renderTemplate("{{reviewNotes}}", { reviewNotes: "<b>x</b>" })).toBe("<b>x</b>");
    expect(renderTemplate("{{firstName}}", { firstName: "<b>x</b>" })).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("the type-to-slug maps", () => {
  it("bulk: the fifteen types map as the hand map did, and a reviewer invitation is the pool invitation", () => {
    expect(BULK_EMAIL_TEMPLATE_SLUGS).toEqual({
      invitation: "speaker-invitation",
      agreement: "speaker-agreement",
      confirmation: "registration-confirmation",
      reminder: "event-reminder",
      "payment-reminder": "payment-reminder",
      custom: "custom-notification",
      "webinar-confirmation": "webinar-confirmation",
      "webinar-reminder-24h": "webinar-reminder-24h",
      "webinar-reminder-1h": "webinar-reminder-1h",
      "webinar-live-now": "webinar-live-now",
      "webinar-thank-you": "webinar-thank-you",
      "survey-invitation": "survey-invitation",
      "abstract-confirmation": "abstract-submission-confirmation",
      "abstract-decision": "abstract-status-update",
      "abstract-reminder": "abstract-reminder",
    });
    expect(bulkTemplateSlugFor("invitation", "reviewers")).toBe("reviewer-pool-invitation");
    expect(bulkTemplateSlugFor("invitation", "speakers")).toBe("speaker-invitation");
    expect(bulkTemplateSlugFor("confirmation", "registrations")).toBe("registration-confirmation");
    expect(bulkTemplateSlugFor("certificate", "registrations")).toBeNull();
    expect(bulkTemplateSlugFor("nope", "speakers")).toBeNull();
  });

  it("single-send: the speaker and registration surfaces map as their routes and sheets did", () => {
    expect(singleSendTypesFor("speaker", { route: true }).map((s) => s.type)).toEqual(["invitation", "agreement", "custom"]);
    expect(singleSendTypesFor("speaker").map((s) => s.type)).toEqual(["invitation", "agreement", "abstract-confirmation", "custom"]);
    expect(singleSendSlugFor("speaker", "abstract-confirmation")).toBe("abstract-submission-confirmation");
    expect(singleSendSlugFor("speaker", "custom")).toBe("custom-notification");
    // Order is registry (seed) order and nothing reads it: the sheet's menu is
    // hand-ordered JSX and the route's enum is a set.
    expect(singleSendTypesFor("registration", { route: true }).map((s) => [s.type, s.label]).sort()).toEqual([
      ["confirmation", "Registration Confirmation"],
      ["custom", "Custom Notification"],
      ["payment-reminder", "Payment Reminder"],
      ["reminder", "Event Reminder"],
      ["survey-invitation", "Survey Invitation"],
    ]);
    expect(singleSendSlugFor("registration", "reminder")).toBe("event-reminder");
    expect(singleSendSlugFor("registration", "invitation")).toBeNull();
  });
});

describe("the dialog option lists", () => {
  it("reproduce the four hand arrays the dialog carried, in order, with the per-audience wording", () => {
    expect(bulkEmailTypeOptionsFor("speakers")).toEqual([
      { value: "invitation", label: "Speaker Invitation", description: "Invite speakers to your event" },
      { value: "agreement", label: "Speaker Agreement", description: "Send agreement terms for review" },
      { value: "certificate", label: "Certificates", description: "Issue & attach certificate PDFs (tag-matched, one email per person)" },
      { value: "custom", label: "Custom Email", description: "Write a custom message" },
    ]);
    expect(bulkEmailTypeOptionsFor("reviewers")).toEqual([
      { value: "custom", label: "Custom Email", description: "Write a custom message to reviewers" },
      { value: "invitation", label: "Review Invitation", description: "Resend the reviewer pool invitation (the email a reviewer gets when added)" },
    ]);
    expect(bulkEmailTypeOptionsFor("registrations")).toEqual([
      { value: "confirmation", label: "Registration Confirmation", description: "Confirm their registration" },
      { value: "reminder", label: "Event Reminder", description: "Remind about the upcoming event" },
      { value: "payment-reminder", label: "Payment Reminder", description: "Chase an outstanding balance with a Pay Now link" },
      { value: "survey-invitation", label: "Survey Invitation", description: "Send a unique link to the post-event feedback survey" },
      { value: "certificate", label: "Certificates", description: "Issue & attach certificate PDFs (tag-matched, one email per person)" },
      { value: "custom", label: "Custom Email", description: "Write a custom message" },
    ]);
    expect(bulkEmailTypeOptionsFor("abstracts")).toEqual([
      { value: "abstract-confirmation", label: "Resend Submission Confirmation", description: "One email per abstract, with its number, title and details" },
      { value: "abstract-decision", label: "Resend Decision", description: "One email per decided abstract, with its current status and reviewer notes" },
      { value: "abstract-reminder", label: "Submission Reminder", description: "Authors who still have a draft; add a message" },
      { value: "custom", label: "Custom Email", description: "Write a custom message" },
    ]);
  });

  it("every option the dialog offers resolves to a slug the pipeline can send, except the certificate pipeline's own", () => {
    for (const audience of ["speakers", "reviewers", "registrations", "abstracts"] as const) {
      for (const o of bulkEmailTypeOptionsFor(audience)) {
        if (o.value === "certificate") continue;
        expect(bulkTemplateSlugFor(o.value, audience), `${audience}/${o.value}`).not.toBeNull();
      }
    }
  });
});

describe("the Settings short list and the descriptions", () => {
  it("lists the eight most-used built-ins", () => {
    expect([...CORE_TEMPLATE_SLUGS].sort()).toEqual(
      ["registration-confirmation", "speaker-invitation", "speaker-agreement", "event-reminder", "abstract-submission-confirmation", "abstract-status-update", "submitter-welcome", "custom-notification"].sort(),
    );
  });

  it("describes a system template and echoes a custom slug", () => {
    expect(templateDescription("submitter-welcome")).toBe("Sent when a submitter creates an account");
    expect(templateDescription("joining-instructions")).toBe("joining-instructions");
  });
});
