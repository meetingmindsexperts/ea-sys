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

const FACULTY = { name: "Faculty", isFaculty: true };
const PHYSICIAN = { name: "Physician", isFaculty: false };
const NURSE = { name: "Nurse ", isFaculty: false };

// Owner, Nov 12, 2026: "if reg type is changed to physician, then API should
// return physician, and faculty, then faculty, if nurse then nurse. They
// should not diverge."
describe("speakerApiRegistrationType", () => {
  it("is the registration's own type, whatever the speaker's own text says", () => {
    // Ahmad Turk and Ammar Chaudhary: text "Physician", registration Faculty.
    expect(speakerApiRegistrationType("Physician", { status: "CONFIRMED", ticketType: FACULTY })).toBe("Faculty");
    expect(speakerApiRegistrationType(null, { status: "PENDING", ticketType: FACULTY })).toBe("Faculty");
    // The other way round: text "Faculty", registration Physician.
    expect(speakerApiRegistrationType("Faculty", { status: "PENDING", ticketType: PHYSICIAN })).toBe("Physician");
    expect(speakerApiRegistrationType("Student", { status: "CONFIRMED", ticketType: NURSE })).toBe("Nurse");
    expect(speakerApiRegistrationType(null, { status: "CHECKED_IN", ticketType: PHYSICIAN })).toBe("Physician");
  });

  it("follows a change of the registration's type and nothing else", () => {
    const speakerText = "Faculty";
    const asType = (ticketType: { name: string; isFaculty: boolean }) => speakerApiRegistrationType(speakerText, { status: "CONFIRMED", ticketType });
    expect([PHYSICIAN, FACULTY, NURSE].map(asType)).toEqual(["Physician", "Faculty", "Nurse"]);
  });

  it("says the one word Faculty for a Faculty type, whatever the type row is called", () => {
    for (const name of ["Faculty.", "Speakers", "Faculty (speakers)"]) {
      expect(speakerApiRegistrationType("x", { status: "CONFIRMED", ticketType: { name, isFaculty: true } })).toBe("Faculty");
    }
  });

  it("falls back to the speaker's own text only while there is no typed, live registration", () => {
    expect(speakerApiRegistrationType(" Nurse ", null)).toBe(" Nurse ");
    expect(speakerApiRegistrationType(null, null)).toBeNull();
    expect(speakerApiRegistrationType("Faculty", { status: "PENDING", ticketType: null })).toBe("Faculty");
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

  it("GET /speakers serves each registration's own type and sends on only the registration's number", async () => {
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
    // The registration decides: Faculty, Physician (her text said Faculty),
    // Physician (his text said Student); the text only where there is none.
    expect(rows.map((r) => [r.id, r.registrationType])).toEqual([["turk", "Faculty"], ["malallah", "Physician"], ["student", "Physician"], ["none", null]]);
    // The status and the type flag were read to decide; neither is sent.
    expect(rows[0].sourceRegistration).toEqual({ serialId: 75 });
    expect(rows[3].sourceRegistration).toBeNull();
    const select = mockDb.speaker.findMany.mock.calls[0][0].include.sourceRegistration.select;
    expect(select).toEqual({ serialId: true, status: true, ticketType: { select: { name: true, isFaculty: true } } });
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
