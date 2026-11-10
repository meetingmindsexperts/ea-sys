import { expect, test } from "@playwright/test";
import { EVENT_ID } from "./fixtures/seed-constants";
import { loginAs } from "./fixtures/login";

// Each test uses its own context so cookies don't leak between roles.
test.describe("RBAC middleware redirects", () => {
  test("REGISTRANT is routed to /my-account from any dashboard page", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAs(page, "REGISTRANT", { expectUrl: /\/my-account/ });

    // Manually try to reach dashboard/events — middleware should bounce
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/my-account/);

    await page.goto("/events");
    await expect(page).toHaveURL(/\/my-account/);

    await context.close();
  });

  test("a signed-out visit to a portal page goes to sign-in and keeps the page to return to", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // An emailed link (a replay, a certificate) opened signed out: the
    // dashboard layout's bare /login used to win and the destination was lost.
    await page.goto("/my-account/certificates");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmy-account%2Fcertificates$/);

    await context.close();
  });

  test("REVIEWER is kept out of dashboard and non-abstract event routes", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Login posts to /login with callbackUrl=/dashboard (default); middleware
    // then redirects reviewers from /dashboard → /events.
    await loginAs(page, "REVIEWER", { expectUrl: /\/events(?:\?|$|\/)/ });

    await page.goto(`/events/${EVENT_ID}/registrations`);
    await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/abstracts`));

    await page.goto(`/events/${EVENT_ID}/abstracts`);
    await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/abstracts`));

    await context.close();
  });

  test("SUBMITTER is kept out of dashboard and non-abstract event routes", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAs(page, "SUBMITTER", { expectUrl: /\/events(?:\?|$|\/)/ });

    await page.goto(`/events/${EVENT_ID}/speakers`);
    await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/abstracts`));

    await page.goto("/events/new");
    await expect(page).toHaveURL(/\/events(?!\/new)/);

    await context.close();
  });
});
