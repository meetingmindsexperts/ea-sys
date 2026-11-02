import { describe, it, expect } from "vitest";
import {
  COLLAPSED_CHARS,
  COLLAPSED_LINES,
  collapseLongText,
  linkifyEmailText,
  splitQuotedHistory,
  tidyEmailText,
} from "@/crm/lib/inbox-message-text";

describe("tidyEmailText", () => {
  it("collapses a newsletter's blank runs and trims every line", () => {
    const raw = "DASHBOARD\r\n \r\n \r\n   \r\n DRIVE MORE FOOTFALL  \r\n\r\n\r\n Jan\n \n \n 29\n\n\n";
    expect(tidyEmailText(raw)).toBe("DASHBOARD\n\nDRIVE MORE FOOTFALL\n\nJan\n\n29");
  });

  it("drops Outlook's redundant <mailto:> annotations", () => {
    expect(tidyEmailText("From: Partnerships a@x.com<mailto:a@x.com>")).toBe("From: Partnerships a@x.com");
  });

  it("drops leading blank lines", () => {
    expect(tidyEmailText("\n\n  \nHello")).toBe("Hello");
  });
});

describe("splitQuotedHistory", () => {
  it("folds a Gmail reply whose 'On ... wrote:' wraps onto two lines", () => {
    const text = tidyEmailText(
      "ok, i am testing back\n\nOn Fri, Jul 24, 2026 at 9:49 AM Event Management System <\nx@meetingmindsexperts.com> wrote:\n\n> hi this is a test\n>\n> Best",
    );
    const { body, quoted } = splitQuotedHistory(text);
    expect(body).toBe("ok, i am testing back");
    expect(quoted).toMatch(/^On Fri, Jul 24/);
    expect(quoted).toContain("> hi this is a test");
  });

  it("folds an Outlook reply from the underscore separator", () => {
    const text = tidyEmailText(
      "Thanks, noted.\n\nRegards\n\n________________________________\nFrom: Partnerships <p@x.com>\nSent: Tuesday, October 27, 2026 2:49 PM\nTo: Someone <s@x.com>\nSubject: Sponsorship Opportunity\n\nDear ...",
    );
    const { body, quoted } = splitQuotedHistory(text);
    expect(body).toBe("Thanks, noted.\n\nRegards");
    expect(quoted).toMatch(/^_{10,}\nFrom: Partnerships/);
  });

  it("folds an Outlook header block with no separator", () => {
    const text = "Please see attached.\n\nFrom: Partnerships p@x.com\nSent: Thursday, October 29, 2026 2:43 PM\nTo: Z\nCc: C\nSubject: Re: Letter";
    expect(splitQuotedHistory(text).body).toBe("Please see attached.");
  });

  it("folds '-----Original Message-----'", () => {
    expect(splitQuotedHistory("Yes.\n\n-----Original Message-----\nFrom: a").quoted).toMatch(/^-----Original/);
  });

  it("folds a trailing block of '>' lines", () => {
    expect(splitQuotedHistory("Agreed.\n\n> earlier\n>\n> text").body).toBe("Agreed.");
  });

  it("leaves a '>' line in the middle of a message alone", () => {
    const text = "Numbers:\n> 50 delegates\nMore below.";
    expect(splitQuotedHistory(text)).toEqual({ body: text, quoted: null });
  });

  it("does not take a 'From:' line without a Sent/Date line for a header", () => {
    const text = "From: our side, all good.\nSee you then.";
    expect(splitQuotedHistory(text)).toEqual({ body: text, quoted: null });
  });

  it("does not take an 'On ...' sentence for a quote marker", () => {
    const text = "On Monday we can sign.\nThe team wrote: nothing yet.";
    expect(splitQuotedHistory(text).quoted).toBeNull();
  });

  it("keeps a bare forward whole: nothing to fold it behind", () => {
    const text = "From: a@x.com\nSent: Monday\nSubject: Fwd\n\nBody";
    expect(splitQuotedHistory(text)).toEqual({ body: text, quoted: null });
  });
});

describe("collapseLongText", () => {
  it("leaves a short message whole", () => {
    expect(collapseLongText("a\nb")).toEqual({ shown: "a\nb", truncated: false });
  });

  it("cuts after the line cap", () => {
    const text = Array.from({ length: COLLAPSED_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const { shown, truncated } = collapseLongText(text);
    expect(truncated).toBe(true);
    expect(shown.split("\n")).toHaveLength(COLLAPSED_LINES);
  });

  it("cuts a few very long lines at a word near the character cap", () => {
    const text = "word ".repeat(1000).trim();
    const { shown, truncated } = collapseLongText(text);
    expect(truncated).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(COLLAPSED_CHARS);
    expect(shown.endsWith("word")).toBe(true);
  });
});

describe("linkifyEmailText", () => {
  it("makes a short link clickable as itself", () => {
    expect(linkifyEmailText("see https://x.com/a.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://x.com/a", label: "https://x.com/a" },
      { kind: "text", text: "." },
    ]);
  });

  it("labels a long link by its host", () => {
    const href = `https://links.10times.com/asm/unsubscribe/?user_id=1&data=${"x".repeat(200)}`;
    const parts = linkifyEmailText(`Unsubscribe ${href}`);
    expect(parts[1]).toEqual({ kind: "link", href, label: "links.10times.com/…" });
  });

  it("swallows Outlook's angle brackets around a link", () => {
    expect(linkifyEmailText("W: www.x.com<http://www.x.com/>\nT")).toEqual([
      { kind: "text", text: "W: www.x.com " },
      { kind: "link", href: "http://www.x.com/", label: "http://www.x.com/" },
      { kind: "text", text: "\nT" },
    ]);
  });

  it("never links anything but http and https", () => {
    expect(linkifyEmailText("javascript:alert(1) ftp://x.com")).toEqual([
      { kind: "text", text: "javascript:alert(1) ftp://x.com" },
    ]);
  });
});
