/**
 * Unit tests for src/services/event-service.ts, the one event-creation path
 * shared by the dashboard route, the agent / MCP tool and (next) the
 * Blueprint. Pins: every caller gets the default registration types, the
 * email templates and an audit row carrying its source; a clashing slug takes
 * -1, -2 and gives up after ten; code collisions; webinar provisioning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockApiLogger, mockResolveCode, mockProvision, mockRefreshStats } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), create: vi.fn() },
    emailTemplate: { createMany: vi.fn() },
    ticketType: { create: vi.fn() },
    organization: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockResolveCode: vi.fn(),
  mockProvision: vi.fn(),
  mockRefreshStats: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-code", () => ({ resolveUniqueEventCode: mockResolveCode }));
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: mockProvision }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/email", () => ({
  DEFAULT_TEMPLATES: [
    { slug: "registration-confirmation", name: "Confirmation", subject: "s", htmlContent: "<p/>", textContent: "t" },
  ],
}));

import { createEvent, type CreateEventInput } from "@/services/event-service";
const ORG_TYPES = ["Delegate", "Exhibitor"];

const BASE: CreateEventInput = {
  organizationId: "org-1",
  userId: "user-1",
  name: "Heart Summit 2027",
  startDate: new Date("2027-03-01T08:00:00Z"),
  endDate: new Date("2027-03-02T17:00:00Z"),
  source: "rest",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(null);
  mockDb.event.create.mockImplementation(async ({ data }) => ({ id: "evt-1", ...data }));
  mockDb.emailTemplate.createMany.mockResolvedValue({ count: 1 });
  mockDb.ticketType.create.mockResolvedValue({});
  mockDb.organization.findUnique.mockResolvedValue({ settings: { defaultRegistrationTypes: ORG_TYPES } });
  mockDb.auditLog.create.mockResolvedValue({});
  mockResolveCode.mockResolvedValue({ ok: true, code: "HS27", derivedCollision: null });
  mockProvision.mockResolvedValue(undefined);
});

describe("createEvent", () => {
  it("creates a DRAFT event with default terms and the derived code", async () => {
    const res = await createEvent(BASE);
    expect(res.ok).toBe(true);
    const data = mockDb.event.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ organizationId: "org-1", slug: "heart-summit-2027", code: "HS27", status: "DRAFT" });
    expect(data.registrationTermsHtml).toBeTruthy();
    expect(data.speakerAgreementHtml).toBeTruthy();
    expect(data).not.toHaveProperty("timezone");
  });

  it.each(["rest", "agent", "mcp", "blueprint"] as const)(
    "seeds templates, registration types and an audit row for source %s",
    async (source) => {
      await createEvent({ ...BASE, source });
      await flush();
      expect(mockDb.emailTemplate.createMany).toHaveBeenCalledTimes(1);
      expect(mockDb.ticketType.create).toHaveBeenCalledTimes(ORG_TYPES.length);
      expect(mockDb.ticketType.create.mock.calls[0][0].data).toMatchObject({ eventId: "evt-1", isDefault: true });
      expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: "CREATE",
        entityType: "Event",
        entityId: "evt-1",
        userId: "user-1",
        changes: expect.objectContaining({ source }),
      });
      expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
    },
  );

  it("seeds the organisation's own list, in its order", async () => {
    await createEvent(BASE);
    await flush();
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "org-1" } }));
    const created = mockDb.ticketType.create.mock.calls.map((c) => [c[0].data.name, c[0].data.sortOrder]);
    expect(created).toEqual([["Delegate", 0], ["Exhibitor", 1]]);
  });

  it.each([
    ["no settings", {}],
    ["an empty list", { defaultRegistrationTypes: [] }],
    ["a malformed list", { defaultRegistrationTypes: "Physician" }],
  ])("seeds no registration types when the organisation has %s", async (_label, settings) => {
    mockDb.organization.findUnique.mockResolvedValue({ settings });
    const res = await createEvent(BASE);
    await flush();
    expect(res.ok).toBe(true);
    expect(mockDb.ticketType.create).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.createMany).toHaveBeenCalledTimes(1);
  });

  it("a clashing slug takes -1, then -2", async () => {
    mockDb.event.findFirst
      .mockResolvedValueOnce({ id: "x" })
      .mockResolvedValueOnce({ id: "y" })
      .mockResolvedValueOnce(null);
    await createEvent(BASE);
    expect(mockDb.event.create.mock.calls[0][0].data.slug).toBe("heart-summit-2027-2");
  });

  it("gives up with SLUG_TAKEN after ten suffixes", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "x" });
    const res = await createEvent({ ...BASE, slug: "summit" });
    expect(res).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
    expect(mockDb.event.findFirst).toHaveBeenCalledTimes(11);
    expect(mockDb.event.create).not.toHaveBeenCalled();
  });

  it("uses a requested slug over the name", async () => {
    await createEvent({ ...BASE, slug: "My Summit" });
    expect(mockDb.event.create.mock.calls[0][0].data.slug).toBe("my-summit");
  });

  it("refuses an end before the start", async () => {
    const res = await createEvent({ ...BASE, endDate: new Date("2027-02-01T00:00:00Z") });
    expect(res).toMatchObject({ ok: false, code: "INVALID_DATE_RANGE" });
    expect(mockDb.event.create).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_DATE_RANGE" }));
  });

  it("a name with no Latin letters falls back to event-<random>", async () => {
    const res = await createEvent({ ...BASE, name: "مؤتمر القلب" });
    expect(res.ok).toBe(true);
    expect(mockDb.event.create.mock.calls[0][0].data.slug).toMatch(/^event-[a-z0-9]{1,5}$/);
  });

  it("refuses a requested slug with no usable characters", async () => {
    const res = await createEvent({ ...BASE, slug: "!!!" });
    expect(res).toMatchObject({ ok: false, code: "INVALID_SLUG" });
    expect(mockDb.event.create).not.toHaveBeenCalled();
  });

  it("retries when a concurrent create wins the unique index, then succeeds", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    mockDb.event.create.mockRejectedValueOnce(race);
    mockDb.event.create.mockImplementationOnce(async ({ data }) => ({ id: "evt-2", ...data }));
    const res = await createEvent(BASE);
    expect(res).toMatchObject({ ok: true, event: { id: "evt-2" } });
    expect(mockDb.event.create).toHaveBeenCalledTimes(2);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "event-service:unique-race-retry", attempt: 1 }));
  });

  it("gives up after three races and rethrows", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    mockDb.event.create.mockRejectedValue(race);
    await expect(createEvent(BASE)).rejects.toBe(race);
    expect(mockDb.event.create).toHaveBeenCalledTimes(3);
  });

  it("does not retry other database errors", async () => {
    mockDb.event.create.mockRejectedValue(new Error("db down"));
    await expect(createEvent(BASE)).rejects.toThrow("db down");
    expect(mockDb.event.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an explicit code that is taken, and uppercases it first", async () => {
    mockResolveCode.mockResolvedValue({ ok: false });
    const res = await createEvent({ ...BASE, code: " hs27 " });
    expect(res).toMatchObject({ ok: false, code: "EVENT_CODE_TAKEN" });
    expect(mockResolveCode).toHaveBeenCalledWith(expect.objectContaining({ explicitCode: "HS27", derivedCode: null }));
  });

  it("drops a derived code that collides, with a warning", async () => {
    mockResolveCode.mockResolvedValue({ ok: true, code: null, derivedCollision: "HS27" });
    const res = await createEvent(BASE);
    expect(res.ok).toBe(true);
    expect(mockDb.event.create.mock.calls[0][0].data.code).toBeNull();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "event-service:code-derivation-collision" }));
  });

  it("provisions a webinar event and only a webinar event", async () => {
    await createEvent({ ...BASE, eventType: "WEBINAR" });
    expect(mockProvision).toHaveBeenCalledWith("evt-1", { actorUserId: "user-1" });
    mockProvision.mockClear();
    await createEvent({ ...BASE, eventType: "CONFERENCE" });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("a failed seed is logged and does not undo the event", async () => {
    mockDb.ticketType.create.mockRejectedValue(new Error("db down"));
    const res = await createEvent(BASE);
    await flush();
    expect(res.ok).toBe(true);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "event-service:seed-registration-types-failed" }),
    );
  });
});
