# Speakers upload their presentation: plan

**Status: PLANNED, NOT BUILT (Nov 19, 2026).** Asked by the owner on Nov 19, 2026:
"an option for speaker to upload their presentation, be it ppt, pdf or video".
Section 7 lists the decisions the build waits on.

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
| Signed links | `@aws-sdk/s3-request-presigner` is installed; used only for admin backup downloads | Nothing signs an upload yet |
| Webinar handouts | PDF, PPTX, DOCX, 8 MB, organiser-uploaded, shown to attendees | A different audience: attendees, not the AV team |

So the files must go **from the browser straight to S3**, never through our
server. That is the one structural change. The rest reuses what is there.

## 3. How the upload works

1. The page asks our server for permission to upload: `POST .../presentations/upload-url`
   with the file's name, type and size, plus the speaker's token (speaker form) or
   the staff sign-in.
2. The server checks who is asking, the type (by extension and the stated MIME
   type) and the size cap, then creates a row in state `UPLOADING`. It answers
   with a **presigned POST** for one S3 key,
   `presentations/{eventId}/{speakerId}/{rowId}.{ext}`. The policy pins the
   exact key, the content type and a `content-length-range`, and expires in
   15 minutes.
3. The browser uploads straight to S3 with a progress bar. nginx and Next.js
   never see the bytes.
4. The page calls `POST .../presentations/{rowId}/complete`. The server checks
   the object really exists with `HeadObject` (size within the cap), then reads
   its first bytes with a ranged `GetObject` to check the magic bytes:
   - PDF: `%PDF-`
   - PPTX and Keynote: a zip (`PK\x03\x04`)
   - MP4 and MOV: `ftyp` at offset 4

   It then marks the row `READY` and logs the upload. A mismatch deletes the
   object and marks the row `FAILED`.
5. Downloads go through an authed route that answers with a **presigned GET**,
   valid for 5 minutes. The bucket stays private, and nothing is ever public.

A row left `UPLOADING` for more than a day, because the browser closed, is
cleared by a small worker job, which also deletes any object it left behind.

**Very large videos (phase 4):** a single presigned POST can carry up to 5 GB,
but one 2 GB upload over hotel Wi-Fi fails as a whole. S3 multipart upload
(presigned part URLs, resumable) is the fix. It is planned separately so that
phase 1 stays small.

**Local development** has no S3 (`STORAGE_PROVIDER=local`). There the
`upload-url` answer points at a local route that accepts the file directly,
with a development-only cap, so the whole flow can be exercised locally.

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
  storageKey     String             // presentations/{eventId}/{speakerId}/{id}.{ext}
  filename       String             // as uploaded, shown and used for downloads
  mimeType       String
  size           Int?               // filled by /complete from HeadObject
  status         PresentationStatus @default(UPLOADING) // UPLOADING | READY | FAILED | REPLACED
  uploadedVia    String             // "speaker-form" | "staff"
  uploadedById   String?            // the staff user, when staff uploaded it
  createdAt      DateTime @default(now())
  readyAt        DateTime?
  @@index([eventId, status])
  @@index([speakerId])
}
```

The migration is additive: a new table and a new enum, nothing changed, safe
for blue/green. Replacing a file keeps the old row as `REPLACED`, because the
bucket is versioned anyway. Only the newest `READY` file per speaker and topic
is shown.

## 5. The screens

- **Speaker profile form** (the speaker's own link): a "Your presentation"
  section with one upload per session or topic the speaker is on, as the agenda
  holds them. Each upload shows a progress bar and the file once received, with
  Replace. The deadline is shown when one is set.
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
  extension and stated type when the link is signed, and the magic bytes after
  the upload. Anything else is refused, and the refusal is logged.
- **Size caps:** these are owner decisions (section 7). The caps are enforced
  by the S3 policy itself, so a client cannot exceed them by lying to our
  server.
- **Rate limits:** per token and per IP on `upload-url`, as the speaker form's
  uploads have now.
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
     origin.
   - Confirming that the instance role's KMS grant covers objects under
     `presentations/`.
   - Optionally, GuardDuty Malware Protection for S3.

## 8. Order of work

| Phase | What | Size |
|---|---|---|
| 1 | Table, presigned upload and complete check, presigned download, the speaker page's Presentations card (staff upload and download), the local-development path | Medium |
| 2 | The speaker profile form's presentation section, per topic or session; the `{{presentationLink}}` token | Medium |
| 3 | The speakers list column and filter, agenda session detail, the per-event Presentations page for AV, the deadline reminder | Medium |
| 4 | Multipart resumable upload for large video; agent and MCP tools (`list_presentations`) | Medium |

Phase 1 needs the owner's CORS step (decision 7) before it can be tried on
production. Every phase gets the full gate and one review, and each ships on
its own.
