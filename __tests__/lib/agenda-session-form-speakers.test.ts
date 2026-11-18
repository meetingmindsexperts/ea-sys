/**
 * The agenda's session form on an event with no speakers (Oct 15 2026): the
 * roles, speakers and topics sections used to vanish without a word, and an
 * organiser on 4th GCC took it for a lost permission. Pinned on the source,
 * because the page is a 2,000-line client component with no render harness:
 *   - topics are offered whatever the speakers (a topic needs none);
 *   - where speakers are needed, a note links to the Speakers page instead of
 *     the section disappearing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/events/[eventId]/agenda/page.tsx"), "utf8");
const block = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe("agenda session form without speakers", () => {
  it("offers topics whatever the event's speakers", () => {
    const topics = block("{/* Topics (optional)", "{/* Zoom Integration");
    expect(topics).toContain("{!isBreakForm && (");
    expect(topics.split("\n").slice(0, 3).join("\n")).not.toMatch(/hasSpeakers|speakers as Speaker\[\]\)\.length/);
    // only the per-topic speaker picker waits for speakers, with the note in its
    // place; a Panel Discussion / Q&A preset has its "Presented by" instead of both
    expect(topics).toContain('{!topic.presenterLabel && !hasSpeakers && (');
    expect(topics).toContain('<NoSpeakersNote eventId={eventId} what="choose who presents this topic" />');
  });

  it("explains, with a link, why session roles cannot be assigned yet", () => {
    const roles = block("{/* Session Roles", "{/* Topics (optional)");
    expect(roles).toContain("{!isBreakForm && !hasSpeakers && (");
    expect(roles).toContain("<NoSpeakersNote");
    expect(src).toMatch(/href=\{`\/events\/\$\{eventId\}\/speakers`\}/);
  });

  // Nov 17, 2026 (owner: "when assigning session roles in agenda, there is no
  // search"). The speaker of a role was a plain dropdown: on MEHF2027 that is
  // 202 names to scroll. It is the same searchable picker the forms use.
  it("lets the organiser search for the speaker of a session role", () => {
    const roles = block("{/* Session Roles", "{/* Topics (optional)");
    expect(roles).toContain("<SearchableSelect");
    expect(roles).toContain('searchPlaceholder="Search speakers..."');
    expect(roles).toContain("options={speakerOptions}");
    // Without the label the row shows the speaker's raw id once one is picked.
    expect(roles).toContain("displayLabel={speakerNameById.get(sr.speakerId)");
    // The role itself (four choices) stays a plain dropdown; the speaker does not.
    expect(roles.match(/<Select\b/g)).toHaveLength(1);
  });

  // Review of 2d3068a6: the API hands speakers over newest first, and names are
  // stored as typed (a trailing space in a first name is two spaces in the label).
  it("lists the speakers by name, with stray spaces collapsed", () => {
    const options = block("const speakerOptions = useMemo(", "const speakerNameById");
    expect(options).toContain('.replace(/\\s+/g, " ").trim()');
    expect(options).toContain("a.label.localeCompare(b.label");
  });
});
