/**
 * The author payment hold (owner, Nov 23, 2026; author-payment-hold.ts).
 *
 * An abstract author's fee is confirmed after review, so the registration the
 * abstract sign-up made is not paid online while the event's switch is off.
 * Until this day only the sign-up's own emails obeyed that switch: the portal,
 * the event's registration page, Resend confirmation, the payment reminder and
 * the checkout all offered Pay Now regardless.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  authorPaymentOnHold,
  AUTHOR_PAYMENT_HOLD_CODE,
  AUTHOR_PAYMENT_HOLD_NOTE,
  AUTHOR_SIGNUP_SOURCE,
} from "@/lib/author-payment-hold";

const ON = { presenterRegistration: { payNowEnabled: true } };
const OFF = { presenterRegistration: { payNowEnabled: false } };

describe("authorPaymentOnHold", () => {
  it("holds the abstract sign-up's registration while the event's switch is off", () => {
    expect(authorPaymentOnHold({ createdSource: AUTHOR_SIGNUP_SOURCE }, OFF)).toBe(true);
  });

  it("opens it when the organisers turn the switch on", () => {
    expect(authorPaymentOnHold({ createdSource: AUTHOR_SIGNUP_SOURCE }, ON)).toBe(false);
  });

  it.each([
    ["no settings at all", null],
    ["settings with no presenter block", {}],
    ["a truthy value that is not true", { presenterRegistration: { payNowEnabled: "yes" } }],
    ["a damaged block", { presenterRegistration: [] }],
  ])("holds on %s: an unreadable switch never opens payment", (_name, settings) => {
    expect(authorPaymentOnHold({ createdSource: AUTHOR_SIGNUP_SOURCE }, settings)).toBe(true);
  });

  it.each([
    "PUBLIC_REGISTER", // a delegate who registered and then submitted keeps an ordinary registration
    "ADMIN_DASHBOARD", // a registration the organisers granted by hand: they have decided
    "SPEAKER_COMPANION",
    "FACULTY_ADMIN",
    "CSV_IMPORT",
    "ONSITE_DESK",
    "GROUP_REGISTER",
  ])("never holds a %s registration, whatever the switch says", (createdSource) => {
    expect(authorPaymentOnHold({ createdSource }, OFF)).toBe(false);
    expect(authorPaymentOnHold({ createdSource }, null)).toBe(false);
  });

  it("never holds a row with no entry path recorded (older rows)", () => {
    expect(authorPaymentOnHold({ createdSource: null }, OFF)).toBe(false);
    expect(authorPaymentOnHold({}, OFF)).toBe(false);
  });

  it("the source it goes by is the one the abstract sign-up stamps", () => {
    expect(AUTHOR_SIGNUP_SOURCE).toBe("PUBLIC_SUBMITTER");
    expect(readFileSync(join(process.cwd(), "src/lib/presenter-signup.ts"), "utf8")).toContain('createdSource: "PUBLIC_SUBMITTER"');
  });

  it("what the person is told says who decides, and promises no date", () => {
    expect(AUTHOR_PAYMENT_HOLD_NOTE).toContain("Online payment is not open yet");
    expect(AUTHOR_PAYMENT_HOLD_NOTE).toContain("organizing team");
    expect(AUTHOR_PAYMENT_HOLD_CODE).toBe("AUTHOR_PAYMENT_ON_HOLD");
  });
});

// ── The doors ─────────────────────────────────────────────────────────
//
// Every file that offers Pay Now, builds a pay link, sends the registration
// confirmation or opens a checkout is listed here with how it obeys the hold.
// A NEW file that does any of those fails this test until it is added: that is
// the point. Hiding a button in one place while another door still takes the
// money is what this rule replaced.

const SRC = join(process.cwd(), "src");

/** A file that names any of these is a pay door. */
const PAY_DOOR_MARKS = /buildPaymentReminderVars\(|registrationPaymentLink\(|sendRegistrationConfirmation\(|buildRegistrationPaymentBlock\(|\/checkout[`"]|checkout\.sessions\.create/;

type Door =
  /** Asks `authorPaymentOnHold` itself. */
  | { how: "asks" }
  /** A page or builder told the answer by its caller: must read the named input. */
  | { how: "told"; by: string }
  /** Cannot meet the abstract sign-up's registration. */
  | { how: "exempt"; why: string };

const DOORS: Record<string, Door> = {
  "app/api/public/events/[slug]/checkout/route.ts": { how: "asks" },
  "app/api/public/events/[slug]/complete-registration/route.ts": { how: "asks" },
  "app/api/registrant/registrations/[registrationId]/resend-confirmation/route.ts": { how: "asks" },
  "app/api/events/[eventId]/registrations/[registrationId]/email/route.ts": { how: "asks" },
  "lib/bulk-email.ts": { how: "asks" },
  "app/e/[slug]/confirmation/page.tsx": { how: "told", by: "paymentOnHold" },
  "app/e/[slug]/my-registration/page.tsx": { how: "told", by: "paymentOnHold" },
  "lib/payment-reminder.ts": { how: "told", by: "onHold" },
  "lib/email.ts": { how: "told", by: "suppressPayNow" },
  "services/registration-service.ts": { how: "told", by: "suppressPayNow" },
  "app/api/public/events/[slug]/register/route.ts": {
    how: "exempt",
    why: "the public registration form makes PUBLIC_REGISTER rows, never the abstract sign-up's",
  },
  "app/api/public/events/[slug]/group-checkout/route.ts": {
    how: "exempt",
    why: "pays a company's group invoice; an author's registration is never in a group",
  },
};

/** Doors that decide the hold for a page without naming a pay link themselves. */
const DECIDERS = [
  "app/api/public/events/[slug]/payment-status/[registrationId]/route.ts",
  "app/api/registrant/registrations/route.ts",
  "app/(dashboard)/my-account/page.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const read = (relative: string) => readFileSync(join(SRC, relative), "utf8");

describe("every pay door obeys the author hold", () => {
  const found = sourceFiles(SRC)
    .filter((path) => PAY_DOOR_MARKS.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(SRC.length + 1))
    .sort();

  it("the list is every pay door in the code, no more and no fewer", () => {
    expect(found).toEqual(Object.keys(DOORS).sort());
  });

  it.each(Object.entries(DOORS).filter(([, d]) => d.how === "asks"))("%s asks the rule", (file) => {
    expect(read(file)).toContain("authorPaymentOnHold(");
  });

  it.each(Object.entries(DOORS).filter(([, d]) => d.how === "told"))("%s reads what its caller decided", (file, door) => {
    expect(read(file)).toContain((door as { by: string }).by);
  });

  it.each(Object.entries(DOORS).filter(([, d]) => d.how === "exempt"))("%s is exempt, with a reason", (_file, door) => {
    expect((door as { why: string }).why.length).toBeGreaterThan(20);
  });

  it.each(DECIDERS)("%s decides it on the server", (file) => {
    expect(read(file)).toContain("authorPaymentOnHold(");
  });

  it("the two callers that build a reminder both pass the hold", () => {
    for (const file of ["app/api/events/[eventId]/registrations/[registrationId]/email/route.ts", "lib/bulk-email.ts"]) {
      expect(read(file)).toMatch(/onHold: authorPaymentOnHold\(/);
    }
  });

  it("every sender of the registration confirmation outside the service passes the hold", () => {
    for (const file of [
      "app/api/public/events/[slug]/complete-registration/route.ts",
      "app/api/registrant/registrations/[registrationId]/resend-confirmation/route.ts",
      "app/api/events/[eventId]/registrations/[registrationId]/email/route.ts",
      "lib/bulk-email.ts",
    ]) {
      expect(read(file)).toMatch(/suppressPayNow: authorPaymentOnHold\(/);
    }
  });

  it("the pages never read the event's settings to decide it: the server answers", () => {
    for (const file of ["app/e/[slug]/confirmation/page.tsx", "app/e/[slug]/my-registration/page.tsx"]) {
      expect(read(file)).not.toContain("authorPaymentOnHold(");
      expect(read(file)).not.toContain("presenterRegistration");
    }
  });

  it("the checkout refuses with the hold's code, after the settled and group answers", () => {
    const checkout = read("app/api/public/events/[slug]/checkout/route.ts");
    const hold = checkout.indexOf("authorPaymentOnHold(registration");
    expect(hold).toBeGreaterThan(checkout.indexOf("NO_PAYMENT_DUE_STATUSES.includes"));
    expect(hold).toBeGreaterThan(checkout.indexOf("COVERED_BY_GROUP"));
    // Before any Stripe work.
    expect(hold).toBeLessThan(checkout.indexOf("sessions.create"));
    expect(checkout).toContain("AUTHOR_PAYMENT_HOLD_CODE");
  });
});
