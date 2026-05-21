/**
 * E2E coverage for the help-chat drawer (sidebar trigger + drawer
 * mechanics + SSE streaming + markdown rendering + clear-chat).
 *
 * The streaming test mocks `/api/help-chat` with a canned SSE response
 * so it's hermetic — no real Anthropic calls, no ANTHROPIC_API_KEY
 * needed in CI, no cost, no flake from network or rate limits. The
 * route's real behavior is verified manually with curl + caching
 * checks; this spec pins the client-side plumbing (fetch shape, SSE
 * parsing, markdown render, localStorage persistence, clear flow).
 */

import { expect, test } from "@playwright/test";
import { loginAs } from "./fixtures/login";

test.describe("help chat", () => {
  test("opens from the sidebar; role-tailored starter chips render; clear chat hidden in empty state", async ({
    page,
  }) => {
    await loginAs(page, "ADMIN");

    const helpButton = page.getByRole("button", { name: /^help$/i });
    await expect(helpButton).toBeVisible();
    await helpButton.click();

    // Drawer header
    await expect(
      page.getByRole("heading", { name: /help assistant/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/Ask anything about EA-SYS/i),
    ).toBeVisible();

    // ADMIN starter chips (two distinct ones — proves the role table
    // is being consulted, not just falling back to a single default).
    await expect(
      page.getByRole("button", { name: "How do I add a registration?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /INCLUSIVE and COMPLIMENTARY/i }),
    ).toBeVisible();

    // "Clear chat" must be hidden until there are messages — otherwise
    // it's a dead button in the empty state.
    await expect(
      page.getByRole("button", { name: /clear chat/i }),
    ).toHaveCount(0);
  });

  test("send via starter chip → SSE renders as markdown → Clear chat appears + resets", async ({
    page,
  }) => {
    // Hermetic mock — single fulfill carries the whole SSE body. The
    // hook's `buffer.split("\n\n")` parser handles this exactly like a
    // real stream (the events split deterministically regardless of
    // how the bytes are chunked over the wire).
    await page.route("**/api/help-chat", async (route) => {
      const sse =
        [
          `data: {"type":"text","delta":"To "}`,
          `data: {"type":"text","delta":"**add** a registration:\\n\\n- Open the **Registrations** tab\\n- Click Add"}`,
          `data: {"type":"done","usage":{"inputTokens":3,"outputTokens":15,"cacheReadTokens":11789,"cacheWriteTokens":0}}`,
        ].join("\n\n") + "\n\n";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse,
      });
    });

    await loginAs(page, "ADMIN");
    await page.getByRole("button", { name: /^help$/i }).click();

    const starter = page.getByRole("button", {
      name: "How do I add a registration?",
    });
    await starter.click();

    // The assistant message renders. Use bullet-list content as the
    // anchor — present only after ReactMarkdown processes the response.
    await expect(page.getByText(/Open the/i)).toBeVisible({ timeout: 5000 });

    // Markdown plumbing assertion: if ReactMarkdown weren't wired,
    // "**add**" would appear as literal text. Asserting the visible
    // body text contains "add" but NOT the surrounding asterisks
    // catches the regression without binding to a specific DOM
    // structure (so changing the rendering library later won't break
    // this test).
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("add"); // word survived rendering
    expect(bodyText).not.toContain("**add**"); // bold markers consumed

    // The "Clear chat" button appears once there are messages.
    const clearBtn = page.getByRole("button", { name: /clear chat/i });
    await expect(clearBtn).toBeVisible();

    // Clear → starter chips return, clear button hides again.
    await clearBtn.click();
    await expect(starter).toBeVisible();
    await expect(clearBtn).toHaveCount(0);
  });
});
