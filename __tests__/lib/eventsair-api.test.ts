import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listEvents,
  testConnection,
  fetchEventDetails,
  fetchEventContacts,
} from "@/lib/eventsair-client";

// Mock the logger
vi.mock("@/lib/logger", () => ({
  apiLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────

const CREDS = { clientId: "test-client", clientSecret: "test-secret" };

/** Build a mock fetch that returns an OAuth token, then responds to GraphQL calls */
function mockFetch(graphqlResponses: Array<{ data?: unknown; errors?: unknown[]; status?: number; failHttp?: boolean }>) {
  let callIndex = 0;

  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    // OAuth token request
    if (urlStr.includes("oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // GraphQL request
    if (urlStr.includes("graphql")) {
      const response = graphqlResponses[callIndex] ?? graphqlResponses[graphqlResponses.length - 1];
      callIndex++;

      if (response.failHttp) {
        return new Response("Internal Server Error", { status: response.status ?? 500 });
      }

      const body: Record<string, unknown> = {};
      if (response.data !== undefined) body.data = response.data;
      if (response.errors) body.errors = response.errors;

      return new Response(JSON.stringify(body), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}

function mockOAuthFailure() {
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({ error: "invalid_client" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  });
}

// ── listEvents ──────────────────────────────────────────────────────

describe("listEvents", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Clear any cached token between tests
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches all events in a single page when count < PAGE_SIZE", async () => {
    const events = [
      { id: "1", name: "Event 2026", startDate: "2026-03-01", endDate: "2026-03-03" },
      { id: "2", name: "Event 2025", startDate: "2025-06-15", endDate: "2025-06-17" },
    ];

    globalThis.fetch = mockFetch([{ data: { events } }]);

    const result = await listEvents(CREDS);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Event 2026");
    expect(result[1].name).toBe("Event 2025");
  });

  it("passes correct GraphQL variables (input, limit, offset)", async () => {
    globalThis.fetch = mockFetch([{ data: { events: [] } }]);

    await listEvents(CREDS);

    // Find the GraphQL call (not the token call)
    const graphqlCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => {
        const url = String(call[0]);
        return url.includes("graphql");
      }
    );

    expect(graphqlCall).toBeDefined();
    const body = JSON.parse((graphqlCall![1] as RequestInit).body as string);

    expect(body.variables).toEqual({
      input: {
        orderBy: { field: "START_DATE", direction: "DESC" },
        where: {
          includeSandboxEvents: false,
          includeArchivedEvents: false,
        },
      },
      limit: 2000,
      offset: 0,
    });
  });

  it("paginates when first page returns exactly PAGE_SIZE results", async () => {
    // First page: 2000 events (full page → triggers second request)
    const page1 = Array.from({ length: 2000 }, (_, i) => ({
      id: `evt-${i}`,
      name: `Event ${i}`,
      startDate: "2025-01-01",
      endDate: "2025-01-02",
    }));
    // Second page: 50 events (partial → stops)
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      id: `evt-${2000 + i}`,
      name: `Event ${2000 + i}`,
      startDate: "2024-01-01",
      endDate: "2024-01-02",
    }));

    globalThis.fetch = mockFetch([
      { data: { events: page1 } },
      { data: { events: page2 } },
    ]);

    const result = await listEvents(CREDS);

    expect(result).toHaveLength(2050);
    expect(result[0].id).toBe("evt-0");
    expect(result[2049].id).toBe("evt-2049");

    // Verify second call used offset=2000
    const graphqlCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("graphql")
    );
    expect(graphqlCalls).toHaveLength(2);

    const secondBody = JSON.parse((graphqlCalls[1][1] as RequestInit).body as string);
    expect(secondBody.variables.offset).toBe(2000);
  });

  it("returns empty array when API returns no events", async () => {
    globalThis.fetch = mockFetch([{ data: { events: [] } }]);
    const result = await listEvents(CREDS);
    expect(result).toEqual([]);
  });

  it("throws when API returns null events (permission/query issue)", async () => {
    globalThis.fetch = mockFetch([{ data: { events: null } }]);
    await expect(listEvents(CREDS)).rejects.toThrow("EventsAir API returned no event data");
  });

  it("throws on GraphQL errors", async () => {
    globalThis.fetch = mockFetch([{
      errors: [{ message: "Query validation failed" }],
    }]);

    await expect(listEvents(CREDS)).rejects.toThrow("Query validation failed");
  });

  it("throws on HTTP error from GraphQL endpoint", async () => {
    globalThis.fetch = mockFetch([{ failHttp: true, status: 500 }]);

    await expect(listEvents(CREDS)).rejects.toThrow("EventsAir API error (500)");
  });

  it("throws when all requests return 401", async () => {
    globalThis.fetch = mockOAuthFailure();
    await expect(listEvents(CREDS)).rejects.toThrow(/EventsAir .* \(401\)/);
  });

  it("stops paginating when a page returns fewer than PAGE_SIZE", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `evt-${i}`,
      name: `Event ${i}`,
      startDate: "2026-01-01",
      endDate: "2026-01-02",
    }));

    globalThis.fetch = mockFetch([{ data: { events: page1 } }]);

    const result = await listEvents(CREDS);

    expect(result).toHaveLength(500);

    // Should only make 1 GraphQL call (not 2)
    const graphqlCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => String(call[0]).includes("graphql")
    );
    expect(graphqlCalls).toHaveLength(1);
  });
});

// ── testConnection ──────────────────────────────────────────────────

describe("testConnection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when auth and healthcheck succeed", async () => {
    globalThis.fetch = mockFetch([{ data: { healthcheck: "ok" } }]);
    const result = await testConnection(CREDS);
    expect(result).toBe(true);
  });

  it("returns false when OAuth fails", async () => {
    globalThis.fetch = mockOAuthFailure();
    const result = await testConnection(CREDS);
    expect(result).toBe(false);
  });

  it("returns false when healthcheck returns GraphQL errors", async () => {
    // Need a working token first, then a GraphQL error
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("oauth2/v2.0/token")) {
        return new Response(
          JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      callCount++;
      return new Response(
        JSON.stringify({ errors: [{ message: "Unauthorized" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await testConnection(CREDS);
    expect(result).toBe(false);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ── fetchEventDetails ───────────────────────────────────────────────

describe("fetchEventDetails", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns event details for a valid event ID", async () => {
    const eventData = {
      id: "ea-123",
      name: "Conference 2026",
      alias: "conf-2026",
      startDate: "2026-05-01",
      endDate: "2026-05-03",
      timezone: "Asia/Dubai",
      venue: { name: "Dubai World Trade Centre", address: "Sheikh Zayed Rd", city: "Dubai", country: "AE" },
      isSandbox: false,
      isArchived: false,
    };

    globalThis.fetch = mockFetch([{ data: { event: eventData } }]);

    const result = await fetchEventDetails(CREDS, "ea-123");

    expect(result).toEqual(eventData);
    expect(result.id).toBe("ea-123");
    expect(result.venue?.city).toBe("Dubai");
  });

  it("passes eventId as a GraphQL variable", async () => {
    globalThis.fetch = mockFetch([{ data: { event: { id: "ea-456", name: "Test", startDate: "2026-01-01", endDate: "2026-01-02" } } }]);

    await fetchEventDetails(CREDS, "ea-456");

    const graphqlCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("graphql")
    );
    const body = JSON.parse((graphqlCall![1] as RequestInit).body as string);
    expect(body.variables.eventId).toBe("ea-456");
  });

  it("throws on GraphQL error (e.g. event not found)", async () => {
    globalThis.fetch = mockFetch([{
      errors: [{ message: "Event not found" }],
    }]);

    await expect(fetchEventDetails(CREDS, "nonexistent")).rejects.toThrow("Event not found");
  });

  it("throws on HTTP 500", async () => {
    globalThis.fetch = mockFetch([{ failHttp: true, status: 500 }]);
    await expect(fetchEventDetails(CREDS, "ea-123")).rejects.toThrow("EventsAir API error (500)");
  });
});

// ── fetchEventContacts ──────────────────────────────────────────────

describe("fetchEventContacts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns contacts with hasMore=false when fewer than limit", async () => {
    const contacts = [
      { id: "c1", firstName: "Alice", lastName: "Smith", primaryEmail: "alice@test.com" },
      { id: "c2", firstName: "Bob", lastName: "Jones", primaryEmail: "bob@test.com" },
    ];

    globalThis.fetch = mockFetch([{ data: { event: { contacts } } }]);

    const result = await fetchEventContacts(CREDS, "ea-123", 0, 500);

    expect(result.contacts).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.contacts[0].primaryEmail).toBe("alice@test.com");
  });

  it("returns hasMore=true when result count equals limit", async () => {
    const contacts = Array.from({ length: 500 }, (_, i) => ({
      id: `c-${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      primaryEmail: `user${i}@test.com`,
    }));

    globalThis.fetch = mockFetch([{ data: { event: { contacts } } }]);

    const result = await fetchEventContacts(CREDS, "ea-123", 0, 500);

    expect(result.contacts).toHaveLength(500);
    expect(result.hasMore).toBe(true);
  });

  it("passes offset and limit as GraphQL variables", async () => {
    globalThis.fetch = mockFetch([{ data: { event: { contacts: [] } } }]);

    await fetchEventContacts(CREDS, "ea-123", 1000, 250);

    const graphqlCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("graphql")
    );
    const body = JSON.parse((graphqlCall![1] as RequestInit).body as string);
    expect(body.variables).toEqual({ eventId: "ea-123", offset: 1000, limit: 250 });
  });

  it("handles null event response (event not accessible)", async () => {
    globalThis.fetch = mockFetch([{ data: { event: null } }]);

    const result = await fetchEventContacts(CREDS, "inaccessible-event");

    expect(result.contacts).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("handles empty contacts array", async () => {
    globalThis.fetch = mockFetch([{ data: { event: { contacts: [] } } }]);

    const result = await fetchEventContacts(CREDS, "ea-123");

    expect(result.contacts).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("uses default offset=0 and limit=500", async () => {
    globalThis.fetch = mockFetch([{ data: { event: { contacts: [] } } }]);

    await fetchEventContacts(CREDS, "ea-123");

    const graphqlCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("graphql")
    );
    const body = JSON.parse((graphqlCall![1] as RequestInit).body as string);
    expect(body.variables.offset).toBe(0);
    expect(body.variables.limit).toBe(500);
  });

  it("throws on GraphQL error", async () => {
    globalThis.fetch = mockFetch([{
      errors: [{ message: "Rate limit exceeded" }],
    }]);

    await expect(fetchEventContacts(CREDS, "ea-123")).rejects.toThrow("Rate limit exceeded");
  });
});
