import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_PASSWORD, EVENT_ID, EVENT_SLUG, ORG_ID, USERS } from "../fixtures/seed-constants";
import { RLS_OWNER_URL } from "./rls-env";

/**
 * Every PAGE, asked as each seeded role and signed out, with row security on.
 *
 * route-smoke.spec.ts already asks every GET route handler, and it runs in
 * this suite too. It does not ask the pages, and a server-rendered page reads
 * the database itself (the dashboard, an event's pages, the public event page,
 * the catalogue, the sitemap). Under a policy a read made outside a tenant
 * lane is not an error, it is an empty page, and the server's detector
 * (RLS_SHADOW=1) names it in the log that server-log.spec.ts reads next.
 *
 * WHAT THIS SPEC CAN AND CANNOT SEE. A page here streams (there is a root
 * loading.tsx), so the status is 200 before the page's own code runs: a page
 * whose server component throws still answers 200. The status check below
 * catches only a failure before the first byte, and a page that never
 * finishes. A page that throws is caught by server-log.spec.ts, which fails
 * on the `request:unhandled-error` line the server writes for it. This spec's
 * job is to make every page RUN, to the end.
 */

const APP = path.resolve(process.cwd(), "src/app");
const NO_SUCH_ID = "cmzzzzzzzzzzzzzzzzzzzzzzz";
const FIXED: Record<string, string> = {
  eventId: EVENT_ID, slug: EVENT_SLUG, orgId: ORG_ID, token: "smoke-token-0000000000000000", index: "0",
  nextauth: "session", path: "smoke", kind: "specialty", topic: "cardiology", category: "free-pass",
};
/** A route parameter whose model is not its own name minus "Id". */
const MODEL_FOR_PARAM: Record<string, string> = {
  sessionId: "eventSession", ticketId: "ticketType", campaignId: "rsvpCampaign", roomId: "roomType", dealId: "crmDeal",
  companyId: "crmCompany", crmContactId: "crmContact", quoteId: "crmQuote", threadId: "crmEmailThread",
  messageId: "crmEmailMessage", projectId: "crmProject", proposalId: "sessionProposal", pollId: "livePoll",
  documentId: "speakerDocument", templateId: "certificateTemplate", certificateId: "issuedCertificate",
  runId: "certificateIssueRun", requestId: "spendRequest", commitmentId: "commitment", budgetId: "eventBudget",
  reimbursementId: "speakerReimbursement", groupId: "registrationGroup",
};
const PARAM = /\[(?:\.\.\.)?([^\]]+)\]/g;

interface Target { pattern: string }

function findTargets(): Target[] {
  const found: Target[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const isPage = entry.name === "page.tsx";
      // The sitemap and robots files are pages in all but name: no route.ts, and the sitemap reads events.
      const isMeta = dir === APP && (entry.name === "sitemap.ts" || entry.name === "robots.ts");
      if (!isPage && !isMeta) continue;
      const segments = path.relative(APP, dir).split(path.sep).filter((s) => s !== "" && !(s.startsWith("(") && s.endsWith(")")));
      let pattern = `/${segments.join("/")}`;
      if (isMeta) pattern = entry.name === "sitemap.ts" ? "/sitemap.xml" : "/robots.txt";
      found.push({ pattern });
    }
  };
  walk(APP);
  return found.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** A real row id for each address parameter, from the seeded event where the table has one. */
async function findIds(targets: Target[]): Promise<Record<string, string | null>> {
  const db = new PrismaClient({ datasourceUrl: RLS_OWNER_URL });
  const ids: Record<string, string | null> = {};
  try {
    const names = new Set(targets.flatMap((t) => [...t.pattern.matchAll(PARAM)].map((m) => m[1])));
    for (const name of names) {
      if (name in FIXED) continue;
      const model = (db as unknown as Record<string, { findFirst?: (args: object) => Promise<{ id: string } | null> }>)[
        MODEL_FOR_PARAM[name] ?? name.replace(/Id$/, "")
      ];
      let row: { id: string } | null = null;
      if (model?.findFirst) {
        row = await model.findFirst({ where: { eventId: EVENT_ID }, select: { id: true } }).catch(() => null);
        row ??= await model.findFirst({ select: { id: true } }).catch(() => null);
      }
      ids[name] = row?.id ?? null;
    }
  } finally {
    await db.$disconnect();
  }
  return ids;
}

test("every page answers, as each role and signed out", async ({ browser, baseURL }) => {
  test.setTimeout(20 * 60_000);
  const targets = findTargets();
  expect(targets.length, "the walk of src/app found the pages").toBeGreaterThan(100);
  const ids = await findIds(targets);
  const urlFor = (pattern: string) => pattern.replace(PARAM, (_m, name: string) => FIXED[name] ?? ids[name] ?? NO_SUCH_ID);

  const bad: string[] = [];
  for (const user of [...USERS, null]) {
    const who = user?.email ?? "signed out";
    let cookie = "";
    if (user) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseURL}/login`);
      // Wait for ONE email field. For a moment after it loads, the page can
      // hold the form twice (the server's copy and the browser's own), and
      // filling "the" field then fails; it settles to one.
      await expect(page.getByLabel("Email")).toHaveCount(1, { timeout: 15_000 });
      await page.getByLabel("Email").fill(user.email);
      await page.getByLabel("Password").fill(DEFAULT_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
      cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      await context.close();
    }
    const queue = [...targets];
    const counts: Record<string, number> = {};
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          const url = urlFor(target.pattern);
          let status: string;
          try {
            const res = await fetch(`${baseURL}${url}`, {
              headers: cookie ? { cookie } : {},
              redirect: "manual",
              signal: AbortSignal.timeout(60_000),
            });
            status = String(res.status);
            // Read to the end. A page streams: the status is sent with the
            // shell, before the page's own reads run. Hanging up early cut
            // those reads short AND made the server log an error of its own
            // for every page (434 of them in the first run), which would have
            // buried a real one.
            await res.arrayBuffer();
          } catch (error) {
            status = `no answer (${(error as Error).name})`;
          }
          counts[status] = (counts[status] ?? 0) + 1;
          const failed = !/^\d+$/.test(status) || Number(status) >= 500;
          if (failed) bad.push(`${who}  ${status}  ${url}`);
        }
      }),
    );
    console.log(`[e2e:rls] ${who}: ${targets.length} asked ${JSON.stringify(counts)}`);
  }
  expect(bad, "5xx or no answer under row security").toEqual([]);
});
