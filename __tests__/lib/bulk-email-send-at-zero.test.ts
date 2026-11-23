import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { showsNobodyToSendNow } from "@/lib/bulk-email-audience";

/**
 * "Send to all 0 registrations" was a real send (Nov 23, 2026). The count in
 * the dialog comes from the list the page holds; the audience of an "everyone
 * matching" send is worked out by the server from the filters. With a list
 * that had failed to load the dialog said 0 and Send mailed everyone.
 */
describe("showsNobodyToSendNow", () => {
  it("a send now to nobody is refused", () => {
    expect(showsNobodyToSendNow({ displayCount: 0, scheduling: false })).toBe(true);
  });

  it("a send now to somebody goes", () => {
    expect(showsNobodyToSendNow({ displayCount: 1, scheduling: false })).toBe(false);
    expect(showsNobodyToSendNow({ displayCount: 228, scheduling: false })).toBe(false);
  });

  it("a send scheduled for later is left alone at 0: nobody may match today, and people will by then", () => {
    expect(showsNobodyToSendNow({ displayCount: 0, scheduling: true })).toBe(false);
  });
});

describe("the send dialog asks it", () => {
  const DIALOG = readFileSync("src/components/bulk-email-dialog.tsx", "utf8");

  it("from the count it SHOWS, so what is shown is what is sent", () => {
    expect(DIALOG).toContain("const nobodyToSendNow = showsNobodyToSendNow({ displayCount, scheduling });");
  });

  it("and Send is off while it is true", () => {
    const button = DIALOG.slice(DIALOG.indexOf("onClick={handleSend}"));
    const disabled = button.slice(0, button.indexOf("{sendButtonContent()}"));
    expect(disabled).toContain("nobodyToSendNow ||");
  });

  it("and says why, so a greyed Send is not a puzzle", () => {
    expect(DIALOG).toContain("Nobody matches, so there is nothing to send.");
  });
});
