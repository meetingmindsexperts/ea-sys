import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { bodyParagraphs, buildEntriesDocx, DOCX_CONTENT_TYPE, sanitizeXmlText } from "@/lib/docx-export";

/**
 * The builder writes real .docx bytes, so the tests read the document back the
 * way Word does: unzip the package and inspect `word/document.xml`. Asserting
 * on the returned object instead would pin our own data structure and prove
 * nothing about what an organiser actually opens.
 *
 * PizZip is already a dependency (the speaker-agreement merge), so reading the
 * package back costs no new package.
 */
function documentXml(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("word/document.xml missing from the package");
  return file.asText();
}

const entry = (heading: string, body = "Body text.") => ({
  heading,
  fields: [{ label: "Theme", value: "Cardiology" }],
  body,
});

describe("buildEntriesDocx", () => {
  it("produces a readable .docx package", async () => {
    const buffer = await buildEntriesDocx({ title: "Event — Abstracts", entries: [entry("A-001  First")] });
    const zip = new PizZip(buffer);

    // The three parts Word needs to recognise the file at all.
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("_rels/.rels")).toBeTruthy();
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("renders the title, the subtitle and every entry in the order given", async () => {
    const buffer = await buildEntriesDocx({
      title: "MEHF 2027 — Abstracts",
      subtitle: "3 abstracts · Exported 10 September 2026",
      entries: [entry("A-001  First"), entry("A-002  Second"), entry("A-003  Third")],
    });
    const xml = documentXml(buffer);

    expect(xml).toContain("MEHF 2027 — Abstracts");
    expect(xml).toContain("3 abstracts · Exported 10 September 2026");

    // Order is the contract: the organiser reads the document top to bottom.
    const first = xml.indexOf("A-001  First");
    const second = xml.indexOf("A-002  Second");
    const third = xml.indexOf("A-003  Third");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("escapes XML-significant characters in titles and bodies", async () => {
    // A title like "Q&A on <5 mm lesions" is ordinary organiser text. Written as
    // markup it would corrupt the package; written as data it survives verbatim.
    const buffer = await buildEntriesDocx({
      title: "Event & Co — Abstracts",
      entries: [
        {
          heading: 'A-001  Q&A on <5 mm "lesions"',
          fields: [{ label: "Theme", value: "A > B" }],
          body: "Body with & and < and >.",
        },
      ],
    });
    const xml = documentXml(buffer);

    expect(xml).toContain("Q&amp;A on &lt;5 mm");
    expect(xml).toContain("A &gt; B");
    expect(xml).toContain("Body with &amp; and &lt; and &gt;.");
    // No raw ampersand-not-entity anywhere: that is what would break the package.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml)).toBe(false);

    // And the package still parses, which is the real proof.
    expect(() => new PizZip(buffer)).not.toThrow();
  });

  it("drops a field whose value is empty rather than printing a bare label", async () => {
    const buffer = await buildEntriesDocx({
      title: "Event",
      entries: [
        {
          heading: "A-001  Untagged",
          fields: [
            { label: "Theme", value: "" },
            { label: "Presenting Author", value: "   " },
            { label: "Presentation Type", value: "Oral" },
          ],
          body: "Body.",
        },
      ],
    });
    const xml = documentXml(buffer);

    // A bare "Theme:" reads as a rendering fault, not as "no theme".
    expect(xml).not.toContain("Theme: ");
    expect(xml).not.toContain("Presenting Author: ");
    expect(xml).toContain("Presentation Type: ");
    expect(xml).toContain("Oral");
  });

  it("renders an empty entry list without failing", async () => {
    const buffer = await buildEntriesDocx({ title: "Event — Abstracts", entries: [] });
    expect(documentXml(buffer)).toContain("No entries.");
  });

  it("exposes the Word content type both routes send", () => {
    expect(DOCX_CONTENT_TYPE).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("bodyParagraphs", () => {
  it("makes one paragraph per non-empty line", () => {
    expect(bodyParagraphs("One\nTwo\nThree")).toHaveLength(3);
  });

  it("collapses blank lines instead of stacking empty paragraphs", () => {
    // A body typed with double line breaks must not open a gap on every break.
    expect(bodyParagraphs("One\n\n\nTwo")).toHaveLength(2);
    expect(bodyParagraphs("\n\n")).toHaveLength(0);
  });

  it("handles Windows line endings", () => {
    expect(bodyParagraphs("One\r\nTwo")).toHaveLength(2);
  });

  it("returns nothing for an empty body", () => {
    expect(bodyParagraphs("")).toHaveLength(0);
  });
});


describe("XML-illegal characters (found on live data, September 10, 2026)", () => {
  // A submitter who drafts in Word and pastes into the form brings Word's own
  // break characters with them. U+000B is what Shift+Enter leaves behind, and
  // XML 1.0 forbids it — on Middle East Heart Failure 2027 one such title made
  // Word refuse the whole four-abstract export with no error anywhere.
  const VT = "\u000B";

  it("keeps the package readable when a title carries a vertical tab", async () => {
    const buffer = await buildEntriesDocx({
      title: "Event",
      entries: [
        {
          heading: `A-004  Heart Failure in Women:${VT}Different Phenotypes`,
          fields: [],
          body: "Body.",
        },
      ],
    });
    const xml = documentXml(buffer);

    expect(xml).not.toContain(VT);
    // The break becomes a space, so the heading still reads as one line.
    expect(xml).toContain("Heart Failure in Women: Different Phenotypes");
  });

  it("emits no XML-illegal code point anywhere, whichever field carries it", async () => {
    const buffer = await buildEntriesDocx({
      title: `Title${VT}with a break`,
      subtitle: "Sub\u0000title",
      entries: [
        {
          heading: `A-001${VT}Heading`,
          fields: [{ label: `Lab\u0007el`, value: `Val${VT}ue` }],
          body: `Body\u0001 one.${VT}Body two.\u001F`,
        },
      ],
    });
    const xml = documentXml(buffer);

    // XML 1.0 admits only tab, newline and carriage return below U+0020.
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)).toBe(false);
  });

  it("treats a vertical tab in a body as the line break it means", async () => {
    // Two lines, not one run with a stray byte and not a dropped break.
    expect(bodyParagraphs(`One${VT}Two`)).toHaveLength(2);
    expect(bodyParagraphs("One\u000CTwo")).toHaveLength(2);
  });
});

describe("sanitizeXmlText", () => {
  it("maps Word's break characters to newlines", () => {
    expect(sanitizeXmlText("a\u000Bb\u000Cc")).toBe("a\nb\nc");
  });

  it("drops the rest of the C0 controls without leaving a mark", () => {
    expect(sanitizeXmlText("a\u0000\u0001\u0008\u001Fb")).toBe("ab");
  });

  it("keeps the whitespace XML actually allows", () => {
    expect(sanitizeXmlText("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("keeps ordinary text, accents and emoji untouched", () => {
    // Emoji are surrogate PAIRS — the lone-surrogate strip must not eat them.
    expect(sanitizeXmlText("Café — naïve › 🫀")).toBe("Café — naïve › 🫀");
  });

  it("drops a lone surrogate, which no valid text contains", () => {
    expect(sanitizeXmlText("a\uD800b")).toBe("ab");
    expect(sanitizeXmlText("a\uDC00b")).toBe("ab");
  });
});
