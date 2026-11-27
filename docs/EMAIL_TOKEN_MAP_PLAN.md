# Email tokens: one map per audience

Planned and built Nov 27, 2026 (steps 0 to 3, and typed emails). Section 7 holds the owner decisions.

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
// src/lib/email-token-map.ts  (a leaf: no server imports, the editor reads it)
amount:     { audiences: ["registrations"] },
honorarium: { audiences: ["speakers"] },
firstName:  { audiences: "all" },
// by step 3 each entry also carries its description, its sample and its panel group
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

### Step 0. The map as data, and the test that was missing. BUILT Nov 27, 2026

- `src/lib/email-token-map.ts`: each token a saved template may use (56 keys, five of them the plain-text mirrors of block tokens), with the audiences a send sets it for.
- The drift tests send a saved template naming every token to every audience, through the bulk pipeline and both per-person routes. `email-template-token-check.test.ts` holds the editor's accepted list to the map (apart from the `...Text` mirrors, which the editor accepts for every key; step 3).
- What they found, fixed in the same change: `{{reviewLink}}` was flagged by the editor; the registration record's send left 12 tokens unset that Communications sets, and the speaker page 7. Both now spread `everyAudienceTokenValues`.

### Step 1. Say no when it is scheduled. BUILT Nov 27, 2026

- `emailTokenRefusal` (the map's file; first named `savedTemplateTokenRefusal`), asked by `precheckBulkEmailViability`: a saved template, or the subject and note typed with it, that names a token its audience's send does not set is refused when the send is made or scheduled (code `TOKENS_NOT_SET`), naming the token and who it is for, or that it is not a token (a spelling). A scheduled send firing goes through the same check. The agent's `send_bulk_email` always sends a typed email, which is checked since step 2 (below).
- The drift test proves both other directions: every token the map gives only to other audiences is really left unset by the send, and a saved-template send hands the renderer no variable the map does not list for its audience (per author and per abstract). Together: the refusal stops nothing that would have gone out.
- `{{subject}}` and `{{message}}` (the subject and note typed for the send) joined the map: the bulk pipeline has always set them for a saved template, and the editor flagged them.

Not done in this step, and why:

- **A typed custom email** was not checked in this step; it is since step 2 (below).
- **The per-person sends** are not asked: they send at once, so the refusal already arrives in the same click.
- **The preview's note and the editor's panel drawn from the map** moved to step 3, where the old lists go.
- **It goes by the template's subject and HTML only**, which is what the send's own guard refuses on. A leftover token in the plain-text part stays a warning, and a note typed for the send is not read (it reaches an email only where the template names `{{message}}` or `{{personalMessage}}`, and no screen offers one with a saved template).
- Checked on production, Nov 27, 2026: 84 saved templates, and every token they use is in the map.

Found by the reviews of steps 0 and 1 and fixed with them: a copy of the Abstract Submission Confirmation carries `{{travelGrantBlock}}`, which the first cut of the map left out (it would have been refused; the token is now set, empty, for every author); a reminder sent from the registration record always said "1" day to go; `{{personalMessage}}` from the registration record was escaped and its tokens left unresolved.

### Step 2. One builder for the values. BUILT Nov 27, 2026

- `src/lib/email-token-values.ts`: `everyAudienceTokenValues` (the event, the person, the sender, the typed note, and the block tokens that stay empty until filled) and `speakerTokenValues` (title, programme and fee from the speaker's context). The bulk pipeline, the registration record's send and the speaker page's send spread them; their own copies are deleted.
- What a sender still assigns itself is its own: links it mints, blocks that come with an attachment, the typed subject and note, one email type's blocks. `email-token-writers.test.ts` lists them per file, in each way a token can be written in (an assignment, a key in the `vars` object, a helper merged whole); a new one fails until it is added there.
- Proof that nothing changed: before the change, a temporary test recorded what each sender hands to `sendEmail` (subject, HTML, text, attachment names) for every email type and audience and for saved templates, 48 bulk emails and 16 per-person ones. After it, all 48 bulk emails were byte for byte the same, and 14 of the 16 per-person ones. The two that differ are the intended one: `{{sessionDetails}}` on the speaker page now comes from the speaker's context, as from Communications (the same session rows; the test's stand-in context and stand-in speaker disagreed).
- Narrower than first planned, on purpose: reviewers' and abstract authors' tokens have one sender (the bulk pipeline), and a registration's money tokens were already one helper (`payment-reminder.ts`), so there was nothing to merge. The compiler checks that the keys a builder writes out are mapped tokens (not the ones it spreads in from `eventLocationVars`); that every mapped token is filled is the drift tests' job.
- `{{subject}}` and `{{message}}` stay each sender's own, set only for a typed email and a saved template. The first cut put them in the shared builder, which would have let a built-in template that names `{{subject}}` go out with an empty subject line where it used to be refused (review of `67cd33d2`); a test holds it.

**A typed email, held to the map too. BUILT Nov 27, 2026** (owner: "yes to typed emails, custom email gets the same priority as built-in ones").

- The typed subject and message are rendered last, by one function for all three senders (`applyTypedSubjectAndNote` in `email-token-values.ts`), with everything a template in the same email gets: the sender's values and the event block. A token now works in a typed subject or message wherever it works in a template. Before, the subject was rendered early (no `{{amount}}`, no RSVP name) and the message without the event block (no `{{eventDateRange}}`).
- A typed email to registrations gets `{{amount}}` (the balance) and `{{paymentBlock}}` (Pay Now), as a saved template does; blank for a group member or anyone with nothing due.
- `emailTokenRefusal(audience, "typed", subject, message)`, asked by the same precheck: a typed email naming a token its audience does not get is refused when it is sent or scheduled. The assistant's `send_bulk_email` is a typed email, so it is covered from here on.
- A typed email's set is the saved template's, less three things: an abstract's own tokens (a typed email goes once per author; the refusal says to use a saved template), and `{{subject}}`, `{{message}}`, `{{personalMessage}}`, which are the typed text itself.
- Found by the review of `fa9aede3` and fixed with it: the message may quote `{{subject}}` as it always could (the first cut refused it); the agreement tokens and `{{entryBarcode}}` are filled when the typed text names them, where they rendered as nothing (the checks that mint them read only the template); editing a scheduled typed email is held to the map too (`PATCH emails/schedule/[id]`); `{{rsvpName}}` alone with no RSVP chosen is refused with the link and the button. What it left is in ROADMAP.
- Proved the same way: 108 recorded bulk emails and 28 per-person ones, every one byte for byte the same after the change; the drift tests hold the typed set in both directions for every audience, and a typed email from a person's record to the same set.

### Step 3. The old lists are gone. BUILT Nov 27, 2026

- Each map entry carries its editor group and its words. `BULK_BASE_VARIABLES`, `BULK_SPEAKER_VARIABLES`, `BULK_PRESENTER_VARIABLES`, `BULK_ABSTRACT_OWN_VARIABLES`, `BULK_ABSTRACT_AUTHOR_VARIABLES`, `BULK_CONDITIONAL_VARIABLES`, the hand-written `CUSTOM_TEMPLATE_VARIABLE_GROUPS` and `isUnlistedCustomTemplateToken` are deleted from the registry. Derived from the map now: the Variables panel, an abstract's own tokens (`ABSTRACT_OWN_TOKEN_KEYS`), and what a built-in template sent from Communications may also use (`BUILT_IN_BULK_TOKEN_KEYS`).
- `templateAllowedTokenKeys` for a saved template is exactly the map's keys. Compared before and after for all 37 built-in slugs and a saved one: the built-in ones accept the identical set, and the panel's groups, order, words and hints are identical. A saved template lost 50 guessed `...Text` mirrors (`{{firstNameText}}`) that no send ever filled, which the editor accepted and the send refused.
- The send dialog's preview is given the audience and asks the send's own check: a token that send would refuse is left bare in the preview, never filled from the samples, and named in a note ("The send would be refused. ..."), for a saved template and a typed email, every audience. The samples themselves stay where they were (`email.ts`): what mattered was that the preview could show a value the send will not fill.
- CLAUDE.md (Key Files) and AGENTS.md (rule 12) carry the rule.

Left as it is, on purpose: `templateAllowedTokenKeys` still treats the two retired slugs as saved templates while the senders do not (hidden rows nobody edits; unifying the two definitions changes nothing a person can reach).

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
