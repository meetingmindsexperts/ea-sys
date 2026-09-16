/**
 * uploadSizeHint — the nudge shown after a large upload (Sep 16, 2026).
 *
 * The property that matters is that it NUDGES and never blocks: every caller
 * uses it as a toast description, so returning null has to mean "say nothing"
 * rather than "say something empty".
 */
import { describe, it, expect } from "vitest";
import { uploadSizeHint, UPLOAD_SIZE_HINT_BYTES } from "@/lib/utils";

const MB = 1024 * 1024;

describe("uploadSizeHint", () => {
  it("says nothing about an ordinary file", () => {
    expect(uploadSizeHint(0)).toBeNull();
    expect(uploadSizeHint(169 * 1024)).toBeNull(); // the 169KB sibling document
    expect(uploadSizeHint(UPLOAD_SIZE_HINT_BYTES - 1)).toBeNull();
  });

  it("speaks up from the threshold onward", () => {
    expect(uploadSizeHint(UPLOAD_SIZE_HINT_BYTES)).not.toBeNull();
  });

  it("names the actual size, so the uploader can judge", () => {
    // The real file from the Sep 16 DR incident: 9,954,169 bytes.
    const hint = uploadSizeHint(9_954_169);
    expect(hint).toContain("9.5 MB");
    expect(hint).toContain("compressing");
  });

  it("stays well under the 10MB upload caps, so it is advice and not a refusal", () => {
    expect(UPLOAD_SIZE_HINT_BYTES).toBeLessThan(10 * MB);
  });
});
