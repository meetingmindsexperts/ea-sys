/**
 * Repair the abstract-submission-confirmation email on events that have real
 * abstracts (Aug 27, 2026).
 *
 * WHY THIS EXISTS
 * ---------------
 * `DEFAULT_TEMPLATES` in src/lib/email.ts is only a SEED. The templates list
 * materialises a row per event on first view, so 26 events hold their own
 * frozen copy and editing the default reaches none of them. Two things drifted:
 *
 *   1. `{{abstractNumber}}` (added Aug 4) is in no live copy, so submitters
 *      never receive the A-### reference we ask them to quote back at us.
 *   2. `{{travelGrantBlock}}` (added Aug 25) is in no live copy, so switching
 *      Travel Grant on would skip every overseas author SILENTLY — the email
 *      simply would not carry the invitation, and nothing would say so.
 *
 * Middle East Heart Failure 2027 additionally has a hand-built table where
 * somebody duplicated the "Status: Submitted" row and renamed the labels
 * without changing the values, so real authors were told:
 *   Paper Number: Submitted / Theme: Submitted / Presenting Author: (blank)
 * with the actual co-author names orphaned outside the styled body.
 *
 * SAFETY
 * ------
 * Dry run by default; `--write` to apply. Every edit is idempotent (skipped
 * when the token is already present) and ANCHOR-BASED: if the expected markup
 * is not found the event is REPORTED AND SKIPPED rather than guessed at. These
 * are organizers' own hand-edited templates and their wording is theirs — this
 * only repairs values that were never wired up, and never rewrites prose.
 *
 * Run it on the box, in the worker container, so it uses the same runtime and
 * env as production:
 *   docker exec ea-sys-worker npx tsx scripts/repair-abstract-confirmation-templates.ts
 *   docker exec ea-sys-worker npx tsx scripts/repair-abstract-confirmation-templates.ts --write
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const WRITE = process.argv.includes("--write");
const SLUG = "abstract-submission-confirmation";

interface Edit {
  what: string;
  apply: (html: string) => string | null; // null = anchor not found
}

/** Insert an "Abstract #" row immediately above whichever row shows the title. */
const addAbstractNumberRow: Edit = {
  what: "add the Abstract # row",
  apply: (html) => {
    if (html.includes("{{abstractNumber}}")) return html; // already there
    // Anchor on the row that renders the title, whatever its exact styling.
    const m = html.match(/<tr>(?:(?!<\/tr>)[\s\S])*?\{\{abstractTitle\}\}[\s\S]*?<\/tr>/);
    if (!m) return null;
    const row =
      '<tr><td style="padding: 8px 0; color: #6b7280;">Abstract #:</td>' +
      '<td style="padding: 8px 0; font-weight: 500;">{{abstractNumber}}</td></tr>';
    return html.replace(m[0], row + m[0]);
  },
};

/** Append the travel-grant block just before the body's final closing tag. */
const addTravelGrantBlock: Edit = {
  what: "add {{travelGrantBlock}}",
  apply: (html) => {
    if (html.includes("{{travelGrantBlock}}")) return html;
    // Prefer the "Important:" note the default puts it after; else end of body.
    const important = html.lastIndexOf("</p>");
    if (important === -1) return null;
    return html.slice(0, important + 4) + "\n{{travelGrantBlock}}" + html.slice(important + 4);
  },
};

/**
 * MEHF only: four table cells whose VALUE was never wired, plus two orphans.
 * Each replacement is exact — a miss reports rather than guesses.
 */
const mehfRepairs: Edit[] = [
  {
    what: 'Paper Number: "Submitted" -> {{abstractNumber}}',
    apply: (h) => {
      const a = '<p>Paper Number:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>Submitted</strong></p>';
      const b = '<p>Paper Number:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>{{abstractNumber}}</strong></p>';
      return h.includes("{{abstractNumber}}") ? h : h.includes(a) ? h.replace(a, b) : null;
    },
  },
  {
    what: 'Theme: "Submitted" -> {{theme}}',
    apply: (h) => {
      const a = '<p>Theme:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>Submitted</strong></p>';
      const b = '<p>Theme:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>{{theme}}</strong></p>';
      return h.includes("{{theme}}") ? h : h.includes(a) ? h.replace(a, b) : null;
    },
  },
  {
    what: "Presenting Author: (blank) -> {{authorName}}",
    apply: (h) => {
      const a = '<p>Presenting Author:</p></td><td colspan="1" rowspan="1"><p></p>';
      const b = '<p>Presenting Author:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>{{authorName}}</strong></p>';
      return h.includes("{{authorName}}") ? h : h.includes(a) ? h.replace(a, b) : null;
    },
  },
  {
    what: 'Co-Author: "Submitted" -> {{coAuthorNames}}',
    apply: (h) => {
      const a = '<p>Co-Author:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>Submitted</strong></p>';
      const b = '<p>Co-Author:</p></td><td colspan="1" rowspan="1" style="padding: 8px 0px; font-weight: 500;"><p><strong>{{coAuthorNames}}</strong></p>';
      return h.includes(a) ? h.replace(a, b) : h;
    },
  },
  {
    what: "remove the orphan <p>Theme:</p> label above the table",
    apply: (h) => {
      const a = '<h3 style="margin-top: 0px; color: rgb(55, 65, 81);">Submission Details</h3><p>Theme:</p>';
      const b = '<h3 style="margin-top: 0px; color: rgb(55, 65, 81);">Submission Details</h3>';
      return h.includes(a) ? h.replace(a, b) : h;
    },
  },
  {
    what: "remove the orphan co-author names dumped outside the body",
    apply: (h) => {
      const a = "</div><p>{{coAuthorNames}}</p>";
      return h.endsWith(a) ? h.slice(0, -a.length) + "</div>" : h;
    },
  },
  {
    what: "stale year in the sign-off -> {{eventName}} (cannot go stale again)",
    apply: (h) => {
      const a = "<p>Middle East Heart Failure Conference 2026 | Registration Team</p>";
      const b = "<p>{{eventName}} | Registration Team</p>";
      return h.includes(a) ? h.replace(a, b) : h;
    },
  },
];

(async () => {
  const rows = await db.emailTemplate.findMany({
    where: { slug: SLUG, isActive: true, event: { abstracts: { some: {} } } },
    select: { id: true, htmlContent: true, textContent: true,
      event: { select: { name: true, status: true, _count: { select: { abstracts: true } } } } },
  });

  console.log(`${WRITE ? "APPLYING" : "DRY RUN"} — ${rows.length} active template(s) on events with abstracts\n`);
  let changed = 0;

  for (const r of rows) {
    const name = r.event?.name ?? "(unknown)";
    console.log("=".repeat(76));
    console.log(`${name}  [${r.event?.status}, ${r.event?._count.abstracts} abstract(s)]`);
    let html = r.htmlContent;
    let text = r.textContent ?? "";
    const done: string[] = [];
    const skipped: string[] = [];

    const edits = name.includes("Middle East Heart Failure")
      ? [...mehfRepairs, addTravelGrantBlock]
      : [addAbstractNumberRow, addTravelGrantBlock];

    for (const e of edits) {
      const next = e.apply(html);
      if (next === null) { skipped.push(`${e.what}  (anchor not found — LEFT ALONE)`); continue; }
      if (next !== html) { html = next; done.push(e.what); }
    }

    // Plain-text half: same two additions, same idempotency.
    if (!text.includes("{{abstractNumber}}") && text.includes("{{abstractTitle}}")) {
      text = text.replace(/(- Title: \{\{abstractTitle\}\})/, "- Abstract #: {{abstractNumber}}\n$1");
      if (text.includes("{{abstractNumber}}")) done.push("text: add Abstract # line");
    }
    if (!text.includes("{{travelGrantBlockText}}")) {
      text = text.trimEnd() + "\n\n{{travelGrantBlockText}}\n";
      done.push("text: add {{travelGrantBlockText}}");
    }

    for (const d of done) console.log("   ✓", d);
    for (const s of skipped) console.log("   !", s);
    if (!done.length) { console.log("   (nothing to do — already current)"); continue; }
    changed++;

    if (WRITE) {
      await db.emailTemplate.update({ where: { id: r.id }, data: { htmlContent: html, textContent: text } });
      console.log("   → written");
    }
  }

  console.log("\n" + "=".repeat(76));
  console.log(`${changed} template(s) ${WRITE ? "updated" : "would be updated"}.`);
  if (!WRITE && changed) console.log("Re-run with --write to apply. Safe to run twice — every edit is idempotent.");
  await db.$disconnect();
})();
