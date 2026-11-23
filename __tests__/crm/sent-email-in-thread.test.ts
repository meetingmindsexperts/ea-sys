/**
 * An email the CRM sent shows in its conversation as what was SENT (Nov 23, 2026).
 *
 * The inbox shows a message's text first. The text part of every email the CRM
 * itself sends (composed, a blast, a reply typed in the inbox) is only a cover
 * line ("Please find our message below / attached."), because the message is
 * HTML, so the conversation showed that line and the email was nowhere to be
 * read: every one since the inbox was built (16 on production the day it was
 * reported). The view now shows the HTML for exactly those, and the text for
 * everything else (a sponsor's mail, and our own mail captured from Outlook).
 *
 * The texts below are the ones production holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_COVER_GREETING, CRM_COVER_TEXT, isCoverTextOnly, sentHtmlToShow } from "@/crm/lib/inbox-message-text";

const HTML = "<table><tr><td><p>Dear Sara,</p><p>The real message.</p></td></tr></table>";

describe("isCoverTextOnly", () => {
  it("knows the cover line as the service stores it, with and without the greeting", () => {
    expect(isCoverTextOnly("Please find our message below / attached.\n")).toBe(true);
    expect(isCoverTextOnly("Dear Jon,\n\nPlease find our message below / attached.\n")).toBe(true);
    expect(isCoverTextOnly("Dear Dr. María José O'Neil-Smith,\r\n\r\nPlease find our message below / attached.\r\n")).toBe(true);
  });

  it("knows whatever the service's own greeting and cover line produce, for any name", () => {
    // Built from the constants the service sends with: change the greeting's words and this still holds.
    for (const name of ["Sara", "", "Smith, John", "Dr. María José O'Neil-Smith", "x".repeat(150)]) {
      expect(isCoverTextOnly(`${CRM_COVER_GREETING.replace("{{firstName}}", name)}\n\n${CRM_COVER_TEXT}\n`), name).toBe(true);
    }
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

  it("shows the HTML of a reply typed in the inbox too: it is sent the same way, with the same cover line", () => {
    expect(sentHtmlToShow({ direction: "OUTBOUND", textBody: "Please find our message below / attached.\n", htmlBody: "<p>ok thanks</p>" })).toBe("<p>ok thanks</p>");
  });

  it("keeps the text of our own mail captured from the mailbox, whose text is the message", () => {
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

  it("the service builds its text part from the constants, never from its own copy of the words", () => {
    expect(service).toContain("const TEXT_TEMPLATE = `${CRM_COVER_TEXT}\\n`;");
    expect(service).toContain("`${CRM_COVER_GREETING}\\n\\n`");
    expect(service).not.toContain("Please find our message below");
    expect(service).not.toMatch(/textGreeting = greeting \? "Dear/);
  });

  it("every email the service records is one it rendered: one writer of the conversation row", () => {
    // If a second writer appears with a real text part, the rule above needs a look.
    expect(service.match(/recordOutboundEmail\(/g)?.length).toBe(1);
    expect(service).toContain("textBody: rendered.textContent ?? null");
  });

  it("the conversation view asks the rule before it shows the text", () => {
    const body = inbox.slice(inbox.indexOf("function MessageBody("), inbox.indexOf("function MessageBubble("));
    // Asked, and its answer RETURNED, before the text is.
    expect(body).toMatch(/const sentHtml = sentHtmlToShow\(message\);\s*if \(sentHtml\) return <HtmlBody html=\{sentHtml\}/);
    expect(body.indexOf("sentHtmlToShow(message)")).toBeLessThan(body.indexOf("PlainTextBody"));
    // Every frame in the file stays locked down: no scripts, no access to the page around it.
    const frames = inbox.match(/<iframe\b/g)?.length ?? 0;
    expect(frames).toBeGreaterThanOrEqual(1);
    expect(inbox.match(/sandbox=""/g)?.length).toBe(frames);
  });
});
