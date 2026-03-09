import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn(), create: vi.fn() },
    ticketType: { create: vi.fn() },
    speaker: { create: vi.fn() },
    track: { create: vi.fn() },
    hotel: { create: vi.fn() },
    roomType: { create: vi.fn() },
    eventSession: { create: vi.fn() },
    sessionSpeaker: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(
    (user: { role: string; organizationId?: string | null }, eventId?: string) => {
      if (user.role === "REVIEWER") {
        return { ...(eventId && { id: eventId }), settings: { path: ["reviewerUserIds"], array_contains: user.organizationId } };
      }
      return { ...(eventId && { id: eventId }), organizationId: user.organizationId };
    }
  ),
}));

// Import route AFTER mocks
import { POST } from "@/app/api/events/[eventId]/clone/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function makeRequest() {
  return new Request("http://localhost/api/events/evt-1/clone", { method: "POST" });
}

const adminSession = {
  user: { id: "user-1", role: "ADMIN", organizationId: "org-1" },
};

const organizerSession = {
  user: { id: "user-2", role: "ORGANIZER", organizationId: "org-1" },
};

const reviewerSession = {
  user: { id: "reviewer-1", role: "REVIEWER", organizationId: null },
};

const submitterSession = {
  user: { id: "submitter-1", role: "SUBMITTER", organizationId: null },
};

/** A full source event with all relationships populated. */
function makeSourceEvent(overrides?: Record<string, unknown>) {
  return {
    id: "evt-1",
    organizationId: "org-1",
    name: "Annual Conference 2026",
    slug: "annual-conference-2026",
    description: "The big event",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-06-03"),
    timezone: "Asia/Dubai",
    venue: "Convention Center",
    address: "123 Main St",
    city: "Dubai",
    country: "UAE",
    eventType: "CONFERENCE",
    tag: "medical",
    specialty: "Cardiology",
    status: "PUBLISHED",
    settings: {
      registrationOpen: true,
      reviewerUserIds: ["rev-1", "rev-2"],
      programmePublished: true,
    },
    bannerImage: "/uploads/banner.jpg",
    footerHtml: "<p>Footer</p>",
    externalId: "ext-123",
    externalSource: "eventsair",
    ticketTypes: [
      {
        id: "tt-1",
        name: "General Admission",
        description: "Standard entry",
        price: 100,
        currency: "USD",
        quantity: 500,
        soldCount: 200,
        maxPerOrder: 5,
        salesStart: null,
        salesEnd: null,
        isActive: true,
        requiresApproval: false,
      },
      {
        id: "tt-2",
        name: "VIP",
        description: "VIP access",
        price: 300,
        currency: "USD",
        quantity: 50,
        soldCount: 10,
        maxPerOrder: 2,
        salesStart: null,
        salesEnd: null,
        isActive: true,
        requiresApproval: true,
      },
    ],
    speakers: [
      {
        id: "sp-1",
        userId: "user-submitter-1",
        title: "DR",
        email: "dr.smith@example.com",
        firstName: "Jane",
        lastName: "Smith",
        bio: "A great speaker",
        organization: "University",
        jobTitle: "Professor",
        phone: "+1234",
        website: "https://jane.example.com",
        photo: "/uploads/photos/jane.jpg",
        city: "London",
        country: "UK",
        specialty: "Cardiology",
        registrationType: "Speaker",
        tags: ["keynote", "invited"],
        socialLinks: { twitter: "@jane" },
        status: "CONFIRMED",
        externalId: "sp-ext-1",
      },
      {
        id: "sp-2",
        userId: null,
        title: null,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Jones",
        bio: null,
        organization: null,
        jobTitle: null,
        phone: null,
        website: null,
        photo: null,
        city: null,
        country: null,
        specialty: null,
        registrationType: null,
        tags: [],
        socialLinks: {},
        status: "INVITED",
        externalId: null,
      },
    ],
    tracks: [
      { id: "tr-1", name: "Track A", description: "Main track", color: "#FF0000", sortOrder: 0 },
      { id: "tr-2", name: "Track B", description: null, color: "#3B82F6", sortOrder: 1 },
    ],
    hotels: [
      {
        id: "h-1",
        name: "Grand Hotel",
        address: "456 Beach Rd",
        description: "5-star",
        contactEmail: "hotel@example.com",
        contactPhone: "+5555",
        stars: 5,
        images: ["/img/hotel.jpg"],
        isActive: true,
        roomTypes: [
          {
            id: "rt-1",
            name: "Deluxe",
            description: "Ocean view",
            pricePerNight: 200,
            currency: "USD",
            capacity: 2,
            totalRooms: 50,
            bookedRooms: 30,
            amenities: ["wifi", "pool"],
            images: [],
            isActive: true,
          },
        ],
      },
    ],
    eventSessions: [
      {
        id: "sess-1",
        trackId: "tr-1",
        name: "Opening Keynote",
        description: "Welcome",
        startTime: new Date("2026-06-01T09:00:00Z"),
        endTime: new Date("2026-06-01T10:00:00Z"),
        location: "Hall A",
        capacity: 500,
        status: "SCHEDULED",
        externalId: "sess-ext-1",
        speakers: [{ sessionId: "sess-1", speakerId: "sp-1", role: "keynote" }],
      },
      {
        id: "sess-2",
        trackId: null,
        name: "Networking Break",
        description: null,
        startTime: new Date("2026-06-01T10:00:00Z"),
        endTime: new Date("2026-06-01T10:30:00Z"),
        location: "Lobby",
        capacity: null,
        status: "SCHEDULED",
        externalId: null,
        speakers: [],
      },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/events/[eventId]/clone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Authentication & Authorization ─────────────────────────────────────

  describe("auth & RBAC", () => {
    it("returns 401 when not authenticated", async () => {
      mockAuth.mockResolvedValue(null);
      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 when session has no user", async () => {
      mockAuth.mockResolvedValue({});
      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(401);
    });

    it("returns 403 for REVIEWER role", async () => {
      mockAuth.mockResolvedValue(reviewerSession);
      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "Forbidden" });
    });

    it("returns 403 for SUBMITTER role", async () => {
      mockAuth.mockResolvedValue(submitterSession);
      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(403);
    });

    it("allows ADMIN role", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst.mockResolvedValue(null); // Event not found is fine
      const res = await POST(makeRequest(), makeParams("evt-1"));
      // Should get 404 (not 403) — auth passed
      expect(res.status).toBe(404);
    });

    it("allows ORGANIZER role", async () => {
      mockAuth.mockResolvedValue(organizerSession);
      mockDb.event.findFirst.mockResolvedValue(null);
      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(404);
    });
  });

  // ── Event Not Found ────────────────────────────────────────────────────

  describe("event not found", () => {
    it("returns 404 when event does not exist", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst.mockResolvedValue(null);

      const res = await POST(makeRequest(), makeParams("nonexistent"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "Event not found" });
    });
  });

  // ── Successful Clone ───────────────────────────────────────────────────

  describe("successful clone", () => {
    function setupSuccessfulClone(sourceOverrides?: Record<string, unknown>) {
      const source = makeSourceEvent(sourceOverrides);
      mockAuth.mockResolvedValue(adminSession);

      // First findFirst: source event lookup (with include)
      // Second findFirst: slug uniqueness check
      mockDb.event.findFirst
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(null); // slug not taken

      // $transaction executes the callback with a mock tx
      let transactionCalls: Record<string, unknown[]> = {};
      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const createdEvent = { id: "new-evt", name: `${source.name} (Copy)`, slug: `${source.slug}-copy` };
        let ttIndex = 0;
        let spIndex = 0;
        let trIndex = 0;

        const tx = {
          event: {
            create: vi.fn().mockResolvedValue(createdEvent),
          },
          ticketType: {
            create: vi.fn().mockImplementation(async () => {
              ttIndex++;
              return { id: `new-tt-${ttIndex}` };
            }),
          },
          speaker: {
            create: vi.fn().mockImplementation(async () => {
              spIndex++;
              return { id: `new-sp-${spIndex}` };
            }),
          },
          track: {
            create: vi.fn().mockImplementation(async () => {
              trIndex++;
              return { id: `new-tr-${trIndex}` };
            }),
          },
          hotel: {
            create: vi.fn().mockResolvedValue({ id: "new-h-1" }),
          },
          roomType: {
            create: vi.fn().mockResolvedValue({ id: "new-rt-1" }),
          },
          eventSession: {
            create: vi.fn()
              .mockResolvedValueOnce({ id: "new-sess-1" })
              .mockResolvedValueOnce({ id: "new-sess-2" }),
          },
          sessionSpeaker: {
            create: vi.fn().mockResolvedValue({}),
          },
        };

        transactionCalls = {};
        for (const [key, value] of Object.entries(tx)) {
          transactionCalls[key] = [];
          for (const [, mockFn] of Object.entries(value as Record<string, ReturnType<typeof vi.fn>>)) {
            const origImpl = mockFn.getMockImplementation() ?? (() => Promise.resolve({}));
            mockFn.mockImplementation(async (...args: unknown[]) => {
              transactionCalls[key].push({ args });
              return (origImpl as (...a: unknown[]) => unknown)(...args);
            });
          }
        }

        const result = await fn(tx);
        return result;
      });

      return { source, getTransactionCalls: () => transactionCalls };
    }

    it("returns 201 with new event data", async () => {
      setupSuccessfulClone();
      const res = await POST(makeRequest(), makeParams("evt-1"));

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty("id", "new-evt");
      expect(body).toHaveProperty("name", "Annual Conference 2026 (Copy)");
      expect(body).toHaveProperty("slug", "annual-conference-2026-copy");
    });

    it("runs all operations inside a transaction", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));
      expect(mockDb.$transaction).toHaveBeenCalledOnce();
    });

    it("creates the event with DRAFT status", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "x", name: "Test (Copy)", slug: "test-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      const eventCreateData = mockTx.event.create.mock.calls[0][0].data;
      expect(eventCreateData.status).toBe("DRAFT");
    });

    it("resets reviewerUserIds in cloned settings", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "x", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      const settings = mockTx.event.create.mock.calls[0][0].data.settings;
      expect(settings.reviewerUserIds).toEqual([]);
      // Other settings should be preserved
      expect(settings.registrationOpen).toBe(true);
      expect(settings.programmePublished).toBe(true);
    });

    it("does not clone externalId or externalSource", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "x", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      const data = mockTx.event.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("externalId");
      expect(data).not.toHaveProperty("externalSource");
    });

    it("clones all ticket types with soldCount reset to 0", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "new-tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      expect(mockTx.ticketType.create).toHaveBeenCalledTimes(2);

      // Check first ticket type
      const tt1Data = mockTx.ticketType.create.mock.calls[0][0].data;
      expect(tt1Data.name).toBe("General Admission");
      expect(tt1Data.soldCount).toBe(0);
      expect(tt1Data.eventId).toBe("new-evt");

      // Check second ticket type
      const tt2Data = mockTx.ticketType.create.mock.calls[1][0].data;
      expect(tt2Data.name).toBe("VIP");
      expect(tt2Data.soldCount).toBe(0);
    });

    it("clones speakers without userId and resets status to INVITED", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      expect(mockTx.speaker.create).toHaveBeenCalledTimes(2);

      // Speaker 1 — originally had userId and CONFIRMED status
      const sp1Data = mockTx.speaker.create.mock.calls[0][0].data;
      expect(sp1Data.email).toBe("dr.smith@example.com");
      expect(sp1Data.firstName).toBe("Jane");
      expect(sp1Data.status).toBe("INVITED"); // Reset
      expect(sp1Data).not.toHaveProperty("userId"); // Not cloned
      expect(sp1Data).not.toHaveProperty("externalId"); // Not cloned

      // Speaker 2
      const sp2Data = mockTx.speaker.create.mock.calls[1][0].data;
      expect(sp2Data.email).toBe("bob@example.com");
      expect(sp2Data.status).toBe("INVITED");
    });

    it("clones tracks preserving color and sort order", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "new-tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      expect(mockTx.track.create).toHaveBeenCalledTimes(2);

      const tr1Data = mockTx.track.create.mock.calls[0][0].data;
      expect(tr1Data.name).toBe("Track A");
      expect(tr1Data.color).toBe("#FF0000");
      expect(tr1Data.sortOrder).toBe(0);
    });

    it("clones hotels and room types with bookedRooms reset to 0", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "new-h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "new-rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      expect(mockTx.hotel.create).toHaveBeenCalledTimes(1);
      const hotelData = mockTx.hotel.create.mock.calls[0][0].data;
      expect(hotelData.name).toBe("Grand Hotel");
      expect(hotelData.stars).toBe(5);

      expect(mockTx.roomType.create).toHaveBeenCalledTimes(1);
      const rtData = mockTx.roomType.create.mock.calls[0][0].data;
      expect(rtData.name).toBe("Deluxe");
      expect(rtData.bookedRooms).toBe(0); // Reset
      expect(rtData.hotelId).toBe("new-h"); // Uses new hotel ID
    });

    it("clones sessions with remapped trackId", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      let trackIndex = 0;
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: {
          create: vi.fn().mockImplementation(async () => {
            trackIndex++;
            return { id: `new-tr-${trackIndex}` };
          }),
        },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "new-sess" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      expect(mockTx.eventSession.create).toHaveBeenCalledTimes(2);

      // Session 1 had trackId "tr-1" → should be remapped to new-tr-1
      const sess1Data = mockTx.eventSession.create.mock.calls[0][0].data;
      expect(sess1Data.name).toBe("Opening Keynote");
      expect(sess1Data.trackId).toBe("new-tr-1");

      // Session 2 had null trackId → should stay null
      const sess2Data = mockTx.eventSession.create.mock.calls[1][0].data;
      expect(sess2Data.name).toBe("Networking Break");
      expect(sess2Data.trackId).toBeNull();
    });

    it("creates session-speaker links with remapped IDs", async () => {
      setupSuccessfulClone();
      await POST(makeRequest(), makeParams("evt-1"));

      const txFn = mockDb.$transaction.mock.calls[0][0];
      let speakerIndex = 0;
      const mockTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: {
          create: vi.fn().mockImplementation(async () => {
            speakerIndex++;
            return { id: `new-sp-${speakerIndex}` };
          }),
        },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: {
          create: vi.fn()
            .mockResolvedValueOnce({ id: "new-sess-1" })
            .mockResolvedValueOnce({ id: "new-sess-2" }),
        },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };

      await txFn(mockTx);

      // Only session 1 had a speaker link (sp-1 → new-sp-1)
      expect(mockTx.sessionSpeaker.create).toHaveBeenCalledTimes(1);
      const ssData = mockTx.sessionSpeaker.create.mock.calls[0][0].data;
      expect(ssData.sessionId).toBe("new-sess-1");
      expect(ssData.speakerId).toBe("new-sp-1"); // Remapped from sp-1
      expect(ssData.role).toBe("keynote");
    });
  });

  // ── Slug Handling ──────────────────────────────────────────────────────

  describe("slug generation", () => {
    it("uses {slug}-copy when available", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(makeSourceEvent())
        .mockResolvedValueOnce(null); // slug is available

      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          event: { create: vi.fn().mockImplementation(async (args: { data: { slug: string } }) => {
            return { id: "new-evt", name: "Test (Copy)", slug: args.data.slug };
          })},
          ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
          speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
          track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
          hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
          roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
          eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
          sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const res = await POST(makeRequest(), makeParams("evt-1"));
      const body = await res.json();
      expect(body.slug).toBe("annual-conference-2026-copy");
    });

    it("appends timestamp when slug-copy already exists", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(makeSourceEvent())
        .mockResolvedValueOnce({ id: "existing-evt" }); // slug taken

      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          event: { create: vi.fn().mockImplementation(async (args: { data: { slug: string } }) => {
            return { id: "new-evt", name: "Test (Copy)", slug: args.data.slug };
          })},
          ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
          speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
          track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
          hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
          roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
          eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
          sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const res = await POST(makeRequest(), makeParams("evt-1"));
      const body = await res.json();
      expect(body.slug).toMatch(/^annual-conference-2026-copy-\d+$/);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles event with no ticket types, speakers, tracks, hotels, or sessions", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(
          makeSourceEvent({
            ticketTypes: [],
            speakers: [],
            tracks: [],
            hotels: [],
            eventSessions: [],
          })
        )
        .mockResolvedValueOnce(null);

      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
          ticketType: { create: vi.fn() },
          speaker: { create: vi.fn() },
          track: { create: vi.fn() },
          hotel: { create: vi.fn() },
          roomType: { create: vi.fn() },
          eventSession: { create: vi.fn() },
          sessionSpeaker: { create: vi.fn() },
        };
        return fn(tx);
      });

      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(201);
    });

    it("handles event with null settings", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(makeSourceEvent({ settings: null }))
        .mockResolvedValueOnce(null);

      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
          ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
          speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
          track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
          hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
          roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
          eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
          sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(201);

      // Verify settings default to empty object
      const txFn = mockDb.$transaction.mock.calls[0][0];
      const verifyTx = {
        event: { create: vi.fn().mockResolvedValue({ id: "x", name: "T (Copy)", slug: "t-copy" }) },
        ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
        speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
        track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
        hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
        roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
        eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
        sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
      };
      await txFn(verifyTx);
      const settings = verifyTx.event.create.mock.calls[0][0].data.settings;
      expect(settings).toEqual({});
    });

    it("handles speaker with null socialLinks", async () => {
      const source = makeSourceEvent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (source.speakers[0] as any).socialLinks = null;
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(null);

      mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          event: { create: vi.fn().mockResolvedValue({ id: "new-evt", name: "T (Copy)", slug: "t-copy" }) },
          ticketType: { create: vi.fn().mockResolvedValue({ id: "tt" }) },
          speaker: { create: vi.fn().mockResolvedValue({ id: "sp" }) },
          track: { create: vi.fn().mockResolvedValue({ id: "tr" }) },
          hotel: { create: vi.fn().mockResolvedValue({ id: "h" }) },
          roomType: { create: vi.fn().mockResolvedValue({ id: "rt" }) },
          eventSession: { create: vi.fn().mockResolvedValue({ id: "s" }) },
          sessionSpeaker: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(201);
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when transaction fails", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst
        .mockResolvedValueOnce(makeSourceEvent())
        .mockResolvedValueOnce(null);
      mockDb.$transaction.mockRejectedValue(new Error("DB connection lost"));

      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "Failed to clone event" });
    });

    it("returns 500 when source event fetch fails", async () => {
      mockAuth.mockResolvedValue(adminSession);
      mockDb.event.findFirst.mockRejectedValue(new Error("Query timeout"));

      const res = await POST(makeRequest(), makeParams("evt-1"));
      expect(res.status).toBe(500);
    });
  });
});
