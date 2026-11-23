/**
 * A registration made with an address that already has an account, by someone
 * who did not show they are that account's holder (signed out, another
 * password), stays out of the account until the address is confirmed
 * (src/lib/registrant-account.ts). Nov 23, 2026: nothing told the person how,
 * and on a webinar, which is watched from the account, five delegates were a
 * day away from "Register to join" followed by "already registered".
 *
 * Pinned here: the email that now goes out, the webinar page's way out, and
 * the rule that stops that page from reloading for ever.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_CONFIRMATION_WATCH, watchConfirmation, type ConfirmationWatch } from "@/lib/confirm-email-watch";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the confirmation email for a registration left out of its account", () => {
  it("says which password the link asks for, and never that the registration works either way", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const mail = emailTemplates.emailVerification({ recipientName: "Jane Doe", verifyLink: "https://x/verify", purpose: "attach", expiresIn: "7 days" });
    expect(mail.subject).toBe("Confirm your email to add your registration to your account");
    for (const body of [mail.htmlContent, mail.textContent]) {
      expect(body).toContain("which already has an account");
      expect(body).toContain("the password of the account you already had, not one typed on the registration form");
      expect(body).toContain("a webinar is watched from the account");
      expect(body).toContain("Reset it from the sign-in page first, then open this link again");
      // True of the older "registrations" email (that registration IS in the
      // account); false here, where a webinar cannot be watched until confirmed.
      expect(body).not.toContain("works either way");
      expect(body).toContain("https://x/verify");
    }
  });

  it("leaves the other confirmation emails as they were", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const earlier = emailTemplates.emailVerification({ recipientName: "A", verifyLink: "https://x/v", purpose: "registrations" });
    expect(earlier.textContent).toContain("Your new registration works either way.");
    expect(earlier.textContent).toContain("If you didn't create this account, you can safely ignore this email.");
    const account = emailTemplates.emailVerification({ recipientName: "A", verifyLink: "https://x/v", purpose: "account" });
    expect(account.subject).toBe("Confirm your Meeting Minds account");
    expect(account.textContent).toContain("An account that is never confirmed is removed after 30 days.");
  });
});

describe("the webinar page's way out", () => {
  const page = read("src/app/e/[slug]/session/[sessionId]/page.tsx");
  const branch = page.slice(page.indexOf('authState.kind === "needs-registration" && !isPast'), page.indexOf('authState.kind === "not-active" && !isPast'));

  it("offers the confirmation link where it says the person is not registered, and keeps Register", () => {
    expect(branch).toContain("<ConfirmEmailNotice forWebinar onConfirmed={reloadPage} />");
    expect(branch).toContain("href={`/e/${slug}/register`}");
    // The notice comes first: it is the only way in for someone who did register.
    expect(branch.indexOf("<ConfirmEmailNotice")).toBeLessThan(branch.indexOf("Register to join"));
  });

  it("says nothing about whether a registration exists: an unproven account must not learn the address's history", () => {
    const notice = read("src/components/registrant/confirm-email-notice.tsx");
    expect(notice).toContain("Already registered for this webinar?");
    expect(notice).toContain("If you registered with ${address} without signing in, confirm the address to join from this account.");
    // It asks only whether the ACCOUNT is confirmed; the page asks nothing more of the server.
    expect(notice.match(/fetch\("([^"]+)"/g)).toEqual(['fetch("/api/registrant/confirm-email"', 'fetch("/api/registrant/confirm-email"']);
  });

  it("asks again only while someone waits on the link", () => {
    const notice = read("src/components/registrant/confirm-email-notice.tsx");
    expect(notice).toContain("refetchInterval: sent && onConfirmed ? CONFIRMED_POLL_MS : false");
  });
});

describe("telling the page the address is confirmed", () => {
  const feed = (answers: Array<boolean | undefined>) => {
    let watch: ConfirmationWatch = NEW_CONFIRMATION_WATCH;
    return answers.map((a) => {
      const next = watchConfirmation(watch, a);
      watch = next.watch;
      return next.tell;
    });
  };

  it("tells it once, when an unconfirmed address becomes confirmed", () => {
    expect(feed([undefined, false, false, true, true, true])).toEqual([false, false, false, true, false, false]);
  });

  it("never tells it for an account confirmed all along (a confirmed person who has not registered would reload for ever)", () => {
    expect(feed([undefined, true, true])).toEqual([false, false, false]);
  });

  it("stays quiet while unconfirmed or unanswered", () => {
    expect(feed([undefined, undefined, false, false])).toEqual([false, false, false, false]);
  });
});
