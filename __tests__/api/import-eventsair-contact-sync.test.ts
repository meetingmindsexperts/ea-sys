/**
 * The EventsAir import copies each imported person to the organisation's
 * contacts from the attendee row it just created (Nov 13, 2026; step 0b of
 * docs/ORG_FIELDS_PLAN.md). Before this file no test ran that line: the only
 * test reaching the route stopped at "EventsAir not configured".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSync, mockFetchContacts } = vi.hoisted(() => ({
  mockSync: vi.fn(),
  mockFetchContacts: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    registration: { findFirst: vi.fn(), create: vi.fn() },
    attendee: { create: vi.fn() },
    importLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } }) }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/lib/registration-email-lock", () => ({ lockRegistrationEmails: vi.fn() }));
vi.mock("@/lib/badge-layout", () => ({ exhibitorBadgeData: () => ({}) }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));
vi.mock("@/lib/utils", () => ({ generateBarcode: () => "barcode-1" }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: async () => 1 }));
vi.mock("@/lib/registration-seat-db", () => ({ claimSeat: async () => true, incrementEventSeatsOverselling: async () => ({ oversold: false }) }));
vi.mock("@/lib/eventsair-client", () => ({ decryptSecret: () => "secret", fetchEventContacts: mockFetchContacts }));
vi.mock("@/lib/import-ticket-type", () => ({
  eventChargesForRegistration: async () => false,
  resolveImportFallbackTicketType: async () => ({ ok: true, ticketType: null }),
}));
vi.mock("@/lib/storage", () => ({ downloadExternalPhoto: async () => "/uploads/photos/imported.jpg" }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: mockSync }));

import { POST } from "@/app/api/events/[eventId]/import/eventsair/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const request = () => new Request("http://x/api", { method: "POST", body: JSON.stringify({ eventsAirEventId: "ea-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.organization.findUnique.mockResolvedValue({ settings: { eventsAir: { clientId: "c", clientSecretEncrypted: "e" } } });
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.registration.create.mockResolvedValue({ id: "reg-1" });
  // The row Prisma returns: every column, the ones the import did not set as null.
  mockDb.attendee.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "att-1", title: null, role: null, additionalEmail: null, state: null, zipCode: null, specialty: null, customSpecialty: null,
    registrationType: null, associationName: null, memberId: null, studentId: null, studentIdExpiry: null, ...data,
  }));
  mockDb.importLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb));
  mockFetchContacts.mockResolvedValue({
    hasMore: false,
    contacts: [{
      id: "ea-contact-1", primaryEmail: "Ana@Example.com", firstName: "Ana", lastName: "Lima", organizationName: "Tawam", jobTitle: "Consultant",
      contactPhoneNumbers: { mobile: "+971 50 000" }, workPhone: "+971 2 000", primaryAddress: { city: "Al Ain", country: "UAE" },
      biography: "Bio", photo: { url: "https://eventsair.example/p.jpg" },
    }],
  });
});

describe("EventsAir import: the contact sync", () => {
  it("sends what the created attendee row holds, to the session's organisation, with no category", async () => {
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);

    expect(mockSync).toHaveBeenCalledTimes(1);
    const payload = mockSync.mock.calls[0][0];
    expect(payload).toMatchObject({
      organizationId: "org1", eventId: "ev1", email: "ana@example.com", firstName: "Ana", lastName: "Lima",
      organization: "Tawam", jobTitle: "Consultant", phone: "+971 50 000", city: "Al Ain", country: "UAE", bio: "Bio",
      photo: "/uploads/photos/imported.jpg",
    });
    // EventsAir gives no type worth calling a category: the contact's own stays.
    expect(payload.registrationType).toBeNull();
    // The row's id and the EventsAir key are not contact fields.
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("externalId");
  });

  it("an already registered contact is skipped and nothing is synced", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "existing" });
    const body = await (await POST(request(), params)).json();
    expect(body).toMatchObject({ created: 0, skipped: 1 });
    expect(mockSync).not.toHaveBeenCalled();
  });
});
