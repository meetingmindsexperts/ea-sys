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
    // Only what was sent: someone already retyping during a slow answer keeps it.
    expect(bad).toContain('setPassword((typed) => (typed === withPassword ? "" : typed))');
    expect(bad).toContain("passwordBox.current?.focus()");
  });

  it("keeps the form on screen: the link is not spent by a refusal", () => {
    expect(branch("BAD_PASSWORD")).toContain('setState("password")');
  });

  it("is announced and red: an alert under the box that shows the refusal, and the box marked invalid", () => {
    expect(page).toMatch(/role="alert"[^>]*className="[^"]*text-red-600[^>]*>\s*\{passwordError\}/);
    expect(page).toContain("aria-invalid={passwordError ? true : undefined}");
    // The resting border, not only the focused one.
    expect(page).toMatch(/\? "border-red-500 /);
  });

  it("goes when the person submits again or starts typing", () => {
    const submit = page.slice(page.indexOf("const onSubmit"), page.indexOf("return (", page.indexOf("const onSubmit")));
    expect(submit).toContain("setPasswordError(null)");
    const box = page.slice(page.indexOf('id="confirm-password"'), page.indexOf("aria-invalid"));
    expect(box).toContain("setPasswordError(null)");
  });

  // Review of 7a84e8032: the first wording ("not one typed on a registration form") was true
  // only for an older account. A NEW account's password IS the one just typed on a form.
  it("says which password is wanted, in words true for a new account and an older one, and keeps saying it beside a refusal", () => {
    expect(page).toContain("The password you sign in with.");
    expect(page).not.toContain("not one typed on a registration form");
    const hint = page.indexOf('id="confirm-password-hint"');
    // Not inside the refusal's condition: it shows with or without one.
    expect(page.slice(page.lastIndexOf("{passwordError && (", hint), hint)).toContain(")}");
    expect(page).toContain('aria-describedby="confirm-password-hint"');
  });

  it("a failed request while confirming is said at the box too", () => {
    const submit = page.slice(page.indexOf("const onSubmit"), page.indexOf("return (", page.indexOf("const onSubmit")));
    expect(submit).toMatch(/catch[\s\S]*setPasswordError\("Something went wrong\. Please try again\."\)/);
  });

  // The link is unspent in both cases, so the form must stay. Before, the 11th wrong try in 15
  // minutes replaced the form with "Verification failed", as if the link were dead.
  it("too many tries, or a server failure, keeps the form and says so at the box", () => {
    const start = page.indexOf("withPassword && (res.status === 429 || res.status >= 500)");
    expect(start).toBeGreaterThan(-1);
    const kept = page.slice(start, page.indexOf("return;", start));
    expect(kept).toContain('setState("password")');
    expect(kept).toContain("setPasswordError(");
    expect(kept).toContain("throttleMessage(data.retryAfterSeconds)");
    // And it is asked BEFORE the page gives up on the link.
    expect(start).toBeLessThan(page.indexOf('setState("error");\n    setMessage(data.error || "We couldn\'t verify your email.")'));
  });

  it("the route sends the wait with a throttled answer", () => {
    expect(route).toMatch(/retryAfterSeconds: check\.retryAfterSeconds/);
  });
});
