/**
 * What the speakers API serves as `registrationType` (owner, Nov 12, 2026).
 *
 * "Check why ahmad turk, ammar chaudhary reg type is PHYSICIAN instead of
 * faculty, whereas they are marked reg type as faculty in production ... in
 * the api, when I fetch it." The API served the speaker's own text, typed by
 * hand; their registrations were on the Faculty type. The website sync (n8n
 * to Webflow) copies this field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { speakerApiRegistrationType } from "@/lib/speaker-registration-type";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: vi.fn(async () => null) }));
vi.mock("@/services/speaker-service", () => ({ updateSpeaker: vi.fn(), createSpeaker: vi.fn() }));

const FACULTY = { isFaculty: true };
const PHYSICIAN = { isFaculty: false };

describe("speakerApiRegistrationType", () => {
  it("says Faculty for a live registration on a Faculty type, whatever the speaker's own text says", () => {
    // Ahmad Turk and Ammar Chaudhary: text "Physician", registration Faculty.
    expect(speakerApiRegistrationType("Physician", { status: "CONFIRMED", ticketType: FACULTY })).toBe("Faculty");
    expect(speakerApiRegistrationType(null, { status: "PENDING", ticketType: FACULTY })).toBe("Faculty");
    expect(speakerApiRegistrationType("Faculty.", { status: "CHECKED_IN", ticketType: FACULTY })).toBe("Faculty");
  });

  it("keeps the speaker's own text, untouched, for everyone else", () => {
    // The three GCC Hub speakers on a Physician registration: saved as Faculty for the website.
    expect(speakerApiRegistrationType("Faculty", { status: "PENDING", ticketType: PHYSICIAN })).toBe("Faculty");
    expect(speakerApiRegistrationType("Student", { status: "CONFIRMED", ticketType: PHYSICIAN })).toBe("Student");
    expect(speakerApiRegistrationType(" Nurse ", null)).toBe(" Nurse ");
    expect(speakerApiRegistrationType(null, null)).toBeNull();
    expect(speakerApiRegistrationType(undefined, { status: "CONFIRMED", ticketType: null })).toBeNull();
  });

  it("does not count a cancelled Faculty registration", () => {
    expect(speakerApiRegistrationType("Physician", { status: "CANCELLED", ticketType: FACULTY })).toBe("Physician");
  });
});

describe("the two reads", () => {
  const organiser = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(organiser);
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
  });

  it("GET /speakers serves Faculty for a Faculty registration and sends on only the registration's number", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "turk", firstName: "Ahmad", registrationType: "Physician", abstracts: [], sessionProposals: [], sourceRegistration: { serialId: 75, status: "CONFIRMED", ticketType: FACULTY } },
      { id: "malallah", firstName: "Fatima", registrationType: "Faculty", abstracts: [], sessionProposals: [], sourceRegistration: { serialId: 43, status: "PENDING", ticketType: PHYSICIAN } },
      { id: "student", firstName: "Sam", registrationType: "Student", abstracts: [], sessionProposals: [], sourceRegistration: { serialId: 9, status: "CONFIRMED", ticketType: PHYSICIAN } },
      { id: "none", firstName: "No", registrationType: null, abstracts: [], sessionProposals: [], sourceRegistration: null },
    ]);
    const { GET } = await import("@/app/api/events/[eventId]/speakers/route");
    const res = await GET(new Request("http://x/api/events/e1/speakers"), { params: Promise.resolve({ eventId: "e1" }) });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; registrationType: string | null; sourceRegistration: unknown }[];
    expect(rows.map((r) => [r.id, r.registrationType])).toEqual([["turk", "Faculty"], ["malallah", "Faculty"], ["student", "Student"], ["none", null]]);
    // The status and the type flag were read to decide; neither is sent.
    expect(rows[0].sourceRegistration).toEqual({ serialId: 75 });
    expect(rows[3].sourceRegistration).toBeNull();
    const select = mockDb.speaker.findMany.mock.calls[0][0].include.sourceRegistration.select;
    expect(select).toEqual({ serialId: true, status: true, ticketType: { select: { isFaculty: true } } });
  });

  it("GET /speakers/{id} serves the same value", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "turk", firstName: "Ahmad", registrationType: "Physician", abstracts: [], _count: { sessions: 1, abstracts: 0 },
      sourceRegistration: { id: "r75", serialId: 75, status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", qrCode: "X", ticketType: { name: "Faculty", isFaculty: true }, attendee: { email: "a@x.com", registrationType: null } },
    });
    const { GET } = await import("@/app/api/events/[eventId]/speakers/[speakerId]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ eventId: "e1", speakerId: "turk" }) });
    const body = (await res.json()) as { registrationType: string; sourceRegistration: Record<string, unknown> };
    expect(body.registrationType).toBe("Faculty");
    expect(body.sourceRegistration.qrCode).toBeUndefined();
  });
});
