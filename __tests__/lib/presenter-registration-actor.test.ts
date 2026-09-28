/**
 * The public presenter sign-up has no staff member acting. It used to hand
 * the registration service `userId: ""`, which is not a user, so the audit
 * row failed its foreign key and was lost (prod, Sep 26 2026 20:08 UTC, the
 * first public presenter sign-up with a paid rate). The registration itself
 * was fine; the audit trail was not. Now it passes null, as every other
 * public write does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createRegistration } = vi.hoisted(() => ({ createRegistration: vi.fn() }));
vi.mock("@/services/registration-service", () => ({ createRegistration }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createAndLinkPayableRegistration } from "@/lib/presenter-registration";

const speaker = {
  id: "sp1", email: "presenter@example.test", firstName: "Feras", lastName: "Bader", title: "DR", role: null,
  additionalEmail: null, organization: null, jobTitle: null, phone: null, photo: null, city: null, state: null,
  zipCode: null, country: null, specialty: null, sourceRegistrationId: null,
};
const base = {
  eventId: "ev1", organizationId: "org1", speaker, ticketTypeId: "tt1", pricingTierId: "tier1",
  source: "api" as const, logPrefix: "test",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  // Refused, so the function returns right after the call under test.
  createRegistration.mockResolvedValue({ ok: false, code: "SOLD_OUT", message: "Sold out" });
});

describe("createAndLinkPayableRegistration: who the audit row names", () => {
  it("names nobody (null) on the public door, never an empty string", async () => {
    await createAndLinkPayableRegistration(base);
    expect(createRegistration.mock.calls[0][0].userId).toBeNull();
  });

  it("names the organizer on a grant", async () => {
    await createAndLinkPayableRegistration({ ...(base as object), actorUserId: "u-org" } as never);
    expect(createRegistration.mock.calls[0][0].userId).toBe("u-org");
  });
});
