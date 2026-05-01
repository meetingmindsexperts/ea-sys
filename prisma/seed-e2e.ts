/**
 * Deterministic seed for the regression Playwright E2E suite.
 *
 * Runs against DATABASE_URL (expected to point at the test DB — see
 * playwright.config.ts, which passes DATABASE_URL_TEST through as DATABASE_URL).
 * Idempotent: deletes the fixed-ID org (cascades) and recreates it.
 *
 * For documentation/screenshot capture (which needs richer fixtures),
 * see prisma/seed-e2e-docs.ts — that file calls seedCore() and then layers
 * sessions, hotels, abstracts, and a webinar event on top.
 *
 * Fixed IDs / emails / passwords live in e2e/fixtures/seed-constants.ts so
 * specs and seed can't drift apart.
 */
import { PrismaClient } from "@prisma/client";
import { seedCore } from "./seed-e2e-core";
import {
  ORG_ID,
  EVENT_ID,
  EVENT_SLUG,
  FREE_CATEGORY_SLUG,
} from "../e2e/fixtures/seed-constants";

const db = new PrismaClient();

async function main() {
  console.log("[seed-e2e] starting");
  await seedCore(db);
  console.log(`[seed-e2e] done — org=${ORG_ID} event=${EVENT_ID} slug=${EVENT_SLUG} category=${FREE_CATEGORY_SLUG}`);
}

main()
  .catch((err) => {
    console.error("[seed-e2e] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
