/** {{portalAccess}}: the part of the one reviewer email the system writes (Nov 10, 2026). */
import { describe, it, expect } from "vitest";
import { reviewerPortalAccess, REVIEWER_SETUP_EXPIRES_IN } from "@/lib/reviewer-portal-access";

const reviewLink = "https://x.test/login?callbackUrl=%2Fmy-reviews";

describe("reviewerPortalAccess", () => {
  it("a reviewer who can sign in gets the portal button only", () => {
    const { html, text } = reviewerPortalAccess({ email: "sam@x.com", reviewLink, setupLink: null });
    expect(html).toContain(`href="${reviewLink}"`);
    expect(html).toContain("signing in with sam@x.com");
    expect(html).not.toMatch(/password/i);
    expect(text).toBe(`Enter the Reviewer Portal by signing in with sam@x.com:\n\nREVIEWER PORTAL: ${reviewLink}`);
  });

  it("a new reviewer gets the set-password button first, then the portal for later visits", () => {
    const setupLink = "https://x.test/accept-invitation?token=abc&email=new%40x.com";
    const { html, text } = reviewerPortalAccess({ email: "new@x.com", reviewLink, setupLink });
    expect(html.indexOf("SET YOUR PASSWORD")).toBeGreaterThan(-1);
    expect(html.indexOf("SET YOUR PASSWORD")).toBeLessThan(html.indexOf("REVIEWER PORTAL"));
    // The link is an attribute value: its & must be escaped.
    expect(html).toContain('href="https://x.test/accept-invitation?token=abc&amp;email=new%40x.com"');
    expect(html).toContain(`within ${REVIEWER_SETUP_EXPIRES_IN}`);
    expect(text).toContain(`SET YOUR PASSWORD: ${setupLink}`);
    expect(text).toContain(`REVIEWER PORTAL: ${reviewLink}`);
    expect(text).not.toContain("<");
  });

  it("escapes the address in the HTML and leaves it plain in the text", () => {
    const { html, text } = reviewerPortalAccess({ email: 'a"<b>@x.com', reviewLink, setupLink: null });
    expect(html).toContain("a&quot;&lt;b&gt;@x.com");
    expect(text).toContain('a"<b>@x.com');
  });
});
