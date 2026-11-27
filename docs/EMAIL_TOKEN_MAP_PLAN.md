# Email tokens: one map per audience

Planned Nov 27, 2026. IN BUILD. Section 7 holds the owner decisions (all three decided Nov 27, 2026).

## 1. The problem

A token such as `{{amount}}` is described in three places that do not know about each other:

1. **What a template may use**: `templateAllowedTokenKeys` in `src/lib/email-template-registry.ts`, built from hand-written lists (`BULK_BASE_VARIABLES`, `BULK_SPEAKER_VARIABLES`, ...). The editor's Variables panel (`CUSTOM_TEMPLATE_VARIABLE_GROUPS`) is a second hand-written copy, kept in step by a test.
2. **What a send fills**: branches inside each sender. The bulk pipeline (`generateEmailForRecipient` in `src/lib/bulk-email.ts`, about 450 lines of branches), the registration sheet's send and the speaker page's send each fill their own set.
3. **What the preview shows**: sample values in `src/lib/email.ts` (`amount: "USD 100.00"` for every template).

When they disagree, a template the editor accepts and the preview renders is refused at send time by the unresolved-token guard, for every recipient.

For the 37 built-in templates the first two are pinned: `email-sender-drift-bulk.test.ts` and `email-sender-drift-single.test.ts` render every default body through every sender. **Nothing pins a saved (custom) template**, and the allowed list has no idea which audience a token belongs to.

### What it has cost

| Date | What happened |
|---|---|
| Sep 18, 2026 | Bulk Registration Confirmation refused on `{{paymentBlock}}`; a template with `{{eventCity}}` sent from Communications and was refused from the registration sheet |
| Sep 25, 2026 | Speaker tokens flagged as unknown in a saved template although a send to speakers fills them |
| Nov 20, 2026 | Abstract tokens in a saved template refused |
| Nov 27, 2026 | A copy of the payment reminder refused on `{{amount}}` for all 25 recipients, 46 minutes after it was saved, at the scheduled send |

### Mismatches that exist today (found while planning, by reading)

- `{{reviewLink}}` is filled for a send to reviewers (`bulk-email.ts`) and is missing from the allowed list, so the editor warns about a token that works.
- `{{daysUntilEvent}}` and `{{personalMessage}}` are filled by the bulk pipeline and not by the registration sheet's send (only its "reminder" type sets the first), so a saved template that uses either sends from Communications and is refused from the sheet.
- `{{honorarium}}` in a saved template sent to registrations is accepted by the editor, scheduled, and refused for everyone at send time. Nothing says so when it is scheduled.

## 2. The idea

One table, the token map: each token once, with who fills it.

```ts
// src/lib/email-tokens/map.ts  (a leaf: no server imports, the editor reads it)
amount: {
  audiences: ["registrations"],
  description: "Amount due (e.g. USD 100.00)",
  note: "Empty for a group member or anyone who owes nothing",
  sample: "USD 100.00",
},
honorarium: { audiences: ["speakers"], ... },
firstName:  { audiences: "all", ... },
paymentBlock: { audiences: ["registrations"], rawHtml: true, ... },
```

Everything else is derived from it or checked against it:

- **The allowed list and the editor's panel** are computed from the map (no hand-written lists).
- **One builder per audience fills the tokens** (`registrationTokens`, `speakerTokens`, `abstractAuthorTokens`, `reviewerTokens`), and both the bulk pipeline and the per-person send call it. Its return type is the map's keys for that audience, so the compiler refuses a token that is declared and not filled, or filled and not declared.
- **A send is checked when it is scheduled**: a template that names a token the chosen audience does not get is refused then, with the token's name and who it is for, not at 07:06 the next morning.
- **The preview** takes its samples from the same map, so it cannot show a value the send will not fill.

## 3. Scope

In: the sends where a person combines a template with an audience: Communications (bulk and scheduled), the registration sheet, the speaker page, the agent's `send_bulk_email`, the preview and test send, and the template editor.

Out, on purpose:

- **Automatic emails** (confirmation, payment receipt, webinar sequence, abstract decisions, about 20 senders). Each sends one built-in template it was written for; the drift tests or their own tests cover them. Their template-specific tokens stay in each template's `variables`.
- **Template-specific branches in the bulk pipeline** (survey link, webinar blocks, registration form link, RSVP). They are keyed by email type, not audience, and are already covered by the drift test. They stay where they are and run after the audience builder.
- **Certificate cover emails, agreement .docx merge fields, CRM emails**: separate vocabularies, kept separate.

## 4. Steps

Each step is one or two commits, changes no email on its own unless stated, and ships by itself.

### Step 0. The map as data, and the test that was missing (about half a day)

- Write the map for the 47 tokens a saved template may use today, each with its audiences. Nothing reads it yet except tests.
- New test, the saved-template twin of the drift tests: for each audience, a saved template that names every token the map gives that audience goes through `executeBulkEmail` and must come out with nothing unresolved; the same through the two per-person routes.
- A second test: `templateAllowedTokenKeys` for a saved template equals the map's keys.
- Expect it to fail on the three mismatches in section 1. Fix each (fill it, or correct the map).

**Why first:** it catches today's class of bug from then on, and it is the safety net for steps 2 and 3.

### Step 1. Say no when it is scheduled (about half a day)

- `precheckBulkEmailViability` (already called by the send route, the schedule route and the agent) asks the map: does this saved template, or typed message, name a token this audience does not get? If so, refuse with code `TOKENS_NOT_FOR_AUDIENCE` and a sentence naming them ("`{{honorarium}}` is filled only when sending to speakers").
- The two per-person routes ask the same.
- The preview answers the same list, so the dialog can show it before Send. The abstract-author preview already does this for its own tokens; this makes it general.
- The editor's Variables panel is drawn from the map (the audience grouping is now data, not a second list).

**Changes for people:** a send that today is accepted and then fails for everyone is refused in the dialog instead. Nothing that sends today stops sending.

### Step 2. One builder per audience (about two days, the risky part)

- `src/lib/email-tokens/registration.ts`, `speaker.ts`, `abstract-author.ts`, `reviewer.ts`: each a function from already-loaded rows to that audience's tokens, typed against the map.
- The bulk pipeline's base block and its audience branches are replaced by a call to the builder, one audience per commit, registrations first (the audience with money in it).
- The registration sheet and the speaker page then call the same builder, and their own copies are deleted.
- Proof that nothing changed: before each commit, a snapshot test renders a fixed set of recipients (paid, unpaid, group member, cancelled, virtual, author on hold; speaker with and without sessions) through every template type for that audience and stores the HTML; after the change the HTML must be byte for byte the same. The snapshot test is deleted when the step is done.

**Rule it sets:** a sender never writes `vars.someToken =` for an audience token; a test lists the files that may.

### Step 3. Delete the old lists (about half a day)

- `BULK_BASE_VARIABLES`, `BULK_SPEAKER_VARIABLES`, `BULK_PRESENTER_VARIABLES`, `BULK_ABSTRACT_*_VARIABLES`, `BULK_CONDITIONAL_VARIABLES` and `CUSTOM_TEMPLATE_VARIABLE_GROUPS` go; their readers ask the map.
- The preview's samples for audience tokens come from the map.
- CLAUDE.md gets its "THE rule" entry; AGENTS.md the convention.

## 5. What it does not fix

- A built-in template's own tokens stay declared per template. That half already works.
- Whether a token's value is right. The map says who fills a token, not what the sum should be (the Nov 27 review's finding about balances was of that second kind).
- A saved copy of the Registration Confirmation still gets the reminder's plain Pay Now as `{{paymentBlock}}` (ROADMAP, Nov 27). The map makes the question visible, since `paymentBlock` gets one definition for the registrations audience; it is decision D3.

## 6. Risks

- **Step 2 edits the file with the most email incidents.** One audience per commit, the byte-for-byte snapshot, and the gate before each push. Never deployed within an hour of a scheduled send.
- **Other work in `bulk-email.ts`.** The sending-speed follow-ups in ROADMAP touch the same file. Step 2 should not overlap them.
- **Step 1 could refuse a send that works.** Only if the map is wrong about an audience, which step 0's test exists to prevent. The refusal names the token, so a wrong entry is found on the first report.

## 7. Owner decisions

All three decided Nov 27, 2026 (owner: "go with your recommendations").

- **D1. How far.** DECIDED: all four steps, in order, checking in after step 1.
- **D2. A token for the wrong audience.** DECIDED: refuse when the send is scheduled, never send it blank. One limit, so that nothing that sends today stops: the older block tokens the bulk pipeline has always set to empty for every audience (`{{presentationDetails}}`, `{{agreementBlock}}`, `{{entryBarcode}}` and the rest of `BULK_BASE_VARIABLES`) stay empty for an audience they mean nothing to. Refused are the tokens a send to that audience does not set at all, which is every case that fails at send time today.
- **D3. `{{paymentBlock}}` in a saved template sent to registrations.** DECIDED: left as today, the reminder's Pay Now button.
