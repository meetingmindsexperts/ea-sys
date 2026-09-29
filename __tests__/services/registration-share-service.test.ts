/**
 * Shared registration views, the write side (docs/REGISTRATION_SHARE_PLAN.md).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { loggerMock } = vi.hoisted(() => ({ loggerMock: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ apiLogger: loggerMock }));
const mockDb = vi.hoisted(() => ({
  registrationShareLink: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  ticketType: { count: vi.fn(), findMany: vi.fn() },
  sponsor: { count: vi.fn(), findMany: vi.fn() },
  promoCode: { count: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  createRegistrationView,
  deleteRegistrationView,
  regenerateRegistrationView,
  updateRegistrationView,
  type RegistrationViewInput,
} from "@/services/registration-share-service";

const scope = { eventId: "ev1", slug: "cardio", organizationId: "org1", userId: "u1" };
const input = (over: Partial<RegistrationViewInput> = {}): RegistrationViewInput => ({
  label: "Front desk",
  enabled: true,
  expiresAt: null,
  statuses: ["CONFIRMED"],
  fields: ["organization"],
  ticketTypeIds: [],
  sponsorIds: [],
  promoCodeIds: [],
  includeFaculty: false,
  ...over,
});
const stored = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  eventId: "ev1",
  organizationId: "org1",
  label: "Front desk",
  token: "t".repeat(43),
  enabled: true,
  expiresAt: null,
  statuses: ["CONFIRMED"],
  fields: ["organization"],
  ticketTypeIds: [],
  sponsorIds: [],
  promoCodeIds: [],
  includeFaculty: false,
  createdById: "u1",
  updatedById: "u1",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registrationShareLink.count.mockResolvedValue(0);
  mockDb.registrationShareLink.findFirst.mockResolvedValue(null);
  mockDb.registrationShareLink.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => stored({ ...data, id: "v-new" }));
  mockDb.registrationShareLink.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => stored(data));
  mockDb.ticketType.count.mockResolvedValue(0);
  mockDb.sponsor.count.mockResolvedValue(0);
  mockDb.promoCode.count.mockResolvedValue(0);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("create", () => {
  it("creates with a fresh token, stamped with the org, and audits it", async () => {
    const r = await createRegistrationView(scope, input());
    expect(r).toEqual({ ok: true, id: "v-new" });
    const data = mockDb.registrationShareLink.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: "ev1", organizationId: "org1", label: "Front desk" });
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "REGISTRATION_VIEW_CREATED", entityType: "RegistrationShareLink" });
  });

  it("stops at the per-event limit", async () => {
    mockDb.registrationShareLink.count.mockResolvedValue(10);
    expect(await createRegistrationView(scope, input())).toMatchObject({ ok: false, code: "TOO_MANY_VIEWS" });
    expect(mockDb.registrationShareLink.create).not.toHaveBeenCalled();
  });

  it("refuses a filter id that is not on this event, so the view can never silently widen", async () => {
    mockDb.ticketType.count.mockResolvedValue(1);
    expect(await createRegistrationView(scope, input({ ticketTypeIds: ["tt1", "tt-other-event"] }))).toMatchObject({ ok: false, code: "UNKNOWN_FILTER" });
    mockDb.ticketType.count.mockResolvedValue(0);
    mockDb.sponsor.count.mockResolvedValue(0);
    expect(await createRegistrationView(scope, input({ sponsorIds: ["sp-x"] }))).toMatchObject({ ok: false, code: "UNKNOWN_FILTER" });
    expect(mockDb.ticketType.count.mock.calls[0][0].where).toEqual({ eventId: "ev1", id: { in: ["tt1", "tt-other-event"] } });
    expect(mockDb.registrationShareLink.create).not.toHaveBeenCalled();
  });

  it("refuses a blank or duplicate name, a past expiry, and bad fields", async () => {
    expect(await createRegistrationView(scope, input({ label: "   " }))).toMatchObject({ code: "INVALID_LABEL" });
    expect(await createRegistrationView(scope, input({ expiresAt: new Date(Date.now() - 1000) }))).toMatchObject({ code: "EXPIRY_IN_PAST" });
    expect(await createRegistrationView(scope, input({ fields: ["originalPrice"] }))).toMatchObject({ code: "UNKNOWN_FIELD" });
    mockDb.registrationShareLink.findFirst.mockResolvedValue({ id: "other" });
    expect(await createRegistrationView(scope, input())).toMatchObject({ code: "LABEL_TAKEN" });
  });

  it("maps a unique-index race on the name to LABEL_TAKEN, not a 500", async () => {
    mockDb.registrationShareLink.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await createRegistrationView(scope, input())).toMatchObject({ ok: false, code: "LABEL_TAKEN" });
  });

  it("logs a warning and records contact fields when they are shown", async () => {
    await createRegistrationView(scope, input({ fields: ["email", "phone"] }));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "registration-shares:contact-fields-enabled", fields: ["email", "phone"] }));
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.contactFieldsShown).toEqual(["email", "phone"]);
  });
});

describe("update, regenerate, delete", () => {
  it("only finds a view on this event", async () => {
    await updateRegistrationView(scope, "v1", input());
    expect(mockDb.registrationShareLink.findFirst.mock.calls[0][0].where).toEqual({ id: "v1", eventId: "ev1" });
    expect(await updateRegistrationView(scope, "v1", input())).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await regenerateRegistrationView(scope, "v1")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await deleteRegistrationView(scope, "v1")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("an already-expired view can still be edited while its expiry is unchanged", async () => {
    const past = new Date(Date.now() - 86_400_000);
    mockDb.registrationShareLink.findFirst.mockResolvedValueOnce(stored({ expiresAt: past }));
    expect(await updateRegistrationView(scope, "v1", input({ expiresAt: past, label: "Renamed" }))).toEqual({ ok: true });
  });

  it("warns only for contact fields newly switched on", async () => {
    mockDb.registrationShareLink.findFirst.mockResolvedValueOnce(stored({ fields: ["email"] }));
    await updateRegistrationView(scope, "v1", input({ fields: ["email", "phone"] }));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ fields: ["phone"] }));
  });

  it("regenerate replaces the token; delete removes the row; both audit", async () => {
    mockDb.registrationShareLink.findFirst.mockResolvedValue(stored());
    await regenerateRegistrationView(scope, "v1");
    expect(mockDb.registrationShareLink.update.mock.calls[0][0].data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await deleteRegistrationView(scope, "v1");
    expect(mockDb.registrationShareLink.delete).toHaveBeenCalledWith({ where: { id: "v1" } });
    expect(mockDb.auditLog.create.mock.calls.map((c) => c[0].data.action)).toEqual(["REGISTRATION_VIEW_REGENERATED", "REGISTRATION_VIEW_DELETED"]);
  });
});
