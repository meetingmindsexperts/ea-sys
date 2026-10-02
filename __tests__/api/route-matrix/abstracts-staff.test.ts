/**
 * Route status matrix, domain 5 part A of the Phase 2 sweep: the staff side
 * of abstracts and session proposals (themes and sub-themes, proposal themes,
 * review criteria, the reviewer pool, an abstract's reviewer assignment, the
 * resend and presenter-agreement emails, the share links). Recorded on the
 * unswept code (Oct 2, 2026); the sweep onto `requirePermission` must leave it
 * byte for byte unchanged. See ./harness.ts for what a cell means.
 *
 * Part B (the abstract and proposal routes where REVIEWER and SUBMITTER also
 * write) is a separate file, because those roles keep their own checks (plan
 * §1).
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({
  validateApiKey: (await import("./harness")).mockValidateApiKey,
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as themesGET, POST as themesPOST } from "@/app/api/events/[eventId]/abstract-themes/route";
import { PUT as themePUT, DELETE as themeDELETE } from "@/app/api/events/[eventId]/abstract-themes/[themeId]/route";
import { POST as subThemesPOST } from "@/app/api/events/[eventId]/abstract-themes/[themeId]/sub-themes/route";
import { PUT as subThemePUT, DELETE as subThemeDELETE } from "@/app/api/events/[eventId]/abstract-themes/[themeId]/sub-themes/[subThemeId]/route";
import { GET as pThemesGET, POST as pThemesPOST } from "@/app/api/events/[eventId]/session-proposal-themes/route";
import { PUT as pThemePUT, DELETE as pThemeDELETE } from "@/app/api/events/[eventId]/session-proposal-themes/[themeId]/route";
import { GET as criteriaGET, POST as criteriaPOST } from "@/app/api/events/[eventId]/review-criteria/route";
import { PUT as criterionPUT, DELETE as criterionDELETE } from "@/app/api/events/[eventId]/review-criteria/[criterionId]/route";
import { GET as reviewersGET, POST as reviewersPOST } from "@/app/api/events/[eventId]/reviewers/route";
import { DELETE as reviewerDELETE } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/route";
import { POST as reviewerResendPOST } from "@/app/api/events/[eventId]/reviewers/[reviewerId]/resend-invitation/route";
import { GET as absReviewersGET, POST as absReviewersPOST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route";
import { DELETE as absReviewerDELETE } from "@/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/[userId]/route";
import { POST as resendConfirmationPOST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/resend-confirmation/route";
import { POST as presenterAgreementPOST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/presenter-agreement/email/route";
import { GET as sharesGET, PUT as sharesPUT, POST as sharesPOST } from "@/app/api/events/[eventId]/submission-shares/route";

const theme = { themeId: "th1" };
const sub = { themeId: "th1", subThemeId: "st1" };
const crit = { criterionId: "cr1" };
const rev = { reviewerId: "u-rev1" };
const abs = { abstractId: "ab1" };

const CASES: HandlerCase[] = [
  { name: "GET abstract-themes", handler: themesGET, method: "GET" },
  { name: "POST abstract-themes", handler: themesPOST, method: "POST", body: { name: "Cardiology" } },
  { name: "PUT abstract-themes/[themeId]", handler: themePUT, method: "PUT", params: theme, body: { name: "Cardio" } },
  { name: "DELETE abstract-themes/[themeId]", handler: themeDELETE, method: "DELETE", params: theme },
  { name: "POST abstract-themes/[themeId]/sub-themes", handler: subThemesPOST, method: "POST", params: theme, body: { name: "Heart failure" } },
  { name: "PUT abstract-themes/[themeId]/sub-themes/[subThemeId]", handler: subThemePUT, method: "PUT", params: sub, body: { name: "HF" } },
  { name: "DELETE abstract-themes/[themeId]/sub-themes/[subThemeId]", handler: subThemeDELETE, method: "DELETE", params: sub },
  { name: "GET session-proposal-themes", handler: pThemesGET, method: "GET" },
  { name: "POST session-proposal-themes", handler: pThemesPOST, method: "POST", body: { name: "Workshops" } },
  { name: "PUT session-proposal-themes/[themeId]", handler: pThemePUT, method: "PUT", params: theme, body: { name: "Labs" } },
  { name: "DELETE session-proposal-themes/[themeId]", handler: pThemeDELETE, method: "DELETE", params: theme },
  { name: "GET review-criteria", handler: criteriaGET, method: "GET" },
  { name: "POST review-criteria", handler: criteriaPOST, method: "POST", body: { name: "Novelty", weight: 30 } },
  { name: "PUT review-criteria/[criterionId]", handler: criterionPUT, method: "PUT", params: crit, body: { weight: 40 } },
  { name: "DELETE review-criteria/[criterionId]", handler: criterionDELETE, method: "DELETE", params: crit },
  { name: "GET reviewers", handler: reviewersGET, method: "GET" },
  { name: "POST reviewers", handler: reviewersPOST, method: "POST", body: { type: "direct", email: "rev@x.test", firstName: "R", lastName: "V" } },
  { name: "DELETE reviewers/[reviewerId]", handler: reviewerDELETE, method: "DELETE", params: rev },
  { name: "POST reviewers/[reviewerId]/resend-invitation", handler: reviewerResendPOST, method: "POST", params: rev, body: {} },
  { name: "GET abstracts/[abstractId]/reviewers", handler: absReviewersGET, method: "GET", params: abs },
  { name: "POST abstracts/[abstractId]/reviewers", handler: absReviewersPOST, method: "POST", params: abs, body: { userId: "u-rev1" } },
  { name: "DELETE abstracts/[abstractId]/reviewers/[userId]", handler: absReviewerDELETE, method: "DELETE", params: { abstractId: "ab1", userId: "u-rev1" } },
  { name: "POST abstracts/[abstractId]/resend-confirmation", handler: resendConfirmationPOST, method: "POST", params: abs, body: {} },
  { name: "POST abstracts/[abstractId]/presenter-agreement/email", handler: presenterAgreementPOST, method: "POST", params: abs, body: {} },
  { name: "GET submission-shares", handler: sharesGET, method: "GET", query: "kind=ABSTRACTS" },
  { name: "PUT submission-shares", handler: sharesPUT, method: "PUT", body: { kind: "ABSTRACTS", enabled: true, statuses: [], fields: [] } },
  { name: "POST submission-shares (regenerate)", handler: sharesPOST, method: "POST", body: { kind: "ABSTRACTS", action: "regenerate" } },
];

describe("route status matrix: abstracts and proposals, staff side", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("abstracts and proposals, staff side", CASES)).toMatchFileSnapshot(
      "./__snapshots__/abstracts-staff.matrix.txt",
    );
  });
});
