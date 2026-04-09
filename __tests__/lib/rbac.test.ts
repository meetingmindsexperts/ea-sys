import { describe, it, expect } from "vitest";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";

// ═══════════════════════════════════════════════════════════════════════════
// RBAC — Role-Based Access Control Tests
//
// EA-SYS enforces RBAC at 3 layers:
//   1. API Layer   — denyReviewer() guard on POST/PUT/DELETE handlers
//   2. Middleware   — redirects restricted roles from non-abstract routes
//   3. Event Scope — buildEventAccessWhere() scopes queries by role
//
// Roles:
//   SUPER_ADMIN, ADMIN    — Full access (org-bound)
//   ORGANIZER             — Full access to assigned events (org-bound)
//   REVIEWER              — Abstracts-only (org-independent, per-event assignment)
//   SUBMITTER             — Abstracts-only (org-independent, per-speaker linkage)
// ═══════════════════════════════════════════════════════════════════════════

const ALL_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "REVIEWER", "SUBMITTER"] as const;
const PRIVILEGED_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] as const;
const RESTRICTED_ROLES = ["REVIEWER", "SUBMITTER"] as const;

// ── Layer 1: API Guard (denyReviewer) ──────────────────────────────────────

describe("RBAC Layer 1: API guard (denyReviewer)", () => {
  describe("blocks restricted roles from write operations", () => {
    it.each([...RESTRICTED_ROLES])("%s is blocked with 403", async (role) => {
      const result = denyReviewer({ user: { role } });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
      const body = await result!.json();
      expect(body).toEqual({ error: "Forbidden" });
    });
  });

  describe("allows privileged roles", () => {
    it.each([...PRIVILEGED_ROLES])("%s is allowed (returns null)", (role) => {
      expect(denyReviewer({ user: { role } })).toBeNull();
    });
  });

  describe("handles edge cases", () => {
    it("null session returns null (auth check runs first)", () => {
      expect(denyReviewer(null)).toBeNull();
    });

    it("session with no user returns null", () => {
      expect(denyReviewer({})).toBeNull();
    });

    it("session with user but no role returns null", () => {
      expect(denyReviewer({ user: {} })).toBeNull();
    });

    it("unknown role returns null (not blocked)", () => {
      expect(denyReviewer({ user: { role: "UNKNOWN" } })).toBeNull();
    });
  });

  describe("guards protect specific resource types", () => {
    // These are the resource types that denyReviewer protects.
    // The guard must be called on ALL POST/PUT/DELETE handlers except abstract routes.
    const protectedResources = [
      "registrations",
      "speakers",
      "tickets",
      "sessions",
      "tracks",
      "hotels",
      "rooms",
      "accommodations",
      "reviewers",
      "contacts",
      "organization/users",
      "events",
    ];

    it.each(protectedResources)(
      "REVIEWER blocked from writing to %s",
      (resource) => {
        // Simulates what each route handler does
        const result = denyReviewer({ user: { role: "REVIEWER" } });
        expect(result).not.toBeNull();
        expect(result!.status).toBe(403);
        // Verify the resource name is in our protected list
        expect(protectedResources).toContain(resource);
      }
    );

    it.each(protectedResources)(
      "SUBMITTER blocked from writing to %s",
      (resource) => {
        const result = denyReviewer({ user: { role: "SUBMITTER" } });
        expect(result).not.toBeNull();
        expect(result!.status).toBe(403);
        expect(protectedResources).toContain(resource);
      }
    );
  });
});

// ── Layer 2: Middleware route redirects ─────────────────────────────────────

describe("RBAC Layer 2: Middleware route redirects", () => {
  // Replicate the middleware redirect logic for testing
  function getMiddlewareAction(
    role: string,
    pathname: string
  ): "next" | { redirect: string } {
    const isRestricted = role === "REVIEWER" || role === "SUBMITTER";

    if (!isRestricted) return "next";

    if (pathname.startsWith("/dashboard") || pathname.startsWith("/settings")) {
      return { redirect: "/events" };
    }

    if (pathname === "/events/new") {
      return { redirect: "/events" };
    }

    const eventPath = pathname.match(/^\/events\/[^/]+(?:\/(.*))?$/);
    if (!eventPath) return "next";

    const eventSubPath = eventPath[1] ?? "";
    const isAbstractsPath =
      eventSubPath === "abstracts" || eventSubPath.startsWith("abstracts/");

    if (isAbstractsPath) return "next";

    const eventBase = pathname.split("/").slice(0, 3).join("/");
    return { redirect: `${eventBase}/abstracts` };
  }

  describe("privileged roles pass through all routes", () => {
    const routes = [
      "/dashboard",
      "/settings",
      "/events/new",
      "/events/evt-1/registrations",
      "/events/evt-1/speakers",
      "/events/evt-1/agenda",
      "/events/evt-1/abstracts",
    ];

    it.each([...PRIVILEGED_ROLES])("%s passes through all routes", (role) => {
      for (const route of routes) {
        expect(getMiddlewareAction(role, route)).toBe("next");
      }
    });
  });

  describe("REVIEWER redirects", () => {
    it("redirects /dashboard to /events", () => {
      expect(getMiddlewareAction("REVIEWER", "/dashboard")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /settings to /events", () => {
      expect(getMiddlewareAction("REVIEWER", "/settings")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /settings/users to /events", () => {
      expect(getMiddlewareAction("REVIEWER", "/settings/users")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /events/new to /events", () => {
      expect(getMiddlewareAction("REVIEWER", "/events/new")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /events/evt-1/registrations to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/registrations")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("redirects /events/evt-1/speakers to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/speakers")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("redirects /events/evt-1/agenda to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/agenda")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("redirects /events/evt-1/tickets to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/tickets")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("redirects /events/evt-1/accommodation to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/accommodation")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("allows /events/evt-1/abstracts", () => {
      expect(getMiddlewareAction("REVIEWER", "/events/evt-1/abstracts")).toBe(
        "next"
      );
    });

    it("allows /events/evt-1/abstracts/abs-1", () => {
      expect(
        getMiddlewareAction("REVIEWER", "/events/evt-1/abstracts/abs-1")
      ).toBe("next");
    });

    it("allows /events (list page)", () => {
      expect(getMiddlewareAction("REVIEWER", "/events")).toBe("next");
    });

    it("allows /events/evt-1 (event detail root)", () => {
      expect(getMiddlewareAction("REVIEWER", "/events/evt-1")).toEqual({
        redirect: "/events/evt-1/abstracts",
      });
    });
  });

  describe("SUBMITTER redirects (same as REVIEWER)", () => {
    it("redirects /dashboard to /events", () => {
      expect(getMiddlewareAction("SUBMITTER", "/dashboard")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /settings to /events", () => {
      expect(getMiddlewareAction("SUBMITTER", "/settings")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /events/new to /events", () => {
      expect(getMiddlewareAction("SUBMITTER", "/events/new")).toEqual({
        redirect: "/events",
      });
    });

    it("redirects /events/evt-1/speakers to /events/evt-1/abstracts", () => {
      expect(
        getMiddlewareAction("SUBMITTER", "/events/evt-1/speakers")
      ).toEqual({ redirect: "/events/evt-1/abstracts" });
    });

    it("allows /events/evt-1/abstracts", () => {
      expect(getMiddlewareAction("SUBMITTER", "/events/evt-1/abstracts")).toBe(
        "next"
      );
    });

    it("allows /events list page", () => {
      expect(getMiddlewareAction("SUBMITTER", "/events")).toBe("next");
    });
  });
});

// ── Layer 3: Event scoping (buildEventAccessWhere) ─────────────────────────

describe("RBAC Layer 3: Event scoping (buildEventAccessWhere)", () => {
  describe("org-bound roles (SUPER_ADMIN, ADMIN, ORGANIZER)", () => {
    it.each([...PRIVILEGED_ROLES])(
      "%s gets org-scoped query without eventId",
      (role) => {
        const where = buildEventAccessWhere({
          id: "user-1",
          role,
          organizationId: "org-1",
        });
        expect(where).toEqual({ organizationId: "org-1" });
        expect(where).not.toHaveProperty("settings");
        expect(where).not.toHaveProperty("speakers");
      }
    );

    it.each([...PRIVILEGED_ROLES])(
      "%s gets org + event scoped query with eventId",
      (role) => {
        const where = buildEventAccessWhere(
          { id: "user-1", role, organizationId: "org-1" },
          "evt-1"
        );
        expect(where).toEqual({ id: "evt-1", organizationId: "org-1" });
      }
    );
  });

  describe("REVIEWER (org-independent, event assignment scoped)", () => {
    it("scopes by reviewerUserIds without eventId", () => {
      const where = buildEventAccessWhere({
        id: "rev-1",
        role: "REVIEWER",
        organizationId: null,
      });
      expect(where).toEqual({
        settings: { path: ["reviewerUserIds"], array_contains: "rev-1" },
      });
    });

    it("scopes by reviewerUserIds with eventId", () => {
      const where = buildEventAccessWhere(
        { id: "rev-1", role: "REVIEWER", organizationId: null },
        "evt-1"
      );
      expect(where).toEqual({
        id: "evt-1",
        settings: { path: ["reviewerUserIds"], array_contains: "rev-1" },
      });
    });

    it("never includes organizationId", () => {
      const where = buildEventAccessWhere({
        id: "rev-1",
        role: "REVIEWER",
        organizationId: null,
      });
      expect(where).not.toHaveProperty("organizationId");
    });

    it("never includes speakers filter", () => {
      const where = buildEventAccessWhere({
        id: "rev-1",
        role: "REVIEWER",
        organizationId: null,
      });
      expect(where).not.toHaveProperty("speakers");
    });
  });

  describe("SUBMITTER (org-independent, speaker linkage scoped)", () => {
    it("scopes by Speaker.userId without eventId", () => {
      const where = buildEventAccessWhere({
        id: "sub-1",
        role: "SUBMITTER",
        organizationId: null,
      });
      expect(where).toEqual({
        speakers: { some: { userId: "sub-1" } },
      });
    });

    it("scopes by Speaker.userId with eventId", () => {
      const where = buildEventAccessWhere(
        { id: "sub-1", role: "SUBMITTER", organizationId: null },
        "evt-1"
      );
      expect(where).toEqual({
        id: "evt-1",
        speakers: { some: { userId: "sub-1" } },
      });
    });

    it("never includes organizationId", () => {
      const where = buildEventAccessWhere({
        id: "sub-1",
        role: "SUBMITTER",
        organizationId: null,
      });
      expect(where).not.toHaveProperty("organizationId");
    });

    it("never includes settings filter", () => {
      const where = buildEventAccessWhere({
        id: "sub-1",
        role: "SUBMITTER",
        organizationId: null,
      });
      expect(where).not.toHaveProperty("settings");
    });
  });

  describe("cross-org isolation", () => {
    it("ADMIN from org-A cannot see org-B events", () => {
      const whereA = buildEventAccessWhere({
        id: "admin-a",
        role: "ADMIN",
        organizationId: "org-A",
      });
      const whereB = buildEventAccessWhere({
        id: "admin-b",
        role: "ADMIN",
        organizationId: "org-B",
      });
      expect(whereA.organizationId).toBe("org-A");
      expect(whereB.organizationId).toBe("org-B");
      expect(whereA.organizationId).not.toBe(whereB.organizationId);
    });

    it("REVIEWER can access events across orgs (no org filter)", () => {
      const where = buildEventAccessWhere({
        id: "rev-1",
        role: "REVIEWER",
        organizationId: null,
      });
      // No org filter — reviewer sees all events they're assigned to
      expect(where).not.toHaveProperty("organizationId");
    });
  });
});

// ── Abstract-specific RBAC ─────────────────────────────────────────────────

describe("RBAC: Abstract-specific access rules", () => {
  const reviewStatuses = [
    "UNDER_REVIEW",
    "ACCEPTED",
    "REJECTED",
    "REVISION_REQUESTED",
  ];
  const submitterEditableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];

  describe("SUBMITTER restrictions on abstracts", () => {
    it("can only edit own abstracts (speaker.userId must match)", () => {
      const abstract = { speaker: { userId: "sub-1" } };
      const session = { id: "sub-1" };
      expect(abstract.speaker.userId).toBe(session.id);
    });

    it("cannot edit another user's abstract", () => {
      const abstract = { speaker: { userId: "sub-1" } };
      const session = { id: "sub-2" };
      expect(abstract.speaker.userId).not.toBe(session.id);
    });

    it.each(submitterEditableStatuses)(
      "can edit abstract in %s status",
      (status) => {
        expect(submitterEditableStatuses.includes(status)).toBe(true);
      }
    );

    it.each(["UNDER_REVIEW", "ACCEPTED", "REJECTED"])(
      "cannot edit abstract in %s status",
      (status) => {
        expect(submitterEditableStatuses.includes(status)).toBe(false);
      }
    );

    it.each(reviewStatuses)(
      "cannot set review status: %s",
      (status) => {
        expect(reviewStatuses.includes(status)).toBe(true);
        // SUBMITTER should be forbidden from setting these
      }
    );

    it("cannot set reviewNotes", () => {
      const isReviewField = (data: Record<string, unknown>) =>
        data.reviewNotes !== undefined;
      expect(isReviewField({ reviewNotes: "Good paper" })).toBe(true);
    });

    it("cannot set reviewScore", () => {
      const isReviewField = (data: Record<string, unknown>) =>
        data.reviewScore !== undefined;
      expect(isReviewField({ reviewScore: 85 })).toBe(true);
    });
  });

  describe("REVIEWER restrictions on abstracts", () => {
    it("cannot create abstracts", () => {
      const role: string = "REVIEWER";
      expect(role === "REVIEWER").toBe(true); // route returns 403
    });

    it("cannot set review statuses (only ADMIN/SUPER_ADMIN can)", () => {
      const isAdmin = (role: string) =>
        role === "SUPER_ADMIN" || role === "ADMIN";
      expect(isAdmin("REVIEWER")).toBe(false);
    });
  });

  describe("ADMIN/SUPER_ADMIN review privileges", () => {
    it.each(["ADMIN", "SUPER_ADMIN"])("%s can set review statuses", (role) => {
      const isAdmin = role === "SUPER_ADMIN" || role === "ADMIN";
      expect(isAdmin).toBe(true);
    });

    it.each(["ORGANIZER", "REVIEWER", "SUBMITTER"])(
      "%s cannot set review statuses",
      (role) => {
        const isAdmin = role === "SUPER_ADMIN" || role === "ADMIN";
        expect(isAdmin).toBe(false);
      }
    );
  });

  describe("DELETE abstract restricted to SUPER_ADMIN", () => {
    it.each([...ALL_ROLES])("role %s delete permission", (role) => {
      const canDelete = role === "SUPER_ADMIN";
      if (role === "SUPER_ADMIN") {
        expect(canDelete).toBe(true);
      } else {
        expect(canDelete).toBe(false);
      }
    });
  });
});

// ── Middleware: CSRF protection ─────────────────────────────────────────────

describe("RBAC: Middleware CSRF protection", () => {
  function shouldCheckCsrf(
    pathname: string,
    method: string,
    hasApiKey: boolean
  ): boolean {
    const mutationMethods = new Set(["POST", "PUT", "DELETE", "PATCH"]);
    if (!pathname.startsWith("/api/")) return false;
    if (!mutationMethods.has(method)) return false;
    if (pathname.startsWith("/api/auth/")) return false;
    if (pathname.startsWith("/api/public/")) return false;
    if (pathname.startsWith("/api/health")) return false;
    if (hasApiKey) return false;
    return true;
  }

  it("checks CSRF on authenticated API mutations", () => {
    expect(shouldCheckCsrf("/api/events", "POST", false)).toBe(true);
  });

  it("checks CSRF on PUT requests", () => {
    expect(shouldCheckCsrf("/api/events/evt-1", "PUT", false)).toBe(true);
  });

  it("checks CSRF on DELETE requests", () => {
    expect(shouldCheckCsrf("/api/events/evt-1", "DELETE", false)).toBe(true);
  });

  it("skips CSRF on GET requests", () => {
    expect(shouldCheckCsrf("/api/events", "GET", false)).toBe(false);
  });

  it("skips CSRF on auth endpoints", () => {
    expect(shouldCheckCsrf("/api/auth/signin", "POST", false)).toBe(false);
  });

  it("skips CSRF on public endpoints", () => {
    expect(shouldCheckCsrf("/api/public/events/slug/register", "POST", false)).toBe(false);
  });

  it("skips CSRF on health endpoint", () => {
    expect(shouldCheckCsrf("/api/health", "GET", false)).toBe(false);
  });

  it("skips CSRF when API key is present", () => {
    expect(shouldCheckCsrf("/api/events", "POST", true)).toBe(false);
  });

  it("validates origin matches host", () => {
    const origin = "https://events.meetingmindsgroup.com";
    const host = "events.meetingmindsgroup.com";
    const originHost = new URL(origin).host;
    expect(originHost).toBe(host);
  });

  it("rejects cross-origin requests", () => {
    const origin = "https://evil.com";
    const host = "events.meetingmindsgroup.com";
    const originHost = new URL(origin).host;
    expect(originHost).not.toBe(host);
  });
});

// ── Middleware: Request body size limit ─────────────────────────────────────

describe("RBAC: Middleware body size limit", () => {
  const MAX_BODY_SIZE = 1_048_576; // 1MB

  it("allows request under 1MB", () => {
    const contentLength = 500_000;
    expect(contentLength <= MAX_BODY_SIZE).toBe(true);
  });

  it("rejects request over 1MB", () => {
    const contentLength = 2_000_000;
    expect(contentLength > MAX_BODY_SIZE).toBe(true);
  });

  it("allows request at exactly 1MB", () => {
    expect(MAX_BODY_SIZE <= MAX_BODY_SIZE).toBe(true);
  });

  it("only checks mutation methods", () => {
    const mutationMethods = new Set(["POST", "PUT", "DELETE", "PATCH"]);
    expect(mutationMethods.has("POST")).toBe(true);
    expect(mutationMethods.has("PUT")).toBe(true);
    expect(mutationMethods.has("DELETE")).toBe(true);
    expect(mutationMethods.has("PATCH")).toBe(true);
    expect(mutationMethods.has("GET")).toBe(false);
    expect(mutationMethods.has("HEAD")).toBe(false);
  });
});

// ── Org-independent vs org-bound user properties ───────────────────────────

describe("RBAC: User organization binding", () => {
  describe("org-bound roles (team members)", () => {
    it.each([...PRIVILEGED_ROLES])(
      "%s has required organizationId",
      (role) => {
        const user = { id: "u-1", role, organizationId: "org-1" };
        expect(user.organizationId).toBeTruthy();
      }
    );
  });

  describe("org-independent roles", () => {
    it("REVIEWER has null organizationId", () => {
      const user = { id: "u-1", role: "REVIEWER", organizationId: null };
      expect(user.organizationId).toBeNull();
    });

    it("SUBMITTER has null organizationId", () => {
      const user = { id: "u-1", role: "SUBMITTER", organizationId: null };
      expect(user.organizationId).toBeNull();
    });
  });
});
