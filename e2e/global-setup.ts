import { execSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";

export default async function globalSetup() {
  // Playwright runs outside Next.js, so .env.local isn't auto-loaded.
  // Pull it in here so DATABASE_URL_TEST can live alongside the other secrets.
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const dbUrl = process.env.DATABASE_URL_TEST;
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL_TEST is not set. Add it to .env.local, .env, or your shell before running Playwright."
    );
  }

  const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl };

  console.log("[playwright:setup] syncing schema to test DB");
  execSync("npx prisma db push --skip-generate", { env, stdio: "inherit" });

  console.log("[playwright:setup] seeding fixture data");
  execSync("npx tsx prisma/seed-e2e.ts", { env, stdio: "inherit" });
}
