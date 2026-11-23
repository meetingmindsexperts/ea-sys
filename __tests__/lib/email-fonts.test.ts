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
  emailFontFiles,
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

  it("reads the first family however it is quoted: hand-written and pasted HTML, not only the editor's", () => {
    const families = (style: string) => webFontsUsedIn(`<p ${style}>x</p>`).map((f) => f.family);
    expect(families(`style='font-family: "Inter", Arial'`)).toEqual(["Inter"]);
    expect(families('style="font-family: &quot;Open Sans&quot;, Arial"')).toEqual(["Open Sans"]);
    expect(families(`style="font-family:'Montserrat',sans-serif"`)).toEqual(["Montserrat"]);
    expect(families('style="FONT-FAMILY: INTER"')).toEqual(["Inter"]);
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
    // Two rules a font: its Latin file and its extended-Latin file.
    expect(html.match(/@font-face/g)?.length).toBe(2);
    expect(html.match(/font-family: 'Open Sans'; font-style/g)?.length).toBe(2);
    expect(html).toContain(`url('${SITE}/email-fonts/open-sans-latin-wght-normal.woff2') format('woff2')`);
    expect(emailFontFaceBlock("<p>plain</p>", SITE)).toContain("font-family: 'Open Sans'");
  });

  it("adds a chosen font beside it, from our own address, and no other", () => {
    const html = wrapWithBranding(span("Inter, Verdana, Geneva, sans-serif"), {});
    expect(html.match(/@font-face/g)?.length).toBe(4);
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
    expect(htmlContent.match(/@font-face/g)?.length).toBe(4);
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

/** Every .tsx file under src, with its text. */
function tsxSources(dir = join(process.cwd(), "src")): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxSources(full));
    else if (entry.endsWith(".tsx")) out.push({ file: full.slice(process.cwd().length + 1), source: readFileSync(full, "utf8") });
  }
  return out;
}

describe("every email editor offers the fonts, and nothing else does", () => {
  // An email editor is one that cleans pasted styles (`cleanPastedStyles`). The fonts are declared
  // for EMAILS (the sender adds them; a public page does not), so page-content editors stay without.
  const editors = tsxSources().flatMap(({ file, source }) => {
    // To the tag's own "/>", not the first ">": a prop such as onChange={(v) => ...} holds one.
    return [...source.matchAll(/<TiptapEditor\b[\s\S]*?\/>/g)].map((m) => ({ file, tag: m[0] }));
  });

  it("finds the editors (not testing nothing)", () => {
    expect(editors.length).toBeGreaterThanOrEqual(15);
    expect(editors.filter((e) => /\bcleanPastedStyles\b/.test(e.tag)).length).toBeGreaterThanOrEqual(7);
  });

  it.each(editors.map((e) => [`${e.file}: ${e.tag.replace(/\s+/g, " ").slice(0, 70)}`, e] as const))("%s", (_label, e) => {
    expect(/\bfontControls\b/.test(e.tag)).toBe(/\bcleanPastedStyles\b/.test(e.tag));
  });
});

describe("the editor keeps and states what it offers", () => {
  const editor = readFileSync(join(process.cwd(), "src/components/ui/tiptap-editor.tsx"), "utf8");

  it("registers the font and size attributes exactly when the menus are on", () => {
    // Without the extension the editor drops both on load: the menus would set what a reload loses.
    expect(editor).toContain("...(fontControls ? [FontStyle] : [])");
    expect(editor).toContain("{fontControls && <FontControls editor={editor} defaultSize={defaultFontSize} />}");
    expect(editor).toContain("{fontControls && <FontDefaultsNote defaultSize={defaultFontSize} />}");
  });

  it("the Email Footer editor states the footer's own size, the one the sender writes", () => {
    const settings = readFileSync(join(process.cwd(), "src/app/(dashboard)/events/[eventId]/settings/page.tsx"), "utf8");
    const footerEditor = settings.slice(settings.indexOf("<Label>Email Footer</Label>"));
    expect(footerEditor.slice(0, footerEditor.indexOf("/>"))).toContain('defaultFontSize="12px"');
    // The footer cell of every email: the same 12px.
    expect(wrapWithBranding("<p>x</p>", {})).toMatch(/<td style="text-align: center;[^"]*font-size: 12px;">/);
  });

  it("no other editor claims a size of its own: they all go out at the body's 14px", () => {
    const withOwnSize = tsxSources().filter((f) => f.source.includes("defaultFontSize=") && !f.file.endsWith("tiptap-editor.tsx"));
    expect(withOwnSize.map((f) => f.file)).toEqual(["src/app/(dashboard)/events/[eventId]/settings/page.tsx"]);
  });
});

describe("letters beyond basic Latin (review of 9a0199bf7)", () => {
  // The first files held Latin only: the ğ of "Doğan" and the Ł of "Łukasz" showed in the
  // fallback font in the middle of a name, on exactly the mail apps that load the font.
  const inRange = (range: string, char: string) => {
    const code = char.codePointAt(0)!;
    return range.split(",").some((part) => {
      const [from, to] = part.replace("U+", "").split("-");
      return code >= parseInt(from!, 16) && code <= parseInt(to ?? from!, 16);
    });
  };

  it("each web font has a Latin file and an extended-Latin file, and Verdana has none", () => {
    for (const f of EMAIL_FONTS.filter((x) => x.file)) {
      expect(emailFontFiles(f).map((x) => x.file), f.label).toEqual([f.file, f.file!.replace("-latin-", "-latin-ext-")]);
    }
    expect(emailFontFiles(EMAIL_FONTS.find((f) => f.family === "Verdana")!)).toEqual([]);
  });

  it("between them the two files hold the letters of Turkish, Polish, Czech and Hungarian names", () => {
    const [latin, ext] = emailFontFiles(EMAIL_DEFAULT_FONT);
    for (const char of "AzéüñçÖ€") expect(inRange(latin!.unicodeRange, char), char).toBe(true);
    for (const char of "ğşİıŁłčřőűżđ") expect(inRange(latin!.unicodeRange, char) || inRange(ext!.unicodeRange, char), char).toBe(true);
    // And the second file is what brings them: without it most are not covered.
    expect([..."ğşŁłčřőű"].every((char) => !inRange(latin!.unicodeRange, char))).toBe(true);
  });

  it("Vietnamese, Greek and Cyrillic are in neither file: those letters show in the fallback font (stated, not hidden)", () => {
    const [latin, ext] = emailFontFiles(EMAIL_DEFAULT_FONT);
    for (const char of "ắβж") expect(inRange(latin!.unicodeRange, char) || inRange(ext!.unicodeRange, char), char).toBe(false);
  });

  it("each declared rule says which characters its file holds, so a mail app fetches only what an email uses", () => {
    const block = emailFontFaceBlock("<p>Doğan</p>", SITE);
    const rules = block.match(/@font-face \{[^}]*\}/g)!;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain("open-sans-latin-wght-normal.woff2");
    expect(rules[1]).toContain("open-sans-latin-ext-wght-normal.woff2");
    for (const rule of rules) expect(rule).toMatch(/unicode-range: U\+[0-9A-F]/);
  });

  it("the editor's own stylesheet declares the same files with the same ranges", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const f of EMAIL_FONTS.filter((x) => x.file)) {
      for (const file of emailFontFiles(f)) {
        const at = css.indexOf(`/email-fonts/${file.file}`);
        expect(at, file.file).toBeGreaterThan(-1);
        expect(css.slice(at, css.indexOf("}", at)), file.file).toContain(`unicode-range: ${file.unicodeRange};`);
      }
    }
  });
});

describe("the font files", () => {
  const dir = join(process.cwd(), "public/email-fonts");

  it("every file of every web font is in the project, and is a WOFF2 font", () => {
    const files = EMAIL_FONTS.flatMap((f) => emailFontFiles(f));
    expect(files).toHaveLength(6);
    for (const f of files) {
      const file = join(dir, f.file);
      expect(existsSync(file), f.file).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString("latin1"), f.file).toBe("wOF2");
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
