# Abstracts and Session Proposals as Word documents

**Status:** SHIPPED September 10, 2026. Built to this plan; the deviations are recorded below.
**Ask (organiser):** export all abstracts into one Word document, and all session proposals into another, each entry as Title, Theme, Presenting Author, Duration, then the body text, one below another.

### Deviations from the plan as written

1. **A bug the plan did not anticipate, found by step 8 and only by step 8.** One abstract title on Middle East Heart Failure 2027 carries a **vertical tab (U+000B)** where the author pressed Shift+Enter in Word before pasting into the submission form. XML 1.0 forbids that character, `docx` writes it straight through, and Word then refuses the file: **one bad title made the whole four-abstract export unopenable, with no error anywhere in the stack**. The builder now sanitises at the single point every string passes through (`sanitizeXmlText`), mapping U+000B and U+000C to newlines because that is what they mean and dropping the rest of the illegal range. Note the contrast worth remembering: `docxtemplater`, which the speaker-agreement merge uses, **detects** this and throws `invalid_xml_characters`; `docx` has no such check, which is why this failed silently rather than loudly.
2. **The proposals export cap was raised from 500 to 5000.** Not in the plan, but the CSV that shipped the day before inherited the list page's `take: 500`, so an event with more than 500 proposals exported a partial file described as complete. Both formats now take the abstracts export's ceiling.
3. **A shared client download helper** (`src/lib/export-download.ts`) rather than the fetch-then-save logic written twice. The proposals page was still a bare `<a href download>`, so this also fixed its silent-failure-on-403 case.
4. **Author label differs by type**: "Presenting Author" on an abstract (the organiser's own wording) and "Proposer" on a session proposal (accurate, and what that CSV column already says), following decision 2's "show what is relevant to what".

## 1. Decisions locked with the owner

| # | Question | Decision |
|---|---|---|
| 1 | Library | Add `docx` (pure JS builder, no native code). Logged as DEP-003. |
| 2 | The "Duration" line | Show what is relevant to each type. Abstracts: Presentation Type. Proposals: Duration (minutes) and Format. |
| 3 | Presenting Author | Name, then organisation and country when set. |
| 4 | Co-authors | A "Co-authors" line when present, each with organisation and country when set. |
| 5 | Separation between entries | Spacing plus a thin horizontal rule (a paragraph bottom border, one line of code in `docx`). No page break. |
| 6 | Theme | "Theme › Sub-theme" when the abstract has a sub-theme, else the theme alone. |

## 2. What exists that this builds on

- `GET /api/events/[eventId]/abstracts?export=csv` and `GET /api/events/[eventId]/session-proposals?export=csv` (September 9, 2026). Both already resolve the population, the staff-only export boundary (`denyReviewer` with no allow-list: SUPER_ADMIN, ADMIN, ORGANIZER), the 5000-row cap on abstracts, and the `recordExport` audit row. The Word export is a second output format on the same call, so it inherits all of that and cannot disagree with the CSV about who or what.
- Abstract `content` and proposal `description` are plain text from a Textarea (no HTML), so the body is split on newlines into paragraphs and nothing is converted.
- `docxtemplater` and `pizzip` are already in the tree for the speaker-agreement merge. They fill a template; they do not build a document from data. The test for this feature unzips the output with `pizzip` and reads the XML, so no second zip library is needed.
- Microsoft Word is installed on the development Mac, so both files are opened in Word as the final check.

## 3. Document layout (per entry)

```
A-007  Title of the abstract                   <- Heading 2
Theme: Cardiology › Heart failure              <- bold label, plain value
Presenting Author: Dr Amal Haddad, Tawam Hospital, United Arab Emirates
Co-authors: Dr Sara Khan, Cleveland Clinic, UAE; Prof Omar Ali, KAUST, Saudi Arabia
Presentation Type: Oral                        <- Duration: 45 minutes + Format: Workshop on proposals
                                               <- blank line
Body paragraph one.
Body paragraph two.
────────────────────────────────────────────   <- thin rule, then spacing
```

- A missing value drops the line (no "Theme: " with nothing after it), the same rule the certificate starter uses for empty labels.
- The document opens with a title line: event name, "Abstracts" or "Session Proposals", the count, and the export date.
- Text is written as data, never as markup, so `&`, `<`, `>` and quotes in a title or body land verbatim in Word.

## 4. Build steps

1. **Dependency.** `npm install docx@9` (pins the major). Bump `package.json` and `package-lock.json` together. Add DEP-003 to `docs/DEPENDENCY_LOG.md` (what, why, exposure: server-only, no network, runs only inside two staff routes).
2. **One builder,** `src/lib/docx-export.ts`: `buildEntriesDocx({ title, entries })` where an entry is `{ heading, fields: { label, value }[], body }`. Returns a `Buffer`. Both routes call it, so the two documents share one layout and a change reaches both. Pure function, no database, no Next imports.
3. **Two mappers beside the builder:** `abstractToDocxEntry(row)` and `proposalToDocxEntry(row)` own the field order and the drop-empty rule, so the routes stay thin and the tests can pin the mapping without a request.
4. **Routes.** In both GETs, `wantsDocx = searchParams.get("export") === "docx"`; it joins `wantsCsv` on the existing staff gate and the abstracts row cap, then returns the buffer with `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document` and `Content-Disposition: attachment; filename="abstracts-{eventId}.docx"` (proposals likewise). `recordExport` records `format: "docx"`. The event name for the document title comes from the event lookup the route already performs (one added `name` in its `select`).
5. **UI.** On both pages the Export CSV button becomes a small Export menu (CSV, Word). Both items use fetch-then-save. This also converts the proposals page off its bare anchor, which today would save an error page as a `.csv` on a lapsed session.
6. **Tests.** Builder: unzip with `pizzip`, assert the entries appear in order, a title containing `&` and `<` is escaped in `document.xml`, empty fields produce no label, a two-paragraph body becomes two paragraphs. Mappers: abstract with sub-theme and co-authors, proposal with duration and format, both with everything absent. Routes: MEMBER gets 403 on `export=docx`, staff gets the Word content type, `recordExport` is called with `format: "docx"`.
7. **Docs.** CLAUDE.md entry, a line in the user guide beside the CSV export callouts (Abstracts and Session Proposals sections), so the help assistant answers "how do I export to Word".
8. **Verify.** Full gate (tsc, eslint, 11 guard scripts, vitest, build). Then export both documents from the local prod copy (MEHF 2027 has abstracts with co-authors and sub-themes; a proposal event with a duration) and open each in Word.

## 5. What does not change

- No schema change, no migration.
- The abstracts JSON list and the CSV are untouched.
- Reviewers, submitters and MEMBER cannot export (same refusal as CSV, logged).
- Drafts are excluded (the list query already hides them from staff).

## 6. Risks and how they are covered

- **Large export: measured, not estimated (September 10, 2026, owner asked whether this blocks the event loop and needs a queue).** It does block, proportionally, and the cost is almost entirely the zip packing rather than building the content (constructing 50,000 paragraphs takes 54ms; `Packer.toBuffer` on them takes 805ms).

  | abstracts | wall time | event loop blocked | RSS added | file |
  |---|---|---|---|---|
  | 12 (the largest real call for papers on prod) | 17ms | ~6ms | 7MB | 9KB |
  | 100 | 25ms | 21ms | 15MB | 10KB |
  | 1,000 | 142ms | 95ms | 162MB | 24KB |
  | 5,000 (the cap) | 1,216ms | ~1,280ms | 304MB | 82KB |

  **Decision: stays synchronous, cap stays at 5,000.** Production holds 15 abstracts and 26 session proposals in total, and the biggest single event has 12, so the real cost today is a 6ms blip on a staff-only click. Lowering the cap was considered and rejected: it would re-introduce the silent truncation this change removed, and the cap is meant to mean "everything".

  **The threshold to act on is roughly 1,000 submissions on one event**, where the block reaches ~100ms and memory rather than time becomes the constraint. Past that the move needs no new mechanism: the worker tier already exists and certificate bulk issuance already has this exact shape, which is render in the background, store the artifact, email a link. Re-measure before building it; these numbers are from a development Mac and the box is a 2-vCPU `t3.large` that also serves the registration desk.
- **Word compatibility.** The builder uses only paragraphs, runs, a heading style and a paragraph border. These are the oldest parts of the format. The Word check in step 8 is the proof.
- **The two documents drifting.** Prevented by construction: one builder, two thin mappers.

## 7. Estimate

About half a day including verification. One commit, one deploy.
