import { describe, it, expect } from "vitest";
import { buildImportPatch, updatedRowMessage } from "@/lib/import-upsert";

const LABELS = { firstName: "first name", jobTitle: "job title", bio: "bio", phone: "phone" } as const;
type K = keyof typeof LABELS;

describe("buildImportPatch", () => {
  const existing = { firstName: "Dana", jobTitle: "Cardiologist", bio: "Old bio", phone: null, tags: ["Faculty"] };

  it("writes only filled cells that differ", () => {
    const { patch, changed } = buildImportPatch<K>(existing, { firstName: "Dana", jobTitle: "Head of Cardiology", bio: "", phone: "+971 50" }, LABELS);
    expect(patch).toEqual({ jobTitle: "Head of Cardiology", phone: "+971 50" });
    expect(changed).toEqual(["job title", "phone"]);
  });

  it("an empty cell never clears a value", () => {
    expect(buildImportPatch<K>(existing, { bio: "   ", jobTitle: undefined }, LABELS).patch).toEqual({});
  });

  it("ignores whitespace-only differences, so re-importing the same file changes nothing", () => {
    const { patch, changed } = buildImportPatch<K>(existing, { firstName: " Dana ", jobTitle: "Cardiologist", tags: ["faculty"] }, LABELS);
    expect(patch).toEqual({});
    expect(changed).toEqual([]);
  });

  it("adds new tags to the existing ones, case-insensitively, never removing", () => {
    const { patch, changed } = buildImportPatch<K>(existing, { tags: ["FACULTY", "committee"] }, LABELS);
    expect(patch.tags).toEqual(["Faculty", "committee"]);
    expect(changed).toEqual(["tags (+committee)"]);
  });
});

describe("updatedRowMessage", () => {
  it("names the row, the person and what changed", () => {
    expect(updatedRowMessage(7, "jane@x.com", ["job title", "bio"])).toBe("Row 7: jane@x.com updated (job title, bio)");
  });
});
