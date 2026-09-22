import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { REPORT_DIR, RUN_FILE, TASKS_FILE, tokenCap } from "./_report";

/**
 * Golden-set globalSetup: the same schema push + seed shape as the
 * regression e2e setup, with the richer golden seed, a fail-fast check
 * that a model key is present (every task is a real model call), and a
 * fresh report directory so this run's numbers never mix with the last.
 */
export default async function globalSetupGolden() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const dbUrl = process.env.DATABASE_URL_TEST;
  if (!dbUrl) {
    throw new Error("DATABASE_URL_TEST is not set. Add it to .env.local before running the golden task set.");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. The golden task set makes real model calls; add the key to .env.");
  }

  const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl };

  console.log("[agent-golden:setup] syncing schema to test DB");
  execSync("npx prisma db push --skip-generate", { env, stdio: "inherit" });

  console.log("[agent-golden:setup] seeding golden fixture data");
  execSync("npx tsx prisma/seed-e2e-golden.ts", { env, stdio: "inherit" });

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(TASKS_FILE, "");
  fs.writeFileSync(
    RUN_FILE,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        modelOverride: process.env.AGENT_MODEL ?? null,
        tokenCap: tokenCap(),
      },
      null,
      2,
    ),
  );
  console.log(`[agent-golden:setup] report dir ${REPORT_DIR}, token cap ${tokenCap()}`);
}
