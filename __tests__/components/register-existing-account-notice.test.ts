import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * The public register form's notice for an email that already has an account.
 * Since the address-proof rule (Nov 5, 2026; src/lib/registrant-account.ts) a
 * registration made signed out joins that account at once only when the typed
 * password matches or the account's address is confirmed. The notice used to
 * promise "sign in with your existing password to manage your registration
 * later", which stopped being true. Pinned on the source: the page is a client
 * form too large to render here.
 */
const source = readFileSync(
  join(process.cwd(), "src/app/e/[slug]/register/[category]/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

describe("register form: existing-account notice", () => {
  it("says signing in first puts the registration in the account straight away", () => {
    expect(source).toContain("Sign in first to have this registration in your account straight away.");
  });

  it("says that otherwise it may wait for the email address to be confirmed", () => {
    expect(source).toContain(
      "If you continue without signing in, it may only show up there after you confirm your email address.",
    );
  });

  it("no longer promises the registration can be managed later just by signing in", () => {
    expect(source).not.toContain("to manage your registration later");
  });

  it("still says the typed password does not replace the account's", () => {
    expect(source).toContain("The password typed here won&apos;t change your account&apos;s password.");
  });
});
