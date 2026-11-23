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
  it("says the registration stands, which password the link asks for, and never that it works either way", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const mail = emailTemplates.emailVerification({ recipientName: "Jane Doe", verifyLink: "https://x/verify", purpose: "attach", expiresIn: "7 days" });
    expect(mail.subject).toBe("Confirm your email to add your registration to your account");
    for (const body of [mail.htmlContent, mail.textContent]) {
      expect(body).toContain("without signing in to the account the address already has");
      // True for every caller, a conference included: nothing about the registration is at stake.
      expect(body).toContain("Your registration stands either way.");
      expect(body).toContain("the password of the account you already had, not one typed on the registration form");
      expect(body).toContain("which is where a webinar is watched");
      expect(body).toContain("Reset it from the sign-in page first, then open this link again");
      // True of the older "registrations" email (that registration IS in the
      // account); misleading here, where a webinar cannot be watched until confirmed.
      expect(body).not.toContain("works either way");
      expect(body).toContain("https://x/verify");
    }
  });

  // Review of 4dcf86f9, finding 2: the session page's button sent the
  // "registrations" email, which says "your new registration works either way".
  it("the link asked for from a session's page speaks of joining, and claims no registration exists", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const mail = emailTemplates.emailVerification({ recipientName: "Jane Doe", verifyLink: "https://x/verify", purpose: "join" });
    expect(mail.subject).toBe("Confirm your email to join from your account");
    expect(mail.textContent).toContain("A registration made with this address without signing in joins the account once the address is confirmed");
    expect(mail.textContent).not.toContain("works either way");
    expect(mail.textContent).not.toContain("was just submitted");
  });

  it("leaves the four older confirmation emails word for word as they were", async () => {
    const { emailTemplates } = await import("@/lib/email");
    const text = (purpose: "team" | "registrations" | "speaker" | "account") =>
      emailTemplates.emailVerification({ recipientName: "A", verifyLink: "https://x/v", purpose });
    const usualIgnore = "If you didn't create this account, you can safely ignore this email.";
    expect(text("registrations").textContent).toContain("Your new registration works either way. Open the link and enter your password to confirm.");
    expect(text("registrations").textContent).toContain(usualIgnore);
    expect(text("team").textContent).toContain("to link your account to the Meeting Minds team");
    expect(text("team").textContent).toContain(usualIgnore);
    expect(text("speaker").textContent).toContain("The organisers already have a speaker profile for this address.");
    expect(text("speaker").textContent).toContain(usualIgnore);
    expect(text("account").textContent).toContain("An account that is never confirmed is removed after 30 days.");
    expect(text("account").subject).toBe("Confirm your Meeting Minds account");
    for (const purpose of ["team", "registrations", "speaker"] as const) {
      expect(text(purpose).subject).toBe("Verify your email \u2014 Meeting Minds");
    }
  });
});

describe("the session page's way out", () => {
  const page = read("src/app/e/[slug]/session/[sessionId]/page.tsx");
  const notice = read("src/components/registrant/confirm-email-notice.tsx");
  const branch = page.slice(page.indexOf('authState.kind === "needs-registration" && !isPast'), page.indexOf('authState.kind === "not-active" && !isPast'));

  it("offers the confirmation link where it says the person is not registered, and keeps Register", () => {
    expect(branch).toContain("<ConfirmEmailNotice forJoining onConfirmed={reloadPage} />");
    expect(branch).toContain("href={`/e/${slug}/register`}");
    // The notice comes first: it is the only way in for someone who did register.
    expect(branch.indexOf("<ConfirmEmailNotice")).toBeLessThan(branch.indexOf("Register to join"));
  });

  it("says nothing about whether a registration exists: an unproven account must not learn the address's history", () => {
    expect(notice).toContain('joining: "Already registered?"');
    expect(notice).toContain("If you registered with ${address} without signing in, confirm the address to join from this account.");
    // It asks only whether the ACCOUNT is confirmed; the page asks nothing more of the server.
    expect(notice.match(/fetch\("([^"]+)"/g)).toEqual(['fetch("/api/registrant/confirm-email"', 'fetch("/api/registrant/confirm-email"']);
  });

  // Review of 4dcf86f9, findings 3 and 4: it asked only after its own button
  // was pressed (the link emailed at registration is the one most people
  // open), and went on asking for ever once the session had ended.
  it("asks for as long as it shows with a listener, and stops on an error", () => {
    expect(notice).toContain('onConfirmed && query.state.status !== "error" && query.state.data?.confirmed === false ? CONFIRMED_POLL_MS : false');
    // The error carries its status, so an ended session is handled as one.
    expect(notice).toContain("throw new ApiError(`Failed to check the email (${res.status})`, res.status)");
    // And it stops promising to let the person in.
    expect(notice).toContain("noticeText(address, sent, kind, !!onConfirmed && !status.isError)");
    expect(notice).toContain("then reload this page.");
  });

  it("tells the route where the link was asked from, so the email fits", () => {
    expect(notice).toContain('body: JSON.stringify(forJoining ? { for: "join" } : {})');
  });

  // Finding 5: confirming records the address, then puts the registrations in the account.
  it("reloads a moment after the address is confirmed, not inside that gap", () => {
    expect(page).toContain("window.setTimeout(() => window.location.reload(), RELOAD_AFTER_CONFIRMING_MS)");
  });
});

// Review of 4dcf86f9, the MED: the note for staff was written above the
// guide's first line, which put the whole guide in the browser's quirks mode
// and hid the note under the sidebar.
describe("the user guide", () => {
  const guide = read("public/user-guide.html");

  it("starts with its doctype", () => {
    expect(guide.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("holds the note for staff once, inside the page", () => {
    expect(guide.split("It tells me to register, but I did").length - 1).toBe(1);
    expect(guide.indexOf("It tells me to register, but I did")).toBeGreaterThan(guide.indexOf("<body"));
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
