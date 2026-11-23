/**
 * Images inside an email body reach the mailbox (Nov 23, 2026).
 *
 * Owner: "in organizer signature, logo is not visible". The editor saves an
 * image uploaded to our own library with a site-relative address
 * (`/uploads/media/...`). That shows in the app and points nowhere in a
 * mailbox. The header and footer images were resolved to the site's full
 * address; the images inside a body never were, so every signature logo sent
 * from the CRM since October (13 emails) was a broken picture.
 *
 * And a signature's logo must not be treated as a banner: the body rule
 * stretches every image to 600px, which would have made the 135px logo four
 * times its size the moment its address was fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBodyImages, renderAndWrap, signatureHtmlForEmail } from "@/lib/email";

const SITE = "https://events.example.test";
const LOGO = '<img src="/uploads/media/2026/10/9820a583.png">';
let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = `${SITE}/`;
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedUrl;
});

describe("a site-relative image address becomes the site's full address", () => {
  it("for an image in the body", () => {
    expect(normalizeBodyImages(`<p>hi</p>${LOGO}`)).toContain(`src="${SITE}/uploads/media/2026/10/9820a583.png"`);
  });

  it("with single quotes too, and with other attributes before the address", () => {
    expect(normalizeBodyImages("<img alt='x' src='/uploads/a.png' />")).toContain(`src='${SITE}/uploads/a.png'`);
  });

  it("and leaves every other kind of address alone", () => {
    for (const src of ["https://cdn.test/a.png", "http://x.test/a.png", "//cdn.test/a.png", "data:image/png;base64,AAAA", "a.png"]) {
      expect(normalizeBodyImages(`<img src="${src}" />`), src).toContain(`src="${src}"`);
    }
    expect(normalizeBodyImages('<img src="cid:logo@x" />')).toBe('<img src="cid:logo@x" />');
  });

  it("is the same on a second pass", () => {
    const once = normalizeBodyImages(`${LOGO}${signatureHtmlForEmail(LOGO)}`);
    expect(normalizeBodyImages(once)).toBe(once);
  });
});

describe("a signature's image keeps its own size", () => {
  it("is not stretched to the body's 600px, and gets the full address", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail(`<p>Sohail</p>${LOGO}`));
    expect(out).toContain(`src="${SITE}/uploads/media/2026/10/9820a583.png"`);
    expect(out).not.toMatch(/width="600"/);
    expect(out).not.toMatch(/[^-]width: 100%/);
    expect(out).toContain("max-width: 100%");
    expect(out).toContain('border="0"');
  });

  it("keeps a width the author gave it", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" width="120" height="76" style="float:left">'));
    expect(out).toContain('width="120"');
    expect(out).toContain('height="76"');
    expect(out).not.toContain("float");
  });

  it("while a banner in the same body is still fitted to 600px", () => {
    const out = normalizeBodyImages(`<img src="/uploads/banner.png" width="2000">${signatureHtmlForEmail(LOGO)}`);
    const [banner, logo] = out.match(/<img[^>]*>/g)!;
    expect(banner).toContain('width="600"');
    expect(banner).not.toContain('width="2000"');
    expect(logo).not.toContain('width="600"');
  });

  it("marks each image once, and nothing else", () => {
    const marked = signatureHtmlForEmail(`<p>Regards</p>${LOGO}${LOGO}`);
    expect(marked.match(/data-keep-size="1"/g)?.length).toBe(2);
    expect(signatureHtmlForEmail(marked)).toBe(marked);
    expect(signatureHtmlForEmail("<p>no picture</p>")).toBe("<p>no picture</p>");
    expect(signatureHtmlForEmail(null)).toBe("");
    expect(signatureHtmlForEmail(undefined)).toBe("");
  });
});

describe("every email that carries a signature", () => {
  it("an event email: {{organizerSignature}} goes out with its logo addressed and at its own size", () => {
    const { htmlContent } = renderAndWrap(
      { subject: "s", htmlContent: '<p>Body</p><img src="/uploads/banner.png">{{organizerSignature}}', textContent: "t" },
      { organizerSignature: `<p>Sohail</p>${LOGO}` },
      {},
      new Set(["organizerSignature"]),
    );
    const images = htmlContent.match(/<img[^>]*>/g)!;
    expect(images).toHaveLength(2);
    expect(images[0]).toContain(`src="${SITE}/uploads/banner.png"`);
    expect(images[0]).toContain('width="600"');
    expect(images[1]).toContain(`src="${SITE}/uploads/media/2026/10/9820a583.png"`);
    expect(images[1]).not.toContain('width="600"');
  });

  it("a CRM email: the service marks the sender's signature before it is placed", () => {
    const service = readFileSync(join(process.cwd(), "src/crm/services/sponsor-email-service.ts"), "utf8");
    expect(service).toContain("signatureHtml: signatureHtmlForEmail(sender?.emailSignature)");
    // The one place the CRM reads the stored signature.
    expect(service.match(/emailSignature/g)?.length).toBe(2);
  });
});
