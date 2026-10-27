/**
 * Reply threading headers (Oct 27, 2026, the CRM inbox reply): In-Reply-To and
 * References make a reply join the recipient's own conversation. The values
 * come from stored message ids, some of them written by OUTSIDE senders, so the
 * guard that matters is that nothing but a well-formed msg-id reaches a header.
 */
import { describe, it, expect } from "vitest";
import { buildRawMime, sesRfcMessageId, threadingHeaders, type SendEmailParams } from "@/lib/email";

const A = "<010901a17cfa8615-eb5c0541@ap-south-1.amazonses.com>";
const B = "<DX1P273MB1475A6B1@DX1P273MB1475.PROD.OUTLOOK.COM>";

describe("threadingHeaders", () => {
  it("emits In-Reply-To and the References chain", () => {
    expect(threadingHeaders({ inReplyTo: B, references: [A, B] })).toEqual([
      { name: "In-Reply-To", value: B },
      { name: "References", value: `${A} ${B}` },
    ]);
  });

  it("is empty without threading, or when the parent id is malformed", () => {
    expect(threadingHeaders(undefined)).toEqual([]);
    expect(threadingHeaders({ inReplyTo: "not-an-id", references: [A] })).toEqual([]);
  });

  it("never lets a stored id inject a header (CR/LF, spaces, extra brackets)", () => {
    const evil = "<a@b>\r\nBcc: victim@example.com";
    expect(threadingHeaders({ inReplyTo: evil, references: [] })).toEqual([]);
    const refs = threadingHeaders({ inReplyTo: A, references: [evil, "<x y@z>", "<<x@z>>", B] });
    expect(refs[1]).toEqual({ name: "References", value: `${B}` });
  });

  it("keeps the root and the newest ids under the length budget, however long the thread", () => {
    // Real SES ids are ~87 characters; 15 of them would pass the 998 limit.
    const ses = (i: number) => `<010901a17cfa86${String(i).padStart(2, "0")}-eb5c0541-2be4-4c5c-b331-188ced46a031-000000@ap-south-1.amazonses.com>`;
    const many = Array.from({ length: 15 }, (_, i) => ses(i));
    const value = threadingHeaders({ inReplyTo: ses(14), references: many })[1]!.value;
    expect(value.length).toBeLessThanOrEqual(900);
    const ids = value.split(" ");
    expect(ids[0]).toBe(ses(0)); // the conversation's root stays
    expect(ids[ids.length - 1]).toBe(ses(14)); // the newest stays
  });

  it("refuses ids with bytes a mail server rejects (non-ASCII, NUL, DEL)", () => {
    for (const bad of ["<ü@x.com>", "<a\u0000@x.com>", "<a\u007f@x.com>"]) {
      expect(threadingHeaders({ inReplyTo: bad, references: [] })).toEqual([]);
    }
  });
});

describe("buildRawMime with threading", () => {
  const base: SendEmailParams = {
    to: [{ email: "sponsor@example.com" }],
    subject: "Re: Sponsorship",
    htmlContent: "<p>Hi</p>",
    attachments: [{ name: "prospectus.pdf", content: "JVBERi0=", contentType: "application/pdf" }],
  };

  it("writes the headers among the message headers, before the body", () => {
    const mime = new TextDecoder().decode(
      buildRawMime({ ...base, threading: { inReplyTo: B, references: [A, B] } }, "Partnerships <p@x.com>"),
    );
    const head = mime.split("\r\n\r\n")[0]!;
    expect(head).toContain(`In-Reply-To: ${B}`);
    expect(head).toContain(`References: ${A} ${B}`);
  });

  it("adds nothing when there is no threading", () => {
    const mime = new TextDecoder().decode(buildRawMime(base, "Partnerships <p@x.com>"));
    expect(mime).not.toContain("In-Reply-To");
  });
});

describe("sesRfcMessageId", () => {
  it("is the Message-ID SES gives its emails", () => {
    expect(sesRfcMessageId("010901a17cfa8615-eb5c0541")).toMatch(/^<010901a17cfa8615-eb5c0541@[a-z0-9-]+\.amazonses\.com>$/);
  });
});
