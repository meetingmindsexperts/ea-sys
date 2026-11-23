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
import {
  SIGNATURE_IMAGE_MAX_WIDTH,
  normalizeBodyImages,
  renderAndWrap,
  renderMessageValue,
  renderTemplate,
  signatureHtmlForEmail,
  wrapWithBranding,
} from "@/lib/email";

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
    expect(out).toContain('border="0"');
  });

  // Owner, Nov 23, 2026: "reduce the org signature logo max width to 150px", "only org signature".
  it("is never wider than 150px: an unsized image is capped by its style and keeps its own width below that", () => {
    expect(SIGNATURE_IMAGE_MAX_WIDTH).toBe(150);
    const out = normalizeBodyImages(signatureHtmlForEmail(LOGO));
    expect(out).toContain("max-width: 150px; height: auto;");
    // No width is invented for it: a 135px logo must not be drawn at 150.
    expect(out).not.toMatch(/\swidth="/);
  });

  it("keeps a width the author gave it when it is under the cap, as an attribute Outlook reads too", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" width="120" height="76" style="float:left">'));
    expect(out).toContain('width="120"');
    expect(out).toMatch(/style="width: 120px; max-width: 150px; height: auto;/);
    // The height follows the width, so the picture keeps its shape.
    expect(out).not.toContain("height=");
    expect(out).not.toContain("float");
  });

  it("brings a wider one down to the cap, whether the author sized it by attribute or in its style", () => {
    for (const img of ['<img src="/uploads/a.png" width="600" height="380">', '<img src="/uploads/a.png" style="width: 420px; height: 300px; max-width: 900px">']) {
      const out = normalizeBodyImages(signatureHtmlForEmail(img));
      expect(out, img).toContain('width="150"');
      expect(out, img).toMatch(/style="width: 150px; max-width: 150px; height: auto;/);
      expect(out, img).not.toMatch(/600|420|900|300px|380/);
    }
  });

  it("keeps a size the author set in the image's style", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" style="width: 135px; max-width: 900px; float: left">'));
    expect(out).toContain('width="135"');
    expect(out).toMatch(/style="width: 135px; max-width: 150px;/);
    expect(out).not.toContain("900px");
    expect(out).not.toContain("float");
  });

  // Review of 0a105c8f1: the forms only hand-written HTML has.
  it("does not read a percentage as pixels: the image counts as unsized", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" width="50%">'));
    expect(out).not.toMatch(/\swidth=/);
    expect(out).toContain('style="max-width: 150px; height: auto;');
  });

  it("clamps an unquoted width too, leaving one width attribute and not two", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail("<img src='/uploads/a.png' width=600 height=380>"));
    expect(out.match(/\swidth=/g)).toHaveLength(1);
    expect(out).toContain('width="150"');
    expect(out).not.toMatch(/600|380/);
  });

  it("keeps the height of an image the author sized by height alone", () => {
    const out = normalizeBodyImages(signatureHtmlForEmail('<img src="/uploads/a.png" style="height: 80px">'));
    expect(out).toContain('height="80"');
    expect(out).toMatch(/style="height: 80px; max-width: 150px; border: 0;/);
    expect(out).not.toMatch(/\swidth=/);
  });

  it("gives the same result on a second pass, sized or not", () => {
    for (const img of [LOGO, '<img src="/uploads/a.png" width="600">', '<img src="/uploads/a.png" width="120">', '<img src="/uploads/a.png" style="height: 80px">']) {
      const once = normalizeBodyImages(signatureHtmlForEmail(img));
      expect(normalizeBodyImages(once), img).toBe(once);
    }
  });

  it("an email's signature goes out capped end to end: the typed token and the template token alike", () => {
    const signature = `<p>Sohail</p>${LOGO}`;
    const { htmlContent } = renderAndWrap({ subject: "s", htmlContent: "<p>Body</p>{{organizerSignature}}", textContent: "t" }, { organizerSignature: signature }, {});
    const [logo] = htmlContent.match(/<img[^>]*>/g)!;
    expect(logo).toContain("max-width: 150px");
  });

  it("the cap is the signature's alone: a banner in the body is still fitted to 600px, not to 150", () => {
    const out = normalizeBodyImages('<img src="/uploads/banner.png">');
    expect(out).toContain('width="600"');
    expect(out).not.toContain("150px");
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
