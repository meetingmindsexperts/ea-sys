/**
 * Text safety for pdfkit's built-in Helvetica (WinAnsi encoding). SERVER ONLY.
 *
 * Moved out of speaker-agreement.ts (Sep 15, 2026) so every renderer that
 * prints user-typed text can use it without importing the agreement module and
 * its docx dependencies. The speaker reimbursement PDF is the second caller: a
 * speaker's name, institution or bank address can hold Arabic or CJK text, and
 * one unencodable character must not fail the whole document.
 */

/**
 * Substitute glyphs that aren't in Helvetica's WinAnsi encoding so they
 * render as legible ASCII in the PDF rather than missing-glyph boxes.
 * Applied only at PDF emission — the acceptance HTML view keeps the
 * original Unicode since browsers render it fine.
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
    .replace(/ /g, " "); // nbsp
  // Defensive sweep: codepoints outside printable ASCII + Latin-1
  // Supplement get replaced with "?". pdfkit's default WinAnsi encoder
  // throws on unencodable codepoints — this stops a stray emoji / CJK /
  // box-drawing char from nuking a whole batch of PDFs.
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
    out += safe ? ch : "?";
  }
  return out;
}
