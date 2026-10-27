# CRM inbox: a working mailbox (plan)

Oct 27, 2026. PLANNED, NOT BUILT. Owner direction: "CRM should have inbox and
outbox just like Gmail, so all people use the CRM to send and receive the
emails." Scope chosen: **Option A, CRM email only**. Mailbox sync with Google
Workspace or Microsoft 365 (Option B) is out of scope.

## 1. What exists today

- Every CRM send (deal email, sponsor blast) creates one **thread per
  recipient** (`CrmEmailThread`) with a reply token in its Reply-To. Replies
  land in SES, then S3, and the `crm-inbound-email` worker job files them on the
  thread every minute (`src/crm/inbound-email-worker.ts`). Each reply is
  forwarded to the deal owner, the partnerships mailbox and the send's CC/BCC.
- The inbox page (`src/crm/components/crm-inbox.tsx`) is **read-only**: a list
  of the newest 100 threads and the conversation. No search, no folders, no
  reply. Unread is one shared flag per thread, cleared when anyone opens it.
- Outgoing emails set **no threading headers** (no own Message-ID, no
  In-Reply-To or References). A reply sent from the CRM today would start a new
  conversation in the sponsor's Gmail or Outlook instead of joining theirs.
- Prod volume: 3 threads, 3,339 active contacts, 4 active CRM users in the
  last 30 days. Everything below is small-table work.

## 2. What gets built

### Phase 1: mailbox layout (about 1 day)

- **Folders** on the left: Inbox (threads with a reply), Sent (everything we
  sent), All. Counts beside Inbox (unread) and Sent.
- **Filters**: Unread only, Mine (deals I own), a deal picker.
- **Search** over subject, counterparty name and email, and deal name.
- **Load more** instead of the hard cap of 100.
- **Mark as unread** and **Archive** (hide from Inbox, still in All). Archive
  is a nullable `archivedAt` on the thread, an additive migration.
- The conversation view keeps the sandboxed iframe for inbound HTML.

### Phase 2: reply from the inbox (about 1.5 days)

- A **Reply** composer under the conversation: the same editor, tokens,
  signature, attachments (deal documents and PDFs) and Preview as the deal
  email dialog, sharing its code rather than copying it.
- **Reply all** re-includes the CC list the thread was sent with.
- Sent through the existing send path with the thread's own reply token, and
  appended to the same thread (`recordOutboundEmail` already accepts a
  `threadId`).
- **Threading headers**: every CRM email gets its own `Message-ID`, stored on
  the message; a reply carries `In-Reply-To` and `References`, so it joins the
  sponsor's conversation in their mail client. This needs a small extension to
  `sendEmail` (a `headers` option on the raw MIME path), core-side.
- Subject defaults to `Re: <subject>`.

### Phase 3: compose from the inbox (about half a day)

- A **Compose** button: pick the deal first (search), then its people. The
  email is a deal email in every respect (event tokens, event branding, deal
  history), so this opens the existing deal email dialog on the chosen deal.
- Each recipient still gets their own thread, as today.

## 3. Owner decisions (Oct 27, 2026)

1. **Read state: shared.** One unread flag per thread; whoever opens it clears
   it for everyone, like a team mailbox. No per-person table.
2. **Visibility: everyone sees all.** A Mine filter narrows to deals I own.
3. **Compose needs a deal.** Every email belongs to a deal, so it always shows
   on the deal's history and carries the event's tokens and branding. Phase 3
   therefore picks a deal first, then that deal's people (plus the account's
   people, as the Add people dialog does).
4. **Keep forwarding** each reply to the deal owner, the partnerships mailbox
   and the send's CC/BCC.

## 4. Risks and costs

- **Threading headers touch core email code** (`src/lib/email.ts`), used by
  every email the platform sends. The change is additive (an optional
  `headers` field) and is pinned by tests on the raw MIME output.
- **Deliverability**: replies go out from the partnerships address, already
  verified and permitted in SES (policy updated Oct 27, 2026).
- **No new background work**: the inbound job stays as it is. Search is an
  indexed query over a small table.
- **Not covered**: email sent to `partnerships@` or a rep's own mailbox
  directly, outside the CRM. The cheap route there is a forwarding rule on the
  mailbox into the CRM's receiving address, decided separately.
