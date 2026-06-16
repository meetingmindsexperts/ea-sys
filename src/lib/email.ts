// Brevo + SendGrid + Postmark disabled — kept commented for one release cycle in
// case we need to revert. AWS SES is the only active provider.
// import {
//   TransactionalEmailsApi,
//   TransactionalEmailsApiApiKeys,
//   SendSmtpEmail,
// } from "@getbrevo/brevo";
// import sgMail from "@sendgrid/mail";
// import { ServerClient as PostmarkServerClient } from "postmark";
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import juice from "juice";
import { apiLogger } from "./logger";
import { logEmail, type EmailLogContext } from "./email-log";
import { getTitleLabel } from "./utils";
import { renderBarcodePng } from "./barcode";
import { formatDateInTz } from "./event-time";

// ── HTML escaping ──────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Provider-agnostic email interface ──────────────────────────────────────────

const DEFAULT_FROM_EMAIL = process.env.EMAIL_FROM || "krishna@meetingmindsdubai.com";
const DEFAULT_FROM_NAME = process.env.EMAIL_FROM_NAME || "Event Management System";

export interface SendEmailParams {
  to: { email: string; name?: string }[];
  /**
   * Carbon-copy recipients. Visible to the primary recipient. Used by
   * the per-event auto-CC feature (Event.emailCcAddresses) so
   * organizers and partner inboxes silently get a copy of every
   * event-scoped send. Empty/undefined = no CC.
   */
  cc?: { email: string; name?: string }[];
  /**
   * Blind carbon-copy recipients. NOT visible to the primary
   * recipient. Reserve for compliance/audit observers.
   */
  bcc?: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  from?: { email: string; name?: string };
  attachments?: Array<{
    name: string;
    content: string; // Base64 encoded
    contentType?: string;
    /**
     * When set, the attachment is embedded INLINE (Content-ID) rather than
     * offered as a download. Reference it from the HTML body via
     * `<img src="cid:<contentId>">`. Used for the entry barcode in the
     * registration confirmation so it renders offline in the recipient's
     * inbox (no auth, no remote fetch — scannable at the desk months later).
     * Pass the bare id (e.g. "reg-barcode"); the MIME builder wraps it in
     * angle brackets.
     */
    contentId?: string;
  }>;
  /**
   * Optional audit context. Pass when the caller can identify which
   * registrant/speaker/contact this email belongs to — the row shows up
   * in that person's detail-sheet Email History card.
   */
  logContext?: EmailLogContext;
  /**
   * Short slug identifying the kind of email — e.g. "registration_confirmation",
   * "payment_confirmation", "speaker_invitation", "speaker_agreement",
   * "abstract_status", "refund_confirmation", "password_reset",
   * "webinar_confirmation". Forwarded to SES as the `EmailType` MessageTag so
   * CloudWatch metrics can be sliced by template kind. Defaults to "unknown".
   */
  emailType?: string;
  /**
   * Whether this is a transactional send (triggered by a single user action,
   * one recipient) or a bulk send (Communications page, scheduled blast).
   * Forwarded to SES as the `Stream` MessageTag so bulk-campaign bounces
   * don't pollute transactional reputation alerts. Defaults to "transactional".
   */
  stream?: "transactional" | "bulk";
}

/**
 * SES MessageTag keys must match `[A-Za-z0-9_-]{1,256}` and values must match
 * `[A-Za-z0-9_-]{0,256}`. We coerce any caller-supplied slug to this shape
 * (lower-case, non-conforming chars → underscore) so a slip in a caller never
 * fails the SES send with a `MessageTagValidationFailed` 400.
 */
function sanitizeTagValue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 256) || "unknown";
}

export type SendEmailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Email provider interface. Implement this to add SendGrid, Resend, etc.
 */
interface EmailProvider {
  send(params: SendEmailParams): Promise<SendEmailResult>;
}

// ── Brevo provider (disabled) ─────────────────────────────────────────────────
/*
let brevoInstance: TransactionalEmailsApi | null = null;

function getBrevoInstance(): TransactionalEmailsApi {
  if (!brevoInstance) {
    brevoInstance = new TransactionalEmailsApi();
    brevoInstance.setApiKey(
      TransactionalEmailsApiApiKeys.apiKey,
      process.env.BREVO_API_KEY || ""
    );
  }
  return brevoInstance;
}

const brevoProvider: EmailProvider = {
  async send(params) {
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.sender = {
      email: params.from?.email || DEFAULT_FROM_EMAIL,
      name: params.from?.name || DEFAULT_FROM_NAME,
    };
    sendSmtpEmail.to = params.to.map((r) => ({ email: r.email, name: r.name || r.email }));
    if (params.cc?.length) {
      sendSmtpEmail.cc = params.cc.map((r) => ({ email: r.email, name: r.name || r.email }));
    }
    if (params.bcc?.length) {
      sendSmtpEmail.bcc = params.bcc.map((r) => ({ email: r.email, name: r.name || r.email }));
    }
    sendSmtpEmail.subject = params.subject;
    sendSmtpEmail.htmlContent = params.htmlContent;
    if (params.textContent) sendSmtpEmail.textContent = params.textContent;
    if (params.replyTo) sendSmtpEmail.replyTo = params.replyTo;
    if (params.attachments?.length) {
      sendSmtpEmail.attachment = params.attachments.map((att) => ({
        name: att.name,
        content: att.content,
        contentType: att.contentType,
      }));
    }

    const result = await getBrevoInstance().sendTransacEmail(sendSmtpEmail);
    return { success: true, messageId: result.body.messageId };
  },
};
*/

// ── SendGrid provider (disabled) ──────────────────────────────────────────────
/*
let sgInitialized = false;

function initSendGrid() {
  if (!sgInitialized && process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    sgInitialized = true;
  }
}

const sendGridProvider: EmailProvider = {
  async send(params) {
    initSendGrid();

    const msg: sgMail.MailDataRequired = {
      to: params.to.map((r) => ({ email: r.email, name: r.name || r.email })),
      ...(params.cc?.length && {
        cc: params.cc.map((r) => ({ email: r.email, name: r.name || r.email })),
      }),
      ...(params.bcc?.length && {
        bcc: params.bcc.map((r) => ({ email: r.email, name: r.name || r.email })),
      }),
      from: {
        email: params.from?.email || DEFAULT_FROM_EMAIL,
        name: params.from?.name || DEFAULT_FROM_NAME,
      },
      subject: params.subject,
      html: params.htmlContent,
      ...(params.textContent && { text: params.textContent }),
      ...(params.replyTo && { replyTo: { email: params.replyTo.email, name: params.replyTo.name } }),
      ...(params.attachments?.length && {
        attachments: params.attachments.map((att) => ({
          filename: att.name,
          content: att.content,
          type: att.contentType || "application/pdf",
          disposition: "attachment" as const,
        })),
      }),
    };

    const [response] = await sgMail.send(msg);
    return {
      success: true,
      messageId: response.headers["x-message-id"] as string,
    };
  },
};
*/

// ── Postmark provider (disabled) ──────────────────────────────────────────────
/*
let postmarkClient: PostmarkServerClient | null = null;

function getPostmarkClient(): PostmarkServerClient {
  if (!postmarkClient) {
    postmarkClient = new PostmarkServerClient(process.env.POSTMARK_API_KEY || "");
  }
  return postmarkClient;
}

const postmarkProvider: EmailProvider = {
  async send(params) {
    const fromEmail = params.from?.email || DEFAULT_FROM_EMAIL;
    const fromName = params.from?.name || DEFAULT_FROM_NAME;

    const result = await getPostmarkClient().sendEmail({
      From: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      To: params.to.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", "),
      ...(params.cc?.length && {
        Cc: params.cc.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", "),
      }),
      ...(params.bcc?.length && {
        Bcc: params.bcc.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", "),
      }),
      Subject: params.subject,
      HtmlBody: params.htmlContent,
      ...(params.textContent && { TextBody: params.textContent }),
      ...(params.replyTo && {
        ReplyTo: params.replyTo.name
          ? `${params.replyTo.name} <${params.replyTo.email}>`
          : params.replyTo.email,
      }),
      ...(params.attachments?.length && {
        Attachments: params.attachments.map((att) => ({
          Name: att.name,
          Content: att.content,
          ContentType: att.contentType || "application/octet-stream",
          // Postmark embeds an attachment inline when ContentID is set to
          // `cid:<id>` (referenced from the HTML as `cid:<id>`); null = a
          // normal download attachment.
          ContentID: att.contentId ? `cid:${att.contentId}` : null,
        })),
      }),
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
    });

    return { success: true, messageId: result.MessageID };
  },
};
*/

// ── AWS SES v2 provider ───────────────────────────────────────────────────────

let sesClient: SESv2Client | null = null;

function getSesClient(): SESv2Client {
  if (!sesClient) {
    sesClient = new SESv2Client({
      region: process.env.AWS_SES_REGION || process.env.AWS_REGION || "ap-south-1",
      // Credentials are picked up automatically from the standard AWS chain:
      // env vars (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) → shared credentials
      // file (~/.aws/credentials) → EC2 instance profile (preferred in prod —
      // attach an IAM role to the instance with ses:SendEmail permission).
    });
    // Fire-and-forget identity probe so the first SES use on every process
    // start logs WHICH credential source the SDK actually resolved. The
    // first time this got rejected with UnrecognizedClientException
    // (Sentry 121795612, May 22 2026), the catch block told us the call
    // failed but not WHICH identity AWS rejected — we had to debug from
    // a stack trace alone. This log line + the warn below close that gap.
    void logSesIdentityDiagnostic(sesClient);
  }
  return sesClient;
}

/**
 * One-shot diagnostic that runs the first time the SES client is constructed.
 * Resolves the SDK's credential provider chain and logs the key shape (no
 * secrets!) so we know which identity SES is being called as.
 *
 * Key prefixes (public AWS convention, safe to log):
 *   AKIA  — long-term IAM user access key (from env or ~/.aws/credentials)
 *   ASIA  — short-term STS / instance-role credentials (sessionToken present)
 *   AROA  — IAM role ID (rare in this code path)
 *   ANPA  — managed policy ID
 *   AIDA  — IAM user ID
 *
 * The "env key set AND no sessionToken in resolved creds" branch is the
 * precedence trap that caused the May 22 incident — env vars override any
 * attached EC2 instance role, so a stale .env key gets sent to SES, gets
 * rejected, and the role we *think* we're using never gets a chance.
 */
// Exported only so the unit suite can call it directly with a fake client;
// production callers always reach this via getSesClient() on first use.
export async function logSesIdentityDiagnostic(client: SESv2Client): Promise<void> {
  try {
    const regionProvider = client.config.region;
    const region = typeof regionProvider === "function" ? await regionProvider() : regionProvider;
    const credsProvider = client.config.credentials;
    if (typeof credsProvider !== "function") {
      apiLogger.warn({ msg: "ses:identity-diagnostic-skipped", reason: "no credential provider on client config" });
      return;
    }
    const creds = await credsProvider();
    const keyPrefix = (creds.accessKeyId ?? "").slice(0, 4) || "(empty)";
    const hasSessionToken = !!creds.sessionToken;
    const hasExpiration = !!creds.expiration;
    const envKeySet = !!process.env.AWS_ACCESS_KEY_ID;
    const envKeyPrefix = envKeySet ? process.env.AWS_ACCESS_KEY_ID!.slice(0, 4) : null;

    const source = hasSessionToken
      ? "temporary credentials (instance role / STS / SSO)"
      : keyPrefix === "AKIA"
        ? "long-term IAM user key (env var or shared credentials file)"
        : "unknown";

    apiLogger.info({
      msg: "ses:identity-diagnostic",
      region,
      keyPrefix,
      hasSessionToken,
      hasExpiration,
      credentialSource: source,
      envKeySet,
      envKeyPrefix,
    });

    if (envKeySet && !hasSessionToken) {
      // Precedence trap — env vars are present AND the resolved creds are
      // long-term (no session token), meaning the SDK picked env over any
      // attached instance role. If the env key is stale (rotated, deleted,
      // wrong account), every SES send becomes UnrecognizedClientException.
      // Remediation: clear AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY from
      // the deployed .env on the box and restart so the SDK falls through
      // to the instance role. See docs/runbook-ses.md.
      apiLogger.warn({
        msg: "ses:env-credentials-in-use",
        warning:
          "AWS_ACCESS_KEY_ID is set in env and is taking precedence over any EC2 instance role. " +
          "If this key is stale, SES sends will fail with UnrecognizedClientException. " +
          "See docs/runbook-ses.md for remediation.",
        envKeyPrefix,
        resolvedKeyPrefix: keyPrefix,
      });
    }
  } catch (error) {
    // Don't crash the process or block sends if the diagnostic itself
    // throws — it's an aid, not a gate. The SES send below will still
    // run and emit its own structured error if the creds are bad.
    apiLogger.warn({ err: error, msg: "ses:identity-diagnostic-failed" });
  }
}

function formatAddress(r: { email: string; name?: string }): string {
  return r.name ? `${r.name} <${r.email}>` : r.email;
}

const sesProvider: EmailProvider = {
  async send(params) {
    const fromEmail = params.from?.email || DEFAULT_FROM_EMAIL;
    const fromName = params.from?.name || DEFAULT_FROM_NAME;
    const fromAddress = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

    // SES v2 has no first-class attachment field; we have to build a raw MIME
    // message when attachments are present. Without attachments, use the
    // simpler Simple content path (lets SES handle MIME assembly + signing).
    const hasAttachments = !!params.attachments?.length;
    const configurationSet = process.env.AWS_SES_CONFIGURATION_SET;

    const input: SendEmailCommandInput = {
      FromEmailAddress: fromAddress,
      Destination: {
        ToAddresses: params.to.map(formatAddress),
        ...(params.cc?.length && { CcAddresses: params.cc.map(formatAddress) }),
        ...(params.bcc?.length && { BccAddresses: params.bcc.map(formatAddress) }),
      },
      ...(params.replyTo && { ReplyToAddresses: [formatAddress(params.replyTo)] }),
      ...(configurationSet && { ConfigurationSetName: configurationSet }),
      // MessageTags drive the CloudWatch dimensions on the configuration
      // set (EmailType + Stream). Defaults match the SES dimension "Default
      // value" fields so any forgotten caller still produces a tagged metric
      // — we'd rather see "unknown" climb in dashboards than have metrics
      // silently drop. sanitizeTagValue guards against caller typos that
      // would otherwise 400 the SES API.
      EmailTags: [
        { Name: "EmailType", Value: sanitizeTagValue(params.emailType ?? "unknown") },
        { Name: "Stream", Value: sanitizeTagValue(params.stream ?? "transactional") },
      ],
      Content: hasAttachments
        ? { Raw: { Data: buildRawMime(params, fromAddress) } }
        : {
            Simple: {
              Subject: { Data: params.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: params.htmlContent, Charset: "UTF-8" },
                ...(params.textContent && {
                  Text: { Data: params.textContent, Charset: "UTF-8" },
                }),
              },
            },
          },
    };

    const result = await getSesClient().send(new SendEmailCommand(input));
    return { success: true, messageId: result.MessageId };
  },
};

/**
 * Build a raw RFC 5322 MIME envelope for SES SendEmail. Used when the caller
 * passes attachments (Quote PDF, agreement .docx, etc.) — the Simple content
 * path doesn't support them.
 *
 * Structure depends on whether any attachments are INLINE (have a contentId):
 *
 *   No inline images:
 *     multipart/mixed
 *       ├─ [multipart/alternative | text/html]   ← body
 *       └─ <regular attachments>                 ← Content-Disposition: attachment
 *
 *   With inline images (e.g. the entry barcode):
 *     multipart/mixed
 *       ├─ multipart/related
 *       │    ├─ [multipart/alternative | text/html]  ← body, references cid:
 *       │    └─ <inline images>                       ← Content-ID, inline
 *       └─ <regular attachments>
 *
 * Each attachment is already base64-encoded by the caller; we just frame it.
 */
export function buildRawMime(params: SendEmailParams, fromAddress: string): Uint8Array {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const mixed = `=_ea_mix_${suffix}`;
  const related = `=_ea_rel_${suffix}`;
  const alt = `=_ea_alt_${suffix}`;

  const inlineAtts = (params.attachments ?? []).filter((a) => a.contentId);
  const regularAtts = (params.attachments ?? []).filter((a) => !a.contentId);

  // The body section — multipart/alternative when a plain-text part exists,
  // otherwise a bare text/html part. Emitted as the lines that follow a
  // boundary delimiter (Content-Type header → blank line → content).
  const bodyLines: string[] = [];
  if (params.textContent) {
    bodyLines.push(
      `Content-Type: multipart/alternative; boundary="${alt}"`, "",
      `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", params.textContent,
      `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", params.htmlContent,
      `--${alt}--`,
    );
  } else {
    bodyLines.push('Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", params.htmlContent);
  }

  const headers: string[] = [
    `From: ${fromAddress}`,
    `To: ${params.to.map(formatAddress).join(", ")}`,
    ...(params.cc?.length ? [`Cc: ${params.cc.map(formatAddress).join(", ")}`] : []),
    ...(params.replyTo ? [`Reply-To: ${formatAddress(params.replyTo)}`] : []),
    `Subject: ${encodeRfc2047(params.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];

  const body: string[] = [`--${mixed}`];

  if (inlineAtts.length > 0) {
    // Body + inline images live together inside a multipart/related so the
    // HTML's cid: references resolve to the sibling image parts.
    body.push(`Content-Type: multipart/related; boundary="${related}"`, "");
    body.push(`--${related}`, ...bodyLines);
    for (const att of inlineAtts) {
      body.push(
        `--${related}`,
        `Content-Type: ${att.contentType || "application/octet-stream"}; name="${att.name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${att.contentId}>`,
        `Content-Disposition: inline; filename="${att.name}"`,
        "",
        att.content.replace(/(.{76})/g, "$1\r\n"),
      );
    }
    body.push(`--${related}--`);
  } else {
    body.push(...bodyLines);
  }

  // Regular (download) attachments hang off the outer multipart/mixed.
  for (const att of regularAtts) {
    body.push(
      `--${mixed}`,
      `Content-Type: ${att.contentType || "application/octet-stream"}; name="${att.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${att.name}"`,
      "",
      att.content.replace(/(.{76})/g, "$1\r\n"),
    );
  }
  body.push(`--${mixed}--`);

  return new TextEncoder().encode(headers.join("\r\n") + "\r\n\r\n" + body.join("\r\n"));
}

/** RFC 2047 encode non-ASCII characters in headers (subject lines). */
function encodeRfc2047(s: string): string {
  // Plain ASCII subject — no encoding needed.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

// ── Provider selection ─────────────────────────────────────────────────────────

function resolveProviderName(): "ses" {
  // Brevo + SendGrid + Postmark are disabled (see commented blocks above).
  // AWS SES is the only active provider.
  return "ses";
}

function getProvider(): EmailProvider {
  return sesProvider;
}

// ── Main send function ─────────────────────────────────────────────────────────

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  // Don't gate on env-var existence — SES SDK picks up credentials from the
  // full AWS chain (instance profile on EC2 has no env vars at all). Let the
  // SendEmailCommand surface a credential error in the catch block instead.

  const providerName = resolveProviderName();
  const toEmails = params.to.map((r) => r.email);
  const primaryTo = toEmails[0] ?? "";

  // Surface any sendEmail caller that forgot to pass logContext — the row
  // still gets written (as entityType=OTHER) but won't link to a detail
  // sheet. This log line lets us find the caller during audits instead of
  // chasing silent symptoms like "I sent an email but no history row".
  if (!params.logContext) {
    apiLogger.warn({
      msg: "sendEmail called without logContext — row will orphan as OTHER",
      to: toEmails,
      subject: params.subject,
    });
  }

  try {
    const result = await getProvider().send(params);

    apiLogger.info({
      msg: "Email sent successfully",
      to: toEmails,
      subject: params.subject,
      messageId: result.messageId,
    });

    // Fire-and-forget audit row. Never blocks the send.
    void logEmail({
      to: primaryTo,
      cc: toEmails.length > 1 ? toEmails.slice(1).join(", ") : null,
      subject: params.subject,
      provider: providerName,
      providerMessageId: result.messageId ?? null,
      status: "SENT",
      context: params.logContext,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    // Postmark errors carry .code (Postmark numeric, e.g. 412 = pending-approval
    // sandbox), .statusCode (HTTP), and .body. SendGrid errors carry .response.
    // Pluck them as top-level context so the file logs + Sentry payload have
    // them without us having to JSON-stringify the whole error.
    const err = error as { code?: number | string; statusCode?: number; body?: unknown; response?: unknown };
    // AWS SDK v3 errors carry a different shape than Postmark/SendGrid:
    //   error.name              — the AWS error code, e.g. "UnrecognizedClientException"
    //   error.$metadata.httpStatusCode  — HTTP status from the service
    //   error.$metadata.requestId       — the X-Amz-RequestId we'd quote to AWS support
    //   error.$fault            — "client" (4xx-class) or "server" (5xx / retryable)
    // Without this, Sentry sees only the message + stack and we have no way
    // to grep for "all UnrecognizedClientException last 24h" or to attach
    // an AWS request ID to a support ticket. Sentry issue 121795612 (May 22)
    // is the worked example.
    const awsErr = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string; attempts?: number };
      $fault?: "client" | "server";
    };
    const awsErrorName = awsErr.name && awsErr.name !== "Error" ? awsErr.name : undefined;
    const awsRequestId = awsErr.$metadata?.requestId;
    apiLogger.error({
      // Pass the raw Error so withSentryForwarding routes it via captureException
      // (full stack trace) instead of captureMessage (string only).
      err: error,
      msg: "Failed to send email",
      error: message,
      // AWS SDK v3 shape — populated when provider is SES, undefined otherwise.
      awsErrorName,
      awsHttpStatus: awsErr.$metadata?.httpStatusCode,
      awsRequestId,
      awsFault: awsErr.$fault,
      // Postmark/SendGrid shape — kept for the currently-disabled providers
      // and back-compat with older log queries.
      providerCode: err.code,
      providerStatus: err.statusCode,
      providerBody: err.body,
      providerResponse: err.response,
      to: toEmails,
      subject: params.subject,
      provider: providerName,
    });
    // Persist the AWS requestId in the EmailLog row when present so the
    // operator can correlate a failed row in /logs back to the exact SES
    // API call (and quote it in an AWS support ticket). Stays inside the
    // existing errorMessage column — no migration needed for what's a
    // diagnostic aid.
    const errorMessageForLog = awsRequestId
      ? `${message} [awsErrorName=${awsErrorName ?? "(unknown)"} awsRequestId=${awsRequestId}]`
      : message;
    void logEmail({
      to: primaryTo,
      cc: toEmails.length > 1 ? toEmails.slice(1).join(", ") : null,
      subject: params.subject,
      provider: providerName,
      status: "FAILED",
      errorMessage: errorMessageForLog,
      context: params.logContext,
    });
    // Fire admin alert (dedup'd, fire-and-forget). Does NOT block the
    // return path of the original send. Recipient self-guard inside
    // notifyAdminOfSendFailure prevents recursion if the alert send
    // itself also fails.
    void notifyAdminOfSendFailure({
      message,
      awsErrorName,
      awsRequestId,
      to: primaryTo,
      subject: params.subject,
      from: params.from?.email,
      logContext: params.logContext,
    });
    return {
      success: false,
      error: message,
    };
  }
}

// ── Admin alert on send failure ────────────────────────────────────────────────

/**
 * Email-specific admin alert. Builds the rich per-email context body
 * (recipient, subject, AWS error code + requestId, eventId, template
 * slug, entityType+id) and delegates to the generic notifyAdminAlert
 * helper in src/lib/admin-alert.ts.
 *
 * Dedup key shape: `email:{awsErrorName}|{recipient-domain}|{sender}`
 * — same error type + same recipient domain + same sender origin =
 * considered the same incident for the next hour. Fine granularity
 * to catch "single sender misconfigured" without bundling unrelated
 * failures.
 *
 * Recursion-safe: notifyAdminAlert internally calls sendEmail to
 * dispatch the alert; if THAT send also fails, sendEmail's catch
 * block re-enters notifyAdminOfSendFailure. The recipient self-guard
 * here short-circuits that path so the alert about a failed alert
 * is suppressed (the original failure is still logged via apiLogger).
 */
interface SendFailureAlertInput {
  message: string;
  awsErrorName?: string;
  awsRequestId?: string;
  to: string;
  subject: string;
  from?: string;
  logContext?: EmailLogContext;
}

async function notifyAdminOfSendFailure(input: SendFailureAlertInput): Promise<void> {
  const { notifyAdminAlert, isAlertSelfRecipient } = await import("./admin-alert");

  // Recipient self-guard — short-circuit BEFORE body-build to avoid
  // wasted work when the alert send itself recursively triggers this
  // path.
  if (isAlertSelfRecipient(input.to)) {
    apiLogger.warn({
      msg: "admin-alert:skipped-self",
      to: input.to,
    });
    return;
  }

  const recipientDomain = input.to.includes("@")
    ? input.to.slice(input.to.lastIndexOf("@") + 1).toLowerCase()
    : input.to.toLowerCase();
  const dedupKey = `email:${input.awsErrorName ?? "unknown"}|${recipientDomain}|${input.from ?? "default"}`;

  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
  const subjectPrefix = `[ea-sys][${env}] Email send failure`;
  const subject = input.awsErrorName
    ? `${subjectPrefix}: ${input.awsErrorName}`
    : subjectPrefix;

  const lines = [
    "An EA-SYS email send failed.",
    "",
    `Environment:   ${env}`,
    `Error:         ${input.message}`,
    input.awsErrorName ? `AWS code:      ${input.awsErrorName}` : null,
    input.awsRequestId ? `AWS requestId: ${input.awsRequestId}` : null,
    `Recipient:     ${input.to}`,
    `Subject:       ${input.subject}`,
    input.from ? `From:          ${input.from}` : null,
    input.logContext?.eventId ? `Event:         ${input.logContext.eventId}` : null,
    input.logContext?.templateSlug ? `Template:      ${input.logContext.templateSlug}` : null,
    input.logContext?.entityType
      ? `Entity:        ${input.logContext.entityType}${
          input.logContext.entityId ? ` / ${input.logContext.entityId}` : ""
        }`
      : null,
    "",
    `Further occurrences of this (errorName + recipient-domain + sender) combo within the next hour will NOT trigger another alert — open /logs in the dashboard to see all failures.`,
    "",
    `--`,
    `ea-sys automated alert`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  await notifyAdminAlert({ subject, body: lines, dedupKey });
}

// ── Template variable rendering ────────────────────────────────────────────────

/**
 * Variables that are ALWAYS server-built HTML blocks (never user input).
 * Treated as raw HTML automatically — callers don't need to opt them in via
 * `rawHtmlKeys`, which forced every site to remember the same tedious list
 * and missed sites rendered the markup as escaped text in the email.
 *
 * Keep this list strictly to fields built from template-literals in code
 * (with their inner user-input pieces already individually `escapeHtml`'d).
 * User-controlled strings like `personalMessage` and `organizerSignature`
 * stay caller-managed — only the caller knows whether the source is a
 * trusted Tiptap editor's HTML or a raw string from a free-form input.
 */
const DEFAULT_RAW_HTML_KEYS = new Set([
  // Built in stripe webhook + sendRegistrationConfirmation +
  // /api/events/[id]/registrations/[id]/email payment-reminder branch.
  "paymentBlock",
  // Stripe webhook only.
  "receiptBlock",
  "taxBlock",
  // Speaker email helper — see buildSpeakerEmailContext().
  "presentationDetails",
  // Webinar enrichment in bulk-email.ts.
  "passcodeBlock",
  "recordingBlock",
]);

/**
 * Replace {{variable}} placeholders with values, HTML-escaping all values.
 * Unmatched placeholders are left as-is.
 *
 * `DEFAULT_RAW_HTML_KEYS` and any caller-supplied `rawHtmlKeys` are merged —
 * either source treats the matching value as raw HTML (no escaping). Use
 * `rawHtmlKeys` for caller-specific fields like `personalMessage` that are
 * trusted in some contexts but not others.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | number | undefined>,
  rawHtmlKeys?: Set<string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) return `{{${key}}}`;
    if (DEFAULT_RAW_HTML_KEYS.has(key) || rawHtmlKeys?.has(key)) return String(value);
    return escapeHtml(String(value));
  });
}

/**
 * Render a template for plain text (no HTML escaping).
 */
export function renderTemplatePlain(
  template: string,
  variables: Record<string, string | number | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) return `{{${key}}}`;
    return String(value);
  });
}

// ── Email branding wrapper ─────────────────────────────────────────────────────

export interface EmailBranding {
  emailHeaderImage?: string | null;
  /**
   * Responsive logo / sign-off image rendered at the very bottom of
   * the email body, below the optional emailFooterHtml block. Same
   * `width="600"` + `max-width: 600px` treatment as the header so
   * Outlook desktop and modern clients render at the email-body
   * width.
   */
  emailFooterImage?: string | null;
  emailFooterHtml?: string | null;
  emailFromAddress?: string | null;
  emailFromName?: string | null;
  /**
   * Per-event auto-CC list (Event.emailCcAddresses). Every send that
   * uses this branding object will automatically CC these addresses.
   * Caller still owns explicit cc/bcc on `sendEmail` — the auto list
   * is merged in via `brandingCc()`.
   */
  emailCcAddresses?: string[];
  eventName?: string;
}

// ── Responsive email-image helpers ────────────────────────────────────
//
// Email images need a careful belt-and-braces approach: modern clients
// (Apple Mail, Gmail web/iOS/Android, Outlook 365 web) honour CSS
// `width: 100%; max-width: 600px`, but Outlook on Windows desktop
// strips most CSS and renders the image at its natural pixel size
// unless an HTML `width="600"` attribute is present. Pairing both
// gives a single render that fits the 600px email body across every
// client we support, on retina-class displays included.

const RESPONSIVE_IMG_STYLE =
  "display: block; width: 100%; max-width: 600px; height: auto; border: 0; line-height: 100%; outline: none; text-decoration: none;";

/**
 * Build a `<tr><td><img></td></tr>` block carrying the responsive
 * attribute set used for header + footer images. `align="center"` on
 * the parent `<td>` is the Outlook fallback for `display: block` on
 * the image.
 */
function responsiveImageBlock(src: string, alt: string): string {
  return `<tr><td style="padding: 0;" align="center">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="600" border="0" style="${RESPONSIVE_IMG_STYLE}" />
  </td></tr>`;
}

/**
 * Rewrite every `<img>` in the body HTML to carry the same responsive
 * attribute set as the header/footer helpers. Defends against Tiptap-
 * inserted images without explicit width/style — and against
 * organizer-set widths that would otherwise overflow the 600px email
 * body. Idempotent (running twice produces the same output).
 *
 * Regex-based on purpose: this runs on the JSDOM-free server path,
 * and the input is already a constrained subset (Tiptap output +
 * server-rendered template literals, both well-formed). Strips any
 * existing `width`, `border`, and `style` attributes on each `<img>`
 * before re-emitting them so the canonical set always wins.
 */
export function normalizeBodyImages(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(?:width|border)\s*=\s*"[^"]*"/gi, "")
      .replace(/\s(?:width|border)\s*=\s*'[^']*'/gi, "")
      .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
      .replace(/\sstyle\s*=\s*'[^']*'/gi, "")
      .trim();
    const prefix = cleaned.length > 0 ? ` ${cleaned}` : "";
    return `<img${prefix} width="600" border="0" style="${RESPONSIVE_IMG_STYLE}" />`;
  });
}

/**
 * Wrap body HTML content with a consistent email layout including header image
 * and footer. Uses table-based layout for email client compatibility.
 */
export function wrapWithBranding(bodyHtml: string, branding: EmailBranding): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";

  // Convert relative image URLs to absolute
  const resolveSrc = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    return raw.startsWith("http") ? raw : `${appUrl}${raw}`;
  };
  const headerSrc = resolveSrc(branding.emailHeaderImage);
  const footerImageSrc = resolveSrc(branding.emailFooterImage);

  // If the template body already opens with an <img> tag (e.g. an admin
  // pasted a banner into the WYSIWYG editor), skip our auto-injected header
  // to avoid rendering two banners stacked on top of each other. We check
  // the first ~400 chars so a body-image counts only when it's clearly at
  // the top of the content, not a footer logo or inline icon further down.
  const bodyOpensWithImage = /^[\s\S]{0,400}<img\b/i.test(bodyHtml);

  const headerBlock = headerSrc && !bodyOpensWithImage
    ? responsiveImageBlock(headerSrc, branding.eventName || "Event")
    : "";

  const footerImageBlock = footerImageSrc
    ? responsiveImageBlock(footerImageSrc, branding.eventName || "Event")
    : "";

  // Normalize any <img> in the Tiptap-edited body to the same responsive
  // attribute set the header/footer use — defends against organizer-
  // inserted images that would otherwise overflow Outlook desktop or
  // render at unexpected widths on mobile.
  const normalizedBody = normalizeBodyImages(bodyHtml);

  const footerContent = branding.emailFooterHtml
    ? normalizeBodyImages(branding.emailFooterHtml)
    : branding.eventName
      ? `<p>This email was sent regarding ${escapeHtml(branding.eventName)}</p>`
      : `<p>Sent from MMGroup EventsHub</p>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; background-color: #ffffff;">
    <tr>
      <td style="padding: 20px 0;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px;">
          ${headerBlock}
          <tr>
            <td style="padding: 24px 30px;">
              ${normalizedBody}
            </td>
          </tr>
          ${footerImageBlock}
          <tr>
            <td style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
              ${footerContent}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Inline CSS from <style> blocks into element style attributes for email
 * client compatibility. Uses the juice library.
 */
export function inlineCss(html: string): string {
  return juice(html);
}

/**
 * Strip the document wrapper (DOCTYPE, html, head, body tags) from a full
 * HTML email document, returning only the body content.
 * Used for loading existing full-document templates into the WYSIWYG editor.
 */
export function stripDocumentWrapper(html: string): string {
  // Try to extract content between <body...> and </body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    return bodyMatch[1].trim();
  }
  // If no body tag, return as-is (already a fragment)
  return html;
}

// ── Available template variables per slug ──────────────────────────────────────

export const TEMPLATE_VARIABLES: Record<string, { key: string; description: string }[]> = {
  "registration-confirmation": [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "paymentBlock", description: "Payment pending block (auto-generated for paid tickets)" },
  ],
  "speaker-invitation": [
    { key: "title", description: "Speaker title prefix (e.g. Dr.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Full prefixed speaker name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "personalMessage", description: "Personal message from organizer" },
    { key: "presentationDetails", description: "Pre-rendered presentation details block (HTML)" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML)" },
  ],
  "speaker-agreement": [
    { key: "title", description: "Speaker title prefix (e.g. Dr.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Full prefixed speaker name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "sessionDetails", description: "Session details" },
    { key: "presentationDetails", description: "Pre-rendered presentation details block (HTML)" },
    { key: "agreementLink", description: "Agreement link URL" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML)" },
  ],
  "event-reminder": [
    { key: "title", description: "Recipient title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventAddress", description: "Event address" },
    { key: "daysUntilEvent", description: "Number of days until event" },
  ],
  "abstract-submission-confirmation": [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractTitle", description: "Abstract title" },
    { key: "managementLink", description: "Abstract management link" },
  ],
  "abstract-status-update": [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractTitle", description: "Abstract title" },
    { key: "newStatus", description: "New status (e.g. ACCEPTED)" },
    { key: "statusHeading", description: "Status heading text" },
    { key: "statusMessage", description: "Status description text" },
    { key: "reviewNotes", description: "Reviewer notes" },
    { key: "reviewScore", description: "Review score (0-10)" },
    { key: "managementLink", description: "Abstract management link" },
  ],
  "submitter-welcome": [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Submitter first name" },
    { key: "lastName", description: "Submitter last name" },
    { key: "eventName", description: "Event name" },
    { key: "loginLink", description: "Login page link" },
  ],
  "custom-notification": [
    { key: "title", description: "Recipient title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "subject", description: "Email subject" },
    { key: "message", description: "Custom message body" },
    { key: "ctaText", description: "Call-to-action button text" },
    { key: "ctaLink", description: "Call-to-action button URL" },
  ],
  "payment-confirmation": [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount paid (e.g. USD 100.00)" },
    { key: "currency", description: "Currency code" },
    { key: "paymentDate", description: "Payment date (formatted)" },
    { key: "receiptUrl", description: "Stripe receipt URL (auto-generated)" },
  ],
  "refund-confirmation": [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount refunded (e.g. USD 100.00)" },
    { key: "refundDate", description: "Refund date (formatted)" },
  ],
  "payment-reminder": [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount due (e.g. USD 100.00)" },
    { key: "paymentBlock", description: "Pay Now button (auto-generated)" },
  ],
};

// ── Default template HTML (body fragments only — wrapped at render time) ──────

export interface DefaultTemplate {
  slug: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string;
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    slug: "registration-confirmation",
    name: "Registration Confirmation",
    subject: "Registration Confirmed - {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your registration for <strong>{{eventName}}</strong> has been confirmed. We look forward to seeing you!</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Registration Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Registration #:</td><td style="padding: 8px 0; font-weight: 500; font-family: monospace;">{{registrationId}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Ticket Type:</td><td style="padding: 8px 0; font-weight: 500;">{{ticketType}}</td></tr>
      </table>
    </div>
    {{paymentBlock}}
    <p>If you have any questions, please don&apos;t hesitate to contact us.</p>
    <p style="margin-bottom: 0;">See you at the event!</p>
  </div>`,
    textContent: `Registration Confirmed - {{eventName}}

Dear {{title}} {{lastName}},

Your registration for {{eventName}} has been confirmed.

Registration Details:
- Registration #: {{registrationId}}
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}
- Ticket Type: {{ticketType}}

{{paymentBlock}}

See you at the event!`,
  },

  {
    slug: "speaker-invitation",
    name: "Speaker Invitation",
    subject: "Speaker Invitation - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">You&apos;re Invited to Speak!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>We would be honored to have you as a speaker at <strong>{{eventName}}</strong>!</p>
    {{personalMessage}}
    {{presentationDetails}}
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Please let us know if you&apos;re interested in speaking at our event. We look forward to hearing from you!</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #00aade;">{{organizerEmail}}</a></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Speaker Invitation - {{eventName}}

Dear {{speakerName}},

We would be honored to have you as a speaker at {{eventName}}!

{{personalMessage}}

{{presentationDetailsText}}

Event Details:
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}

Best regards,
{{organizerName}}
{{organizerEmail}}`,
  },

  {
    slug: "speaker-agreement",
    name: "Invited Faculty Participation Agreement",
    subject: "Invited Faculty Participation Agreement — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Invited Faculty Participation Agreement</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>Thank you for agreeing to participate as invited faculty at <strong>{{eventName}}</strong>. On behalf of {{organizerName}}, please find attached the <strong>Invited Faculty Participation Agreement</strong> setting out the terms of your engagement.</p>
    {{presentationDetails}}
    <div style="background: #fffbeb; padding: 14px 18px; border-left: 4px solid #d97706; margin: 20px 0; color: #92400e; font-size: 14px;">
      <strong>Important:</strong> No speaker fee or honorarium is provided under this Agreement. Faculty receive pre-approved travel and accommodation support only, in accordance with applicable GCC healthcare and Mecomed compliance standards.
    </div>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151; font-size: 15px;">Key points</h3>
      <ul style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px; line-height: 1.6;">
        <li>Presentation slides are due <strong>no later than 45 days before the Conference start date</strong>.</li>
        <li>All travel must be <strong>pre-approved in writing</strong> by {{organizerName}} before booking.</li>
        <li>A completed <strong>Conflict of Interest Declaration Form</strong> is required prior to the Conference.</li>
        <li>CME/CPD recording consent is described in Section 5 of the attached Agreement.</li>
      </ul>
    </div>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151; font-size: 15px;">Event details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 6px 0; color: #6b7280;">Event:</td><td style="padding: 6px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280;">Date:</td><td style="padding: 6px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280;">Venue:</td><td style="padding: 6px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p><strong>Your personalized Agreement is attached to this email as a PDF.</strong> Please review it and confirm your participation by clicking the button below — no printing or signing is required.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{agreementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">Review &amp; Accept Agreement</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; text-align: center;">This link is unique to you and will expire in 30 days.</p>
    <p>{{personalMessage}}</p>
    <p>If you have any questions about the Agreement, please reach out before confirming.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #00aade;">{{organizerEmail}}</a></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Invited Faculty Participation Agreement — {{eventName}}

Dear {{speakerName}},

Thank you for agreeing to participate as invited faculty at {{eventName}}. On behalf of {{organizerName}}, please find attached the Invited Faculty Participation Agreement setting out the terms of your engagement.

{{presentationDetailsText}}

IMPORTANT: No speaker fee or honorarium is provided under this Agreement. Faculty receive pre-approved travel and accommodation support only, in accordance with applicable GCC healthcare and Mecomed compliance standards.

Key points:
- Presentation slides are due no later than 45 days before the Conference start date.
- All travel must be pre-approved in writing by {{organizerName}} before booking.
- A completed Conflict of Interest Declaration Form is required prior to the Conference.
- CME/CPD recording consent is described in Section 5 of the attached Agreement.

Event details:
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}

Your personalized Agreement is attached to this email as a PDF. Please review it and confirm your participation here — no printing or signing required:
{{agreementLink}}

This link is unique to you and will expire in 30 days.

{{personalMessage}}

If you have any questions about the Agreement, please reach out before confirming.

Best regards,
{{organizerName}}
{{organizerEmail}}`,
  },

  {
    slug: "event-reminder",
    name: "Event Reminder",
    subject: "Reminder: {{eventName}} is coming up!",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">{{daysUntilEvent}} Days to Go!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>This is a friendly reminder that <strong>{{eventName}}</strong> is coming up in {{daysUntilEvent}} days!</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Don&apos;t forget to bring your registration confirmation or QR code for check-in.</p>
    <p style="margin-bottom: 0;">We look forward to seeing you!</p>
  </div>`,
    textContent: `Reminder: {{eventName}} is coming up!

Dear {{title}} {{lastName}},

This is a friendly reminder that {{eventName}} is coming up in {{daysUntilEvent}} days!

Event Details:
- Date: {{eventDate}}
- Venue: {{eventVenue}}

We look forward to seeing you!`,
  },

  {
    slug: "abstract-submission-confirmation",
    name: "Abstract Submission Confirmation",
    subject: "Abstract Submitted - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Abstract Submitted!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your abstract has been successfully submitted for <strong>{{eventName}}</strong>.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Submission Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Status:</td><td style="padding: 8px 0; font-weight: 500;">Submitted</td></tr>
      </table>
    </div>
    <p>You can view the status of your abstract, make edits, and see reviewer feedback using the link below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
    <p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Important:</strong> Save this email! The link above is your personal access link to manage your submission.</p>
  </div>`,
    textContent: `Abstract Submitted - {{eventName}}

Dear {{title}} {{lastName}},

Your abstract has been successfully submitted for {{eventName}}.

Submission Details:
- Title: {{abstractTitle}}
- Status: Submitted

View Your Abstract: {{managementLink}}

Important: Save this email! The link above is your personal access link to manage your submission.`,
  },

  {
    slug: "abstract-status-update",
    name: "Abstract Status Update",
    subject: "{{statusHeading}} - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">{{statusHeading}}</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>{{statusMessage}}</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Abstract Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Status:</td><td style="padding: 8px 0; font-weight: 500;">{{newStatus}}</td></tr>
      </table>
    </div>
    {{reviewNotes}}
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
  </div>`,
    textContent: `{{statusHeading}} - {{eventName}}

Dear {{title}} {{lastName}},

{{statusMessage}}

Abstract Details:
- Title: {{abstractTitle}}
- Status: {{newStatus}}

{{reviewNotes}}

View Your Abstract: {{managementLink}}`,
  },

  {
    slug: "submitter-welcome",
    name: "Submitter Welcome",
    subject: "Welcome to {{eventName}} - Account Created",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Welcome!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your account has been created successfully for <strong>{{eventName}}</strong>. You can now log in to submit your abstracts.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{loginLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Log In &amp; Submit Abstract</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you did not create this account, you can safely ignore this email.</p>
  </div>`,
    textContent: `Welcome to {{eventName}} - Account Created

Dear {{title}} {{lastName}},

Your account has been created successfully for {{eventName}}. You can now log in to submit your abstracts.

Log In: {{loginLink}}`,
  },

  {
    slug: "abstract-reminder",
    name: "Abstract Submission Reminder",
    subject: "Reminder: Submit Your Abstract for {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Abstract Submission Reminder</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>This is a friendly reminder to submit your abstract for <strong>{{eventName}}</strong>.</p>
    <p>If you have already submitted, please check your dashboard for any updates or revision requests from the review committee.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstracts</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you have any questions, please contact the event organizer.</p>
  </div>`,
    textContent: `Abstract Submission Reminder - {{eventName}}

Dear {{title}} {{lastName}},

This is a friendly reminder to submit your abstract for {{eventName}}.

If you have already submitted, please check your dashboard for any updates or revision requests.

View Your Abstracts: {{managementLink}}`,
  },

  {
    slug: "custom-notification",
    name: "Custom Notification",
    subject: "{{subject}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">{{subject}}</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <div style="white-space: pre-wrap;">{{message}}</div>
  </div>`,
    textContent: `{{subject}}

Dear {{title}} {{lastName}},

{{message}}`,
  },
  {
    slug: "payment-confirmation",
    name: "Payment Confirmation",
    subject: "Payment Received — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; text-align: center; line-height: 56px; font-size: 28px;">&#10003;</div>
    </div>
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827; text-align: center;">Payment Received</h1>
    <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 14px; text-align: center;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 24px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Thank you for your payment. Here are your invoice details:</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration #</td><td style="padding: 10px 16px; font-weight: 600; text-align: right; font-family: monospace;">{{registrationId}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Payment Reference</td><td style="padding: 10px 16px; font-weight: 500; text-align: right; font-family: monospace; font-size: 12px;">{{paymentReference}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Event</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{eventName}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Date</td><td style="padding: 10px 16px; text-align: right;">{{eventDate}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration Type</td><td style="padding: 10px 16px; text-align: right;">{{ticketType}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Amount Paid</td><td style="padding: 10px 16px; font-weight: 700; font-size: 16px; text-align: right; color: #059669;">{{amount}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Payment Date</td><td style="padding: 10px 16px; text-align: right;">{{paymentDate}}</td></tr>
    </table>
    {{receiptBlock}}
    <p style="color: #6b7280; font-size: 13px;">Please save this email for your records. If you have any questions, contact the event organizer.</p>
  </div>`,
    textContent: `Payment Received — {{eventName}}

Dear {{title}} {{lastName}},

Thank you for your payment. Here are your invoice details:

Registration #: {{registrationId}}
Payment Reference: {{paymentReference}}
Event: {{eventName}}
Date: {{eventDate}}
Registration Type: {{ticketType}}
Amount Paid: {{amount}}
Payment Date: {{paymentDate}}

{{receiptBlock}}

Please save this email for your records.`,
  },
  {
    slug: "refund-confirmation",
    name: "Refund Confirmation",
    subject: "Refund Processed — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 56px; height: 56px; border-radius: 50%; background: #fef3c7; text-align: center; line-height: 56px; font-size: 28px;">&#8617;</div>
    </div>
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827; text-align: center;">Refund Processed</h1>
    <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 14px; text-align: center;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 24px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your payment has been refunded. Please allow 5–10 business days for the amount to appear on your statement.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration #</td><td style="padding: 10px 16px; font-weight: 600; text-align: right; font-family: monospace;">{{registrationId}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Event</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{eventName}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Date</td><td style="padding: 10px 16px; text-align: right;">{{eventDate}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration Type</td><td style="padding: 10px 16px; text-align: right;">{{ticketType}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Amount Refunded</td><td style="padding: 10px 16px; font-weight: 700; font-size: 16px; text-align: right; color: #dc2626;">{{amount}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Refund Date</td><td style="padding: 10px 16px; text-align: right;">{{refundDate}}</td></tr>
    </table>
    <p style="color: #6b7280; font-size: 13px;">If you have any questions about this refund, please contact the event organizer.</p>
  </div>`,
    textContent: `Refund Processed — {{eventName}}

Dear {{title}} {{lastName}},

Your payment has been refunded. Please allow 5–10 business days for the amount to appear on your statement.

Registration #: {{registrationId}}
Event: {{eventName}}
Date: {{eventDate}}
Registration Type: {{ticketType}}
Amount Refunded: {{amount}}
Refund Date: {{refundDate}}

If you have any questions, please contact the event organizer.`,
  },
  {
    slug: "payment-reminder",
    name: "Payment Reminder",
    subject: "Payment Reminder — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 56px; height: 56px; border-radius: 50%; background: #fef3c7; text-align: center; line-height: 56px; font-size: 28px;">&#9888;</div>
    </div>
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827; text-align: center;">Payment Reminder</h1>
    <p style="color: #6b7280; margin: 0 0 24px 0; font-size: 14px; text-align: center;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 24px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>This is a friendly reminder that your registration payment is still pending. Please complete your payment to secure your spot.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Event</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{eventName}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Date</td><td style="padding: 10px 16px; text-align: right;">{{eventDate}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration Type</td><td style="padding: 10px 16px; text-align: right;">{{ticketType}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Amount Due</td><td style="padding: 10px 16px; font-weight: 700; font-size: 16px; text-align: right; color: #dc2626;">{{amount}}</td></tr>
    </table>
    {{paymentBlock}}
    <p style="color: #6b7280; font-size: 13px;">If you have already made the payment, please disregard this email. For any questions, contact the event organizer.</p>
  </div>`,
    textContent: `Payment Reminder — {{eventName}}

Dear {{title}} {{lastName}},

This is a friendly reminder that your registration payment is still pending. Please complete your payment to secure your spot.

Event: {{eventName}}
Date: {{eventDate}}
Registration Type: {{ticketType}}
Amount Due: {{amount}}

{{paymentBlock}}

If you have already made the payment, please disregard this email.`,
  },

  // ── Webinar sequence ──────────────────────────────────────────────────────
  {
    slug: "webinar-confirmation",
    name: "Webinar Registration Confirmation",
    subject: "You're registered for {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>You're confirmed for <strong>{{eventName}}</strong>. Save this email — it contains your join link.</p>
    <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #bae6fd;">
      <h3 style="margin-top: 0; color: #075985;">Webinar Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{webinarDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Time:</td><td style="padding: 8px 0; font-weight: 500;">{{webinarTime}}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">Join Webinar</a>
    </div>
    {{passcodeBlock}}
    <p style="color: #6b7280; font-size: 13px;">You can join up to 15 minutes before the scheduled start time. We'll also send you reminders 24 hours and 1 hour before the webinar begins.</p>
    <p style="margin-bottom: 0;">See you online!</p>
  </div>`,
    textContent: `You're registered for {{eventName}}

Dear {{title}} {{lastName}},

You're confirmed for {{eventName}}.

Date: {{webinarDate}}
Time: {{webinarTime}}

Join link: {{joinUrl}}
{{passcodeBlock}}

You can join up to 15 minutes before the scheduled start time. We'll send reminders 24 hours and 1 hour before the webinar begins.`,
  },

  {
    slug: "webinar-reminder-24h",
    name: "Webinar Reminder — 24 hours",
    subject: "Tomorrow: {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{firstName}}</strong>,</p>
    <p>Just a reminder that <strong>{{eventName}}</strong> starts tomorrow.</p>
    <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #bae6fd;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{webinarDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Time:</td><td style="padding: 8px 0; font-weight: 500;">{{webinarTime}}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">Save Join Link</a>
    </div>
    {{passcodeBlock}}
    <p style="color: #6b7280; font-size: 13px;">Add it to your calendar so you don't miss it.</p>
  </div>`,
    textContent: `Tomorrow: {{eventName}}

Hi {{firstName}},

Just a reminder that {{eventName}} starts tomorrow.

Date: {{webinarDate}}
Time: {{webinarTime}}

Join link: {{joinUrl}}
{{passcodeBlock}}`,
  },

  {
    slug: "webinar-reminder-1h",
    name: "Webinar Reminder — 1 hour",
    subject: "Starting in 1 hour: {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{firstName}}</strong>,</p>
    <p><strong>{{eventName}}</strong> starts in about 1 hour. Get ready!</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">Join Webinar</a>
    </div>
    {{passcodeBlock}}
    <p style="color: #6b7280; font-size: 13px;">Doors open 15 minutes before the scheduled start. See you there.</p>
  </div>`,
    textContent: `Starting in 1 hour: {{eventName}}

Hi {{firstName}},

{{eventName}} starts in about 1 hour. Get ready!

Join link: {{joinUrl}}
{{passcodeBlock}}

Doors open 15 minutes before the scheduled start.`,
  },

  {
    slug: "webinar-live-now",
    name: "Webinar Live Now",
    subject: "We're live: {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{firstName}}</strong>,</p>
    <p><strong>{{eventName}}</strong> is starting now. Click below to join.</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #dc2626; color: #ffffff; padding: 16px 40px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 18px;">Join Now</a>
    </div>
    {{passcodeBlock}}
  </div>`,
    textContent: `We're live: {{eventName}}

Hi {{firstName}},

{{eventName}} is starting now.

Join now: {{joinUrl}}
{{passcodeBlock}}`,
  },

  {
    slug: "webinar-thank-you",
    name: "Webinar Thank You",
    subject: "Thank you for joining {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Thank you for joining <strong>{{eventName}}</strong>. We hope you found it valuable.</p>
    {{recordingBlock}}
    <p>If you have any feedback, we'd love to hear from you.</p>
    <p style="margin-bottom: 0;">See you at the next one!</p>
  </div>`,
    textContent: `Thank you for joining {{eventName}}

Dear {{title}} {{lastName}},

Thank you for joining {{eventName}}. We hope you found it valuable.

{{recordingBlock}}

If you have any feedback, we'd love to hear from you.`,
  },

  {
    slug: "webinar-panelist-invitation",
    name: "Webinar Panelist Invitation",
    subject: "You're a panelist for {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{panelistName}}</strong>,</p>
    <p>You've been added as a panelist for <strong>{{eventName}}</strong>.</p>
    <p>As a panelist you can present, share your screen, unmute, and answer attendee Q&amp;A. Use the privileged link below to join &mdash; <em>please don't share it</em>.</p>
    <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #bae6fd;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Session:</td><td style="padding: 8px 0; font-weight: 500;">{{sessionName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Starts:</td><td style="padding: 8px 0; font-weight: 500;">{{sessionStart}}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">Join as Panelist</a>
    </div>
    <p style="color: #6b7280; font-size: 12px; word-break: break-all;">
      If the button doesn't work, paste this URL into your browser: <a href="{{joinUrl}}" style="color: #0284c7;">{{joinUrl}}</a>
    </p>
    {{organizerSignature}}
  </div>`,
    textContent: `You're a panelist for {{eventName}}

Hi {{panelistName}},

You've been added as a panelist for {{eventName}}.

As a panelist you can present, share your screen, unmute, and answer attendee Q&A. Use the privileged link below to join — please don't share it.

Session: {{sessionName}}
Starts:  {{sessionStart}}

Join as panelist: {{joinUrl}}

{{organizerSignature}}`,
  },

  {
    slug: "survey-invitation",
    name: "Survey Invitation",
    // Cert-neutral default — does NOT promise certificate delivery
    // because the survey is only gated for CME events, not every
    // ATTENDANCE cert. CME-required events override per-event with
    // their own cert-delivery language via the template editor.
    subject: "How was {{eventName}}? Quick feedback survey",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for attending <strong>{{eventName}}</strong>. We&apos;d love your feedback — it takes about 2–3 minutes and helps us improve future events.</p>
    {{personalMessage}}
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{surveyLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">Take the survey</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; margin: 0 0 0 0;">Or copy this link into your browser:<br><span style="word-break: break-all; color: #00aade;">{{surveyLink}}</span></p>
    <p style="color: #6b7280; font-size: 13px;">This link expires in 7 days and is for your use only.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
    {{organizerSignature}}
  </div>`,
    textContent: `How was {{eventName}}?

Dear {{firstName}},

Thank you for attending {{eventName}}. We'd love your feedback — it takes about 2-3 minutes and helps us improve future events.

{{personalMessage}}

Take the survey: {{surveyLink}}

This link expires in 7 days and is for your use only.

Best regards,
{{organizerName}}

{{organizerSignature}}`,
  },

  {
    slug: "survey-thankyou",
    name: "Survey Thank You",
    // Sent automatically by the public POST handler immediately on
    // successful submit. Also cert-neutral by default — CME events
    // override to add their cert-delivery language.
    subject: "Thank you for your feedback — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for completing the post-event survey for <strong>{{eventName}}</strong>. Your feedback has been recorded and will help us shape future events.</p>
    <p style="margin-bottom: 0;">— The {{eventName}} team</p>
  </div>`,
    textContent: `Thank you for your feedback — {{eventName}}

Dear {{firstName}},

Thank you for completing the post-event survey for {{eventName}}. Your feedback has been recorded and will help us shape future events.

— The {{eventName}} team`,
  },
];

// ── Helper to get a default template by slug ───────────────────────────────────

export function getDefaultTemplate(slug: string): DefaultTemplate | undefined {
  return DEFAULT_TEMPLATES.find((t) => t.slug === slug);
}

// ── Abstract status helpers ────────────────────────────────────────────────────

export function getAbstractStatusInfo(status: string): { heading: string; message: string } {
  const map: Record<string, { heading: string; message: string }> = {
    UNDER_REVIEW: {
      heading: "Abstract Under Review",
      message: "Your abstract is now being reviewed by our committee. We will notify you once a decision has been made.",
    },
    ACCEPTED: {
      heading: "Abstract Accepted!",
      message: "Congratulations! Your abstract has been accepted. We look forward to your presentation.",
    },
    REJECTED: {
      heading: "Abstract Decision",
      message: "Thank you for your submission. After careful review, we are unable to accept your abstract for this event.",
    },
    REVISION_REQUESTED: {
      heading: "Revision Requested",
      message: "The review committee has requested revisions to your abstract. Please update your submission using the link below.",
    },
  };
  return map[status] || { heading: "Abstract Status Update", message: `Your abstract status has been updated to: ${status}.` };
}

// ── System-level templates (not per-event, stay hardcoded) ─────────────────────

export const systemTemplates = {
  userInvitation: (params: {
    recipientName: string;
    recipientEmail: string;
    organizationName: string;
    inviterName: string;
    role: string;
    setupLink: string;
    expiresIn?: string;
  }) => {
    const bodyHtml = `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">You're Invited!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">Join ${escapeHtml(params.organizationName)} on MMGroup EventsHub</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p><strong>${escapeHtml(params.inviterName)}</strong> has invited you to join <strong>${escapeHtml(params.organizationName)}</strong> on MMGroup EventsHub as a <strong>${escapeHtml(params.role)}</strong>.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Invitation Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Organization:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.organizationName)}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Your Role:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.role)}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Your Email:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.recipientEmail)}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${escapeHtml(params.setupLink)}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Accept Invitation & Set Password</a>
    </div>
    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This invitation will expire in ${escapeHtml(params.expiresIn)}.</p>` : ""}
    <p style="color: #6b7280; font-size: 14px;">If you didn't expect this invitation, you can safely ignore this email.</p>
  </div>`;
    return {
      subject: `You've been invited to join ${params.organizationName}`,
      htmlContent: inlineCss(wrapWithBranding(bodyHtml, { eventName: params.organizationName })),
      textContent: `You've been invited to join ${params.organizationName}

Hi ${params.recipientName},

${params.inviterName} has invited you to join ${params.organizationName} on MMGroup EventsHub as a ${params.role}.

Accept Invitation & Set Password: ${params.setupLink}

${params.expiresIn ? `Note: This invitation will expire in ${params.expiresIn}.` : ""}`,
    };
  },

  passwordReset: (params: {
    recipientName: string;
    resetLink: string;
    expiresIn?: string;
  }) => {
    const bodyHtml = `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Reset Your Password</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">We received a request to reset your password.</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p>Use the button below to set a new password for your MMGroup EventsHub account.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${escapeHtml(params.resetLink)}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Reset Password</a>
    </div>
    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This reset link will expire in ${escapeHtml(params.expiresIn)}.</p>` : ""}
    <p style="color: #6b7280; font-size: 14px;">If you did not request a password reset, you can safely ignore this email.</p>
  </div>`;
    return {
      subject: "Reset your EventsHub password",
      htmlContent: inlineCss(wrapWithBranding(bodyHtml, {})),
      textContent: `Reset your EventsHub password

Hi ${params.recipientName},

Use the link below to set a new password: ${params.resetLink}

${params.expiresIn ? `Note: This reset link will expire in ${params.expiresIn}.` : ""}`,
    };
  },

  registrationCompletion: (params: {
    recipientName: string;
    recipientEmail: string;
    eventName: string;
    eventDate: string;
    eventVenue: string;
    completionLink: string;
    expiresIn?: string;
  }) => {
    const bodyHtml = `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Complete Your Registration</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">${escapeHtml(params.eventName)}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p>You have been registered for <strong>${escapeHtml(params.eventName)}</strong>. Please complete your registration by filling in the remaining details and setting up your account.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.eventName)}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.eventDate)}</td></tr>
        ${params.eventVenue ? `<tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.eventVenue)}</td></tr>` : ""}
      </table>
    </div>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${escapeHtml(params.completionLink)}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Complete Your Registration</a>
    </div>
    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This link will expire in ${escapeHtml(params.expiresIn)}.</p>` : ""}
    <p style="color: #6b7280; font-size: 14px;">If you did not expect this email, you can safely ignore it.</p>
  </div>`;
    return {
      subject: `Complete your registration for ${params.eventName}`,
      htmlContent: inlineCss(wrapWithBranding(bodyHtml, { eventName: params.eventName })),
      textContent: `Complete your registration for ${params.eventName}

Hi ${params.recipientName},

You have been registered for ${params.eventName}. Please complete your registration by visiting the link below.

Event: ${params.eventName}
Date: ${params.eventDate}
${params.eventVenue ? `Venue: ${params.eventVenue}` : ""}

Complete Your Registration: ${params.completionLink}

${params.expiresIn ? `Note: This link will expire in ${params.expiresIn}.` : ""}`,
    };
  },
};

// ── Legacy compatibility: emailTemplates ───────────────────────────────────────
// Keep the old API working during transition. All callers will be migrated to
// use DB templates with renderTemplate().

export const emailTemplates = {
  userInvitation: (params: Parameters<typeof systemTemplates.userInvitation>[0]) =>
    systemTemplates.userInvitation(params),
  passwordReset: (params: Parameters<typeof systemTemplates.passwordReset>[0]) =>
    systemTemplates.passwordReset(params),
  registrationCompletion: (params: Parameters<typeof systemTemplates.registrationCompletion>[0]) =>
    systemTemplates.registrationCompletion(params),
};

// ── Sample preview variables for email template preview ──────────────────────

export function getSamplePreviewVariables(
  overrides?: Partial<Record<string, string | number>>
): Record<string, string | number> {
  return {
    // Formatted title prefix (e.g. "Dr."). Matches the {{title}} convention
    // used by every send-site — getTitleLabel(enum) returns this exact shape.
    title: "Dr.",
    firstName: "John",
    lastName: "Doe",
    eventName: "Sample Conference 2026",
    eventDate: "Monday, March 15, 2026",
    eventVenue: "Convention Center, Dubai",
    eventAddress: "123 Main Street",
    ticketType: "VIP Pass",
    registrationId: "ABCD1234",
    organizerName: "Event Organizer",
    organizerEmail: "organizer@example.com",
    personalMessage: "We're excited to have you!",
    sessionDetails: "Opening Keynote - Main Hall",
    agreementLink: "#",
    abstractTitle: "Sample Abstract Title",
    newStatus: "ACCEPTED",
    statusHeading: "Abstract Accepted!",
    statusMessage: "Congratulations! Your abstract has been accepted.",
    reviewNotes: "Excellent work. Well-structured and relevant.",
    reviewScore: 9,
    managementLink: "#",
    loginLink: "#",
    daysUntilEvent: 7,
    subject: "Custom Subject",
    message: "This is a custom message body.",
    ctaText: "Click Here",
    ctaLink: "#",
    amount: "USD 100.00",
    currency: "USD",
    paymentDate: "Monday, March 1, 2026",
    receiptUrl: "#",
    refundDate: "Monday, March 5, 2026",
    paymentBlock: "",
    ...overrides,
  };
}

/** Minimal event shape `buildEventPreviewVariables` needs (a Prisma `select`). */
export interface PreviewEventData {
  name: string;
  startDate: Date;
  endDate?: Date | null;
  venue?: string | null;
  address?: string | null;
  city?: string | null;
  timezone?: string | null;
  supportEmail?: string | null;
  organization?: { name: string } | null;
  ticketTypes?: { name: string }[] | null;
  /**
   * Up to one representative registration so {{registrationId}} reflects a
   * real confirmation number (padded serial, same shape a real send uses).
   * When the event has no registrations yet, the builder falls back to the
   * static "9999" placeholder.
   */
  registrations?: { id: string; serialId: number | null }[] | null;
}

interface PreviewUserData {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

/**
 * Build template-preview / test-email variables from REAL event data, so a
 * preview or test reflects the actual event (name, dates, venue, organizer,
 * ticket type) instead of "Sample Conference 2026". Event-level fields come
 * from the event; the greeting (firstName/lastName) uses the recipient (the
 * test goes to the signed-in user); deeply entity-specific fields
 * (abstractTitle, reviewNotes, amounts) stay as the sample placeholders since
 * a generic preview isn't tied to a specific attendee/abstract. `extra`
 * overrides win last (e.g. customSubject/customMessage from the bulk preview).
 */
export function buildEventPreviewVariables(
  event: PreviewEventData,
  user: PreviewUserData,
  extra?: Partial<Record<string, string | number>>,
): Record<string, string | number> {
  const tz = event.timezone ?? null;
  const start = formatDateInTz(event.startDate, tz ?? "");
  const multiDay =
    event.endDate != null &&
    formatDateInTz(event.endDate, tz ?? "") !== start;
  const eventDate = multiDay
    ? `${start} – ${formatDateInTz(event.endDate as Date, tz ?? "")}`
    : start;
  const daysUntilEvent = Math.max(
    0,
    Math.ceil((event.startDate.getTime() - Date.now()) / 86_400_000),
  );

  // Confirmation number from a real registration, formatted the same way a
  // real send does (padded serial, else last-8 of the id). No registrations
  // yet → static "9999" placeholder.
  const reg = event.registrations?.[0];
  const registrationId = reg
    ? reg.serialId != null
      ? String(reg.serialId).padStart(3, "0")
      : reg.id.slice(-8).toUpperCase()
    : "9999";

  const realOverrides: Partial<Record<string, string | number>> = {
    registrationId,
    eventName: event.name,
    eventDate,
    eventVenue: event.venue || "",
    eventAddress: [event.address, event.city].filter(Boolean).join(", "),
    organizerName:
      event.organization?.name ||
      `${user.firstName || "Event"} ${user.lastName || "Organizer"}`.trim(),
    organizerEmail: event.supportEmail || user.email || "organizer@example.com",
    daysUntilEvent,
    // Greet the actual recipient (the test goes to the signed-in user).
    ...(user.firstName ? { firstName: user.firstName } : {}),
    ...(user.lastName ? { lastName: user.lastName } : {}),
    // First real registration type, if the event has one.
    ...(event.ticketTypes?.[0]?.name ? { ticketType: event.ticketTypes[0].name } : {}),
  };

  return getSamplePreviewVariables({ ...realOverrides, ...extra });
}

// ── Helper to load event template from DB (with fallback to default) ───────────

export async function getEventTemplate(
  eventId: string,
  slug: string
): Promise<{ subject: string; htmlContent: string; textContent: string; branding: EmailBranding } | null> {
  // Lazy import to avoid circular dependency (db → logger → email)
  const { db } = await import("./db");

  const [dbTemplate, event] = await Promise.all([
    db.emailTemplate.findUnique({
      where: { eventId_slug: { eventId, slug } },
      select: { subject: true, htmlContent: true, textContent: true, isActive: true },
    }),
    db.event.findFirst({
      where: { id: eventId },
      select: {
        emailHeaderImage: true,
        emailFooterImage: true,
        emailFooterHtml: true,
        emailFromAddress: true,
        emailFromName: true,
        emailCcAddresses: true,
        name: true,
      },
    }),
  ]);

  const branding: EmailBranding = {
    emailHeaderImage: event?.emailHeaderImage,
    emailFooterImage: event?.emailFooterImage,
    emailFooterHtml: event?.emailFooterHtml,
    emailFromAddress: event?.emailFromAddress,
    emailFromName: event?.emailFromName,
    emailCcAddresses: event?.emailCcAddresses ?? [],
    eventName: event?.name,
  };

  if (dbTemplate && !dbTemplate.isActive) {
    apiLogger.info({ msg: "Email template is disabled, falling back to default", eventId, slug });
  }

  if (dbTemplate?.isActive) {
    return {
      subject: dbTemplate.subject,
      htmlContent: dbTemplate.htmlContent,
      textContent: dbTemplate.textContent || "",
      branding,
    };
  }

  // Fallback to default template
  const def = getDefaultTemplate(slug);
  if (!def) {
    apiLogger.error({ msg: "No default email template found for slug", slug, eventId });
    return null;
  }

  return { subject: def.subject, htmlContent: def.htmlContent, textContent: def.textContent, branding };
}

/**
 * Render a template with variables and wrap with branding.
 * This is the main function for preparing email HTML for sending.
 */
export function renderAndWrap(
  template: { subject: string; htmlContent: string; textContent: string },
  variables: Record<string, string | number | undefined>,
  branding: EmailBranding,
  rawHtmlKeys?: Set<string>
): { subject: string; htmlContent: string; textContent: string } {
  const subject = renderTemplatePlain(template.subject, variables);
  const bodyHtml = renderTemplate(template.htmlContent, variables, rawHtmlKeys);
  const wrapped = wrapWithBranding(bodyHtml, branding);
  const htmlContent = inlineCss(wrapped);
  const textContent = renderTemplatePlain(template.textContent, variables);
  return { subject, htmlContent, textContent };
}

/**
 * Extract the `from` override from branding (if the event has a custom sender).
 */
export function brandingFrom(branding: EmailBranding): SendEmailParams["from"] {
  if (branding.emailFromAddress) {
    return { email: branding.emailFromAddress, name: branding.emailFromName || undefined };
  }
  return undefined;
}

/**
 * Build the CC list (event-level + per-recipient).
 *
 * Two independent sources are merged:
 *   1. **Event-level auto-CC** — `branding.emailCcAddresses`, set by
 *      organizers in Event Settings. Optional. Typically used for
 *      org-level observers (ops/admin inbox).
 *   2. **Per-recipient additional emails** — passed via the third
 *      argument. Sourced from `Attendee.additionalEmail` /
 *      `Speaker.additionalEmail` — the registrant/speaker's own
 *      backup or secretary inbox that they provided at signup.
 *
 * Both lists are independently optional. If both are empty (or fully
 * deduped against the primary recipient) the helper returns
 * `undefined` so the spread is a no-op.
 *
 * The `exclude` set (typically the primary `to` recipient) is removed
 * from both sources so an organizer who lists their own email as
 * both registrant and CC, or whose `additionalEmail` matches their
 * primary, doesn't receive a duplicate copy.
 *
 * Returned addresses are trim+lowercased; the merged list is
 * deduplicated case-insensitively across both sources.
 *
 * Usage:
 *   await sendEmail({
 *     to: [{ email: attendee.email }],
 *     cc: brandingCc(branding,
 *                    [{ email: attendee.email }],
 *                    [attendee.additionalEmail]),
 *     ...rendered,
 *   });
 */
export function brandingCc(
  branding: EmailBranding,
  exclude?: { email: string }[],
  additionalEmails?: (string | null | undefined)[]
): SendEmailParams["cc"] {
  const excludeSet = new Set((exclude ?? []).map((r) => r.email.trim().toLowerCase()));

  const seen = new Set<string>();
  const cc: { email: string }[] = [];

  // Event-level CC first so the order is stable across renders.
  for (const raw of branding.emailCcAddresses ?? []) {
    const e = raw.trim().toLowerCase();
    if (!e || excludeSet.has(e) || seen.has(e)) continue;
    seen.add(e);
    cc.push({ email: e });
  }

  // Per-recipient additionals — null/undefined/empty entries silently
  // dropped so callers can pass nullable schema fields without first
  // filtering.
  for (const raw of additionalEmails ?? []) {
    if (!raw) continue;
    const e = raw.trim().toLowerCase();
    if (!e || excludeSet.has(e) || seen.has(e)) continue;
    seen.add(e);
    cc.push({ email: e });
  }

  return cc.length > 0 ? cc : undefined;
}

// ── Helper function to send registration confirmation ──────────────────────────

export async function sendRegistrationConfirmation(params: {
  to: string;
  /**
   * Registrant's secondary inbox (Attendee.additionalEmail). Auto-CC'd
   * on this confirmation when present. Independent of the event-level
   * `Event.emailCcAddresses` list.
   */
  additionalEmail?: string | null;
  firstName: string;
  lastName?: string;
  title?: string | null;
  organization?: string | null;
  eventName: string;
  eventDate: Date;
  eventVenue: string;
  eventCity: string;
  ticketType: string;
  pricingTierName?: string | null;
  registrationId: string;
  serialId?: number | null;
  qrCode: string;
  /**
   * venue vs online. VIRTUAL ⇒ the entry-barcode block is replaced with a
   * "joining instructions will be sent" message (a virtual registration also
   * has no qrCode, so the barcode block self-skips anyway). Defaults IN_PERSON.
   */
  attendanceMode?: "IN_PERSON" | "VIRTUAL";
  eventId?: string;
  /**
   * Organization that owns the event. Threaded into the EmailLog row's
   * `organizationId` column so the Email History card on the
   * registration detail sheet can find it. Without this, the row is
   * written with organizationId=null and gets filtered out by the
   * read query (see src/lib/email-log.ts getEmailLogsFor history note).
   */
  organizationId?: string | null;
  eventSlug?: string;
  ticketPrice?: number;
  ticketCurrency?: string;
  taxRate?: number | null;
  taxLabel?: string | null;
  bankDetails?: string | null;
  supportEmail?: string | null;
  // Issuing organization (company block + logo for the quote PDF attachment)
  organizationName?: string;
  companyName?: string | null;
  companyAddress?: string | null;
  companyCity?: string | null;
  companyState?: string | null;
  companyZipCode?: string | null;
  companyCountry?: string | null;
  taxId?: string | null;
  logoPath?: string | null;
  // Bill-to extras
  jobTitle?: string | null;
  billingFirstName?: string | null;
  billingLastName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZipCode?: string | null;
  billingCountry?: string | null;
  taxNumber?: string | null;
}) {
  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(params.eventDate));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";
  const paymentLink = params.eventSlug
    ? `${appUrl}/e/${params.eventSlug}/confirmation?id=${params.registrationId}&name=${encodeURIComponent(params.firstName)}&price=${params.ticketPrice ?? 0}&currency=${params.ticketCurrency ?? "USD"}`
    : "";

  // Build payment block for paid tickets (HTML + plain text versions)
  let paymentBlock = "";
  let paymentBlockText = "";
  if (params.ticketPrice && params.ticketPrice > 0) {
    const currency = params.ticketCurrency || "USD";
    const baseAmount = Number(params.ticketPrice);
    const taxRate = params.taxRate ? Number(params.taxRate) : 0;
    const taxAmount = taxRate > 0 ? baseAmount * (taxRate / 100) : 0;
    const totalAmount = baseAmount + taxAmount;
    const taxLabel = params.taxLabel || "Tax";

    let amountLine = "";
    let amountLineText = "";
    if (taxRate > 0) {
      amountLine = `<p style="margin: 0 0 4px 0; font-size: 14px; color: #78350f;">Subtotal: ${escapeHtml(currency)} ${baseAmount.toFixed(2)}</p>
      <p style="margin: 0 0 4px 0; font-size: 14px; color: #78350f;">${escapeHtml(taxLabel)} (${taxRate}%): ${escapeHtml(currency)} ${taxAmount.toFixed(2)}</p>
      <p style="margin: 0 0 12px 0; font-size: 14px; color: #78350f;"><strong>Total: ${escapeHtml(currency)} ${totalAmount.toFixed(2)}</strong></p>`;
      amountLineText = `Subtotal: ${currency} ${baseAmount.toFixed(2)}\n${taxLabel} (${taxRate}%): ${currency} ${taxAmount.toFixed(2)}\nTotal: ${currency} ${totalAmount.toFixed(2)}`;
    } else {
      amountLine = `<p style="margin: 0 0 12px 0; font-size: 14px; color: #78350f;">Amount due: <strong>${escapeHtml(currency)} ${baseAmount.toFixed(2)}</strong></p>`;
      amountLineText = `Amount due: ${currency} ${baseAmount.toFixed(2)}`;
    }

    paymentBlock = `<div style="background: #fef3c7; padding: 16px 20px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
      <p style="margin: 0 0 8px 0; font-weight: 600; color: #92400e;">Payment Pending</p>
      ${amountLine}
      <a href="${escapeHtml(paymentLink)}" style="display: inline-block; background: #00aade; color: white; padding: 10px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px;">Pay Now</a>
      <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">You can also pay later using this link anytime.</p>
    </div>`;
    paymentBlockText = `Payment Pending\n${amountLineText}\nPay Now: ${paymentLink}`;
  }

  const vars: Record<string, string | number | undefined> = {
    // Title rendered as the formatted prefix ("Dr.", "Prof.", "Mr.", etc.) —
    // empty string when null/unknown so the {{title}} placeholder collapses
    // cleanly. Callers pass the raw Title enum ("DR", "PROF") and we
    // normalize here via getTitleLabel — single source of truth for the
    // enum→display mapping across every send-site.
    title: getTitleLabel(params.title),
    firstName: params.firstName,
    lastName: params.lastName ?? "",
    eventName: params.eventName,
    eventDate,
    eventVenue: [params.eventVenue, params.eventCity].filter(Boolean).join(", "),
    ticketType: params.ticketType,
    registrationId: params.serialId != null
      ? String(params.serialId).padStart(3, "0")
      : params.registrationId,
    paymentBlock,
  };

  // Try DB template first, fall back to default
  let tpl: { subject: string; htmlContent: string; textContent: string; branding: EmailBranding } | null = null;

  if (params.eventId) {
    tpl = await getEventTemplate(params.eventId, "registration-confirmation");
  }

  const branding = tpl?.branding || { eventName: params.eventName };
  const template = tpl || getDefaultTemplate("registration-confirmation");

  if (!template) {
    apiLogger.error({ msg: "No registration-confirmation template found" });
    return { success: false, error: "Email template not found" };
  }

  // Entry barcode — embedded INLINE (cid:reg-barcode) so it renders offline
  // in the recipient's inbox and stays scannable at the registration desk
  // even months later, with no auth and no remote fetch. Rendered from the
  // immutable qrCode via the same helper the badge uses (includetext so the
  // digits sit under the bars). Failure is non-fatal — the email still sends
  // without the barcode, and the badge/portal remain as fallbacks.
  const isVirtual = params.attendanceMode === "VIRTUAL";

  let barcodeAttachment: NonNullable<SendEmailParams["attachments"]>[number] | null = null;
  let barcodeBlock = "";
  let barcodeBlockText = "";
  // Virtual attendees get a "joining instructions coming" note instead of a
  // barcode. (A virtual registration also has no qrCode, so the block below
  // self-skips — this is belt-and-braces in case a qrCode is ever present.)
  if (isVirtual) {
    barcodeBlock = `<div style="text-align:center; margin:24px 0; padding:16px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px;">
        <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.05em; color:#0369a1; font-weight:600;">VIRTUAL ATTENDANCE</p>
        <p style="margin:0; font-size:14px; color:#0c4a6e;">You're registered to attend online. <strong>Joining instructions and your access link will be sent to you closer to the event.</strong></p>
      </div>`;
    barcodeBlockText = `\n\nVirtual attendance: You're registered to attend online. Joining instructions and your access link will be sent to you closer to the event.`;
  } else if (params.qrCode) {
    try {
      const png = await renderBarcodePng(params.qrCode, { includetext: true });
      barcodeAttachment = {
        name: "entry-barcode.png",
        content: png.toString("base64"),
        contentType: "image/png",
        contentId: "reg-barcode",
      };
      barcodeBlock = `<div style="text-align:center; margin:24px 0; padding:16px; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px;">
        <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.05em; color:#6b7280; font-weight:600;">YOUR ENTRY BARCODE</p>
        <img src="cid:reg-barcode" alt="Entry barcode" style="display:block; margin:0 auto; max-width:280px; height:auto;" />
        <p style="margin:10px 0 0; font-size:12px; color:#6b7280;">Show this at the registration desk for check-in.</p>
      </div>`;
      barcodeBlockText = `\n\nYour entry barcode: ${params.qrCode}\nShow this at the registration desk for check-in.`;
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to render entry barcode for confirmation email", registrationId: params.registrationId });
    }
  }

  // Render HTML with raw paymentBlock (contains HTML), text with plain text
  // version. The barcode block is appended after the template body so it
  // shows regardless of whether a DB-overridden template includes a
  // placeholder for it.
  const subject = renderTemplatePlain(template.subject, vars);
  const bodyHtml = renderTemplate(template.htmlContent, vars, new Set(["paymentBlock"])) + barcodeBlock;
  const wrapped = wrapWithBranding(bodyHtml, branding);
  const htmlContent = inlineCss(wrapped);
  const textVars = { ...vars, paymentBlock: paymentBlockText };
  const textContent = renderTemplatePlain(template.textContent, textVars) + barcodeBlockText;

  // Attachments: inline barcode (if rendered) + quote PDF for paid tickets.
  const attachments: NonNullable<SendEmailParams["attachments"]> = [];
  if (barcodeAttachment) attachments.push(barcodeAttachment);
  if (params.ticketPrice && params.ticketPrice > 0 && params.organizationName) {
    try {
      const { generateQuotePDF } = await import("@/lib/quote-pdf");
      const pdfBuffer = await generateQuotePDF({
        quoteNumber: params.registrationId.toUpperCase().slice(-8),
        date: new Date(),
        eventName: params.eventName,
        eventDate: params.eventDate,
        eventVenue: params.eventVenue || null,
        eventCity: params.eventCity || null,
        firstName: params.firstName,
        lastName: params.lastName || "",
        email: params.to,
        organization: params.organization || null,
        title: params.title || null,
        jobTitle: params.jobTitle || null,
        billingFirstName: params.billingFirstName || null,
        billingLastName: params.billingLastName || null,
        billingEmail: params.billingEmail || null,
        billingPhone: params.billingPhone || null,
        billingAddress: params.billingAddress || null,
        billingCity: params.billingCity || null,
        billingState: params.billingState || null,
        billingZipCode: params.billingZipCode || null,
        billingCountry: params.billingCountry || null,
        taxNumber: params.taxNumber || null,
        registrationType: params.ticketType,
        pricingTier: params.pricingTierName || null,
        price: params.ticketPrice,
        currency: params.ticketCurrency || "USD",
        taxRate: params.taxRate || null,
        taxLabel: params.taxLabel || "VAT",
        bankDetails: params.bankDetails || null,
        supportEmail: params.supportEmail || null,
        organizationName: params.organizationName ?? "",
        companyName: params.companyName || null,
        companyAddress: params.companyAddress || null,
        companyCity: params.companyCity || null,
        companyState: params.companyState || null,
        companyZipCode: params.companyZipCode || null,
        companyCountry: params.companyCountry || null,
        taxId: params.taxId || null,
        logoPath: params.logoPath || null,
      });
      attachments.push({
        name: `quote-${params.registrationId.slice(-8)}.pdf`,
        content: pdfBuffer.toString("base64"),
        contentType: "application/pdf",
      });
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to generate quote PDF for email attachment" });
    }
  }

  return sendEmail({
    to: [{ email: params.to, name: params.firstName }],
    cc: brandingCc(branding, [{ email: params.to }], [params.additionalEmail]),
    subject,
    htmlContent,
    textContent,
    from: brandingFrom(branding),
    // Empty → undefined so a barcode-less, quote-less confirmation still
    // uses SES's Simple content path instead of raw MIME.
    attachments: attachments.length ? attachments : undefined,
    emailType: "registration_confirmation",
    stream: "transactional",
    logContext: {
      organizationId: params.organizationId ?? null,
      eventId: params.eventId ?? null,
      entityType: "REGISTRATION",
      entityId: params.registrationId,
      templateSlug: "registration-confirmation",
    },
  });
}
