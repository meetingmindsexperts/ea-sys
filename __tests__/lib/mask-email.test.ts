import { describe, it, expect } from "vitest";
import { maskEmail } from "@/lib/mask-email";

describe("maskEmail", () => {
  it("keeps the first letter and the domain only", () => {
    expect(maskEmail("jane.doe@gmail.com")).toBe("j***@gmail.com");
  });
  it("handles empty and malformed input without throwing", () => {
    expect(maskEmail("")).toBe("");
    expect(maskEmail(null)).toBe("");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail("@nolocal.com")).toBe("***");
  });
});
