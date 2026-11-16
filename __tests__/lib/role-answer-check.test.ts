/**
 * Which Role a door may store (step 1c of docs/ORG_FIELDS_PLAN.md): a NEWLY
 * chosen answer must be one the organisation offers now; the one the record
 * already holds is kept, retired or not. Replaces the fixed list of nine that
 * every door's schema held.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { organization: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { roleAnswerProblem, ROLE_NOT_OFFERED } from "@/lib/person-field-check";
import { roleAnswerRefusal, resolveWrittenRole, checkEventPersonFields } from "@/lib/person-field-rules";
import { defaultPersonFields, readPersonFields, PERSON_FIELDS_SETTING } from "@/lib/person-fields";

const OWN_SETTINGS = {
  [PERSON_FIELDS_SETTING]: {
    role: {
      label: "Profession",
      options: [
        { key: "ENGINEER", label: "Engineer" },
        { key: "OLD", label: "Old job", retired: true },
      ],
    },
  },
};
const OWN = readPersonFields(OWN_SETTINGS).role;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.organization.findUnique.mockResolvedValue({ settings: OWN_SETTINGS });
});

describe("roleAnswerProblem", () => {
  it("accepts an answer on offer, and today's nine for an organisation with no list", () => {
    expect(roleAnswerProblem(OWN, "ENGINEER")).toBeNull();
    expect(roleAnswerProblem(defaultPersonFields().role, "PHYSICIAN")).toBeNull();
  });

  it("refuses a newly chosen answer the organisation does not offer, retired ones included", () => {
    expect(roleAnswerProblem(OWN, "PHYSICIAN")).toEqual({ path: "role", message: ROLE_NOT_OFFERED });
    expect(roleAnswerProblem(OWN, "OLD")).toEqual({ path: "role", message: ROLE_NOT_OFFERED });
  });

  it("keeps the answer the record already holds, even retired or gone", () => {
    expect(roleAnswerProblem(OWN, "OLD", "OLD")).toBeNull();
    expect(roleAnswerProblem(OWN, "PHYSICIAN", "PHYSICIAN")).toBeNull();
  });

  it("leaves 'nothing chosen' to the required rule", () => {
    expect(roleAnswerProblem(OWN, undefined)).toBeNull();
    expect(roleAnswerProblem(OWN, "")).toBeNull();
    expect(roleAnswerProblem(OWN, null)).toBeNull();
  });
});

describe("roleAnswerRefusal (a door with no event)", () => {
  it("reads the organisation's list and answers in the shape a form shows", async () => {
    expect(await roleAnswerRefusal("org1", "ENGINEER")).toBeNull();
    expect(await roleAnswerRefusal("org1", "PHYSICIAN")).toEqual({ formErrors: [], fieldErrors: { role: [ROLE_NOT_OFFERED] } });
    expect(mockDb.organization.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "org1" } }));
  });

  it("refuses an organisation's own answer when the list cannot be read, never stores it unchecked", async () => {
    mockDb.organization.findUnique.mockRejectedValue(new Error("pool timeout"));
    expect(await roleAnswerRefusal("org1", "ENGINEER")).not.toBeNull();
    expect(await roleAnswerRefusal("org1", "PHYSICIAN")).toBeNull();
  });

  it("does not read anything when no role is chosen", async () => {
    expect(await roleAnswerRefusal("org1", "")).toBeNull();
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
  });
});

describe("checkEventPersonFields (an event door)", () => {
  const event = { organizationId: "org1", settings: {} };
  it("refuses a Role the event's organisation does not offer, beside the required rule", async () => {
    const check = await checkEventPersonFields(event, { role: "PHYSICIAN", specialty: "Cardiology" });
    expect(check.refusal?.fieldErrors.role).toEqual([ROLE_NOT_OFFERED]);
  });
  it("keeps the role an edited record already holds", async () => {
    const check = await checkEventPersonFields(event, { role: "OLD", specialty: "Cardiology" }, { storedRole: "OLD" });
    expect(check.refusal).toBeNull();
  });
});

describe("resolveWrittenRole (the agent's tools)", () => {
  it("reads a key or a label of an answer on offer", async () => {
    expect(await resolveWrittenRole("org1", "engineer")).toEqual({ ok: true, key: "ENGINEER" });
    expect(await resolveWrittenRole("org1", "ENGINEER")).toEqual({ ok: true, key: "ENGINEER" });
    expect(await resolveWrittenRole("org1", "")).toEqual({ ok: true, key: null });
  });
  it("refuses a retired or unknown answer and says what is on offer", async () => {
    expect(await resolveWrittenRole("org1", "Old job")).toEqual({ ok: false, offered: ["Engineer"] });
    expect(await resolveWrittenRole("org1", "Physician")).toEqual({ ok: false, offered: ["Engineer"] });
  });
});
