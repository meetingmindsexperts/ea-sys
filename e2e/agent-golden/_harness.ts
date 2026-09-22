/**
 * The Playwright side of the golden task set: signs in as a seeded account,
 * sends one request through POST /api/agent/execute exactly as the chat
 * page does (same body, same approval round trip), reads the SSE stream,
 * then loads the stored run(s) so a spec grades the recorded steps rather
 * than the wire. One `golden` fixture per test; the fixture writes the
 * task's report line when the test ends.
 *
 * Why HTTP rather than the loop in-process: the handler's role check, rate
 * limit, event binding, approval-token verification and run recording are
 * all part of what a person hits, and a golden run should hit them too.
 */
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  accountIndex,
  allSteps,
  approvalRequests,
  parseSse,
  replyText,
  runTotals,
  sseError,
  sumChargedTokens,
  type GoldenRun,
  type GoldenStep,
  type NeedsApproval,
  type SseEvent,
} from "./_grade";
import { appendTaskLine, readTaskLines, tokenCap } from "./_report";
import { GOLDEN_ADMINS, GOLDEN_MEMBER, GOLDEN_PASSWORD } from "./_seed-constants";

export { expect };

export type Actor = "admin" | "member";

export interface AskOptions {
  message: string;
  /** The event the request is about; omit (or null) for the org door. */
  eventId?: string | null;
  /** What to do with an approval card: leave it (default), approve it, or cancel it (a cancel never reaches the server). */
  approval?: "none" | "approve" | "cancel";
  /** Who asks; admins rotate over the seeded pool, "member" is the one MEMBER. */
  as?: Actor;
  /** Prior turns, as the page would send them. */
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface AskResult {
  status: number;
  /** The reply to the request itself. */
  reply: string;
  /** The reply to the approval round trip, when one was made. */
  approvalReply: string | null;
  events: SseEvent[];
  approvals: NeedsApproval[];
  /** The request's run, then the approval's run when one was made. */
  runs: GoldenRun[];
  firstRun: GoldenRun;
  /** Steps of the request's run only. */
  firstSteps: GoldenStep[];
  /** Steps across every run this ask produced. */
  steps: GoldenStep[];
}

export interface Golden {
  db: PrismaClient;
  /** The admin account this test runs as. */
  admin: { email: string };
  member: { email: string };
  ask(opts: AskOptions): Promise<AskResult>;
}

let prisma: PrismaClient | null = null;
function testDb(): PrismaClient {
  if (!prisma) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error("DATABASE_URL_TEST is not set");
    prisma = new PrismaClient({ datasourceUrl: url });
  }
  return prisma;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(GOLDEN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

function toRun(row: {
  id: string;
  outcome: string;
  errorClass: string | null;
  turns: number;
  toolCalls: number;
  writes: number;
  refusals: number;
  approvalsRequested: number;
  approvalsRun: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number | null;
  model: string | null;
  reply: string | null;
  steps: { seq: number; tool: string; outcome: string; code: string | null; write: boolean; approved: boolean; durationMs: number; input: unknown }[];
}): GoldenRun {
  return {
    id: row.id,
    outcome: row.outcome,
    errorClass: row.errorClass,
    turns: row.turns,
    toolCalls: row.toolCalls,
    writes: row.writes,
    refusals: row.refusals,
    approvalsRequested: row.approvalsRequested,
    approvalsRun: row.approvalsRun,
    toolErrors: row.toolErrors,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    durationMs: row.durationMs,
    model: row.model,
    reply: row.reply,
    steps: row.steps.map((s) => ({
      seq: s.seq,
      tool: s.tool,
      outcome: s.outcome,
      code: s.code,
      write: s.write,
      approved: s.approved,
      durationMs: s.durationMs,
      input: s.input,
    })),
  };
}

/**
 * The runs an account started since `since`, oldest first. Step rows are
 * written fire-and-forget by the recorder, so this polls briefly until
 * every run's steps match its toolCalls count.
 */
async function loadRuns(db: PrismaClient, userId: string, since: Date, expected: number): Promise<GoldenRun[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await db.agentRun.findMany({
      where: { userId, startedAt: { gte: since } },
      orderBy: { startedAt: "asc" },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
    const settled =
      rows.length >= expected &&
      rows.every((r) => r.outcome !== "RUNNING" && r.steps.length >= r.toolCalls);
    if (settled || Date.now() > deadline) return rows.map(toRun);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function postExecute(page: Page, body: Record<string, unknown>) {
  // The middleware refuses an authenticated API mutation with no Origin
  // (src/proxy.ts, the CSRF rule); a browser sends its own, so the harness
  // sends the app's, exactly as the chat page's fetch does.
  const origin = new URL(page.url()).origin;
  const res = await page.request.post("/api/agent/execute", {
    data: body,
    headers: { "content-type": "application/json", origin },
    timeout: 230_000,
  });
  const text = await res.text();
  return { status: res.status(), text };
}

export const test = base.extend<{ golden: Golden }>({
  // Playwright names this callback `use`; the lint rule for React hooks keys on that name.
  golden: async ({ page }, provide, testInfo: TestInfo) => {
    const spent = sumChargedTokens(readTaskLines());
    const cap = tokenCap();
    if (spent > cap) {
      testInfo.skip(true, `token cap reached: ${spent} charged tokens > ${cap} (AGENT_GOLDEN_TOKEN_CAP)`);
    }

    const db = testDb();
    const admin = GOLDEN_ADMINS[accountIndex(testInfo.title, testInfo.repeatEachIndex, GOLDEN_ADMINS.length)];
    const member = GOLDEN_MEMBER;
    let signedInAs: string | null = null;
    const runsThisTest: GoldenRun[] = [];
    let lastAccount = admin.email;
    const t0 = Date.now();

    const golden: Golden = {
      db,
      admin,
      member,
      async ask(opts) {
        const actor = opts.as ?? "admin";
        const account = actor === "member" ? member.email : admin.email;
        lastAccount = account;
        if (signedInAs !== account) {
          await signIn(page, account);
          signedInAs = account;
        }
        const user = await db.user.findUnique({ where: { email: account }, select: { id: true } });
        if (!user) throw new Error(`golden account ${account} is not seeded`);

        const since = new Date(Date.now() - 1000);
        const eventId = opts.eventId ?? null;
        const first = await postExecute(page, { message: opts.message, history: opts.history ?? [], eventId });
        if (first.status !== 200) {
          throw new Error(`POST /api/agent/execute returned ${first.status}: ${first.text.slice(0, 300)}`);
        }
        const events = parseSse(first.text);
        const err = sseError(events);
        if (err) throw new Error(`agent stream ended in error: ${err}`);
        const reply = replyText(events);
        const approvals = approvalRequests(events);

        let approvalReply: string | null = null;
        let expectedRuns = 1;
        if (opts.approval === "approve" && approvals.length > 0) {
          const a = approvals[0];
          const history = [
            ...(opts.history ?? []),
            { role: "user" as const, content: opts.message },
            ...(reply ? [{ role: "assistant" as const, content: reply }] : []),
          ];
          const second = await postExecute(page, {
            message: `Approved: ${a.label}.`,
            history,
            eventId,
            approval: { toolName: a.toolName, input: a.input, token: a.token },
          });
          if (second.status !== 200) {
            throw new Error(`approval POST returned ${second.status}: ${second.text.slice(0, 300)}`);
          }
          const secondEvents = parseSse(second.text);
          const secondErr = sseError(secondEvents);
          if (secondErr) throw new Error(`approval stream ended in error: ${secondErr}`);
          approvalReply = replyText(secondEvents);
          expectedRuns = 2;
        }

        const runs = await loadRuns(db, user.id, since, expectedRuns);
        if (runs.length < 1) throw new Error("no AgentRun row was recorded for the request");
        runsThisTest.push(...runs);
        return {
          status: first.status,
          reply,
          approvalReply,
          events,
          approvals,
          runs,
          firstRun: runs[0],
          firstSteps: runs[0].steps,
          steps: allSteps(runs),
        };
      },
    };

    await provide(golden);

    const totals = runTotals(runsThisTest);
    const firstError = testInfo.errors[0]?.message;
    appendTaskLine({
      title: testInfo.title,
      file: testInfo.file.split("/").slice(-1)[0],
      status: testInfo.status ?? "unknown",
      account: lastAccount,
      repeat: testInfo.repeatEachIndex,
      runIds: runsThisTest.map((r) => r.id),
      model: runsThisTest.find((r) => r.model)?.model ?? null,
      ...totals,
      wallMs: Date.now() - t0,
      ...(firstError ? { error: firstError.slice(0, 600) } : {}),
    });
  },
});
