/**
 * Who may assign a mapped email token by hand (docs/EMAIL_TOKEN_MAP_PLAN.md,
 * step 2). The three senders that let a person pair a template with an
 * audience take their token VALUES from the builders in email-token-values.ts,
 * so the same template reads the same from Communications and from one
 * person's record. What each still assigns itself is listed here: links it
 * mints, blocks with an attachment, the typed subject and note, one email
 * type's own blocks. A new `vars.<token> =` for a mapped token fails this
 * until it is added, which is the moment to ask whether it belongs in a
 * builder that every sender shares.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_TOKEN_MAP } from "@/lib/email-token-map";

const OWN: Record<string, string[]> = {
  "src/lib/bulk-email.ts": [
    "agreementBlock", "agreementBlockText", "agreementLink", "amount", "authorName", "entryBarcode", "entryBarcodeText",
    "managementLink", "message", "paymentBlock", "personalMessage", "reviewLink", "rsvpButton", "rsvpLink", "rsvpName",
    "subject", "travelGrantBlock", "travelGrantBlockText",
  ],
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts": [
    "amount", "daysUntilEvent", "entryBarcode", "entryBarcodeText", "message", "paymentBlock", "personalMessage",
    "rsvpButton", "rsvpLink", "rsvpName", "subject",
  ],
  "src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts": [
    "agreementAttachment", "agreementBlock", "agreementBlockText", "agreementLink", "message", "personalMessage",
    "rsvpButton", "rsvpLink", "rsvpName", "subject",
  ],
};

describe("mapped email tokens are assigned by the shared builders", () => {
  it.each(Object.keys(OWN))("%s assigns by hand only what is its own", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    expect(src).toContain("everyAudienceTokenValues(");
    const assigned = [...new Set([...src.matchAll(/\bvars\.(\w+)\s*=[^=]/g)].map((m) => m[1]))]
      .filter((k) => k in EMAIL_TOKEN_MAP)
      .sort();
    expect(assigned).toEqual(OWN[file]);
  });
});
