/**
 * Bill-to naming + address-line normalisation for the quote / invoice /
 * receipt family.
 *
 * Both helpers exist because of an organizer-reported defect, and both defects
 * were of the same class: a value that renders fine in isolation but is WRONG
 * once you know which caller produced it.
 *
 *  - `formatRecipientName` — callers disagree on the title's shape. The quote
 *    builder passes the raw Prisma enum ("DR"), the invoice builder passes the
 *    already-formatted label ("Dr."). Anything handling only one of the two
 *    breaks the other, and the invoice failure mode is SILENT (a dropped
 *    honorific), which is why it is pinned in both directions here.
 *
 *  - `toAddressLines` — the header advances a fixed 11pt per array entry, so a
 *    multi-line address arriving as ONE entry draws over the line beneath it.
 */
import { describe, it, expect } from "vitest";
import { formatDateShort, formatRecipientName, toAddressLines } from "@/lib/pdf/document-layout";

describe("formatDateShort", () => {
  it("renders day-first, not month-first", () => {
    // The organizer-reported defect: 9 April printed as "4/9/2026", which a
    // UAE or European reader files as 4 September. On an invoice this lands on
    // the issue date and the due date, i.e. on the payment clock.
    expect(formatDateShort(new Date("2026-04-09T08:00:00Z"))).toBe("09/04/2026");
  });

  it("zero-pads both parts so the format is self-evident", () => {
    // Unpadded "4/9" gives a reader nothing to infer the convention from;
    // fixed-width "04/09" at least signals one is in force.
    expect(formatDateShort(new Date("2026-01-02T08:00:00Z"))).toBe("02/01/2026");
    expect(formatDateShort(new Date("2026-12-25T08:00:00Z"))).toBe("25/12/2026");
  });

  it("is unambiguous on a date where the two conventions cannot be told apart", () => {
    // 5/5 reads the same either way — a passing assertion here would prove
    // nothing, so it is paired with a date that discriminates.
    expect(formatDateShort(new Date("2026-05-05T08:00:00Z"))).toBe("05/05/2026");
    expect(formatDateShort(new Date("2026-05-11T08:00:00Z"))).toBe("11/05/2026");
  });

  it("renders in Asia/Dubai, not the server's timezone", () => {
    // 21:30 UTC on the 8th is 01:30 on the 9th in Dubai. Without the shift the
    // same document would date differently depending on where it rendered.
    expect(formatDateShort(new Date("2026-04-08T21:30:00Z"))).toBe("09/04/2026");
  });
});

describe("formatRecipientName", () => {
  it("maps the raw Prisma enum to a written honorific (the quote path)", () => {
    expect(formatRecipientName("DR", "Ahmed", "Osman")).toBe("Dr. Ahmed Osman");
    expect(formatRecipientName("PROF", "Jane", "Doe")).toBe("Prof. Jane Doe");
  });

  it("passes an ALREADY-formatted label through unchanged (the invoice path)", () => {
    // The regression this guards: mapping only the enum would return
    // "Ahmed Osman" here, silently dropping the title from every invoice.
    expect(formatRecipientName("Dr.", "Ahmed", "Osman")).toBe("Dr. Ahmed Osman");
    expect(formatRecipientName("Prof.", "Jane", "Doe")).toBe("Prof. Jane Doe");
  });

  it("addresses the recipient given-name first, never surname-first", () => {
    // "Osman, DR Ahmed" was a directory sort order printed where a form of
    // address belongs.
    const rendered = formatRecipientName("DR", "Ahmed", "Osman");
    expect(rendered).toBe("Dr. Ahmed Osman");
    expect(rendered).not.toContain(",");
  });

  it("omits the honorific entirely when there is none", () => {
    expect(formatRecipientName(null, "Ahmed", "Osman")).toBe("Ahmed Osman");
    expect(formatRecipientName(undefined, "Ahmed", "Osman")).toBe("Ahmed Osman");
    expect(formatRecipientName("", "Ahmed", "Osman")).toBe("Ahmed Osman");
  });

  it("never leaves stray padding when a name part is blank", () => {
    expect(formatRecipientName("DR", "Ahmed", "")).toBe("Dr. Ahmed");
    expect(formatRecipientName(null, "", "Osman")).toBe("Osman");
  });
});

describe("toAddressLines", () => {
  it("splits an admin-entered line break into its own rendered line", () => {
    // What the organizer asked for: "Dubai Studio City" on its own line. The
    // field is a textarea, so the break is theirs to place — this makes the
    // renderer honour it instead of collapsing it into one over-drawn line.
    expect(toAddressLines("508 & 509, DSC tower\nDubai Studio City")).toEqual([
      "508 & 509, DSC tower",
      "Dubai Studio City",
    ]);
  });

  it("handles CRLF, which is what a Windows paste produces", () => {
    expect(toAddressLines("Line one\r\nLine two")).toEqual(["Line one", "Line two"]);
  });

  it("strips a dangling separator at the end of a line", () => {
    // The live MM Group record ends "…Dubai Studio City," — a trailing comma
    // on the last address line is always a typo, never intent.
    expect(toAddressLines("508 & 509, DSC tower, Dubai Studio City,")).toEqual([
      "508 & 509, DSC tower, Dubai Studio City",
    ]);
    expect(toAddressLines("Somewhere;")).toEqual(["Somewhere"]);
  });

  it("keeps separators INSIDE a line", () => {
    expect(toAddressLines("508 & 509, DSC tower")).toEqual(["508 & 509, DSC tower"]);
  });

  it("drops null, undefined, empty and whitespace-only parts", () => {
    expect(toAddressLines(null, "Dubai 502464", undefined, "", "   ", "UAE")).toEqual([
      "Dubai 502464",
      "UAE",
    ]);
  });

  it("drops blank lines produced by a double line break", () => {
    // Otherwise an admin pressing enter twice buys a blank 11pt gap that
    // pushes the TRN line into the info boxes below.
    expect(toAddressLines("First\n\nSecond")).toEqual(["First", "Second"]);
  });

  it("returns an empty array when there is nothing to render", () => {
    expect(toAddressLines(null, undefined, "")).toEqual([]);
  });

  it("flattens across parts in argument order", () => {
    expect(toAddressLines("A\nB", "C", "D\nE")).toEqual(["A", "B", "C", "D", "E"]);
  });
});
