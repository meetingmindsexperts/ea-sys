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
import { normalizeBodyImages, renderAndWrap, renderMessageValue, renderTemplate, signatureHtmlForEmail, wrapWithBranding } from "@/lib/email";

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

  it("rewrites the address itself, never a data-src beside it", () => {
    const out = normalizeBodyImages('<img data-src="/lazy.png" src="/uploads/a.png" />');
    expect(out).toContain('data-src="/lazy.png"');
    expect(out).toContain(`src="${SITE}/uploads/a.png"`);
  });

  it("gives the header and footer images the same base, with one slash", () => {
    const html = wrapWithBranding("<p>x</p>", { emailHeaderImage: "/uploads/h.png", emailFooterImage: "/uploads/f.png" });
    expect(html).toContain(`src="${SITE}/uploads/h.png"`);
    expect(html).toContain(`src="${SITE}/uploads/f.png"`);
    expect(html).not.toContain(`${SITE}//uploads`);
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

  it("keeps a size the author set in the image's style, and gives Outlook the width as an attribute", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" style="width: 135px; max-width: 900px; float: left">'));
    expect(out).toContain('width="135"');
    expect(out).toMatch(/style="width: 135px; max-width: 100%;/);
    expect(out).not.toContain("900px");
    expect(out).not.toContain("float");
  });

  it("only the mark itself counts: the words in an alt or a file name do not keep a banner from being fitted", () => {
    for (const img of ['<img alt="data-keep-size" src="/b.png">', '<img src="/uploads/data-keep-size.png">']) {
      expect(normalizeBodyImages(img), img).toContain('width="600"');
    }
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

  it("the token typed INSIDE the message (the compose box) is marked too", () => {
    // renderMessageValue places the signature before renderAndWrap ever sees it.
    const message = renderMessageValue("<p>Hello</p>{{organizerSignature}}", { organizerSignature: `<p>Sohail</p>${LOGO}` }, { isHtml: true });
    const { htmlContent } = renderAndWrap(
      { subject: "s", htmlContent: "{{message}}", textContent: "t" },
      { message, organizerSignature: `<p>Sohail</p>${LOGO}` },
      {},
      new Set(["message"]),
    );
    const [logo] = htmlContent.match(/<img[^>]*>/g)!;
    expect(logo).toContain(`src="${SITE}/uploads/media/2026/10/9820a583.png"`);
    expect(logo).not.toContain('width="600"');
  });

  it("a preview or a test send, which render and wrap by hand, shows what the send shows", () => {
    // email-preview and the template test send call these two directly.
    const body = renderTemplate("<p>Body</p>{{organizerSignature}}", { organizerSignature: LOGO });
    const [logo] = wrapWithBranding(body, {}).match(/<img[^>]*>/g)!;
    expect(logo).toContain(`src="${SITE}/uploads/media/2026/10/9820a583.png"`);
    expect(logo).not.toContain('width="600"');
  });

  it("the plain-text part is not given the mark", () => {
    const { textContent } = renderAndWrap({ subject: "s", htmlContent: "x", textContent: "{{organizerSignature}}" }, { organizerSignature: LOGO }, {});
    expect(textContent).not.toContain("data-keep-size");
  });

  it("a CRM email: the service marks the sender's signature as it loads it, for both of its slots", () => {
    const service = readFileSync(join(process.cwd(), "src/crm/services/sponsor-email-service.ts"), "utf8");
    expect(service).toMatch(/signatureHtml: signatureHtmlForEmail\(sender\?\.emailSignature\)/);
    // No second read of the stored signature that could skip the mark.
    expect(service.match(/\.emailSignature\b/g)?.length).toBe(1);
  });
});
