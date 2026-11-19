/**
 * The one writer of an email's delivery report (Nov 19, 2026): found across
 * organisations by the mail service's message id, written in the lane of the
 * organisation the email belongs to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tenantDb, operatorDb, lanes, logger } = vi.hoisted(() => ({
  tenantDb: { emailLog: { update: vi.fn(), findFirst: vi.fn() } },
  operatorDb: { emailLog: { findFirst: vi.fn(), updateMany: vi.fn() } },
  lanes: [] as string[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: tenantDb, dbOperator: operatorDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));

import { recordDeliveryEvent } from "@/lib/email-delivery";
import { getTenantOrgId } from "@/lib/tenant-context";
import type { SesDeliveryEvent } from "@/lib/ses-events";

const AT = new Date("2026-11-19T09:00:00.000Z");
const event = (over: Partial<SesDeliveryEvent> = {}): SesDeliveryEvent => ({
  kind: "BOUNCED",
  messageId: "0109-abc",
  at: AT,
  recipients: ["doc@example.org"],
  bounceType: "Permanent",
  bounceSubType: "General",
  detail: "smtp; 550 5.1.1 user unknown",
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: "log1",
  organizationId: "org1",
  eventId: "ev1",
  to: "Doc@Example.org",
  templateSlug: "speaker-invitation",
  deliveryStatus: null,
  bounceType: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  lanes.length = 0;
  tenantDb.emailLog.update.mockImplementation(async () => {
    lanes.push(getTenantOrgId() ?? "");
    return {};
  });
  operatorDb.emailLog.updateMany.mockResolvedValue({ count: 1 });
});

describe("recordDeliveryEvent", () => {
  it("finds the email by message id on the privileged client and writes in its organisation's lane", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row());

    expect(await recordDeliveryEvent(event())).toBe("recorded");

    expect(operatorDb.emailLog.findFirst.mock.calls[0][0].where).toEqual({ providerMessageId: "0109-abc" });
    expect(tenantDb.emailLog.findFirst).not.toHaveBeenCalled();
    expect(lanes).toEqual(["org1"]);
    expect(tenantDb.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log1", organizationId: "org1" },
      data: { deliveryStatus: "BOUNCED", deliveryAt: AT, bounceType: "Permanent", bounceSubType: "General", deliveryDetail: "smtp; 550 5.1.1 user unknown" },
    });
    expect(operatorDb.emailLog.updateMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-delivery:bounced", emailLogId: "log1", to: "Doc@Example.org" }));
  });

  it("writes an email that belongs to no organisation on the privileged client, without reading it back", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row({ organizationId: null }));

    expect(await recordDeliveryEvent(event({ kind: "DELIVERED", bounceType: null, bounceSubType: null, detail: "250 OK" }))).toBe("recorded");

    expect(tenantDb.emailLog.update).not.toHaveBeenCalled();
    expect(operatorDb.emailLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log1", organizationId: null },
      data: { deliveryStatus: "DELIVERED", deliveryAt: AT, bounceType: null, bounceSubType: null, deliveryDetail: "250 OK" },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("changes nothing for an email it has no record of, and says so quietly", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(null);

    expect(await recordDeliveryEvent(event())).toBe("unknown-message");

    expect(tenantDb.emailLog.update).not.toHaveBeenCalled();
    expect(operatorDb.emailLog.updateMany).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-delivery:unknown-message" }));
  });

  it("does not mark the email when only a copied address bounced, and logs the address", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row());

    expect(await recordDeliveryEvent(event({ recipients: ["colleague@example.org"] }))).toBe("copy-only");

    expect(tenantDb.emailLog.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-delivery:copy-recipient", recipients: ["colleague@example.org"] }));
  });

  it("says nothing loud when a copied address was simply delivered", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row());

    expect(await recordDeliveryEvent(event({ kind: "DELIVERED", recipients: ["colleague@example.org"], bounceType: null }))).toBe("copy-only");

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("matches the address whatever its case and when the row holds several", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row({ to: "first@example.org, Doc@Example.org" }));

    expect(await recordDeliveryEvent(event())).toBe("recorded");
  });

  it("leaves a bounce in place when a late 'delivered' report arrives", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row({ deliveryStatus: "BOUNCED", bounceType: "Permanent" }));

    expect(await recordDeliveryEvent(event({ kind: "DELIVERED", bounceType: null }))).toBe("unchanged");

    expect(tenantDb.emailLog.update).not.toHaveBeenCalled();
  });

  it("records a spam complaint over 'delivered' and raises it at error level", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row({ deliveryStatus: "DELIVERED" }));

    expect(await recordDeliveryEvent(event({ kind: "COMPLAINED", bounceType: null, bounceSubType: null, detail: "abuse" }))).toBe("recorded");

    expect(tenantDb.emailLog.update.mock.calls[0][0].data.deliveryStatus).toBe("COMPLAINED");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "email-delivery:complaint", detail: "abuse" }));
  });

  it("lets a failed write reach the caller, so the report is retried", async () => {
    operatorDb.emailLog.findFirst.mockResolvedValue(row());
    tenantDb.emailLog.update.mockRejectedValue(new Error("db down"));

    await expect(recordDeliveryEvent(event())).rejects.toThrow("db down");
  });
});
