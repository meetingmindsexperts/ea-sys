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
 * web font here is written as a STACK that ends in Verdana, which Windows and
 * Apple devices have (an Android phone has neither it nor the font, and shows
 * its own sans-serif, Roboto): a recipient sees the chosen font, Verdana or
 * Roboto, never a serif surprise. Verdana itself needs no file.
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
  /**
   * The file under /email-fonts/ a mail app downloads for ordinary Latin text;
   * null for a font every computer has. Its extended-Latin sister file (the
   * same name with `latin-ext`) carries the letters of Turkish, Polish, Czech,
   * Hungarian and the like: see `emailFontFaceRule`.
   */
  file: string | null;
}

/**
 * The characters each of a font's two files holds (from the fontsource
 * packages' own stylesheets, the same for all three fonts). A mail app fetches
 * the second file only for an email that uses one of its letters. Without it
 * the ğ of "Doğan" or the Ł of "Łukasz" showed in the fallback font, in the
 * middle of a name (review of 9a0199bf7). Vietnamese, Greek and Cyrillic are
 * in neither file and show in the fallback.
 */
const LATIN_RANGE = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT_RANGE = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

/** A font's files with the characters each covers: Latin first, then extended Latin. */
export function emailFontFiles(font: EmailFont): { file: string; unicodeRange: string }[] {
  if (!font.file) return [];
  return [
    { file: font.file, unicodeRange: LATIN_RANGE },
    { file: font.file.replace("-latin-", "-latin-ext-"), unicodeRange: LATIN_EXT_RANGE },
  ];
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

/**
 * The web fonts an email's HTML asks for, in the list's order. Reads the FIRST
 * family of each `font-family`, however it is quoted: bare, in single or double
 * quotes, or as `&quot;` (hand-written and pasted HTML, not only the editor's).
 */
export function webFontsUsedIn(html: string): EmailFont[] {
  const used = new Set<string>();
  for (const m of html.matchAll(/font-family\s*:\s*(?:&quot;|["'])?\s*([^;"'<>&,]+)/gi)) {
    const font = emailFontFor(m[1]);
    if (font?.file) used.add(font.family);
  }
  return EMAIL_FONTS.filter((f) => used.has(f.family));
}

/** A font's `@font-face` rules, one per file. The files are variable fonts: each carries every weight. */
export function emailFontFaceRule(font: EmailFont, base: string): string {
  return emailFontFiles(font)
    .map(
      (f) =>
        `@font-face { font-family: '${font.family}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('${base}${EMAIL_FONTS_PATH}/${f.file}') format('woff2'); unicode-range: ${f.unicodeRange}; }`,
    )
    .join("\n    ");
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
