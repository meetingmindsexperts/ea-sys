/**
 * A composed CRM email shows in its conversation as what was SENT (Nov 23, 2026).
 *
 * The inbox shows a message's text first. A composed email's text part is only
 * a cover line ("Please find our message below / attached."), because the
 * message itself is HTML, so the conversation opened on that line and the
 * email was nowhere to be read: every composed email since the inbox was built
 * (16 on production the day it was reported). The view now shows the HTML for
 * exactly those, and the text for everything else.
 *
 * The texts below are the ones production holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_COVER_TEXT, isCoverTextOnly, sentHtmlToShow } from "@/crm/lib/inbox-message-text";

const HTML = "<table><tr><td><p>Dear Sara,</p><p>The real message.</p></td></tr></table>";

describe("isCoverTextOnly", () => {
  it("knows the cover line as the service stores it, with and without the greeting", () => {
    expect(isCoverTextOnly("Please find our message below / attached.\n")).toBe(true);
    expect(isCoverTextOnly("Dear Jon,\n\nPlease find our message below / attached.\n")).toBe(true);
    expect(isCoverTextOnly("Dear Dr. María José O'Neil-Smith,\r\n\r\nPlease find our message below / attached.\r\n")).toBe(true);
  });

  it("is false for a real message, even one that quotes the line or ends with it", () => {
    expect(isCoverTextOnly("hi this is a test")).toBe(false);
    expect(isCoverTextOnly("Thanks.\n\nOn Mon, MM wrote:\n> Please find our message below / attached.")).toBe(false);
    expect(isCoverTextOnly("We agreed 40k for Gold. Please find our message below / attached.")).toBe(false);
    expect(isCoverTextOnly(`Dear Sara, ${"a long real message. ".repeat(20)}, ${CRM_COVER_TEXT}`)).toBe(false);
    expect(isCoverTextOnly("Please find our message below / attached. Also the price is 5k.")).toBe(false);
  });

  it("is false for nothing at all", () => {
    expect(isCoverTextOnly(null)).toBe(false);
    expect(isCoverTextOnly(undefined)).toBe(false);
    expect(isCoverTextOnly("")).toBe(false);
  });
});

describe("sentHtmlToShow", () => {
  const cover = "Dear Sara,\n\nPlease find our message below / attached.\n";

  it("shows the HTML of a composed email, whose text is only the cover line", () => {
    expect(sentHtmlToShow({ direction: "OUTBOUND", textBody: cover, htmlBody: HTML })).toBe(HTML);
  });

  it("keeps the text of a reply typed in the inbox", () => {
    expect(sentHtmlToShow({ direction: "OUTBOUND", textBody: "hi this is a test", htmlBody: "<p>hi this is a test</p>" })).toBeNull();
  });

  it("never swaps a SPONSOR's message for its HTML, whatever its text says", () => {
    // Their HTML is anyone's markup; the text-first rule for inbound mail stays.
    expect(sentHtmlToShow({ direction: "INBOUND", textBody: cover, htmlBody: HTML })).toBeNull();
  });

  it("has nothing to show when there is no HTML, so the text (or the empty note) stands", () => {
    expect(sentHtmlToShow({ direction: "OUTBOUND", textBody: cover, htmlBody: null })).toBeNull();
    expect(sentHtmlToShow({ direction: "OUTBOUND", textBody: cover })).toBeNull();
  });
});

describe("the send and the view share one cover line", () => {
  const service = readFileSync(join(process.cwd(), "src/crm/services/sponsor-email-service.ts"), "utf8");
  const inbox = readFileSync(join(process.cwd(), "src/crm/components/crm-inbox.tsx"), "utf8");

  it("the service builds its text part from the constant, never from its own copy of the words", () => {
    expect(service).toContain("const TEXT_TEMPLATE = `${CRM_COVER_TEXT}\\n`;");
    expect(service).not.toContain("Please find our message below");
  });

  it("the conversation view asks the rule before it shows the text", () => {
    const body = inbox.slice(inbox.indexOf("function MessageBody("), inbox.indexOf("function MessageBubble("));
    expect(body.indexOf("sentHtmlToShow(message)")).toBeGreaterThan(-1);
    expect(body.indexOf("sentHtmlToShow(message)")).toBeLessThan(body.indexOf("PlainTextBody"));
    // The frame stays locked down: no scripts, no access to the page around it.
    expect(inbox).toContain('sandbox=""');
    expect(inbox).not.toMatch(/sandbox="[^"]*allow/);
  });
});
