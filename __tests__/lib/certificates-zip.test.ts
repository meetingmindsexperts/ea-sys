/**
 * certZipEntryName — safe, unique zip entry filenames for the per-run
 * "Download all certificates" export.
 */
import { describe, it, expect } from "vitest";
import { certZipEntryName } from "@/lib/certificates/zip";

describe("certZipEntryName", () => {
  it("builds '{serial} - {name}.pdf'", () => {
    expect(certZipEntryName("OMM-ATT-0001", "Dr. Jane Doe", new Set())).toBe(
      "OMM-ATT-0001 - Dr. Jane Doe.pdf",
    );
  });

  it("strips path separators so a name can never become a path inside the zip", () => {
    const name = certZipEntryName("S-1", "../../etc/passwd", new Set());
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).toBe("S-1 - ....etcpasswd.pdf");
  });

  it("strips Windows-reserved and control characters", () => {
    const name = certZipEntryName("S-1", "a<b>c:d*e?f\"g|h\u0000i", new Set());
    expect(name).toBe("S-1 - abcdefghi.pdf");
  });

  it("collapses whitespace and caps the length", () => {
    const name = certZipEntryName("S-1", `Very   spaced   ${"x".repeat(300)}`, new Set());
    expect(name).toContain("Very spaced");
    expect(name.length).toBeLessThanOrEqual(126); // 120 base + ".pdf"
  });

  it("falls back to 'certificate.pdf' when everything is stripped", () => {
    expect(certZipEntryName("", "///", new Set())).toBe("certificate.pdf");
  });

  it("handles a missing recipient name", () => {
    expect(certZipEntryName("S-9", null, new Set())).toBe("S-9.pdf");
    expect(certZipEntryName("S-9", "   ", new Set())).toBe("S-9.pdf");
  });

  it("dedupes collisions with a numbered suffix and records names in `taken`", () => {
    const taken = new Set<string>();
    expect(certZipEntryName("S-1", "Jane", taken)).toBe("S-1 - Jane.pdf");
    expect(certZipEntryName("S-1", "Jane", taken)).toBe("S-1 - Jane (2).pdf");
    expect(certZipEntryName("S-1", "Jane", taken)).toBe("S-1 - Jane (3).pdf");
    expect(taken.size).toBe(3);
  });
});
