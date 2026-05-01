import { execSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Documentation-only globalSetup — runs the richer seed-e2e-docs.ts so
 * screenshot specs have populated sessions / hotels / abstracts / a
 * webinar event with attendance + polls + Q&A. Used exclusively by
 * playwright.docs.config.ts; the regression suite continues to use the
 * leaner seed-e2e.ts via e2e/global-setup.ts.
 */
export default async function globalSetupDocs() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const dbUrl = process.env.DATABASE_URL_TEST;
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL_TEST is not set. Add it to .env.local, .env, or your shell before running screenshot capture.",
    );
  }

  const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl };

  console.log("[playwright:setup-docs] syncing schema to test DB");
  execSync("npx prisma db push --skip-generate", { env, stdio: "inherit" });

  console.log("[playwright:setup-docs] seeding docs fixture data");
  execSync("npx tsx prisma/seed-e2e-docs.ts", { env, stdio: "inherit" });
}
