/**
 * A download named after text a person typed (an event's slug or code) must
 * not fail on a letter outside Latin-1 (Nov 12, 2026). Found on the local copy
 * of production: the certificate recipients CSV answered 500 for the event
 * whose slug is "AβTC2026", because `new Response` refuses such a header.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentDisposition } from "@/lib/download-filename";

describe("contentDisposition", () => {
  it("the failure it prevents: a raw non-Latin-1 name makes the response itself throw", () => {
    expect(() => new Response("", { headers: { "Content-Disposition": 'attachment; filename="certificate-recipients-AβTC2026.csv"' } })).toThrow(TypeError);
  });

  it("gives a header the response accepts, with a plain name and the real one", () => {
    const value = contentDisposition("certificate-recipients-AβTC2026.csv");
    const res = new Response("", { headers: { "Content-Disposition": value } });
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"certificate-recipients-A_TC2026.csv\"; filename*=UTF-8''certificate-recipients-A%CE%B2TC2026.csv",
    );
  });

  it("leaves a plain name as it was, so a page reading filename=\"...\" finds the same name as before", () => {
    const value = contentDisposition("hm2026-floor-plan-a3.pdf");
    expect(/filename="([^"]+)"/.exec(value)?.[1]).toBe("hm2026-floor-plan-a3.pdf");
    expect(value.endsWith("filename*=UTF-8''hm2026-floor-plan-a3.pdf")).toBe(true);
  });

  it("a quote or a backslash cannot close the name early", () => {
    const value = contentDisposition('a"b\\c.csv');
    expect(value.startsWith('attachment; filename="a_b_c.csv"; ')).toBe(true);
  });

  it("the encoded name holds only what RFC 5987 allows bare", () => {
    const encoded = contentDisposition("it's (a) *name*.csv").split("filename*=UTF-8''")[1];
    expect(encoded).toBe("it%27s%20%28a%29%20%2Aname%2A.csv");
  });

  it("an invoice number carrying an event code typed with a Greek letter, upper-cased as the settings form does", () => {
    const number = `${"AβTC2026".toUpperCase()}-INV-001`;
    expect(() => new Response("", { headers: { "Content-Disposition": `attachment; filename="${number}.pdf"` } })).toThrow(TypeError);
    const res = new Response("", { headers: { "Content-Disposition": contentDisposition(`${number}.pdf`) } });
    expect(res.headers.get("Content-Disposition")).toContain('filename="A_TC2026-INV-001.pdf"');
  });

  it("inline when asked", () => {
    expect(contentDisposition("x.pdf", "inline").startsWith("inline; ")).toBe(true);
  });
});

/**
 * Every download header in src/ (review of 7b2160d8). The first version of
 * this test looked for `.slug` / `.code` on the header's own line, and missed
 * three of the eight headers that commit fixed (a name built on an earlier
 * line) and four invoice PDFs whose invoice number carries the event's code.
 *
 * The rule now: a Content-Disposition that puts a VALUE into the name either
 * calls contentDisposition(), or its file is listed below with every value it
 * writes and why that value can only be plain characters. A new header, or a
 * new value in an old one, fails here until someone has looked at it.
 */
describe("every download header in src/", () => {
  const ID = "a database id, found in the database before the header is written";
  const DATE = "a date or a timestamp the server made";
  const SAFE_NAME = "made plain on an earlier line (non-word characters replaced)";
  const ALLOWED: Record<string, { values: string[]; why: string }> = {
    "src/app/api/invoices/export/route.ts": { values: ["name", "stamp"], why: `name is one of two literals; stamp is ${DATE}` },
    "src/app/api/registrant/registrations/[registrationId]/quote/route.ts": { values: ["filename"], why: "quote-pdf.ts: quote-<last 8 of the registration id>.pdf" },
    "src/app/api/public/events/[slug]/registrations/[registrationId]/document/route.ts": { values: ["filename"], why: "quote-pdf.ts: quote-<last 8 of the registration id>.pdf" },
    "src/app/api/registrant/certificates/[certificateId]/download/route.ts": { values: ["filename"], why: "the serial with everything but letters, digits, . _ - removed" },
    "src/app/api/contacts/export/route.ts": { values: ["Date.now()"], why: DATE },
    "src/app/api/crm/contacts/[crmContactId]/export/route.ts": { values: ["crmContactId"], why: ID },
    "src/app/api/crm/inbox/messages/[messageId]/attachments/[index]/route.ts": { values: ["disposition", "safeName"], why: SAFE_NAME },
    "src/app/api/crm/activity/export/route.ts": { values: ["stamp"], why: DATE },
    "src/app/api/crm/deals/[dealId]/documents/[documentId]/route.ts": { values: ["safeName"], why: SAFE_NAME },
    "src/app/api/crm/deals/export/route.ts": { values: ["stamp"], why: DATE },
    "src/app/api/logs/archive/route.ts": { values: ["file"], why: "matched against a strict file-name pattern first" },
    "src/app/api/procurement/suppliers/export/route.ts": { values: ["supplierExportFilename(now)"], why: DATE },
    "src/app/api/procurement/requests/[requestId]/quotes/[quoteId]/file/route.ts": { values: ["safeQuoteFileName(quote.fileName)"], why: "quote-file.ts keeps plain characters only" },
    "src/app/api/procurement/commitments/[commitmentId]/pdf/route.ts": { values: ["result.commitmentNo"], why: "PO-2026-0001: numbered by the server" },
    "src/app/api/procurement/budgets/[budgetId]/export/route.ts": { values: ["budgetExportFilename(b)"], why: "budget-export.ts keeps plain characters only" },
    "src/app/api/hr/attendance/route.ts": { values: ["parsed.data.from", "parsed.data.to"], why: "YYYY-MM-DD, by the request schema" },
    "src/app/api/events/[eventId]/webinar/chat/route.ts": { values: ["ctx.id"], why: ID },
    "src/app/api/events/[eventId]/webinar/attendance/route.ts": { values: ["event.id"], why: ID },
    "src/app/api/events/[eventId]/webinar/polls/[pollId]/export/route.ts": { values: ["pollId"], why: ID },
    "src/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/file/route.ts": { values: ["safeName"], why: SAFE_NAME },
    "src/app/api/events/[eventId]/reimbursements/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/events/[eventId]/certificates/preview/route.ts": { values: ["template.category.toLowerCase()", "template.id"], why: `an enum and ${ID}` },
    "src/app/api/events/[eventId]/reimbursements/[reimbursementId]/pdf/route.ts": { values: ["filename"], why: "reimbursementPdfFilename: ASCII only" },
    "src/app/api/events/[eventId]/reimbursements/[reimbursementId]/documents/[documentId]/route.ts": { values: ["safeName"], why: SAFE_NAME },
    "src/app/api/events/[eventId]/travel-grants/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/events/[eventId]/abstracts/route.ts": { values: ["args.eventId"], why: ID },
    "src/app/api/events/[eventId]/survey/responses/export/route.ts": { values: ["filename"], why: "sanitizeFilenameStem on every typed part" },
    "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route.ts": { values: ["fileSlug(campaign.name)"], why: "fileSlug keeps a-z, 0-9 and -" },
    "src/app/api/events/[eventId]/session-proposals/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/events/[eventId]/registrations/[registrationId]/supporting-document/route.ts": { values: ["safeName"], why: SAFE_NAME },
    "src/app/api/events/[eventId]/registrations/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/events/[eventId]/registrations/[registrationId]/quote/route.ts": { values: ["registration.id.slice(-8)"], why: ID },
    "src/app/api/events/[eventId]/registrations/badges/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/events/[eventId]/analytics/route.ts": { values: ["eventId"], why: ID },
    "src/app/api/blueprint/files/[id]/route.ts": {
      values: ['isInlineType(result.contentType) ? "inline" : "attachment"', "encodeURIComponent(result.name)"],
      why: "percent-encoded, so plain characters whatever the name",
    },
    "src/lib/email.ts": { values: ["sanitizeMimeFilename(att.name)"], why: "a MIME part inside an email body, not a response header" },
  };

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  const relative = (file: string) => file.slice(process.cwd().length + 1);

  /** Each header with the values it writes. A value on the next line counts (a wrapped literal). */
  const headers = files.flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.flatMap((line, i) => {
      const at = line.search(/content-disposition/i);
      if (at === -1 || file.endsWith("download-filename.ts")) return [];
      const rest = line.slice(at);
      const wrapped = /content-disposition["'`]?\s*[:,]?\s*$/i.test(rest);
      const text = wrapped ? `${rest} ${lines[i + 1] ?? ""}` : rest;
      const values = [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      return [{ file: relative(file), line: i + 1, text: text.trim(), values, usesHelper: /contentDisposition\(/.test(text) }];
    });
  });

  it("finds the headers at all (the scan is not silently empty)", () => {
    expect(headers.length).toBeGreaterThan(50);
    expect(headers.filter((h) => h.usesHelper).length).toBeGreaterThanOrEqual(14);
  });

  it("a header that writes a value calls contentDisposition, or every value is listed with its reason", () => {
    const unexplained = headers
      .filter((h) => !h.usesHelper && h.values.length > 0)
      .flatMap((h) => h.values.filter((v) => !ALLOWED[h.file]?.values.includes(v)).map((v) => `${h.file}:${h.line} writes \${${v}}`));
    expect(unexplained).toEqual([]);
  });

  it("a header's value is written where the header is set: a literal or the helper, never a variable built elsewhere", () => {
    // `"Content-Disposition": raw` or `.set("Content-Disposition", raw)` would
    // hide every value from the test above.
    const elsewhere = headers
      .map((h) => ({ h, value: /content-disposition["'`]\s*[:,]\s*(.*)$/i.exec(h.text)?.[1] }))
      .filter(({ value }) => value !== undefined && !/^(["'`]|contentDisposition\()/.test(value))
      .map(({ h }) => `${h.file}:${h.line} ${h.text}`);
    expect(elsewhere).toEqual([]);
  });

  it("the list holds nothing stale: every listed value is still written by its file", () => {
    const stale = Object.entries(ALLOWED).flatMap(([file, { values }]) =>
      values
        .filter((v) => !headers.some((h) => h.file === file && !h.usesHelper && h.values.includes(v)))
        .map((v) => `${file} no longer writes \${${v}}`),
    );
    expect(stale).toEqual([]);
  });

  it("nothing an organiser or a caller types is on the list: a slug, a code, an invoice number, a query value", () => {
    const typed = Object.entries(ALLOWED).flatMap(([file, { values }]) =>
      values.filter((v) => /\bslug\b|\bcode\b|invoiceNumber|groupId|searchParams/.test(v)).map((v) => `${file}: ${v}`),
    );
    expect(typed).toEqual([]);
  });

  it("the downloads named after a slug, a code or an invoice number go through the helper", () => {
    const using = [...new Set(headers.filter((h) => h.usesHelper).map((h) => h.file))].sort();
    expect(using).toEqual([
      "src/app/api/events/[eventId]/certificates/recipients/route.ts",
      "src/app/api/events/[eventId]/certificates/runs/[runId]/download/route.ts",
      "src/app/api/events/[eventId]/export-bundle/route.ts",
      "src/app/api/events/[eventId]/invoices/[invoiceId]/pdf/route.ts",
      "src/app/api/events/[eventId]/invoices/export/route.ts",
      "src/app/api/events/[eventId]/registrations/route.ts",
      "src/app/api/events/[eventId]/venue/plan-pdf/route.ts",
      "src/app/api/events/[eventId]/venue/room-sheet/route.ts",
      "src/app/api/public/events/[slug]/floor-plan/[token]/pdf/route.ts",
      "src/app/api/public/events/[slug]/registrations/[registrationId]/document/route.ts",
      "src/app/api/registrant/my-group/[groupId]/invoice/[invoiceId]/route.ts",
      "src/app/api/registrant/registrations/[registrationId]/invoices/[invoiceId]/pdf/route.ts",
      "src/lib/webinar/handout-download.ts",
    ]);
  });
});
