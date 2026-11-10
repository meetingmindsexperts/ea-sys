/**
 * The attendee-facing brand (Nov 10, 2026): HCPs see Meeting Minds Experts,
 * staff see MM Group. Each half falls back to the organisation's own.
 */
import { describe, it, expect } from "vitest";
import { readPublicBrand } from "@/lib/public-brand";

const ORG = { name: "MM Group", logo: "/uploads/mmg.png" };

describe("readPublicBrand", () => {
  it("uses what Settings holds", () => {
    expect(readPublicBrand({ publicBrand: { name: "Meeting Minds Experts", logo: "/uploads/mme.png" } }, ORG)).toEqual({
      name: "Meeting Minds Experts",
      logo: "/uploads/mme.png",
    });
  });

  it("falls back half by half to the organisation's own", () => {
    expect(readPublicBrand({ publicBrand: { name: "Meeting Minds Experts", logo: null } }, ORG)).toEqual({ name: "Meeting Minds Experts", logo: "/uploads/mmg.png" });
    expect(readPublicBrand({ publicBrand: { name: "  ", logo: "/uploads/mme.png" } }, ORG)).toEqual({ name: "MM Group", logo: "/uploads/mme.png" });
  });

  it("an organisation that never set it, or a malformed value, looks as before", () => {
    expect(readPublicBrand({}, ORG)).toEqual(ORG);
    expect(readPublicBrand(null, ORG)).toEqual(ORG);
    expect(readPublicBrand({ publicBrand: { name: 42 } }, ORG)).toEqual(ORG);
  });
});

describe("the password reset email names the recipient's brand", () => {
  it("an attendee's says Meeting Minds Experts; without a name it keeps the staff default", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const hcp = emailTemplates.passwordReset({ recipientName: "A B", resetLink: "https://x/r", productName: "Meeting Minds Experts" });
    expect(hcp.subject).toBe("Reset your Meeting Minds Experts password");
    expect(hcp.htmlContent).toContain("Sent from Meeting Minds Experts");
    expect(hcp.htmlContent).not.toContain("MM Group");
    expect(emailTemplates.passwordReset({ recipientName: "A B", resetLink: "https://x/r" }).subject).toBe("Reset your MM Group Events password");
  });
});

describe("the confirmation and account-exists emails name the attendee-facing brand", () => {
  it("footer says the brand when given, the staff default otherwise", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const conf = emailTemplates.emailVerification({ recipientName: "A", verifyLink: "https://x/v", purpose: "account", productName: "Meeting Minds Experts" });
    expect(conf.htmlContent).toContain("Sent from Meeting Minds Experts");
    expect(conf.htmlContent).not.toContain("MM Group");
    const exists = emailTemplates.accountExists({ recipientName: "A", signInLink: "https://x/l", resetLink: "https://x/r", productName: "Meeting Minds Experts" });
    expect(exists.htmlContent).toContain("Sent from Meeting Minds Experts");
    expect(emailTemplates.emailVerification({ recipientName: "A", verifyLink: "https://x/v", purpose: "team" }).htmlContent).toContain("Sent from MM Group Events");
  });
});

describe("publicBrand.logo", () => {
  it("takes our uploads or https, never a third-party http or protocol-relative address", async () => {
    const { publicBrandSettingsSchema } = await import("@/lib/public-brand");
    expect(publicBrandSettingsSchema.safeParse({ logo: "/uploads/photos/x.png" }).success).toBe(true);
    expect(publicBrandSettingsSchema.safeParse({ logo: "https://cdn.example.com/x.png" }).success).toBe(true);
    for (const bad of ["http://tracker.example/x.png", "//tracker.example/x.png", "javascript:alert(1)", "data:image/svg+xml;base64,AA"]) {
      expect(publicBrandSettingsSchema.safeParse({ logo: bad }).success).toBe(false);
    }
  });
});
