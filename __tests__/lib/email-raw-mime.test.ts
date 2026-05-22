/**
 * Unit tests for buildRawMime — the SES raw-MIME envelope builder.
 *
 * MIME framing is fiddly and breaks silently (a misplaced boundary or a
 * missing Content-ID makes the barcode vanish in the recipient's inbox),
 * so we pin the structure:
 *   1. Inline attachments (contentId set) → wrapped in multipart/related
 *      with `Content-ID: <id>` + `Content-Disposition: inline`, so the
 *      HTML's `cid:` reference resolves.
 *   2. Regular attachments (no contentId) → `Content-Disposition: attachment`,
 *      no multipart/related.
 *   3. Mixed (inline + regular together) → related wraps body + inline image;
 *      the regular attachment hangs off the outer multipart/mixed.
 *   4. The plain-text alternative is preserved.
 */

import { describe, it, expect } from "vitest";
import { buildRawMime, type SendEmailParams } from "@/lib/email";

const FROM = "Events <events@example.com>";

function base(overrides: Partial<SendEmailParams> = {}): SendEmailParams {
  return {
    to: [{ email: "attendee@example.com", name: "Jane Doe" }],
    subject: "Your registration",
    htmlContent: '<p>Hello</p><img src="cid:reg-barcode" alt="barcode" />',
    textContent: "Hello",
    ...overrides,
  };
}

function decode(out: Uint8Array): string {
  return new TextDecoder().decode(out);
}

describe("buildRawMime — inline (cid) attachments", () => {
  it("wraps body + inline image in multipart/related with Content-ID + inline disposition", () => {
    const mime = decode(
      buildRawMime(
        base({
          attachments: [
            { name: "entry-barcode.png", content: "QkFTRTY0", contentType: "image/png", contentId: "reg-barcode" },
          ],
        }),
        FROM,
      ),
    );

    expect(mime).toContain("multipart/related");
    expect(mime).toContain("Content-ID: <reg-barcode>");
    expect(mime).toContain("Content-Disposition: inline; filename=\"entry-barcode.png\"");
    expect(mime).toContain("Content-Type: image/png");
    // The HTML body still references the cid.
    expect(mime).toContain('src="cid:reg-barcode"');
    // Plain-text alternative preserved.
    expect(mime).toContain('text/plain');
  });
});

describe("buildRawMime — regular (download) attachments", () => {
  it("uses attachment disposition and no multipart/related", () => {
    const mime = decode(
      buildRawMime(
        base({
          attachments: [
            { name: "quote.pdf", content: "JVBERi0=", contentType: "application/pdf" },
          ],
        }),
        FROM,
      ),
    );

    expect(mime).toContain("Content-Disposition: attachment; filename=\"quote.pdf\"");
    expect(mime).not.toContain("multipart/related");
    expect(mime).not.toContain("Content-ID:");
  });
});

describe("buildRawMime — mixed inline + regular", () => {
  it("nests inline image in related, keeps the regular attachment at the mixed level", () => {
    const mime = decode(
      buildRawMime(
        base({
          attachments: [
            { name: "entry-barcode.png", content: "QkFTRTY0", contentType: "image/png", contentId: "reg-barcode" },
            { name: "quote.pdf", content: "JVBERi0=", contentType: "application/pdf" },
          ],
        }),
        FROM,
      ),
    );

    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain("multipart/related");
    expect(mime).toContain("Content-ID: <reg-barcode>");
    expect(mime).toContain("Content-Disposition: inline; filename=\"entry-barcode.png\"");
    expect(mime).toContain("Content-Disposition: attachment; filename=\"quote.pdf\"");
  });
});

describe("buildRawMime — headers", () => {
  it("includes From / To / Subject / MIME-Version and the mixed boundary", () => {
    const mime = decode(
      buildRawMime(
        base({ attachments: [{ name: "x.png", content: "QQ==", contentType: "image/png", contentId: "x" }] }),
        FROM,
      ),
    );
    expect(mime).toContain(`From: ${FROM}`);
    expect(mime).toContain("To: Jane Doe <attendee@example.com>");
    expect(mime).toContain("Subject: Your registration");
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("Content-Type: multipart/mixed");
  });
});
