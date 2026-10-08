/** Blueprint uploads are typed by their bytes, never by name or declared type. */
import { describe, it, expect } from "vitest";
import { sniffBlueprintFile } from "@/lib/blueprint/blueprint-files";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const text = (s: string) => new TextEncoder().encode(s);

describe("sniffBlueprintFile", () => {
  it.each([
    ["png", bytes(0x89, 0x50, 0x4e, 0x47), "plan.png", "image/png"],
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), "x.jpg", "image/jpeg"],
    ["gif", bytes(0x47, 0x49, 0x46, 0x38), "x.gif", "image/gif"],
    ["webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "x.webp", "image/webp"],
    ["pdf", bytes(0x25, 0x50, 0x44, 0x46), "programme.pdf", "application/pdf"],
    ["docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("....[Content_Types].xml")]), "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["svg", text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), "logo.svg", "image/svg+xml"],
  ])("accepts %s", (_label, buf, name, type) => {
    expect(sniffBlueprintFile(buf, name)?.contentType).toBe(type);
  });

  it.each([
    ["an executable named .png", bytes(0x4d, 0x5a), "plan.png"],
    ["a zip that is not an Office file", bytes(0x50, 0x4b, 0x03, 0x04), "archive.zip"],
    ["a plain zip renamed .docx", bytes(0x50, 0x4b, 0x03, 0x04), "brief.docx"],
    ["HTML", text("<html><script>alert(1)</script></html>"), "page.html"],
  ])("refuses %s", (_label, buf, name) => {
    expect(sniffBlueprintFile(buf, name)).toBeNull();
  });
});
