/**
 * Route status matrix, domain 15 of the Phase 2 sweep, part A: organisation
 * settings (the organisation, its branding, the AI / Stripe / Zoom / EventsAir
 * credentials and their tests, API keys and OAuth clients, sign-in activity
 * and who is online, custom roles (permission sets) and who holds them, the
 * org-wide Onsite Staff list, signing a user out everywhere, the organisation
 * activity page). Part B (inviting and managing users) follows. Recorded on
 * the unswept code (Oct 5, 2026); the sweep onto `requirePermission` must
 * leave it byte for byte unchanged except where a change is intended and
 * reviewed. See ./harness.ts for what a cell means. None of these routes is
 * under an event, so every case runs once per caller.
 *
 * Changes re-recorded on purpose (Oct 5, 2026): the platform operator
 * (SUPER_ADMIN with no organisation) gets a clean 403 on the organisation PUT,
 * API keys, OAuth clients, the Onsite Staff list and the organisation activity
 * page, because their keys are organisation-wide and an organisation-wide key
 * needs an organisation (`can()`). It reached them with a null organisation
 * before (200, 404, or a 500 from a write). Production has no such account:
 * its one SUPER_ADMIN belongs to the organisation and holds every key.
 *
 * Every network call fails here (`fetch` is stubbed to throw), so no
 * credential test reaches Stripe, Zoom, EventsAir or a model provider.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-key")>()),
  validateApiKey: (await import("./harness")).mockValidateApiKey,
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as orgGET, PUT as orgPUT } from "@/app/api/organization/route";
import { GET as brandingGET } from "@/app/api/organization/branding/route";
import { GET as activeUsersGET } from "@/app/api/organization/active-users/route";
import { GET as loginActivityGET } from "@/app/api/organization/login-activity/route";
import { GET as aiGET, PUT as aiPUT, DELETE as aiDELETE } from "@/app/api/organization/ai/credentials/route";
import { POST as aiTestPOST } from "@/app/api/organization/ai/test-connection/route";
import { GET as stripeGET, PUT as stripePUT, DELETE as stripeDELETE } from "@/app/api/organization/stripe/credentials/route";
import { POST as stripeTestPOST } from "@/app/api/organization/stripe/test-connection/route";
import { GET as zoomGET, PUT as zoomPUT, DELETE as zoomDELETE } from "@/app/api/organization/zoom/credentials/route";
import { POST as zoomTestPOST } from "@/app/api/organization/zoom/test-connection/route";
import { GET as eaGET, PUT as eaPUT } from "@/app/api/organization/eventsair/credentials/route";
import { GET as eaEventsGET } from "@/app/api/organization/eventsair/events/route";
import { POST as eaTestPOST } from "@/app/api/organization/eventsair/test-connection/route";
import { GET as keysGET, POST as keysPOST } from "@/app/api/organization/api-keys/route";
import { DELETE as keyDELETE } from "@/app/api/organization/api-keys/[keyId]/route";
import { GET as oauthGET } from "@/app/api/organization/oauth-clients/route";
import { PATCH as oauthPATCH } from "@/app/api/organization/oauth-clients/[clientId]/route";
import { GET as setsGET, POST as setsPOST } from "@/app/api/organization/permission-sets/route";
import { PATCH as setPATCH } from "@/app/api/organization/permission-sets/[permissionSetId]/route";
import { GET as holdersGET } from "@/app/api/organization/permission-sets/holders/route";
import { GET as userSetsGET, PUT as userSetsPUT } from "@/app/api/organization/users/[userId]/permission-sets/route";
import { POST as revokePOST } from "@/app/api/organization/users/[userId]/revoke-sessions/route";
import { GET as onsiteListGET } from "@/app/api/organization/onsite-staff/route";
import { GET as orgActivityGET } from "@/app/api/activity/route";

const org = { perEvent: false } as const;
const user = { userId: "u-member" };

const CASES: HandlerCase[] = [
  { name: "GET organization", handler: orgGET, method: "GET", ...org },
  { name: "PUT organization", handler: orgPUT, method: "PUT", body: { name: "Renamed Org" }, ...org },
  { name: "GET organization/branding", handler: brandingGET, method: "GET", ...org },
  { name: "GET organization/active-users", handler: activeUsersGET, method: "GET", ...org },
  { name: "GET organization/login-activity", handler: loginActivityGET, method: "GET", ...org },
  { name: "GET organization/ai/credentials", handler: aiGET, method: "GET", ...org },
  { name: "PUT organization/ai/credentials", handler: aiPUT, method: "PUT", body: { provider: "anthropic", apiKey: "sk-test" }, ...org },
  { name: "DELETE organization/ai/credentials", handler: aiDELETE, method: "DELETE", ...org },
  { name: "POST organization/ai/test-connection", handler: aiTestPOST, method: "POST", body: {}, ...org },
  { name: "GET organization/stripe/credentials", handler: stripeGET, method: "GET", ...org },
  { name: "PUT organization/stripe/credentials", handler: stripePUT, method: "PUT", body: { secretKey: "sk_test_x" }, ...org },
  { name: "DELETE organization/stripe/credentials", handler: stripeDELETE, method: "DELETE", ...org },
  { name: "POST organization/stripe/test-connection", handler: stripeTestPOST, method: "POST", body: {}, ...org },
  { name: "GET organization/zoom/credentials", handler: zoomGET, method: "GET", ...org },
  { name: "PUT organization/zoom/credentials", handler: zoomPUT, method: "PUT", body: { accountId: "a", clientId: "c", clientSecret: "s" }, ...org },
  { name: "DELETE organization/zoom/credentials", handler: zoomDELETE, method: "DELETE", ...org },
  { name: "POST organization/zoom/test-connection", handler: zoomTestPOST, method: "POST", body: {}, ...org },
  { name: "GET organization/eventsair/credentials", handler: eaGET, method: "GET", ...org },
  { name: "PUT organization/eventsair/credentials", handler: eaPUT, method: "PUT", body: { clientId: "c", clientSecret: "s" }, ...org },
  { name: "GET organization/eventsair/events", handler: eaEventsGET, method: "GET", ...org },
  { name: "POST organization/eventsair/test-connection", handler: eaTestPOST, method: "POST", body: {}, ...org },
  { name: "GET organization/api-keys", handler: keysGET, method: "GET", ...org },
  { name: "POST organization/api-keys", handler: keysPOST, method: "POST", body: { name: "Matrix key" }, ...org },
  { name: "POST organization/api-keys (INTERNAL tier)", handler: keysPOST, method: "POST", body: { name: "Matrix key", rateLimitTier: "INTERNAL" }, ...org },
  { name: "DELETE organization/api-keys/[keyId]", handler: keyDELETE, method: "DELETE", params: { keyId: "k1" }, ...org },
  { name: "GET organization/oauth-clients", handler: oauthGET, method: "GET", ...org },
  { name: "PATCH organization/oauth-clients/[clientId]", handler: oauthPATCH, method: "PATCH", params: { clientId: "oc1" }, body: { rateLimitTier: "INTERNAL" }, ...org },
  { name: "GET organization/permission-sets", handler: setsGET, method: "GET", ...org },
  { name: "POST organization/permission-sets", handler: setsPOST, method: "POST", body: { name: "Matrix set", permissions: [] }, ...org },
  { name: "PATCH organization/permission-sets/[permissionSetId]", handler: setPATCH, method: "PATCH", params: { permissionSetId: "ps1" }, body: { name: "Renamed" }, ...org },
  { name: "GET organization/permission-sets/holders", handler: holdersGET, method: "GET", ...org },
  { name: "GET organization/users/[userId]/permission-sets", handler: userSetsGET, method: "GET", params: user, ...org },
  { name: "PUT organization/users/[userId]/permission-sets", handler: userSetsPUT, method: "PUT", params: user, body: { permissionSetIds: [] }, ...org },
  { name: "POST organization/users/[userId]/revoke-sessions", handler: revokePOST, method: "POST", params: user, body: {}, ...org },
  { name: "GET organization/onsite-staff", handler: onsiteListGET, method: "GET", ...org },
  { name: "GET activity (organisation)", handler: orgActivityGET, method: "GET", ...org },
];

describe("route status matrix: organisation settings (part A)", () => {
  beforeAll(() => {
    // Custom roles (permission sets) live behind the procurement module flag.
    vi.stubEnv("PROCUREMENT_MODULE_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("organisation settings (part A)", CASES)).toMatchFileSnapshot("./__snapshots__/org-settings.matrix.txt");
  });
});
