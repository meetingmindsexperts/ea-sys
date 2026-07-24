/**
 * CRM inbound email — the intake half of the CRM inbox. SERVER/WORKER ONLY.
 *
 * SES receives mail for $CRM_REPLY_DOMAIN and writes the raw MIME to
 * s3://$CRM_INBOUND_S3_BUCKET/inbound/. This tick (every minute) drains that
 * prefix: parse → spam/virus gate → resolve the reply token to its thread →
 * store the INBOUND message (+ attachments to the private upload prefix) →
 * notify + forward-copy the deal owner → move the object out of inbound/.
 *
 * DORMANT WITHOUT ENV: no CRM_INBOUND_S3_BUCKET → the tick no-ops quietly.
 *
 * Failure isolation: each object processes in its own try/catch — one
 * malformed email can't block the queue. An object that fails STAYS in
 * inbound/ and retries next tick; the s3Key dedupe check makes the retry safe
 * even when the crash landed between the DB row and the S3 move.
 *
 * Sort order per object:  gate → row → side effects → move.
 * The row is the source of truth; notification/forward failures log and never
 * un-record a received email.
 */
import fs from "fs/promises";
import path from "path";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
// Value import (not `import type`): Prisma.PrismaClientKnownRequestError is used
// at runtime in the P2002 race check, and Prisma.InputJsonValue as a type.
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import { notifyCrmUser } from "@/crm/lib/crm-notifications";

const MAX_OBJECTS_PER_TICK = 25;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Reply tokens are 20 hex chars (crm-email-thread-service.mintReplyToken). */
const TOKEN_RE = /^([0-9a-f]{20})@(.+)$/i;
/** Rolling token window (review M1): a thread's token expires this many days
 *  after its last activity, killing a leaked token on a dormant conversation. */
export const TOKEN_TTL_DAYS = 180;

let s3: S3Client | null = null;
function s3Client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region:
        process.env.CRM_INBOUND_S3_REGION?.trim() ||
        process.env.AWS_REGION ||
        "ap-south-1",
    });
  }
  return s3;
}

export interface InboundTickResult {
  scanned: number;
  stored: number;
  duplicates: number;
  quarantined: number;
  unmatched: number;
  failures: number;
}

/** Flatten mailparser's to/cc shapes into plain addresses. */
function recipientAddresses(parsed: ParsedMail): string[] {
  const collect = (v: AddressObject | AddressObject[] | undefined): string[] =>
    (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) =>
      a.value.map((x) => x.address ?? "").filter(Boolean),
    );
  return [...collect(parsed.to), ...collect(parsed.cc)];
}

/**
 * Extract the thread token from the recipient list. When CRM_REPLY_DOMAIN is
 * set the domain must match (defense against stray mail landing in the
 * bucket); without it, any token-shaped local part counts.
 */
export function extractReplyToken(addresses: string[], replyDomain: string | null): string | null {
  for (const addr of addresses) {
    const m = TOKEN_RE.exec(addr.trim());
    if (!m) continue;
    if (replyDomain && m[2].toLowerCase() !== replyDomain.toLowerCase()) continue;
    return m[1].toLowerCase();
  }
  return null;
}

/** SES receipt verdict headers on the stored MIME. Returns the failing verdict. */
export function failedVerdict(parsed: ParsedMail): string | null {
  for (const h of ["x-ses-spam-verdict", "x-ses-virus-verdict"]) {
    const v = parsed.headers.get(h);
    const s = typeof v === "string" ? v : "";
    if (s.toUpperCase() === "FAIL") return `${h}:FAIL`;
  }
  return null;
}

function emailDomain(addr: string): string {
  return (addr.toLowerCase().split("@")[1] ?? "").trim();
}

/**
 * Verify an inbound reply's sender against the thread's counterparty (review
 * H1 — the anti-BEC gate). The reply token authenticates the THREAD, never the
 * SENDER, and the token leaks through forwarded mail; without this, anyone with
 * a token can inject a spoofed "Abbott replied — new bank details" message.
 *
 * Signals (any failure ⇒ unverified):
 *   - explicit DMARC=fail in SES's Authentication-Results (spoofed envelope), and
 *   - From domain must equal the counterparty's domain (the realistic attack is
 *     a spoofed display name from a foreign domain; a same-org colleague reply
 *     still passes).
 *
 * Fails toward UNVERIFIED: a false-unverified only adds a warning badge and
 * skips the auto-forward (recoverable — the message is still in the inbox); a
 * false-verified is fraud. Asymmetric, so we err strict.
 */
export function verifySender(
  parsed: ParsedMail,
  counterpartyEmail: string,
): { verified: boolean; reason: string } {
  const from = parsed.from?.value?.[0]?.address ?? "";
  const fromDomain = emailDomain(from);
  const cpDomain = emailDomain(counterpartyEmail);

  const authRaw = parsed.headers.get("authentication-results");
  const auth = typeof authRaw === "string" ? authRaw : Array.isArray(authRaw) ? authRaw.join(" ") : "";
  if (/dmarc\s*=\s*fail/i.test(auth)) return { verified: false, reason: "dmarc-fail" };

  if (!fromDomain || !cpDomain || fromDomain !== cpDomain) {
    return { verified: false, reason: "domain-mismatch" };
  }
  return { verified: true, reason: "domain-match" };
}

/** Best-effort unlink of just-written attachment files when the row never lands. */
async function cleanupAttachmentFiles(paths: string[]): Promise<void> {
  for (const rel of paths) {
    if (!rel.startsWith("/uploads/crm-email-attachments/")) continue;
    const abs = path.resolve(process.cwd(), "public", rel.slice(1));
    await fs.unlink(abs).catch((err) =>
      apiLogger.warn({ msg: "crm-inbound:orphan-unlink-failed", abs, err: err instanceof Error ? err.message : String(err) }),
    );
  }
}

async function moveObject(bucket: string, fromKey: string, toKey: string): Promise<void> {
  const client = s3Client();
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
      Key: toKey,
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

interface StoredAttachment {
  filename: string;
  size: number;
  mimeType: string;
  path: string;
}

/**
 * Persist inbound attachments under the PRIVATE crm-email-attachments prefix
 * (blocked on the public /uploads catch-all — same policy as deal documents).
 * Oversize/overflow files are skipped WITH a log line, never silently.
 */
async function storeAttachments(parsed: ParsedMail, threadId: string): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  const list = parsed.attachments ?? [];
  for (const att of list) {
    if (out.length >= MAX_ATTACHMENTS) {
      apiLogger.warn({ msg: "crm-inbound:attachment-count-capped", threadId, dropped: list.length - out.length });
      break;
    }
    if (att.size > MAX_ATTACHMENT_BYTES) {
      apiLogger.warn({ msg: "crm-inbound:attachment-too-large", threadId, size: att.size, filename: att.filename });
      continue;
    }
    const safeName = (att.filename ?? "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const dirRel = path.join("uploads", "crm-email-attachments", threadId);
    const dirAbs = path.resolve(process.cwd(), "public", dirRel);
    await fs.mkdir(dirAbs, { recursive: true });
    const storedName = `${globalThis.crypto.randomUUID()}-${safeName}`;
    await fs.writeFile(path.join(dirAbs, storedName), att.content);
    out.push({
      filename: safeName,
      size: att.size,
      mimeType: att.contentType ?? "application/octet-stream",
      path: `/${dirRel.split(path.sep).join("/")}/${storedName}`,
    });
  }
  return out;
}

/**
 * Compute who a reply forward-copies to: the deal owner, the partnerships shared
 * mailbox, and the outbound send's CC/BCC (`notifyEmails`, incl. the sender's own
 * "copy to me"). Deduped + lowercased, and the person who just replied is NEVER
 * included (don't bounce their own message back). Pure — unit-tested directly.
 */
export function buildForwardAudience(input: {
  ownerEmail?: string | null;
  ownerName?: string;
  partnerships?: string | null;
  notifyEmails?: string[] | null;
  replierEmail: string;
}): { email: string; name?: string }[] {
  const replier = input.replierEmail.trim().toLowerCase();
  const seen = new Set<string>();
  const out: { email: string; name?: string }[] = [];
  const add = (email: string | null | undefined, name?: string) => {
    const e = email?.trim().toLowerCase();
    if (!e || e === replier || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, name });
  };
  add(input.ownerEmail, input.ownerName);
  add(input.partnerships);
  for (const e of input.notifyEmails ?? []) add(e);
  return out;
}

/**
 * Bell the deal owner + forward-copy the reply to everyone on the thread — the
 * deal owner, the partnerships shared mailbox, and the CC/BCC addresses the
 * outbound send carried (`notifyEmails`, which includes the sender's own "copy
 * to me"). So a reply reaches Outlook, not just the CRM inbox. All best-effort —
 * the stored message row is the source of truth.
 */
async function notifyOwner(args: {
  thread: {
    id: string;
    organizationId: string;
    subject: string;
    counterpartyEmail: string;
    notifyEmails: string[];
    deal: { id: string; name: string; ownerId: string | null } | null;
  };
  fromEmail: string;
  fromName: string | null;
  textBody: string | null;
  htmlBody: string | null;
  /** review H1: an unverified sender still bells (in-app, staff-only) but the
   *  email forward to a real mailbox is SUPPRESSED. */
  unverified: boolean;
}): Promise<void> {
  const ownerId = args.thread.deal?.ownerId ?? null;
  const senderLabel = args.fromName ? `${args.fromName} (${args.fromEmail})` : args.fromEmail;

  // In-app bell — owner only (the shared inbox is the staff-wide surface).
  if (ownerId) {
    await notifyCrmUser({
      organizationId: args.thread.organizationId,
      recipientId: ownerId,
      actorId: null,
      type: "EMAIL_RECEIVED",
      title: args.unverified ? "⚠ Unverified reply in the CRM inbox" : "New reply in the CRM inbox",
      message: args.unverified
        ? `An UNVERIFIED sender (${senderLabel}) replied on ${args.thread.deal?.name ?? "a deal"} — verify before acting: ${args.thread.subject}`
        : `${senderLabel} replied on ${args.thread.deal?.name ?? "a deal"}: ${args.thread.subject}`,
      link: `/crm/inbox?thread=${args.thread.id}`,
    });
  }

  // Anti-BEC: never forward an unverified "reply" to a real mailbox under our
  // branding — the in-app bell + inbox badge are the safe surface for it.
  if (args.unverified) return;

  // Build the forward audience: deal owner + partnerships shared mailbox + the
  // send's CC/BCC (incl. the sender's copy). Deduped (lowercased), minus the
  // person who just replied (never bounce their own message back to them).
  const owner = ownerId
    ? await db.user.findUnique({
        where: { id: ownerId },
        select: { email: true, firstName: true, lastName: true },
      })
    : null;
  const ownerName = owner
    ? `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || undefined
    : undefined;
  const audience = buildForwardAudience({
    ownerEmail: owner?.email,
    ownerName,
    partnerships: process.env.CRM_EMAIL_FROM_ADDRESS?.trim() || null,
    notifyEmails: args.thread.notifyEmails,
    // Exclude whoever ACTUALLY sent this inbound (args.fromEmail) — NOT the
    // thread counterparty. They differ when a CC'd colleague replies: that
    // colleague is in notifyEmails, so using counterpartyEmail here would
    // bounce their own reply back to them (the counterparty is the outbound
    // To, so it is never in the audience and excluding it is a no-op anyway).
    replierEmail: args.fromEmail,
  });

  if (audience.length === 0) return;

  // Primary recipient in To, everyone else BCC — keeps the internal
  // distribution list private (BCC'd watchers stay hidden from each other).
  const [primary, ...rest] = audience;

  const banner =
    `<div style="padding:10px 14px;margin:0 0 16px;background:#f0f9ff;border-left:3px solid #0284c7;font-size:13px;color:#0c4a6e">` +
    `Sponsor reply received in the CRM inbox — read &amp; reply there (this forward is a copy).</div>`;
  const bodyHtml =
    args.htmlBody ??
    `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(args.textBody ?? "")}</pre>`;

  const res = await sendEmail({
    to: [{ email: primary.email, name: primary.name }],
    ...(rest.length ? { bcc: rest.map((r) => ({ email: r.email, name: r.name })) } : {}),
    subject: `Fwd: ${args.thread.subject}`,
    htmlContent: `${banner}${bodyHtml}`,
    textContent: `Sponsor reply received in the CRM inbox — read & reply there.\n\nFrom: ${senderLabel}\n\n${args.textBody ?? ""}`,
    emailType: "crm_email",
    stream: "transactional",
    logContext: {
      organizationId: args.thread.organizationId,
      entityType: ownerId ? "USER" : "OTHER",
      entityId: ownerId,
      templateSlug: "crm-inbound-forward",
      triggeredByUserId: null,
    },
  });
  if (!res.success) {
    apiLogger.warn({ msg: "crm-inbound:forward-failed", threadId: args.thread.id, error: res.error });
  }
}

async function processObject(bucket: string, key: string, replyDomain: string | null): Promise<
  "stored" | "duplicate" | "quarantined" | "unmatched"
> {
  const basename = key.slice("inbound/".length) || key;
  const processedKey = `processed/${basename}`;

  // Retry safety: a crash between the DB row and the S3 move leaves the object
  // in inbound/ with its row already written — next tick just finishes the move.
  const existing = await db.crmEmailMessage.findFirst({
    where: { s3Key: processedKey },
    select: { id: true },
  });
  if (existing) {
    await moveObject(bucket, key, processedKey);
    apiLogger.warn({ msg: "crm-inbound:duplicate-object", key });
    return "duplicate";
  }

  const obj = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = Buffer.from(await obj.Body!.transformToByteArray());
  const parsed = await simpleParser(raw);

  const verdict = failedVerdict(parsed);
  if (verdict) {
    await moveObject(bucket, key, `quarantine/${basename}`);
    apiLogger.warn({ msg: "crm-inbound:quarantined", key, verdict });
    return "quarantined";
  }

  const token = extractReplyToken(recipientAddresses(parsed), replyDomain);
  const thread = token
    ? await db.crmEmailThread.findUnique({
        where: { replyToken: token },
        select: {
          id: true,
          organizationId: true,
          subject: true,
          crmContactId: true,
          counterpartyEmail: true,
          notifyEmails: true,
          expiresAt: true,
          revokedAt: true,
          deal: { select: { id: true, name: true, ownerId: true } },
        },
      })
    : null;
  if (!thread) {
    await moveObject(bucket, key, `unmatched/${basename}`);
    apiLogger.warn({ msg: "crm-inbound:unmatched", key, hasToken: !!token });
    return "unmatched";
  }

  // Token lifecycle (review M1): a revoked (deal archived) or expired (dormant)
  // token no longer accepts mail — it goes unmatched, not into the thread.
  const now = new Date();
  if (thread.revokedAt || (thread.expiresAt && thread.expiresAt < now)) {
    await moveObject(bucket, key, `unmatched/${basename}`);
    apiLogger.warn({
      msg: "crm-inbound:token-inactive",
      key,
      threadId: thread.id,
      reason: thread.revokedAt ? "revoked" : "expired",
    });
    return "unmatched";
  }

  const fromEmail = parsed.from?.value?.[0]?.address ?? "unknown";
  const fromName = parsed.from?.value?.[0]?.name || null;
  const textBody = parsed.text ?? null;
  const htmlBody = typeof parsed.html === "string" ? parsed.html : null;

  // Anti-BEC (review H1): authenticate the sender against the counterparty.
  const sender = verifySender(parsed, thread.counterpartyEmail);
  if (!sender.verified) {
    apiLogger.warn({ msg: "crm-inbound:unverified-sender", key, threadId: thread.id, reason: sender.reason, fromEmail });
  }

  const attachments = await storeAttachments(parsed, thread.id);
  const rolledExpiry = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Store the message + flag the thread ATOMICALLY (review H3): a transient blip
  // between the two must never leave a stored-but-invisible reply. The s3Key
  // unique (review H2) makes a racing tick's create throw P2002 — the loser
  // treats it as the already-filed duplicate BEFORE any forward.
  try {
    await db.$transaction([
      db.crmEmailMessage.create({
        data: {
          organizationId: thread.organizationId,
          threadId: thread.id,
          direction: "INBOUND",
          fromEmail,
          fromName,
          subject: parsed.subject ?? null,
          textBody,
          htmlBody,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          s3Key: processedKey,
          attachments: attachments.length
            ? (attachments as unknown as Prisma.InputJsonValue)
            : undefined,
          spamVerdict: "PASS",
          unverifiedSender: !sender.verified,
        },
      }),
      db.crmEmailThread.update({
        where: { id: thread.id },
        data: { hasUnread: true, lastMessageAt: now, lastInboundAt: now, expiresAt: rolledExpiry },
      }),
    ]);
  } catch (err) {
    // The row never landed — don't leave the just-written attachment files orphaned.
    await cleanupAttachmentFiles(attachments.map((a) => a.path));
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A concurrent tick won the s3Key race — same email, already filed.
      await moveObject(bucket, key, processedKey);
      apiLogger.warn({ msg: "crm-inbound:duplicate-race", key, threadId: thread.id });
      return "duplicate";
    }
    // Transient (pooler blip / SIGTERM) — leave in inbound/, retry next tick
    // (no row was committed, so the retry re-processes cleanly).
    throw err;
  }

  if (thread.deal) {
    void recordCrmActivity({
      organizationId: thread.organizationId,
      entityType: "DEAL",
      entityId: thread.deal.id,
      action: "EMAIL_RECEIVED",
      actorId: null,
      changes: { from: fromEmail, subject: parsed.subject ?? thread.subject, unverified: !sender.verified },
    });
  }

  try {
    await notifyOwner({ thread, fromEmail, fromName, textBody, htmlBody, unverified: !sender.verified });
  } catch (err) {
    apiLogger.warn({
      msg: "crm-inbound:notify-failed",
      threadId: thread.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await moveObject(bucket, key, processedKey);
  apiLogger.info({
    msg: "crm-inbound:stored",
    threadId: thread.id,
    dealId: thread.deal?.id ?? null,
    attachments: attachments.length,
    unverified: !sender.verified,
  });
  return "stored";
}

export async function runTick(): Promise<InboundTickResult> {
  const result: InboundTickResult = {
    scanned: 0,
    stored: 0,
    duplicates: 0,
    quarantined: 0,
    unmatched: 0,
    failures: 0,
  };

  const bucket = process.env.CRM_INBOUND_S3_BUCKET?.trim();
  if (!bucket) {
    apiLogger.debug({ msg: "crm-inbound:dormant-no-bucket" });
    return result;
  }
  const replyDomain = process.env.CRM_REPLY_DOMAIN?.trim() || null;

  const listed = await s3Client().send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: "inbound/", MaxKeys: MAX_OBJECTS_PER_TICK }),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key!).filter((k) => k && k !== "inbound/");
  result.scanned = keys.length;

  for (const key of keys) {
    try {
      const outcome = await processObject(bucket, key, replyDomain);
      if (outcome === "stored") result.stored++;
      else if (outcome === "duplicate") result.duplicates++;
      else if (outcome === "quarantined") result.quarantined++;
      else result.unmatched++;
    } catch (err) {
      result.failures++;
      apiLogger.error({
        msg: "crm-inbound:object-failed",
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.scanned > 0) {
    apiLogger.info({ msg: "crm-inbound:tick", ...result });
  }
  return result;
}
