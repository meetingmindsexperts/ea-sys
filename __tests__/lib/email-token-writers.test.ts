/**
 * Who may assign a mapped email token by hand (docs/EMAIL_TOKEN_MAP_PLAN.md,
 * step 2). The three senders that let a person pair a template with an
 * audience take their token VALUES from the builders in email-token-values.ts,
 * so the same template reads the same from Communications and from one
 * person's record (the typed subject and note through applyTypedSubjectAndNote,
 * for all three). What each still assigns itself is listed here: links it
 * mints, blocks with an attachment, one email type's own blocks. A new `vars.<token> =` for a mapped token fails this
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
    "managementLink", "paymentBlock", "reviewLink", "rsvpButton", "rsvpLink", "rsvpName",
    "travelGrantBlock", "travelGrantBlockText",
  ],
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts": [
    "amount", "daysUntilEvent", "entryBarcode", "entryBarcodeText", "paymentBlock",
    "rsvpButton", "rsvpLink", "rsvpName",
  ],
  "src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts": [
    "agreementAttachment", "agreementBlock", "agreementBlockText", "agreementLink",
    "rsvpButton", "rsvpLink", "rsvpName",
  ],
};

/** What the `const vars = { ... }` initializer may hold at its top level: the builders, and a key that is the sender's own. */
const INITIALIZER: Record<string, string[]> = {
  "src/lib/bulk-email.ts": ["...everyAudienceTokenValues"],
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts": ["...everyAudienceTokenValues"],
  "src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts": ["...everyAudienceTokenValues", "...speakerTokenValues", "agreementLink"],
};

/** What may be merged into `vars` whole: a builder, or a helper that owns its tokens. */
const MERGED: Record<string, string[]> = {
  "src/lib/bulk-email.ts": ["abstractOwnVars", "presenter.vars", "registrationFormVars", "speakerTokenValues"],
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts": [],
  "src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts": ["presenter.vars"],
};

/** The top-level entries of the object literal that follows `marker`. */
function topLevelEntries(src: string, marker: string): string[] {
  const start = src.indexOf(marker);
  expect(start, `no "${marker}"`).toBeGreaterThan(-1);
  const entries: string[] = [];
  let depth = 0;
  for (const line of src.slice(start + marker.length).split("\n")) {
    const m = depth === 0 ? /^\s*(\.\.\.\w+|\w+)\s*[,:(]/.exec(line) : null;
    if (m) entries.push(m[1]);
    for (const c of line.replace(/\/\/.*$/, "")) {
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
    }
    if (depth < 0) break;
  }
  return entries;
}

describe("mapped email tokens are assigned by the shared builders", () => {
  it.each(Object.keys(OWN))("%s assigns by hand only what is its own", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    const assigned = [...new Set([...src.matchAll(/\bvars\.(\w+)\s*(?:\?\?)?=[^=]/g)].map((m) => m[1]))]
      .filter((k) => k in EMAIL_TOKEN_MAP)
      .sort();
    expect(assigned).toEqual(OWN[file]);
    // The same rule for the other ways to write a token in.
    expect(topLevelEntries(src, "const vars: Record<string, string | number> = {")).toEqual(INITIALIZER[file]);
    expect([...new Set([...src.matchAll(/Object\.assign\(\s*vars,\s*([\w.]+)/g)].map((m) => m[1]))].sort()).toEqual(MERGED[file]);
    // A literal key in brackets; a helper filling its own object by a loop is not one.
    expect(src).not.toMatch(/\bvars\[["'`]/);
  });
});
