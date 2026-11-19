# Speakers upload their presentation: plan

**Status: PLANNED, NOT BUILT (Nov 19, 2026).** Asked by the owner on Nov 19, 2026:
"an option for speaker to upload their presentation, be it ppt, pdf or video".
Section 7 lists the decisions the build waits on. Revised the same day after a
review of the first draft: the facts about today's system held, and six points
of the design changed (the form staying open, the missing package, pinning the
checked version, the file signatures, the size column, the storage module).

## 1. Why

Slides come in by email today. The MEHFC 2027 invitation asks each speaker to
"provide us the presentation slides via email before the 30th of November"
for CME accreditation. Someone then has to match each attachment to a speaker
and a session by hand, and chase whoever has not sent one, with no list of who
has. The AV team gets the files the same way on the day.

## 2. What exists, and why it does not stretch to this

| What | Today | The gap |
|---|---|---|
| Speaker's own link | The speaker profile form, `/e/{slug}/speaker-form/{token}`: one token per speaker (`SpeakerProfileForm`), sent as `{{profileFormLink}}` | Two fixed slots only: passport and cover letter |
| Speaker files | `SpeakerDocument` (kind `SIGNED_AGREEMENT` or `OTHER`), on the speaker page's Documents card | No link to a session or topic, no upload state, no versions |
| Accepted types | PDF, JPG, PNG, checked by magic bytes | No PPTX, Keynote or video |
| Size | 10 MB (`PROFILE_DOC_MAX_SIZE`) | A deck is often 20 to 100 MB, a talk video 200 MB to 2 GB |
| The path | Browser → nginx → Next.js → storage | nginx refuses any body over 10 MB (`client_max_body_size 10M`) and the proxy caps uploads at 10.5 MB (`UPLOAD_BODY_SIZE`); a 2 GB body through the app would also tie up a web container for minutes |
| Storage | S3 in production (`ea-sys-uploads`, ap-south-1, SSE-KMS, versioned; `STORAGE_PROVIDER=s3`) | Fine as it is |
| Signed links | `@aws-sdk/s3-request-presigner` is installed (it signs GET and PUT URLs); used only for admin backup downloads | Nothing signs an upload yet, and a presigned POST needs `@aws-sdk/s3-presigned-post`, which is **not installed** |
| Webinar handouts | PDF, PPTX, DOCX, 8 MB, organiser-uploaded, shown to attendees | A different audience: attendees, not the AV team |

So the files must go **from the browser straight to S3**, never through our
server. That is the one structural change. The rest reuses what is there.

## 3. How the upload works

1. The page asks our server for permission to upload: `POST .../presentations/upload-url`
   with the file's name and size, plus the speaker's token (speaker form) or
   the staff sign-in.
2. The server checks who is asking, the type and the size cap, then creates a
   row in state `UPLOADING`. The type comes from the **extension**, never the
   browser's stated type: browsers report an empty type for `.key` and `.pptx`
   on some systems (`resolveHandoutType` in `src/lib/webinar/handouts.ts`
   handles the same thing). It answers with a **presigned POST** for one S3
   key, `presentations/{eventId}/{speakerId}/{rowId}.{ext}`. The policy pins
   the exact key, the server's content type (which the form must send as
   given) and a `content-length-range`, and expires in 15 minutes.

   A presigned POST, not a presigned PUT: only a POST policy carries
   `content-length-range`, which is what makes S3 itself enforce the size cap.
   It needs a new dependency, `@aws-sdk/s3-presigned-post`, pinned beside the
   other AWS packages (`3.1086.0`), with the lockfile and a
   `docs/DEPENDENCY_LOG.md` entry.
3. The browser uploads straight to S3 with a progress bar. nginx and Next.js
   never see the bytes.
4. The page calls `POST .../presentations/{rowId}/complete`. The server checks
   the object really exists with `HeadObject` (size within the cap), then reads
   its first bytes with a ranged `GetObject` to check the signature:
   - PDF: `%PDF-`
   - PPTX and Keynote: a zip (`PK\x03\x04`). This proves a zip and no more,
     so a renamed `.docx` would pass; the type shown stays the extension's.
   - Legacy PPT: OLE2 (`D0 CF 11 E0 A1 B1 1A E1`). It is not a zip.
   - MP4: `ftyp` at offset 4.
   - MOV: `ftyp` at offset 4, or a classic QuickTime atom there (`moov`,
     `mdat`, `wide`, `free`, `skip`).

   It then marks the row `READY`, records the object's **`VersionId` and
   ETag**, and logs the upload. A mismatch removes the object and marks the row
   `FAILED`.

   Why the version is recorded: a POST policy can be used again until it
   expires, so the same form could post a different file to the same key after
   the check, and on a versioned bucket that new version becomes the current
   one. The `HeadObject`, the ranged read and every later download therefore
   all name the recorded `VersionId`. What was checked is what is served, and
   the size, the time and any malware verdict describe that same file.
5. Downloads go through an authed route that answers with a **presigned GET**
   for the recorded version, valid for 5 minutes, with
   `ResponseContentDisposition` built by `contentDisposition` so the file
   arrives under the name it was uploaded with (the key is a row id). The
   bucket stays private, and nothing is ever public.

A row left `UPLOADING` for more than a day, because the browser closed, is
cleared by a small worker job (inside the organisation's lane, as every worker
job is), which also removes any object it left behind.

"Removes" on a versioned bucket only adds a delete marker: the bytes stay, and
the hourly copy to the DR bucket has no `--delete`. So rejected, abandoned and
replaced files are really cleared by a **lifecycle rule** on `presentations/`
(expire noncurrent versions after a set number of days, abort incomplete
multipart uploads after 7), which is an owner step (section 7).

**Very large videos (phase 4):** a single presigned POST can carry up to 5 GB,
but one 2 GB upload over hotel Wi-Fi fails as a whole. S3 multipart upload
(presigned part URLs, resumable) is the fix. It is planned separately so that
phase 1 stays small.

**Local development** has no S3 (`STORAGE_PROVIDER=local`). There the
`upload-url` answer points at a local route that accepts the file directly, so
the whole flow can be exercised locally. That route exists only for the
`local` provider, and its real cap is the proxy's 10.5 MB multipart limit. The
`supabase` provider (Vercel) is not supported: the feature is offered only
where the provider is `s3`, or `local` in development.

### The storage module (AGENTS.md rule 8)

Every file operation goes through `src/lib/storage.ts`, and the database holds
a stored path of the form `/uploads/{segment}/...`. This feature keeps to that:

- `presentations` is registered in `src/lib/upload-prefixes.ts`. It is private
  by default, because the public `/uploads` catch-all is an allow-list.
- Four new primitives live in the storage module, each with its `local` twin:
  sign an upload, head an object, read a byte range, sign a download.
- The row stores the stored path (`/uploads/presentations/...`), from which the
  S3 key follows as it does for every other file.
- **`readStoredFile` is never used for these files.** It buffers the whole
  object, so a 2 GB video would land in a web container's memory.

## 4. The data

A new table, rather than more kinds on `SpeakerDocument`. A presentation has a
lifecycle (uploading, ready, failed, replaced), belongs to a session or topic,
and is read by different people (the AV team) under a different rule.
`SpeakerDocument` stays the speaker's paperwork.

```prisma
model SpeakerPresentation {
  id             String   @id @default(cuid())
  eventId        String
  organizationId String?            // tenancy convention, stamped by every writer
  speakerId      String
  sessionId      String?            // the session it is for, when known
  topicId        String?            // or the topic (talk) within it
  url            String             // stored path: /uploads/presentations/{eventId}/{speakerId}/{id}.{ext}
  s3VersionId    String?            // the version that was checked; every read names it
  etag           String?
  filename       String             // as uploaded, shown and used for downloads
  mimeType       String             // from the extension, decided by the server
  size           BigInt?            // bytes, from HeadObject at /complete
  status         PresentationStatus @default(UPLOADING) // UPLOADING | READY | FAILED | REPLACED
  uploadedVia    String             // "speaker-form" | "staff"
  uploadedById   String?            // the staff user, when staff uploaded it
  createdAt      DateTime @default(now())
  readyAt        DateTime?

  event   Event         @relation(fields: [eventId], references: [id], onDelete: Cascade)
  speaker Speaker       @relation(fields: [speakerId], references: [id], onDelete: Cascade)
  session EventSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)
  topic   SessionTopic? @relation(fields: [topicId], references: [id], onDelete: SetNull)

  @@index([eventId, status])
  @@index([speakerId])
  @@index([organizationId])
}
```

`size` is a `BigInt`: a 32-bit integer stops at 2,147,483,647 bytes, one byte
short of 2 GiB, and a write past it throws. It is converted to a number at the
JSON edge.

The migration is additive: a new table and a new enum, nothing changed, safe
for blue/green. The table gets a row policy in `prisma/rls/` with the others
(written, never applied by migration). Deleting a speaker deletes their rows;
the objects are cleared by the lifecycle rule. Replacing a file keeps the old
row as `REPLACED`. Only the newest `READY` file per speaker and topic is shown.

## 5. The screens

- **Speaker profile form** (the speaker's own link): a "Your presentation"
  section with one upload per session or topic the speaker is on, as the agenda
  holds them. Each upload shows a progress bar and the file once received, with
  Replace. The deadline is shown when one is set.

  **The form is one-shot today, and this section must not be.** Once
  submitted, the page says "This form has already been submitted" and its
  uploads answer 409 `ALREADY_SUBMITTED`. Speakers send their passport and bio
  first and their slides weeks later, so the presentation section stays open
  on a submitted form, through its own routes, until the deadline or the
  event. The passport and cover letter slots stay locked as they are.
- **Speaker page:** a Presentations card listing each file, its session, size,
  received time, Download and, for staff, Upload on the speaker's behalf.
- **Agenda, session detail:** each topic shows its speaker's file, or
  "Not received".
- **Speakers list:** a "Presentation" column (Received, or Missing) and a
  filter. That filter is the chase list.
- **Presentations page per event** (phase 3): every session in time order,
  with its files, for the AV team, plus Download all for a session. Large files
  are listed as individual links rather than zipped, because zipping 2 GB of
  video on the server is the problem section 3 avoids.
- **Email:** a token `{{presentationLink}}` (the same speaker form link,
  opening at the presentation section), and an optional reminder to every
  speaker still Missing a set number of days before the deadline (an event
  setting, `presentationDeadline`).

## 6. Rules and safety

- **Permissions:**
  - Staff view and download with `speakers.read`, and upload or delete with
    `speakers.update`.
  - The AV team reads through a new key, `presentations.read`, which a custom
    role can give alone. A temporary AV technician then sees files and nothing
    else.
  - The speaker acts only through their own token.
- **Types:** PDF, PPTX, PPT, KEY, MP4 and MOV. Each is checked twice: the
  extension when the link is signed, and the file's signature after the upload
  (section 3; for the zip-based types that proves a zip, not the exact type).
  Anything else is refused, and the refusal is logged.
- **Size caps:** these are owner decisions (section 7). The caps are enforced
  by the S3 policy itself, so a client cannot exceed them by lying to our
  server.
- **Rate limits:** per token and per IP on `upload-url`, as the speaker form's
  uploads have now.
- **A quota per speaker:** a rate limit alone lets a leaked link store tens of
  gigabytes an hour, so the number of live files and the total bytes per
  speaker are capped too (for example 10 files and 5 GB).
- **Tenancy:** the public routes read their event through `findPublicEvent`,
  the staff routes through `findGatedEvent`, and the worker job enters the
  organisation's lane.
- **Malware:** the files are opened by the AV team's laptops. Amazon GuardDuty
  Malware Protection for S3 can scan each new object. It is an AWS setting, so
  it is offered to the owner, not built.
- **Logging:** every refusal and every failure is logged, and each upload,
  replacement and deletion is an audit row.
- **Retention:** an owner decision (section 7). The default is to keep the
  files as long as the event.

## 7. Decisions the build waits on

1. **Where speakers upload.**
   - **Recommended:** the existing speaker profile form link, so speakers get
     one link only.
   - Alternatives: the account portal, or a separate link of its own.
2. **One file per speaker, or one per session or topic?**
   - **Recommended:** per topic when the speaker has topics, else per session.
     A speaker on two panels then has two slots.
3. **Size caps.**
   - **Recommended:** 200 MB for slides and 2 GB for video.
   - The 2 GB cap waits on phase 4 (multipart); until then video is capped at
     500 MB.
4. **Who sees the files:** organisers only, or also an AV role
   (`presentations.read`)?
5. **Is a deadline and reminder wanted, and how many days before?**
6. **How long the files are kept after the event.**
7. **AWS steps that are the owner's to run.** These are instructions, not
   something I execute:
   - A CORS rule on `ea-sys-uploads` allowing `POST` from the production
     origin (phase 4 adds `PUT` and `ExposeHeaders: ETag` for multipart).
   - `s3:GetObjectVersion` on the instance role, which it lacks today
     (`docs/FROM_SCRATCH_REBUILD.md`), so a download can name the checked
     version. Phase 4 adds the multipart actions.
   - A lifecycle rule on `presentations/`: expire noncurrent versions after a
     set number of days, and abort incomplete multipart uploads after 7.
   - Checking whether the bucket policy demands the
     `x-amz-server-side-encryption` header on uploads. If it does, the POST
     form and its policy carry those fields; if not, the bucket's default
     encryption applies with nothing extra. (KMS access is not per prefix, and
     the role's key permissions already cover the bucket.)
   - Optionally, GuardDuty Malware Protection for S3.

## 8. Order of work

| Phase | What | Size |
|---|---|---|
| 1 | The `@aws-sdk/s3-presigned-post` dependency, the storage module's four primitives, the table, presigned upload and complete check (version pinned), presigned download, the speaker page's Presentations card (staff upload and download), the local-development path | Medium |
| 2 | The speaker profile form's presentation section, open after the form is submitted, per topic or session; the per-speaker quota; the `{{presentationLink}}` token | Medium |
| 3 | The speakers list column and filter, agenda session detail, the per-event Presentations page for AV, the deadline reminder | Medium |
| 4 | Multipart resumable upload for large video; agent and MCP tools (`list_presentations`) | Medium |

Phase 1 needs the owner's CORS, `s3:GetObjectVersion` and lifecycle steps
(decision 7) before it can be tried on production. Every phase gets the full gate and one review, and each ships on
its own.
