/**
 * The approval step (architecture review §4.5, Phase 2): which tools pause
 * for the person, and the token that ties an Approve click to exactly one
 * call for one person within ten minutes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { APPROVAL_REQUIRED_TOOLS, approvalLabel, requiresApproval } from "@/lib/agent/approvals";
import {
  APPROVAL_TOKEN_TTL_SECONDS,
  canonicalJson,
  mintApprovalToken,
  verifyApprovalToken,
} from "@/lib/agent/approval-token";

beforeAll(() => {
  // CI has no .env; the token is signed with the auth secret.
  process.env.NEXTAUTH_SECRET ??= "test-secret-for-approval-tokens";
});

describe("requiresApproval", () => {
  it("names the readiness list and every delete tool", () => {
    for (const name of ["send_bulk_email", "create_zoom_meeting", "upsert_sponsors", "replace_session_speakers", "update_cme_settings", "replace_budget_lines"]) {
      expect(APPROVAL_REQUIRED_TOOLS.has(name), name).toBe(true);
      expect(requiresApproval(name)).toBe(true);
    }
    expect(requiresApproval("delete_promo_code")).toBe(true);
    expect(requiresApproval("delete_room_type")).toBe(true);
    expect(requiresApproval("delete_anything_added_later")).toBe(true);
  });

  it("leaves ordinary writes and reads alone", () => {
    for (const name of ["create_speaker", "update_session", "create_event", "list_events", "research_sponsor", "create_budget", "add_budget_lines"]) {
      expect(requiresApproval(name), name).toBe(false);
    }
  });

  it("labels the known tools in plain words and falls back to the name", () => {
    expect(approvalLabel("send_bulk_email")).toBe("Send a bulk email");
    expect(approvalLabel("delete_room_type")).toBe("Delete a room type");
    expect(approvalLabel("replace_budget_lines")).toBe("Replace a budget's lines");
    expect(approvalLabel("delete_later_tool")).toBe("delete later tool");
  });
});

describe("approval token", () => {
  const subject = {
    userId: "u1",
    organizationId: "org1",
    eventId: "ev1",
    toolName: "send_bulk_email",
    input: { eventId: "ev1", recipientType: "speakers", subject: "Hello", message: "<p>hi</p>" },
  };

  it("verifies the call it was minted for, with keys in any order", () => {
    const { token, expiresAt } = mintApprovalToken(subject);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(verifyApprovalToken(token, subject)).toEqual({ ok: true });
    const reordered = { ...subject, input: { message: "<p>hi</p>", subject: "Hello", recipientType: "speakers", eventId: "ev1" } };
    expect(verifyApprovalToken(token, reordered)).toEqual({ ok: true });
  });

  it("refuses a different person, org, event, tool or input", () => {
    const { token } = mintApprovalToken(subject);
    expect(verifyApprovalToken(token, { ...subject, userId: "u2" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyApprovalToken(token, { ...subject, organizationId: "org2" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyApprovalToken(token, { ...subject, eventId: null })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyApprovalToken(token, { ...subject, toolName: "delete_room_type" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyApprovalToken(token, { ...subject, input: { ...subject.input, subject: "Changed" } })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("expires after ten minutes and rejects tampering", () => {
    const minted = Date.now();
    const { token } = mintApprovalToken(subject, minted);
    expect(verifyApprovalToken(token, subject, minted + (APPROVAL_TOKEN_TTL_SECONDS - 1) * 1000)).toEqual({ ok: true });
    expect(verifyApprovalToken(token, subject, minted + (APPROVAL_TOKEN_TTL_SECONDS + 1) * 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
    const [body, sig] = token.split(".");
    expect(verifyApprovalToken(`${body}.${sig.slice(0, -2)}xx`, subject).ok).toBe(false);
    const forgedBody = Buffer.from(JSON.stringify({ v: 1, userId: "u1", organizationId: "org1", eventId: "ev1", toolName: "send_bulk_email", inputHash: "0", exp: 9999999999, jti: "x" })).toString("base64url");
    expect(verifyApprovalToken(`${forgedBody}.${sig}`, subject)).toEqual({ ok: false, reason: "signature" });
    expect(verifyApprovalToken("garbage", subject)).toEqual({ ok: false, reason: "malformed" });
  });

  it("canonicalises nested input deterministically", () => {
    expect(canonicalJson({ b: [1, { z: 1, a: 2 }], a: null, u: undefined })).toBe('{"a":null,"b":[1,{"a":2,"z":1}]}');
  });
});
