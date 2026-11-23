/**
 * The fonts an email's author may choose (Nov 23, 2026).
 *
 * Three of the four are web fonts a mail app must download; Outlook and Gmail
 * will not. What matters and is pinned here:
 *  1. every offered font is a stack that ends in Verdana, so a recipient whose
 *     mail app loads nothing sees Verdana, never a serif surprise;
 *  2. an email declares only the web fonts it uses, from OUR address, and an
 *     email that uses none goes out byte for byte as before;
 *  3. the declaration is hidden from Outlook on Windows, which otherwise sets
 *     the whole text in Times New Roman, and it survives the CSS inliner;
 *  4. the files are in the project and are real fonts, and are served with the
 *     header a cross-origin font fetch needs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EMAIL_DEFAULT_FONT,
  EMAIL_DEFAULT_FONT_SIZE,
  EMAIL_FONTS,
  EMAIL_FONT_SIZES,
  emailFontFaceBlock,
  emailFontFor,
  storedFontFamily,
  storedFontSize,
  webFontsUsedIn,
} from "@/lib/email-fonts";
import { inlineCss, renderAndWrap, wrapWithBranding } from "@/lib/email";

const SITE = "https://events.example.test";
let savedUrl: string | undefined;
beforeEach(() => {
  savedUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = SITE;
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedUrl;
});

const span = (stack: string, text = "Hello") => `<p><span style="font-family: ${stack}">${text}</span></p>`;

describe("the offered fonts", () => {
  it("are the four the owner asked for, Montserrat standing in for Mont", () => {
    expect(EMAIL_FONTS.map((f) => f.label)).toEqual(["Montserrat", "Verdana", "Inter", "Open Sans"]);
  });

  it("every one falls back to Verdana, then a generic sans-serif", () => {
    for (const f of EMAIL_FONTS) expect(f.stack, f.label).toMatch(/Verdana, Geneva, sans-serif$/);
  });

  it("can sit inside a double-quoted style attribute: no double quote in any stack", () => {
    for (const f of EMAIL_FONTS) expect(f.stack, f.label).not.toContain('"');
  });

  it("the sizes are plain pixel lengths, smallest first", () => {
    expect(EMAIL_FONT_SIZES.every((s) => /^\d+px$/.test(s))).toBe(true);
    expect([...EMAIL_FONT_SIZES].sort((a, b) => parseInt(a) - parseInt(b))).toEqual([...EMAIL_FONT_SIZES]);
  });
});

describe("reading a font back from HTML", () => {
  it("knows an offered font however the browser quoted it, and stores our own stack", () => {
    expect(emailFontFor('"Open Sans", Verdana, Geneva, sans-serif')?.label).toBe("Open Sans");
    expect(storedFontFamily('"Open Sans", Verdana, Geneva, sans-serif')).toBe("'Open Sans', Verdana, Geneva, sans-serif");
    expect(storedFontFamily("inter")).toBe("Inter, Verdana, Geneva, sans-serif");
  });

  it("keeps a font it does not offer, made safe for a style attribute", () => {
    expect(emailFontFor("Calibri, sans-serif")).toBeNull();
    expect(storedFontFamily('"Comic Sans MS", cursive')).toBe("'Comic Sans MS', cursive");
    expect(storedFontFamily("  ")).toBeNull();
    expect(storedFontFamily(null)).toBeNull();
  });

  it("keeps a plain size and drops anything that is not one", () => {
    expect(storedFontSize("18px")).toBe("18px");
    expect(storedFontSize(" 11PT ")).toBe("11pt");
    expect(storedFontSize("large")).toBeNull();
    expect(storedFontSize("calc(1px + 1em)")).toBeNull();
    expect(storedFontSize("18px; color: red")).toBeNull();
    expect(storedFontSize(undefined)).toBeNull();
  });
});

describe("which web fonts an email uses", () => {
  it("finds each one once, in the list's order, and never Verdana", () => {
    const html = span("Inter, Verdana, Geneva, sans-serif") + span("Verdana, Geneva, sans-serif") + span("Montserrat, Verdana, Geneva, sans-serif") + span("Inter, Verdana, Geneva, sans-serif");
    expect(webFontsUsedIn(html).map((f) => f.family)).toEqual(["Montserrat", "Inter"]);
  });

  it("is not fooled by the name in the text, or as a fallback further down a stack", () => {
    expect(webFontsUsedIn("<p>We set this in Inter and Montserrat.</p>")).toEqual([]);
    expect(webFontsUsedIn(span("Georgia, Inter, serif"))).toEqual([]);
  });
});

describe("the default every email goes out in (owner, Nov 23, 2026)", () => {
  it("is Open Sans at 14px, one of the offered fonts and sizes", () => {
    expect(EMAIL_DEFAULT_FONT.label).toBe("Open Sans");
    expect(EMAIL_DEFAULT_FONT_SIZE).toBe("14px");
    expect(EMAIL_FONTS).toContain(EMAIL_DEFAULT_FONT);
    expect(EMAIL_FONT_SIZES).toContain(EMAIL_DEFAULT_FONT_SIZE);
  });

  it("is written on the body and on the email's own content cell, so Outlook reads it too", () => {
    const html = wrapWithBranding("<p>plain</p>", {});
    const stack = "font-family: 'Open Sans', Verdana, Geneva, sans-serif; font-size: 14px;";
    expect(html).toMatch(new RegExp(`<body style="[^"]*${stack.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(html).toContain(`<td style="padding: 24px 30px; ${stack}">`);
    // The old device-by-device font is gone.
    expect(html).not.toContain("-apple-system");
    expect(html).not.toContain("Segoe UI");
  });

  it("keeps the footer's own small size, in the same font", () => {
    const html = wrapWithBranding("<p>plain</p>", {});
    expect(html).toContain("font-family: 'Open Sans', Verdana, Geneva, sans-serif; font-size: 12px;");
  });

  it("is never written onto the author's own text: a font or size they set wins by sitting inside", () => {
    const { htmlContent } = renderAndWrap(
      { subject: "s", htmlContent: '<div style="font-family: Georgia, serif; font-size: 18px"><p>Set by the author</p></div>', textContent: "t" },
      {},
      {},
    );
    // The paragraph inside the author's block gets the margin rule and nothing about fonts.
    expect(htmlContent).toMatch(/<p style="margin: 0 0 8px 0;?">Set by the author<\/p>/);
    expect(htmlContent).toMatch(/<div style="font-family: Georgia, serif; font-size: 18px;?">/);
  });
});

describe("the declaration a sent email carries", () => {
  it("always declares the default font, and only it for an email that chooses none", () => {
    const html = wrapWithBranding(`<p>plain</p>${span("Verdana, Geneva, sans-serif")}`, {});
    expect(html.match(/@font-face/g)?.length).toBe(1);
    expect(html).toContain(`url('${SITE}/email-fonts/open-sans-latin-wght-normal.woff2') format('woff2')`);
    expect(emailFontFaceBlock("<p>plain</p>", SITE)).toContain("font-family: 'Open Sans'");
  });

  it("adds a chosen font beside it, from our own address, and no other", () => {
    const html = wrapWithBranding(span("Inter, Verdana, Geneva, sans-serif"), {});
    expect(html.match(/@font-face/g)?.length).toBe(2);
    expect(html).toContain(`url('${SITE}/email-fonts/inter-latin-wght-normal.woff2') format('woff2')`);
    expect(html).not.toContain("montserrat-latin");
  });

  it("is hidden from Outlook on Windows, in the head", () => {
    const html = wrapWithBranding(span("Inter, Verdana, Geneva, sans-serif"), {});
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const open = head.indexOf("<!--[if !mso]><!-->");
    const close = head.indexOf("<!--<![endif]-->");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const face = head.indexOf("@font-face");
    expect(face).toBeGreaterThan(open);
    expect(face).toBeLessThan(close);
  });

  it("survives the CSS inliner: the declaration, its Outlook guard and the text's own stack", () => {
    const { htmlContent } = renderAndWrap(
      { subject: "s", htmlContent: "{{message}}", textContent: "t" },
      { message: span("Montserrat, Verdana, Geneva, sans-serif", "Dear Sara") },
      {},
      new Set(["message"]),
    );
    expect(htmlContent.match(/@font-face/g)?.length).toBe(2);
    expect(htmlContent).toContain(`${SITE}/email-fonts/montserrat-latin-wght-normal.woff2`);
    expect(htmlContent.indexOf("<!--[if !mso]><!-->")).toBeLessThan(htmlContent.indexOf("@font-face"));
    expect(htmlContent.lastIndexOf("@font-face")).toBeLessThan(htmlContent.indexOf("<!--<![endif]-->"));
    // One guard, opened once and closed once.
    expect(htmlContent.match(/\[if !mso\]/g)?.length).toBe(1);
    expect(htmlContent).toMatch(/<span style="font-family: Montserrat, Verdana, Geneva, sans-serif;?">Dear Sara<\/span>/);
    // The paragraph rule is still inlined as before.
    expect(inlineCss("<style>p{margin:0 0 8px 0}</style><p>x</p>")).toContain('style="margin: 0 0 8px 0;"');
  });
});

describe("every email editor offers the fonts, and nothing else does", () => {
  // An email editor is one that cleans pasted styles (`cleanPastedStyles`). The fonts are declared
  // for EMAILS (the sender adds them; a public page does not), so page-content editors stay without.
  function tsxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
      else if (entry.endsWith(".tsx")) out.push(full);
    }
    return out;
  }
  const editors = tsxFiles(join(process.cwd(), "src")).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/<TiptapEditor\b[^>]*?\/?>/g)].map((m) => ({ file: file.slice(process.cwd().length + 1), tag: m[0] }));
  });

  it("finds the editors (not testing nothing)", () => {
    expect(editors.length).toBeGreaterThanOrEqual(15);
    expect(editors.filter((e) => /\bcleanPastedStyles\b/.test(e.tag)).length).toBeGreaterThanOrEqual(7);
  });

  it.each(editors.map((e) => [`${e.file}: ${e.tag.replace(/\s+/g, " ").slice(0, 70)}`, e] as const))("%s", (_label, e) => {
    expect(/\bfontControls\b/.test(e.tag)).toBe(/\bcleanPastedStyles\b/.test(e.tag));
  });
});

describe("the font files", () => {
  const dir = join(process.cwd(), "public/email-fonts");

  it("every web font's file is in the project, and is a WOFF2 font", () => {
    const web = EMAIL_FONTS.filter((f) => f.file);
    expect(web).toHaveLength(3);
    for (const f of web) {
      const file = join(dir, f.file!);
      expect(existsSync(file), f.file!).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString("latin1"), f.file!).toBe("wOF2");
    }
  });

  it("each ships with its licence (the SIL Open Font License asks for it)", () => {
    for (const name of ["inter", "open-sans", "montserrat"]) {
      expect(readFileSync(join(dir, `${name}-LICENSE.txt`), "utf8")).toContain("SIL Open Font License");
    }
  });

  it("are served with the header a font fetched from another origin needs", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    const rule = config.slice(config.indexOf('source: "/email-fonts/:file*"'));
    expect(rule.indexOf('key: "Access-Control-Allow-Origin", value: "*"')).toBeGreaterThan(-1);
    expect(rule.indexOf("Access-Control-Allow-Origin")).toBeLessThan(rule.indexOf("source:", 10));
  });
});
