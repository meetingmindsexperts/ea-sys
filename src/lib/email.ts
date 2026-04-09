import {
  TransactionalEmailsApi,
  TransactionalEmailsApiApiKeys,
  SendSmtpEmail,
} from "@getbrevo/brevo";
import sgMail from "@sendgrid/mail";
import juice from "juice";
import { apiLogger } from "./logger";

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
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
  from?: { email: string; name?: string };
  attachments?: Array<{
    name: string;
    content: string; // Base64 encoded
    contentType?: string;
  }>;
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

// ── Brevo provider (current) ───────────────────────────────────────────────────

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

// ── SendGrid provider ─────────────────────────────────────────────────────────

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

// ── Provider selection ─────────────────────────────────────────────────────────

function getProvider(): EmailProvider {
  const provider = process.env.EMAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? "sendgrid" : "brevo");
  if (provider === "sendgrid") return sendGridProvider;
  return brevoProvider;
}

// ── Main send function ─────────────────────────────────────────────────────────

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!process.env.BREVO_API_KEY && !process.env.SENDGRID_API_KEY) {
    apiLogger.warn({ msg: "No email provider configured (BREVO_API_KEY or SENDGRID_API_KEY), skipping email send" });
    return { success: false, error: "Email service not configured" };
  }

  try {
    const result = await getProvider().send(params);

    apiLogger.info({
      msg: "Email sent successfully",
      to: params.to.map((r) => r.email),
      subject: params.subject,
      messageId: result.messageId,
    });

    return result;
  } catch (error) {
    apiLogger.error({
      msg: "Failed to send email",
      error: error instanceof Error ? error.message : "Unknown error",
      to: params.to.map((r) => r.email),
      subject: params.subject,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}

// ── Template variable rendering ────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders with values, HTML-escaping all values.
 * Unmatched placeholders are left as-is.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | number | undefined>,
  rawHtmlKeys?: Set<string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) return `{{${key}}}`;
    if (rawHtmlKeys?.has(key)) return String(value);
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
  emailFooterHtml?: string | null;
  emailFromAddress?: string | null;
  emailFromName?: string | null;
  eventName?: string;
}

/**
 * Wrap body HTML content with a consistent email layout including header image
 * and footer. Uses table-based layout for email client compatibility.
 */
export function wrapWithBranding(bodyHtml: string, branding: EmailBranding): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://events.meetingmindsgroup.com";

  // Convert relative image URLs to absolute
  const headerSrc = branding.emailHeaderImage
    ? branding.emailHeaderImage.startsWith("http")
      ? branding.emailHeaderImage
      : `${appUrl}${branding.emailHeaderImage}`
    : null;

  const headerBlock = headerSrc
    ? `<tr><td style="padding: 0;">
        <img src="${escapeHtml(headerSrc)}" alt="${escapeHtml(branding.eventName || "Event")}" style="display: block; width: 100%; max-width: 600px; height: auto;" />
      </td></tr>`
    : "";

  const footerContent = branding.emailFooterHtml
    ? branding.emailFooterHtml
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
              ${bodyHtml}
            </td>
          </tr>
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
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "personalMessage", description: "Personal message from organizer" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
  ],
  "speaker-agreement": [
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "sessionDetails", description: "Session details" },
    { key: "agreementLink", description: "Agreement link URL" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
  ],
  "event-reminder": [
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventAddress", description: "Event address" },
    { key: "daysUntilEvent", description: "Number of days until event" },
  ],
  "abstract-submission-confirmation": [
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractTitle", description: "Abstract title" },
    { key: "managementLink", description: "Abstract management link" },
  ],
  "abstract-status-update": [
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
    { key: "firstName", description: "Submitter first name" },
    { key: "lastName", description: "Submitter last name" },
    { key: "eventName", description: "Event name" },
    { key: "loginLink", description: "Login page link" },
  ],
  "custom-notification": [
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "subject", description: "Email subject" },
    { key: "message", description: "Custom message body" },
    { key: "ctaText", description: "Call-to-action button text" },
    { key: "ctaLink", description: "Call-to-action button URL" },
  ],
  "payment-confirmation": [
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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your registration for <strong>{{eventName}}</strong> has been confirmed. We look forward to seeing you!</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Registration Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Confirmation #:</td><td style="padding: 8px 0; font-weight: 500; font-family: monospace;">{{registrationId}}</td></tr>
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

Dear {{firstName}},

Your registration for {{eventName}} has been confirmed.

Registration Details:
- Confirmation #: {{registrationId}}
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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>We would be honored to have you as a speaker at <strong>{{eventName}}</strong>!</p>
    {{personalMessage}}
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
  </div>`,
    textContent: `Speaker Invitation - {{eventName}}

Dear {{firstName}},

We would be honored to have you as a speaker at {{eventName}}!

{{personalMessage}}

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
    name: "Speaker Agreement",
    subject: "Speaker Agreement - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Speaker Agreement</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for agreeing to speak at <strong>{{eventName}}</strong>. We are excited to have you as part of our event!</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Please review and confirm the speaker agreement by clicking the button below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{agreementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">Review &amp; Accept Agreement</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; text-align: center;">This link is unique to you and will expire in 30 days.</p>
    <p>If you have any questions, please don&apos;t hesitate to reach out.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #00aade;">{{organizerEmail}}</a></p>
  </div>`,
    textContent: `Speaker Agreement - {{eventName}}

Dear {{firstName}},

Thank you for agreeing to speak at {{eventName}}.

Event Details:
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}

Please review and confirm the speaker agreement here:
{{agreementLink}}

This link is unique to you and will expire in 30 days.

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
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

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
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

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
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

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your account has been created successfully for <strong>{{eventName}}</strong>. You can now log in to submit your abstracts.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{loginLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Log In &amp; Submit Abstract</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you did not create this account, you can safely ignore this email.</p>
  </div>`,
    textContent: `Welcome to {{eventName}} - Account Created

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>This is a friendly reminder to submit your abstract for <strong>{{eventName}}</strong>.</p>
    <p>If you have already submitted, please check your dashboard for any updates or revision requests from the review committee.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstracts</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you have any questions, please contact the event organizer.</p>
  </div>`,
    textContent: `Abstract Submission Reminder - {{eventName}}

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <div style="white-space: pre-wrap;">{{message}}</div>
  </div>`,
    textContent: `{{subject}}

Dear {{firstName}},

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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for your payment. Here are your invoice details:</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Confirmation Number</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{registrationId}}</td></tr>
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

Dear {{firstName}},

Thank you for your payment. Here are your invoice details:

Confirmation Number: {{registrationId}}
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
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your payment has been refunded. Please allow 5–10 business days for the amount to appear on your statement.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #f9fafb; border-radius: 8px;">
      <tr><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Confirmation Number</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{registrationId}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Event</td><td style="padding: 10px 16px; font-weight: 600; text-align: right;">{{eventName}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Date</td><td style="padding: 10px 16px; text-align: right;">{{eventDate}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Registration Type</td><td style="padding: 10px 16px; text-align: right;">{{ticketType}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Amount Refunded</td><td style="padding: 10px 16px; font-weight: 700; font-size: 16px; text-align: right; color: #dc2626;">{{amount}}</td></tr>
      <tr style="border-top: 1px solid #e5e7eb;"><td style="padding: 10px 16px; color: #6b7280; font-size: 13px;">Refund Date</td><td style="padding: 10px 16px; text-align: right;">{{refundDate}}</td></tr>
    </table>
    <p style="color: #6b7280; font-size: 13px;">If you have any questions about this refund, please contact the event organizer.</p>
  </div>`,
    textContent: `Refund Processed — {{eventName}}

Dear {{firstName}},

Your payment has been refunded. Please allow 5–10 business days for the amount to appear on your statement.

Confirmation Number: {{registrationId}}
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
    <p>Dear <strong>{{firstName}}</strong>,</p>
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

Dear {{firstName}},

This is a friendly reminder that your registration payment is still pending. Please complete your payment to secure your spot.

Event: {{eventName}}
Date: {{eventDate}}
Registration Type: {{ticketType}}
Amount Due: {{amount}}

{{paymentBlock}}

If you have already made the payment, please disregard this email.`,
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
      select: { emailHeaderImage: true, emailFooterHtml: true, emailFromAddress: true, emailFromName: true, name: true },
    }),
  ]);

  const branding: EmailBranding = {
    emailHeaderImage: event?.emailHeaderImage,
    emailFooterHtml: event?.emailFooterHtml,
    emailFromAddress: event?.emailFromAddress,
    emailFromName: event?.emailFromName,
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

// ── Helper function to send registration confirmation ──────────────────────────

export async function sendRegistrationConfirmation(params: {
  to: string;
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
  eventId?: string;
  eventSlug?: string;
  ticketPrice?: number;
  ticketCurrency?: string;
  taxRate?: number | null;
  taxLabel?: string | null;
  bankDetails?: string | null;
  supportEmail?: string | null;
  organizationName?: string;
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
    firstName: params.firstName,
    lastName: "",
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

  // Render HTML with raw paymentBlock (contains HTML), text with plain text version
  const subject = renderTemplatePlain(template.subject, vars);
  const bodyHtml = renderTemplate(template.htmlContent, vars, new Set(["paymentBlock"]));
  const wrapped = wrapWithBranding(bodyHtml, branding);
  const htmlContent = inlineCss(wrapped);
  const textVars = { ...vars, paymentBlock: paymentBlockText };
  const textContent = renderTemplatePlain(template.textContent, textVars);

  // Generate quote PDF attachment if price > 0
  let attachments: SendEmailParams["attachments"];
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
        registrationType: params.ticketType,
        pricingTier: params.pricingTierName || null,
        price: params.ticketPrice,
        currency: params.ticketCurrency || "USD",
        taxRate: params.taxRate || null,
        taxLabel: params.taxLabel || "VAT",
        bankDetails: params.bankDetails || null,
        supportEmail: params.supportEmail || null,
        organizationName: params.organizationName,
      });
      attachments = [{
        name: `quote-${params.registrationId.slice(-8)}.pdf`,
        content: pdfBuffer.toString("base64"),
        contentType: "application/pdf",
      }];
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to generate quote PDF for email attachment" });
    }
  }

  return sendEmail({
    to: [{ email: params.to, name: params.firstName }],
    subject,
    htmlContent,
    textContent,
    from: brandingFrom(branding),
    attachments,
  });
}
