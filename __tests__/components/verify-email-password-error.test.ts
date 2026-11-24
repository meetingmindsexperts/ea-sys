/**
 * The confirmation page says so when the password is wrong (Nov 24, 2026).
 *
 * The owner typed a wrong password there twice on production, three seconds
 * apart, and saw "no error or UI state": the only sign was the grey sentence
 * above the form changing to another grey sentence, and the second try changed
 * nothing. The refusal now shows at the box.
 *
 * The unit suite has no browser document, so the page is pinned by its source;
 * it was run for real in a browser the same day.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(process.cwd(), "src/app/verify-email/page.tsx"), "utf8");
const route = readFileSync(join(process.cwd(), "src/app/api/auth/verify-email/route.ts"), "utf8");

/** The page's handling of one refusal code, up to its `return`. */
function branch(code: string): string {
  const start = page.indexOf(`data.code === "${code}"`);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, page.indexOf("return;", start));
}

describe("a wrong password on the confirmation page", () => {
  it("is the code the route answers with", () => {
    expect(route).toContain('code: "BAD_PASSWORD"');
  });

  it("is shown at the box, not by rewriting the sentence above the form", () => {
    const bad = branch("BAD_PASSWORD");
    expect(bad).toContain("setPasswordError(");
    expect(bad).not.toContain("setMessage(");
  });

  it("empties the box and puts the cursor back in it, so a second wrong try is seen as one", () => {
    const bad = branch("BAD_PASSWORD");
    expect(bad).toContain('setPassword("")');
    expect(bad).toContain("passwordBox.current?.focus()");
  });

  it("keeps the form on screen: the link is not spent by a refusal", () => {
    expect(branch("BAD_PASSWORD")).toContain('setState("password")');
  });

  it("is announced and red: an alert under the box, and the box marked invalid", () => {
    expect(page).toMatch(/role="alert"[^>]*className="[^"]*text-red-600/);
    expect(page).toContain("aria-invalid={passwordError ? true : undefined}");
    expect(page).toContain("border-red-500");
  });

  it("goes when the person submits again or starts typing", () => {
    const submit = page.slice(page.indexOf("const onSubmit"), page.indexOf("return (", page.indexOf("const onSubmit")));
    expect(submit).toContain("setPasswordError(null)");
    const box = page.slice(page.indexOf('id="confirm-password"'), page.indexOf("aria-invalid"));
    expect(box).toContain("setPasswordError(null)");
  });

  it("says which password is wanted before anyone gets it wrong", () => {
    expect(page).toContain("The password of the account you already have, not one typed on a registration form.");
  });

  it("a failed request while confirming is said at the box too", () => {
    const submit = page.slice(page.indexOf("const onSubmit"), page.indexOf("return (", page.indexOf("const onSubmit")));
    expect(submit).toMatch(/catch[\s\S]*setPasswordError\("Something went wrong\. Please try again\."\)/);
  });
});
