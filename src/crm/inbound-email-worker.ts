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
import type { Prisma } from "@prisma/client";
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

/** Forward-copy + bell for the deal owner. Both best-effort — the row is truth. */
async function notifyOwner(args: {
  thread: {
    id: string;
    organizationId: string;
    subject: string;
    deal: { id: string; name: string; ownerId: string | null } | null;
  };
  fromEmail: string;
  fromName: string | null;
  textBody: string | null;
  htmlBody: string | null;
}): Promise<void> {
  const ownerId = args.thread.deal?.ownerId ?? null;
  if (!ownerId) return;

  const senderLabel = args.fromName ? `${args.fromName} (${args.fromEmail})` : args.fromEmail;

  void notifyCrmUser({
    organizationId: args.thread.organizationId,
    recipientId: ownerId,
    actorId: null,
    type: "EMAIL_RECEIVED",
    title: "New reply in the CRM inbox",
    message: `${senderLabel} replied on ${args.thread.deal?.name ?? "a deal"}: ${args.thread.subject}`,
    link: `/crm/inbox?thread=${args.thread.id}`,
  }).catch(() => {
    // notifyCrmUser never throws by contract; belt-and-braces.
  });

  const owner = await db.user.findUnique({
    where: { id: ownerId },
    select: { email: true, firstName: true, lastName: true },
  });
  if (!owner?.email) return;
  const ownerName = `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || undefined;

  const banner =
    `<div style="padding:10px 14px;margin:0 0 16px;background:#f0f9ff;border-left:3px solid #0284c7;font-size:13px;color:#0c4a6e">` +
    `Sponsor reply received in the CRM inbox — read &amp; reply there (this forward is a copy).</div>`;
  const bodyHtml =
    args.htmlBody ??
    `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(args.textBody ?? "")}</pre>`;

  const res = await sendEmail({
    to: [{ email: owner.email, name: ownerName }],
    subject: `Fwd: ${args.thread.subject}`,
    htmlContent: `${banner}${bodyHtml}`,
    textContent: `Sponsor reply received in the CRM inbox — read & reply there.\n\nFrom: ${senderLabel}\n\n${args.textBody ?? ""}`,
    emailType: "crm_email",
    stream: "transactional",
    logContext: {
      organizationId: args.thread.organizationId,
      entityType: "USER",
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
          deal: { select: { id: true, name: true, ownerId: true } },
        },
      })
    : null;
  if (!thread) {
    await moveObject(bucket, key, `unmatched/${basename}`);
    apiLogger.warn({ msg: "crm-inbound:unmatched", key, hasToken: !!token });
    return "unmatched";
  }

  const fromEmail = parsed.from?.value?.[0]?.address ?? "unknown";
  const fromName = parsed.from?.value?.[0]?.name || null;
  const textBody = parsed.text ?? null;
  const htmlBody = typeof parsed.html === "string" ? parsed.html : null;
  const attachments = await storeAttachments(parsed, thread.id);

  await db.crmEmailMessage.create({
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
    },
  });
  await db.crmEmailThread.update({
    where: { id: thread.id },
    data: { hasUnread: true, lastMessageAt: new Date(), lastInboundAt: new Date() },
  });

  if (thread.deal) {
    void recordCrmActivity({
      organizationId: thread.organizationId,
      entityType: "DEAL",
      entityId: thread.deal.id,
      action: "EMAIL_RECEIVED",
      actorId: null,
      changes: { from: fromEmail, subject: parsed.subject ?? thread.subject },
    });
  }

  try {
    await notifyOwner({ thread, fromEmail, fromName, textBody, htmlBody });
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
