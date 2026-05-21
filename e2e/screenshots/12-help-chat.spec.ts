/**
 * Chapter 12 — Help Chat
 *
 * Two figures for the user-guide Help section:
 *   1. Empty state — drawer open with role-tailored starter chips and the
 *      "Or browse the full guide" CTA visible.
 *   2. Conversation — a starter chip clicked, the assistant's markdown-
 *      rendered answer in the thread, and the "Clear chat" affordance.
 *
 * The conversation shot mocks `/api/help-chat` with a canned SSE response
 * (matching the format the live route emits) so the screenshot is
 * deterministic — no Anthropic call, no model drift, no token spend.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { snap } from "./_helpers";

const CHAPTER = "12-help-chat";

test.describe.configure({ mode: "serial" });

test("help drawer — empty state with starter chips", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^help$/i }).click();
  // Drawer slides in with a transform animation. reducedMotion=reduce
  // freezes most of it, but Radix's Sheet exit/enter transform can still
  // be in flight when the heading first becomes "visible". Anchor on the
  // starter chip button instead — it's the lowest element in the drawer,
  // so once it's in the viewport the slide-in is definitively complete.
  await page
    .getByRole("button", { name: "How do I add a registration?" })
    .waitFor({ state: "visible" });
  // Hide the dev-only Sentry "1 issue" floating button — leaks into the
  // bottom-left of viewport-only shots in dev mode.
  await page.addStyleTag({
    content: "#sentry-feedback, [data-sentry-feedback], #__next-build-watcher { display: none !important; }",
  });

  await snap(page, {
    chapter: CHAPTER,
    name: "01-help-empty-state",
    viewportOnly: true,
  });
});

test("help drawer — conversation with markdown answer", async ({ page }) => {
  // Hermetic SSE mock — same wire format as src/app/api/help-chat/route.ts.
  // Markdown in the delta is the point: it exercises the ReactMarkdown
  // pipeline so the screenshot shows bold + bullet list rendered, not the
  // raw asterisks that would leak through if the renderer regressed.
  await page.route("**/api/help-chat", async (route) => {
    const sse =
      [
        `data: {"type":"text","delta":"To "}`,
        `data: {"type":"text","delta":"**add a registration**, open the **Registrations** tab on your event, then:\\n\\n- Click **Add Registration** in the top-right\\n- Pick a registration type and (if set up) a pricing tier\\n- Fill in the attendee's name, email, and country\\n- Click **Create**\\n\\nThe attendee receives a confirmation email automatically when there's an outstanding balance."}`,
        `data: {"type":"done","usage":{"inputTokens":3,"outputTokens":52,"cacheReadTokens":11789,"cacheWriteTokens":0}}`,
      ].join("\n\n") + "\n\n";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse,
    });
  });

  await loginAs(page, "ADMIN");
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^help$/i }).click();
  await page
    .getByRole("heading", { name: /help assistant/i })
    .waitFor({ state: "visible" });

  await page
    .getByRole("button", { name: "How do I add a registration?" })
    .click();

  // Anchor on a phrase that only appears after ReactMarkdown processes the
  // streamed body — confirms the assistant message has rendered before we
  // capture.
  await page
    .getByText(/registration type and/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  // Same Sentry/dev-overlay hide as the empty-state spec.
  await page.addStyleTag({
    content: "#sentry-feedback, [data-sentry-feedback], #__next-build-watcher { display: none !important; }",
  });

  await snap(page, {
    chapter: CHAPTER,
    name: "02-help-conversation",
    viewportOnly: true,
  });
});
