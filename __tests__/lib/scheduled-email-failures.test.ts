/**
 * The scheduled-email failure-format contract shared by the worker (writer) and
 * the Communications list UI (reader). Pins the `lastError` parsing so the two
 * sides can't drift: JSON array → recipient list; plain string / malformed /
 * non-recipient JSON → null (so the UI falls back to a plain error tooltip).
 */
import { describe, it, expect } from "vitest";
import { parseFailedRecipients, MAX_STORED_ERRORS } from "@/lib/scheduled-email-failures";

describe("parseFailedRecipients", () => {
  it("parses a JSON array of {email,error}", () => {
    const json = JSON.stringify([
      { email: "a@x.com", error: "hard bounce" },
      { email: "b@x.com", error: "mailbox full" },
    ]);
    expect(parseFailedRecipients(json)).toEqual([
      { email: "a@x.com", error: "hard bounce" },
      { email: "b@x.com", error: "mailbox full" },
    ]);
  });

  it("returns null for a plain-string error (whole-row FAILED)", () => {
    expect(parseFailedRecipients("SES throttled")).toBeNull();
  });

  it("returns null for null / empty", () => {
    expect(parseFailedRecipients(null)).toBeNull();
    expect(parseFailedRecipients("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseFailedRecipients("[{oops")).toBeNull();
  });

  it("returns null for a JSON array that isn't a recipient list", () => {
    expect(parseFailedRecipients(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseFailedRecipients(JSON.stringify([{ foo: "bar" }]))).toBeNull();
  });

  it("exposes a positive storage cap", () => {
    expect(MAX_STORED_ERRORS).toBeGreaterThan(0);
  });
});
