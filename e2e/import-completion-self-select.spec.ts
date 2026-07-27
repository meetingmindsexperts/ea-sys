/**
 * Organizer imports registrations WITHOUT a registration type, then the
 * registrant states their own type on the completion form ("Send Registration
 * Forms" → /e/[slug]/complete-registration?token=…).
 *
 * This is the flow behind the July 27 2026 import fix. Before it:
 *   • the importer silently defaulted typeless rows onto an arbitrary ticket
 *     type — on real events, one literally named "Faculty";
 *   • the completion page threw on a null type (`data.ticketType.name`), so a
 *     typeless registrant got a white screen and could never complete.
 *
 * The email SEND itself is deliberately not clicked: `sendEmail` goes to real
 * SES, so a spec that clicked it would either bounce mail from a test run or
 * depend on local AWS credentials. The token is minted here exactly as
 * send-completion-emails/route.ts mints it (same `reg:<id>` identifier, same
 * hash), which is the part the registrant's link actually depends on.
 */
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { EVENT_ID, EVENT_SLUG, PAID_TICKET_TYPE_ID } from "./fixtures/seed-constants";
import { loginAs, pickSelect } from "./fixtures/login";

const dbUrl = process.env.DATABASE_URL_TEST;
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

test.afterAll(async () => {
  await db.$disconnect();
});

/** Close the topmost dialog. */
async function guestEscape(page: import("@playwright/test").Page) {
  await page.keyboard.press("Escape");
}

/** Mirrors hashVerificationToken() in src/lib/security.ts — sha256 of the raw
 *  token peppered with NEXTAUTH_SECRET (imported rather than re-implemented
 *  would be nicer, but specs can't resolve the "@/" alias). */
function hashToken(raw: string) {
  const pepper = process.env.NEXTAUTH_SECRET;
  if (!pepper) throw new Error("NEXTAUTH_SECRET is required to mint a completion token");
  return createHash("sha256").update(`${raw}:${pepper}`).digest("hex");
}

test("imported-without-a-type registrant picks their own type and is priced for it", async ({
  page,
  context,
}) => {
  const email = `csv-import-e2e+${Date.now()}@test.local`;

  // ── 1. Organizer imports a CSV with NO registrationType column ──────────
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/registrations`);

  await page.getByRole("button", { name: /import csv/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/registration type for rows without one/i)).toBeVisible();

  // Leave the fallback picker on "Leave blank" — the whole point of the run.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "registrations.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`firstName,lastName,email\nCsv,Importee,${email}\n`),
  });
  await dialog.getByRole("button", { name: /^import$/i }).click();

  // Reported honestly rather than silently typed.
  await expect(dialog.getByText(/1 with no registration type/i)).toBeVisible({ timeout: 20_000 });
  // Escape rather than a Close button — the dialog has both a footer "Close"
  // and Radix's built-in X, so the role query is ambiguous.
  await guestEscape(page);

  const registration = await db.registration.findFirstOrThrow({
    where: { eventId: EVENT_ID, attendee: { email } },
    select: { id: true, ticketTypeId: true, paymentStatus: true },
  });
  expect(registration.ticketTypeId).toBeNull();

  const soldBefore = (
    await db.ticketType.findUniqueOrThrow({
      where: { id: PAID_TICKET_TYPE_ID },
      select: { soldCount: true },
    })
  ).soldCount;

  // ── 2. Mint the completion link the organizer would have emailed ────────
  const rawToken = `e2e-completion-${Date.now()}`;
  await db.verificationToken.create({
    data: {
      identifier: `reg:${registration.id}`,
      token: hashToken(rawToken),
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  // ── 3. Registrant opens it logged-out and completes ─────────────────────
  const guest = await context.browser()!.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(`/e/${EVENT_SLUG}/complete-registration?token=${rawToken}`);

  // The picker only exists because the registration has no type. Before the
  // fix this page threw during render instead.
  await expect(guestPage.getByRole("heading", { name: /registration type/i })).toBeVisible({
    timeout: 20_000,
  });
  const standard = guestPage.getByRole("button", { name: /standard/i }).first();
  await expect(standard).toContainText("100");
  await standard.click();

  await pickSelect(guestPage, "Title", "Dr.");
  await guestPage.getByPlaceholder("Physician").fill("Consultant");
  await guestPage.getByPlaceholder("Acme Inc.").fill("E2E Hospital");
  await guestPage.getByPlaceholder("+1 234 567 8900").fill("+971500000001");
  await pickSelect(guestPage, "Select country", "United Arab Emirates");
  await guestPage.getByPlaceholder("Dubai").fill("Dubai");
  await pickSelect(guestPage, "Select role", "Physician");
  await pickSelect(guestPage, "Select specialty", "Cardiology");
  await guestPage.getByRole("checkbox").last().check();

  await Promise.all([
    guestPage.waitForURL(new RegExp(`/e/${EVENT_SLUG}/confirmation`), { timeout: 30_000 }),
    guestPage.getByRole("button", { name: /complete registration/i }).click(),
  ]);

  // The confirmation page drives Pay Now off this — a paid completion that
  // came through as "free" is exactly the silent revenue hole being guarded.
  expect(new URL(guestPage.url()).searchParams.get("price")).toBe("100");

  // ── 4. The registration is now typed, priced and payable ────────────────
  const after = await db.registration.findUniqueOrThrow({
    where: { id: registration.id },
    select: {
      ticketTypeId: true,
      paymentStatus: true,
      originalPrice: true,
      attendee: { select: { registrationType: true } },
    },
  });
  expect(after.ticketTypeId).toBe(PAID_TICKET_TYPE_ID);
  expect(Number(after.originalPrice)).toBe(100);
  expect(after.paymentStatus).toBe("UNASSIGNED"); // money is now owed
  expect(after.attendee.registrationType).toBe("Standard");

  // The seat is claimed at completion, not at import.
  const soldAfter = (
    await db.ticketType.findUniqueOrThrow({
      where: { id: PAID_TICKET_TYPE_ID },
      select: { soldCount: true },
    })
  ).soldCount;
  expect(soldAfter).toBe(soldBefore + 1);

  await guest.close();
});
