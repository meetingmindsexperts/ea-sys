/**
 * The fonts and sizes an email's author may choose (Nov 23, 2026; owner: "add
 * options for font family and font size", in every email editor).
 *
 * Client-safe: constants and string work only. The editor's toolbar reads the
 * lists, the editor's stylesheet shows the fonts, and the sender
 * (`wrapWithBranding` in email.ts) declares the ones an email uses.
 *
 * THE THING TO KNOW. Three of the four are WEB fonts: nobody has them
 * installed, so a mail app has to download them, and we serve the files
 * ourselves (`public/email-fonts/`, owner: "download and serve them from our
 * system"). Apple Mail and iPhone Mail download them. Outlook (Windows and the
 * web) and Gmail do not, and show the next font in the list instead. So every
 * web font here is written as a STACK that ends in Verdana, which every
 * computer has: a recipient sees the chosen font or Verdana, never a serif
 * surprise. Verdana itself needs no file.
 *
 * Montserrat stands in for Mont, the organisation's paid typeface, which has
 * no licensed web files in this project (owner's choice, Nov 23, 2026).
 */

export interface EmailFont {
  /** Shown in the toolbar. */
  label: string;
  /** The family name as CSS knows it. */
  family: string;
  /** What is written on the text: the family, then what to show without it. */
  stack: string;
  /** The file under /email-fonts/ a mail app downloads; null for a font every computer has. */
  file: string | null;
}

const FALLBACK = "Verdana, Geneva, sans-serif";

export const EMAIL_FONTS: readonly EmailFont[] = [
  { label: "Montserrat", family: "Montserrat", stack: `Montserrat, ${FALLBACK}`, file: "montserrat-latin-wght-normal.woff2" },
  { label: "Verdana", family: "Verdana", stack: FALLBACK, file: null },
  { label: "Inter", family: "Inter", stack: `Inter, ${FALLBACK}`, file: "inter-latin-wght-normal.woff2" },
  { label: "Open Sans", family: "Open Sans", stack: `'Open Sans', ${FALLBACK}`, file: "open-sans-latin-wght-normal.woff2" },
];

/** Sizes offered, in pixels: what every mail app reads the same way. */
export const EMAIL_FONT_SIZES: readonly string[] = ["12px", "14px", "16px", "18px", "20px", "24px", "28px"];

/**
 * What every email goes out in unless its author chooses otherwise (owner,
 * Nov 23, 2026: "make Open Sans the default for all emails and then 14px
 * body"). Until then an email named no font at all beyond the reader's own
 * system font, and no size, so the same email looked different on every
 * device. The sender writes these on the email's body and on its own table
 * cells (email.ts); text the author styled keeps its own.
 */
export const EMAIL_DEFAULT_FONT: EmailFont = EMAIL_FONTS.find((f) => f.family === "Open Sans")!;
export const EMAIL_DEFAULT_FONT_SIZE = "14px";
/** The default as an inline style, for the sender's wrapper. */
export const EMAIL_DEFAULT_TEXT_STYLE = `font-family: ${EMAIL_DEFAULT_FONT.stack}; font-size: ${EMAIL_DEFAULT_FONT_SIZE};`;

/** The public path the font files are served from (CORS open: next.config.ts). */
export const EMAIL_FONTS_PATH = "/email-fonts";

/** The first family named in a CSS `font-family` value, without quotes, lower case. */
function firstFamily(value: string): string {
  return (value.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

/** The offered font a CSS `font-family` value starts with, or null for any other font. */
export function emailFontFor(value: string | null | undefined): EmailFont | null {
  if (!value) return null;
  const first = firstFamily(value);
  return EMAIL_FONTS.find((f) => f.family.toLowerCase() === first) ?? null;
}

/**
 * A `font-family` read back from HTML, as the editor stores it: an offered
 * font becomes its own stack (a browser reads our stack back with its own
 * quoting), any other font is kept, with double quotes made single so it sits
 * safely inside a `style="..."` attribute. Null when there is none.
 */
export function storedFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return emailFontFor(trimmed)?.stack ?? trimmed.replace(/"/g, "'");
}

/** A `font-size` read back from HTML: a plain length is kept, anything else is dropped. */
export function storedFontSize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^\d+(\.\d+)?(px|pt|em|rem|%)$/.test(trimmed) ? trimmed : null;
}

/** The web fonts an email's HTML asks for, in the list's order. */
export function webFontsUsedIn(html: string): EmailFont[] {
  const used = new Set<string>();
  for (const m of html.matchAll(/font-family\s*:\s*([^;"<>]+)/gi)) {
    const font = emailFontFor(m[1]);
    if (font?.file) used.add(font.family);
  }
  return EMAIL_FONTS.filter((f) => used.has(f.family));
}

/** One `@font-face` rule. The files are variable fonts: one file carries every weight. */
export function emailFontFaceRule(font: EmailFont, base: string): string {
  return `@font-face { font-family: '${font.family}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('${base}${EMAIL_FONTS_PATH}/${font.file}') format('woff2'); }`;
}

/**
 * The block that declares an email's web fonts: the default font always (the
 * whole email is set in it), then any other the author chose.
 *
 * Wrapped so OUTLOOK ON WINDOWS NEVER SEES IT (`<!--[if !mso]><!-->`): shown a
 * declared web font it cannot load, that Outlook drops the whole stack and
 * sets the text in Times New Roman. Without the declaration it reads the
 * stack and lands on Verdana.
 */
export function emailFontFaceBlock(html: string, base: string): string {
  const chosen = new Set(webFontsUsedIn(html).map((f) => f.family));
  const fonts = EMAIL_FONTS.filter((f) => f.file && (f.family === EMAIL_DEFAULT_FONT.family || chosen.has(f.family)));
  const rules = fonts.map((f) => emailFontFaceRule(f, base)).join("\n    ");
  return `<!--[if !mso]><!-->\n  <style>\n    ${rules}\n  </style>\n  <!--<![endif]-->`;
}
