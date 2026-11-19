/**
 * One reading of what happened to an email, shared by every screen that shows
 * it (Nov 19, 2026).
 */
import { describe, expect, it } from "vitest";
import { bouncingAddresses, emailOutcome } from "@/lib/email-outcome";

describe("emailOutcome", () => {
  it("says Sent when the mail service has reported nothing", () => {
    expect(emailOutcome({ status: "SENT", deliveryStatus: null })).toEqual({ label: "Sent", tone: "neutral", explanation: null });
    expect(emailOutcome({ status: "SENT" }).label).toBe("Sent");
  });

  it("says Delivered, Marked as spam and Failed", () => {
    expect(emailOutcome({ status: "SENT", deliveryStatus: "DELIVERED" })).toEqual({ label: "Delivered", tone: "good", explanation: null });
    expect(emailOutcome({ status: "SENT", deliveryStatus: "COMPLAINED" })).toMatchObject({ label: "Marked as spam", tone: "bad" });
    expect(emailOutcome({ status: "FAILED", errorMessage: "unresolved_tokens: {{title}}" })).toEqual({ label: "Failed", tone: "bad", explanation: "unresolved_tokens: {{title}}" });
  });

  it("tells a permanent bounce from a temporary one", () => {
    const permanent = emailOutcome({ status: "SENT", deliveryStatus: "BOUNCED", bounceType: "Permanent", bounceSubType: "General" });
    expect(permanent).toMatchObject({ label: "Bounced", tone: "bad" });
    expect(permanent.explanation).toContain("not delivered until the address is corrected");

    const temporary = emailOutcome({ status: "SENT", deliveryStatus: "BOUNCED", bounceType: "Transient", bounceSubType: "MailboxFull" });
    expect(temporary).toEqual({ label: "Bounced (temporary)", tone: "warn", explanation: "The mailbox is full." });

    expect(emailOutcome({ status: "SENT", deliveryStatus: "BOUNCED", bounceType: "Transient", bounceSubType: "General" }).explanation).toContain("temporary failure");
    expect(emailOutcome({ status: "SENT", deliveryStatus: "BOUNCED", bounceType: "Undetermined" }).label).toBe("Bounced (temporary)");
  });

  it("says the email was never sent when the address was already on the bounce list", () => {
    const dropped = emailOutcome({ status: "SENT", deliveryStatus: "BOUNCED", bounceType: "Permanent", bounceSubType: "OnAccountSuppressionList" });
    expect(dropped.explanation).toContain("blocked by the mail service after an earlier bounce or spam complaint");
  });

  it("a failed send stays Failed whatever else the row carries", () => {
    expect(emailOutcome({ status: "FAILED", deliveryStatus: "DELIVERED" }).label).toBe("Failed");
  });
});

describe("bouncingAddresses", () => {
  const row = (to: string, createdAt: string, deliveryStatus: "DELIVERED" | "BOUNCED" | "COMPLAINED" | null, bounceType: string | null = null) => ({
    status: "SENT" as const,
    to,
    createdAt,
    deliveryStatus,
    bounceType,
    deliveryAt: deliveryStatus ? createdAt : null,
  });

  it("flags an address whose newest reported email bounced for good", () => {
    const found = bouncingAddresses(
      [row("Doc@Example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent"), row("doc@example.org", "2026-11-04T06:00:00.000Z", "BOUNCED", "Permanent")],
      [" DOC@example.org "],
    );
    // Since the FIRST bounce of the run, not the latest: unreachable since October.
    expect(found).toEqual([{ address: "doc@example.org", since: "2026-10-02T12:00:00.000Z" }]);
  });

  it("dates the run from after the address last worked", () => {
    const found = bouncingAddresses(
      [
        row("doc@example.org", "2026-09-01T06:00:00.000Z", "BOUNCED", "Permanent"),
        row("doc@example.org", "2026-09-10T06:00:00.000Z", "DELIVERED"),
        row("doc@example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent"),
        row("doc@example.org", "2026-11-04T06:00:00.000Z", "BOUNCED", "Permanent"),
      ],
      ["doc@example.org"],
    );
    expect(found).toEqual([{ address: "doc@example.org", since: "2026-10-02T12:00:00.000Z" }]);
  });

  it("stops flagging once a later email is delivered (the address was put right)", () => {
    expect(
      bouncingAddresses(
        [row("doc@example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent"), row("doc@example.org", "2026-11-04T06:00:00.000Z", "DELIVERED")],
        ["doc@example.org"],
      ),
    ).toEqual([]);
  });

  it("ignores emails the mail service said nothing about, in any order", () => {
    expect(
      bouncingAddresses(
        [row("doc@example.org", "2026-11-18T06:00:00.000Z", null), row("doc@example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent")],
        ["doc@example.org"],
      ),
    ).toEqual([{ address: "doc@example.org", since: "2026-10-02T12:00:00.000Z" }]);
  });

  it("does not flag a temporary bounce, a failed send, or an address that never bounced", () => {
    expect(
      bouncingAddresses(
        [
          row("full@example.org", "2026-11-01T06:00:00.000Z", "BOUNCED", "Transient"),
          { ...row("failed@example.org", "2026-11-01T06:00:00.000Z", "BOUNCED", "Permanent"), status: "FAILED" as const },
          row("fine@example.org", "2026-11-01T06:00:00.000Z", "DELIVERED"),
        ],
        ["full@example.org", "failed@example.org", "fine@example.org"],
      ),
    ).toEqual([]);
  });

  it("flags both of a person's current addresses when both bounce (the main and the additional one)", () => {
    const found = bouncingAddresses(
      [
        row("b@example.org", "2026-11-01T06:00:00.000Z", "BOUNCED", "Permanent"),
        row("a@example.org", "2026-11-02T06:00:00.000Z", "BOUNCED", "Permanent"),
        row("c@example.org", "2026-11-02T06:00:00.000Z", "DELIVERED"),
      ],
      ["a@example.org", "b@example.org", null, undefined, ""],
    );
    expect(found.map((f) => f.address)).toEqual(["a@example.org", "b@example.org"]);
  });

  it("stops warning about an old address once the person's address has been corrected", () => {
    const history = [row("old@example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent")];
    expect(bouncingAddresses(history, ["old@example.org"])).toHaveLength(1);
    // Staff corrected the address: the old rows keep the old address, the warning must not.
    expect(bouncingAddresses(history, ["new@example.org"])).toEqual([]);
  });

  it("flags nothing when it is not told the person's address", () => {
    expect(bouncingAddresses([row("doc@example.org", "2026-10-02T12:00:00.000Z", "BOUNCED", "Permanent")], [])).toEqual([]);
  });
});
