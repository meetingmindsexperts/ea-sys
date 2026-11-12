/**
 * The one-off script's plan for each registration on the adopted type (Nov 12,
 * 2026). The dry run prints this plan and the write follows it, so the plan is
 * the thing to pin.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("../../src/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { planRow } from "../../scripts/adopt-ordinary-faculty-type";

describe("planRow", () => {
  it("settles a pending, unpaid registration whose speaker is confirmed or still invited", () => {
    expect(planRow({ status: "PENDING", paymentStatus: "UNPAID" }, "CONFIRMED")).toBe("settle");
    expect(planRow({ status: "PENDING", paymentStatus: "UNPAID" }, "INVITED")).toBe("settle");
  });
  it("settles a registration with no speaker record: a committee member typed onto the type", () => {
    expect(planRow({ status: "PENDING", paymentStatus: "UNPAID" }, null)).toBe("settle");
  });
  it.each(["DECLINED", "CANCELLED"])("cancels the registration of a speaker who is %s", (status) => {
    expect(planRow({ status: "PENDING", paymentStatus: "UNPAID" }, status)).toBe("cancel");
    expect(planRow({ status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" }, status)).toBe("cancel");
  });
  it("leaves what is already in line, and anything already cancelled", () => {
    expect(planRow({ status: "CONFIRMED", paymentStatus: "COMPLIMENTARY" }, "CONFIRMED")).toBe("leave");
    expect(planRow({ status: "CANCELLED", paymentStatus: "UNPAID" }, "DECLINED")).toBe("leave");
    expect(planRow({ status: "CHECKED_IN", paymentStatus: "PAID" }, "CONFIRMED")).toBe("leave");
  });
});
