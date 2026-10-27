/**
 * Partnerships mailbox capture: the pure rules (Oct 27, 2026). Owner rulings:
 * partnerships@ only, nothing a sponsor sends is ignored, machine mail never
 * becomes a contact, internal-only mail (and the CRM's own forward copies)
 * never loops back in.
 */
import { describe, it, expect } from "vitest";
import {
  captureDirection,
  contactNameFromSender,
  isAutomatedMail,
  domainMatchesWebsite,
  isFreemailDomain,
  normalizeSubject,
  websiteDomain,
} from "@/crm/lib/inbox-capture";

const MAILBOX = "partnerships@meetingmindsdubai.com";
const internal = (e: string) => e.endsWith("@meetingmindsdubai.com") || e.endsWith("@meetingmindsexperts.com");
const dir = (fromEmail: string, recipients: string[]) =>
  captureDirection({ mailbox: MAILBOX, fromEmail, recipients, isInternal: internal, replyDomain: "reply.meetingmindsexperts.com" });

describe("captureDirection", () => {
  it("a sponsor writing to the mailbox is inbound, with the sender as the counterparty", () => {
    expect(dir("jane@abbott.com", [MAILBOX])).toEqual({ kind: "inbound", counterparty: "jane@abbott.com" });
  });

  it("the mailbox writing out (a rep in Outlook) is outbound to the first outside recipient", () => {
    expect(dir(MAILBOX, ["sohail@meetingmindsdubai.com", "jane@abbott.com"])).toEqual({
      kind: "outbound",
      counterparty: "jane@abbott.com",
    });
  });

  it("skips internal-only mail, including the CRM's own forward copies to the mailbox", () => {
    expect(dir("saleh@meetingmindsdubai.com", [MAILBOX])).toEqual({ kind: "skip", reason: "internal-sender" });
    expect(dir(MAILBOX, [MAILBOX])).toEqual({ kind: "skip", reason: "internal-only" });
  });

  it("captures a sender who only Bcc'd the mailbox (delivery to the capture address is the proof)", () => {
    expect(dir("jane@abbott.com", ["colleague@abbott.com"])).toEqual({ kind: "inbound", counterparty: "jane@abbott.com" });
  });

  it("skips mail from the CRM's own receiving domain", () => {
    expect(dir("abc@reply.meetingmindsexperts.com", [MAILBOX]).kind).toBe("skip");
  });

  it("is case-insensitive", () => {
    expect(dir("Jane@Abbott.com", ["Partnerships@MeetingMindsDubai.com"]).kind).toBe("inbound");
  });
});

describe("isAutomatedMail", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it("flags auto-replies, lists, bulk mail and no-reply senders", () => {
    expect(isAutomatedMail(headers({ "auto-submitted": "auto-replied" }), "jane@abbott.com")).toBe(true);
    expect(isAutomatedMail(headers({ "list-unsubscribe": "<mailto:x>" }), "news@abbott.com")).toBe(true);
    expect(isAutomatedMail(headers({ precedence: "bulk" }), "x@abbott.com")).toBe(true);
    expect(isAutomatedMail(headers({}), "no-reply@abbott.com")).toBe(true);
    expect(isAutomatedMail(headers({}), "MAILER-DAEMON@abbott.com")).toBe(true);
  });

  it("does not flag a person, or an explicit Auto-Submitted: no", () => {
    expect(isAutomatedMail(headers({}), "jane@abbott.com")).toBe(false);
    expect(isAutomatedMail(headers({ "auto-submitted": "no" }), "jane@abbott.com")).toBe(false);
  });
});

describe("normalizeSubject", () => {
  it("strips stacked reply and forward prefixes and case", () => {
    expect(normalizeSubject("RE: Fwd: re:  Sponsorship  Gold")).toBe("sponsorship gold");
    expect(normalizeSubject("Re[2]: AW: Sponsorship")).toBe("sponsorship");
    expect(normalizeSubject(null)).toBe("");
  });
});

describe("contactNameFromSender", () => {
  it("splits a display name", () => {
    expect(contactNameFromSender("Jane Doe", "jane@abbott.com")).toEqual({ firstName: "Jane", lastName: "Doe", tags: [] });
  });

  it("flips Outlook's 'Last, First' like the import does", () => {
    expect(contactNameFromSender("Doe, Jane", "jane@abbott.com")).toMatchObject({ firstName: "Jane", lastName: "Doe" });
  });

  it("falls back to the email and tags needs-name when there is no usable name", () => {
    expect(contactNameFromSender(null, "jane.doe@abbott.com")).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      tags: ["needs-name"],
    });
    expect(contactNameFromSender("jane@abbott.com", "jane@abbott.com").tags).toContain("needs-name");
  });

  it("a single name gets surname Unknown, tagged", () => {
    expect(contactNameFromSender("Jane", "jane@abbott.com")).toEqual({
      firstName: "Jane",
      lastName: "Unknown",
      tags: ["needs-name"],
    });
  });
});

describe("website domains (review MED: no lookalike matches)", () => {
  it("reads the domain from a website however it is written", () => {
    expect(websiteDomain("https://www.Abbott.com/en")).toBe("abbott.com");
    expect(websiteDomain("abbott.com")).toBe("abbott.com");
    expect(websiteDomain("")).toBeNull();
  });

  it("matches the same domain or a subdomain, never a lookalike", () => {
    expect(domainMatchesWebsite("abbott.com", "https://www.abbott.com")).toBe(true);
    expect(domainMatchesWebsite("uk.abbott.com", "abbott.com")).toBe(true);
    expect(domainMatchesWebsite("abbott.co", "https://www.abbott.com")).toBe(false);
    expect(domainMatchesWebsite("lab.com", "collab.com")).toBe(false);
  });
});

describe("isFreemailDomain", () => {
  it("knows consumer domains and nothing else", () => {
    expect(isFreemailDomain("Gmail.com")).toBe(true);
    expect(isFreemailDomain("abbott.com")).toBe(false);
  });
});
