import { describe, it, expect } from "vitest";
import { mergeAgreementHtml, parseHtmlToBlocks } from "@/lib/speaker-agreement";
import type { SpeakerEmailContext } from "@/lib/speaker-agreement";

const ctx: SpeakerEmailContext = {
  title: "Dr.",
  firstName: "Jane",
  lastName: "Smith",
  speakerName: "Dr. Jane Smith",
  speakerEmail: "jane@example.com",
  eventName: "International Cardiology Summit",
  eventSlug: "cardio-2026",
  eventStartDate: "March 5, 2026",
  eventEndDate: "March 7, 2026",
  eventDate: "March 5, 2026",
  eventVenue: "Dubai World Trade Centre",
  eventAddress: "Sheikh Zayed Road, Dubai",
  organizationName: "Heart Society",
  sessionTitles: "Opening Keynote",
  topicTitles: "Heart Failure 2026",
  sessionDateTime: "Mar 5, 2026, 9:00 AM",
  trackNames: "Main Stage",
  role: "Speaker",
  presentationDetails: "<table>...</table>",
  presentationDetailsText: "Session: Opening Keynote",
};

describe("mergeAgreementHtml", () => {
  it("replaces known tokens with the speaker's values", () => {
    const merged = mergeAgreementHtml(
      "<p>Dear {{speakerName}}, welcome to {{eventName}}.</p>",
      ctx,
    );
    expect(merged).toContain("Dr. Jane Smith");
    expect(merged).toContain("International Cardiology Summit");
    expect(merged).not.toContain("{{");
  });

  it("leaves unknown tokens in place so typos are visible", () => {
    const merged = mergeAgreementHtml(
      "<p>Hello {{nonexistent}} and {{firstName}}.</p>",
      ctx,
    );
    expect(merged).toContain("{{nonexistent}}");
    expect(merged).toContain("Jane");
  });

  it("escapes HTML special chars in replacement values to prevent injection", () => {
    const evil: SpeakerEmailContext = {
      ...ctx,
      firstName: "<script>alert(1)</script>",
      organizationName: "Acme & Co <Evil>",
    };
    const merged = mergeAgreementHtml(
      "<p>Hi {{firstName}} from {{organizationName}}.</p>",
      evil,
    );
    expect(merged).not.toContain("<script>");
    expect(merged).toContain("&lt;script&gt;");
    expect(merged).toContain("Acme &amp; Co &lt;Evil&gt;");
  });

  it("tolerates whitespace inside braces ({{ firstName }})", () => {
    const merged = mergeAgreementHtml("<p>{{ firstName }}</p>", ctx);
    expect(merged).toContain("Jane");
  });
});

describe("parseHtmlToBlocks", () => {
  it("emits one block per top-level paragraph and heading", () => {
    const blocks = parseHtmlToBlocks(
      "<h2>Title</h2><p>Body one.</p><p>Body two.</p>",
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ kind: "paragraph" });
    expect(blocks[2]).toMatchObject({ kind: "paragraph" });
  });

  it("preserves bold + italic runs inside a paragraph", () => {
    const blocks = parseHtmlToBlocks(
      "<p>Hello <strong>Dr. Smith</strong>, your <em>session</em> is confirmed.</p>",
    );
    expect(blocks).toHaveLength(1);
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("expected paragraph");
    const bold = para.runs.find((r) => r.bold);
    const italic = para.runs.find((r) => r.italic);
    expect(bold?.text).toContain("Dr. Smith");
    expect(italic?.text).toContain("session");
    const plain = para.runs.find((r) => !r.bold && !r.italic);
    expect(plain?.text).toContain("Hello");
  });

  it("emits numbered list-items with correct indices", () => {
    const blocks = parseHtmlToBlocks(
      "<ol><li>First</li><li>Second</li><li>Third</li></ol>",
    );
    const items = blocks.filter((b) => b.kind === "list-item");
    expect(items).toHaveLength(3);
    expect(items.map((b) => (b.kind === "list-item" ? b.index : 0))).toEqual([
      1, 2, 3,
    ]);
    expect(items.every((b) => b.kind === "list-item" && b.ordered)).toBe(true);
  });

  it("emits bullet list-items with ordered=false", () => {
    const blocks = parseHtmlToBlocks("<ul><li>A</li><li>B</li></ul>");
    const items = blocks.filter((b) => b.kind === "list-item");
    expect(items).toHaveLength(2);
    expect(items.every((b) => b.kind === "list-item" && !b.ordered)).toBe(true);
  });

  it("emits a rule block for <hr>", () => {
    const blocks = parseHtmlToBlocks("<p>Top</p><hr/><p>Bottom</p>");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("captures link hrefs as underlined runs", () => {
    const blocks = parseHtmlToBlocks(
      '<p>Contact <a href="mailto:x@y.com">us</a>.</p>',
    );
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("expected paragraph");
    const link = para.runs.find((r) => r.link);
    expect(link?.text).toBe("us");
    expect(link?.link).toBe("mailto:x@y.com");
    expect(link?.underline).toBe(true);
  });

  it("flattens unknown tags to their inner text without crashing", () => {
    const blocks = parseHtmlToBlocks(
      "<p>Before <img src='x' /> <custom>inner</custom> after</p>",
    );
    expect(blocks).toHaveLength(1);
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("expected paragraph");
    const combined = para.runs.map((r) => r.text).join("");
    expect(combined).toContain("Before");
    expect(combined).toContain("inner");
    expect(combined).toContain("after");
  });

  it("decodes entities in text runs", () => {
    const blocks = parseHtmlToBlocks("<p>Acme &amp; Co &lt;Ltd&gt;</p>");
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("expected paragraph");
    expect(para.runs.map((r) => r.text).join("")).toContain("Acme & Co <Ltd>");
  });
});
