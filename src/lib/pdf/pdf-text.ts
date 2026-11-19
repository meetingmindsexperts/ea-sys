/**
 * Text safety for pdfkit's built-in Helvetica (WinAnsi encoding). SERVER ONLY.
 *
 * Moved out of speaker-agreement.ts (Sep 15, 2026) so every renderer that
 * prints user-typed text can use it without importing the agreement module and
 * its docx dependencies. The speaker reimbursement PDF is the second caller: a
 * speaker's name, institution or bank address can hold Arabic or CJK text, and
 * one unencodable character must not fail the whole document.
 */

import { greekLetterName } from "@/lib/event-slug";

/**
 * Substitute glyphs that aren't in Helvetica's WinAnsi encoding so they
 * render as legible ASCII in the PDF rather than missing-glyph boxes.
 * Applied only at PDF emission — the acceptance HTML view keeps the
 * original Unicode since browsers render it fine.
 *
 * Greek letters are written out by name (β becomes "beta", Δ "Delta") and
 * Greek mu becomes the micro sign. Everything else the font cannot draw
 * (Arabic, CJK, emoji) still becomes "?": drawing those needs a Unicode font
 * embedded in the PDF, which no PDF here has.
 */
export function sanitizePdfText(s: string): string {
  const substituted = s
    .replace(/☐/g, "[ ]")
    .replace(/☑/g, "[x]")
    .replace(/☒/g, "[x]")
    // Non-WinAnsi dashes only — explicit enumeration so we don't accidentally
    // include en-dash (U+2013) or em-dash (U+2014), which ARE WinAnsi-safe and
    // get preserved by the allowlist below. Earlier `[‐-―]` was a range
    // U+2010..U+2015 that swallowed en/em dashes, making the allowlist dead.
    .replace(/[‐‑‒―]/g, "-")
    .replace(/[‘’]/g, "'") // smart single quotes
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/•/g, "•") // bullet (this IS in WinAnsi but belt-and-suspenders)
    .replace(/ /g, " ") // nbsp
    // Greek mu is the unit prefix in "5 μg". The micro sign looks the same and
    // IS in WinAnsi, so the unit survives ("5 mug" would be worse than "?").
    .replace(/μ/g, "µ");
  // Defensive sweep: codepoints outside printable ASCII + Latin-1
  // Supplement get replaced with "?". pdf-lib (the certificates) THROWS on a
  // character its font cannot encode, which would stop a whole batch. pdfkit
  // (everything else) does not throw: it writes a broken code that makes a
  // PDF reader misread the REST of that line, so "Invoice for Greek-letter
  // Summit, total AED 500" loses the amount (measured Nov 19, 2026). Either
  // way the text must arrive here first.
  let out = "";
  for (const ch of substituted) {
    const cp = ch.codePointAt(0) ?? 0;
    const safe =
      cp === 0x0a || cp === 0x09 ||
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0xff) ||
      cp === 0x2013 || cp === 0x2014 || // en/em dashes (WinAnsi-mapped)
      cp === 0x2022 || // bullet
      cp === 0x20ac || // euro
      cp === 0x2122; // trademark
    // A Greek letter is spelled out, not lost: an event named "Improving
    // Outcomes in β-Thalassemia" printed "?-Thalassemia" on the speaker
    // agreement (Nov 19, 2026) and would have on its certificates. The font
    // cannot draw Greek; "beta-Thalassemia" is how the name is written without it.
    // An accented Greek letter (ά, ή, ώ) is named by its bare letter, as the
    // event address rule does after taking the accent off.
    out += safe ? ch : (greekLetterName(ch) ?? greekLetterName(ch.normalize("NFKD")[0] ?? "") ?? "?");
  }
  return out;
}
