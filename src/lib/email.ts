import {
  TransactionalEmailsApi,
  TransactionalEmailsApiApiKeys,
  SendSmtpEmail,
} from "@getbrevo/brevo";
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
    sendSmtpEmail.sender = { email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME };
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

// ── Provider selection ─────────────────────────────────────────────────────────
// To switch to SendGrid or Resend, implement EmailProvider and select it here
// based on an environment variable like EMAIL_PROVIDER=sendgrid|resend|brevo.

function getProvider(): EmailProvider {
  // Future: check process.env.EMAIL_PROVIDER and return the right provider
  return brevoProvider;
}

// ── Main send function ─────────────────────────────────────────────────────────

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  if (!process.env.BREVO_API_KEY) {
    apiLogger.warn({ msg: "BREVO_API_KEY not configured, skipping email send" });
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
  variables: Record<string, string | number | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) return `{{${key}}}`;
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
};

// ── Default template HTML ──────────────────────────────────────────────────────

export interface DefaultTemplate {
  slug: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string;
}

const WRAPPER_START = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">`;

const WRAPPER_END = `
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding {{eventName}}</p>
  </div>
</body>
</html>`;

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    slug: "registration-confirmation",
    name: "Registration Confirmation",
    subject: "Registration Confirmed - {{eventName}}",
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Registration Confirmed!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your registration for <strong>{{eventName}}</strong> has been confirmed. We look forward to seeing you!</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Registration Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Confirmation #:</td><td style="padding: 8px 0; font-weight: 500; font-family: monospace;">{{registrationId}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Ticket Type:</td><td style="padding: 8px 0; font-weight: 500;">{{ticketType}}</td></tr>
      </table>
    </div>
    <p>If you have any questions, please don't hesitate to contact us.</p>
    <p style="margin-bottom: 0;">See you at the event!</p>
  </div>
${WRAPPER_END}`,
    textContent: `Registration Confirmed - {{eventName}}

Dear {{firstName}},

Your registration for {{eventName}} has been confirmed.

Registration Details:
- Confirmation #: {{registrationId}}
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}
- Ticket Type: {{ticketType}}

See you at the event!`,
  },

  {
    slug: "speaker-invitation",
    name: "Speaker Invitation",
    subject: "Speaker Invitation - {{eventName}}",
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">You're Invited to Speak!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>We would be honored to have you as a speaker at <strong>{{eventName}}</strong>!</p>
    {{personalMessage}}
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Please let us know if you're interested in speaking at our event. We look forward to hearing from you!</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #11998e;">{{organizerEmail}}</a></p>
  </div>
${WRAPPER_END}`,
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
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Speaker Agreement</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for agreeing to speak at <strong>{{eventName}}</strong>. We are excited to have you as part of our event!</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Event:</td><td style="padding: 8px 0; font-weight: 500;">{{eventName}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Please review and acknowledge the speaker agreement terms. By participating as a speaker, you agree to:</p>
    <ul style="color: #4b5563;">
      <li>Deliver your presentation as scheduled</li>
      <li>Provide presentation materials in advance if requested</li>
      <li>Allow the event to record and distribute your session (if applicable)</li>
      <li>Adhere to the event's code of conduct</li>
    </ul>
    <p>If you have any questions, please don't hesitate to reach out.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #667eea;">{{organizerEmail}}</a></p>
  </div>
${WRAPPER_END}`,
    textContent: `Speaker Agreement - {{eventName}}

Dear {{firstName}},

Thank you for agreeing to speak at {{eventName}}.

Event Details:
- Event: {{eventName}}
- Date: {{eventDate}}
- Venue: {{eventVenue}}

Best regards,
{{organizerName}}
{{organizerEmail}}`,
  },

  {
    slug: "event-reminder",
    name: "Event Reminder",
    subject: "Reminder: {{eventName}} is coming up!",
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">{{daysUntilEvent}} Days to Go!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>This is a friendly reminder that <strong>{{eventName}}</strong> is coming up in {{daysUntilEvent}} days!</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Date:</td><td style="padding: 8px 0; font-weight: 500;">{{eventDate}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Venue:</td><td style="padding: 8px 0; font-weight: 500;">{{eventVenue}}</td></tr>
      </table>
    </div>
    <p>Don't forget to bring your registration confirmation or QR code for check-in.</p>
    <p style="margin-bottom: 0;">We look forward to seeing you!</p>
  </div>
${WRAPPER_END}`,
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
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Abstract Submitted!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your abstract has been successfully submitted for <strong>{{eventName}}</strong>.</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Submission Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Status:</td><td style="padding: 8px 0; font-weight: 500;">Submitted</td></tr>
      </table>
    </div>
    <p>You can view the status of your abstract, make edits, and see reviewer feedback using the link below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
    <p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Important:</strong> Save this email! The link above is your personal access link to manage your submission.</p>
  </div>
${WRAPPER_END}`,
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
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">{{statusHeading}}</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>{{statusMessage}}</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Abstract Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Status:</td><td style="padding: 8px 0; font-weight: 500;">{{newStatus}}</td></tr>
      </table>
    </div>
    {{reviewNotes}}
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
  </div>
${WRAPPER_END}`,
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
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Welcome!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Your account has been created successfully for <strong>{{eventName}}</strong>. You can now log in to submit your abstracts.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{loginLink}}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Log In & Submit Abstract</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you did not create this account, you can safely ignore this email.</p>
  </div>
${WRAPPER_END}`,
    textContent: `Welcome to {{eventName}} - Account Created

Dear {{firstName}},

Your account has been created successfully for {{eventName}}. You can now log in to submit your abstracts.

Log In: {{loginLink}}`,
  },

  {
    slug: "custom-notification",
    name: "Custom Notification",
    subject: "{{subject}}",
    htmlContent: `${WRAPPER_START}
  <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">{{subject}}</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">{{eventName}}</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <div style="white-space: pre-wrap;">{{message}}</div>
  </div>
${WRAPPER_END}`,
    textContent: `{{subject}}

Dear {{firstName}},

{{message}}`,
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
  }) => ({
    subject: `You've been invited to join ${params.organizationName}`,
    htmlContent: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">You're Invited!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Join ${escapeHtml(params.organizationName)} on MMGroup EventsHub</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p><strong>${escapeHtml(params.inviterName)}</strong> has invited you to join <strong>${escapeHtml(params.organizationName)}</strong> on MMGroup EventsHub as a <strong>${escapeHtml(params.role)}</strong>.</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Invitation Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Organization:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.organizationName)}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Your Role:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.role)}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Your Email:</td><td style="padding: 8px 0; font-weight: 500;">${escapeHtml(params.recipientEmail)}</td></tr>
      </table>
    </div>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${escapeHtml(params.setupLink)}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Accept Invitation & Set Password</a>
    </div>
    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This invitation will expire in ${escapeHtml(params.expiresIn)}.</p>` : ""}
    <p style="color: #6b7280; font-size: 14px;">If you didn't expect this invitation, you can safely ignore this email.</p>
  </div>
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;"><p>Sent from MMGroup EventsHub - Event Management Platform</p></div>
</body></html>`,
    textContent: `You've been invited to join ${params.organizationName}

Hi ${params.recipientName},

${params.inviterName} has invited you to join ${params.organizationName} on MMGroup EventsHub as a ${params.role}.

Accept Invitation & Set Password: ${params.setupLink}

${params.expiresIn ? `Note: This invitation will expire in ${params.expiresIn}.` : ""}`,
  }),

  passwordReset: (params: {
    recipientName: string;
    resetLink: string;
    expiresIn?: string;
  }) => ({
    subject: "Reset your EventsHub password",
    htmlContent: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Reset Your Password</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">We received a request to reset your password.</p>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p>Use the button below to set a new password for your MMGroup EventsHub account.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${escapeHtml(params.resetLink)}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Reset Password</a>
    </div>
    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This reset link will expire in ${escapeHtml(params.expiresIn)}.</p>` : ""}
    <p style="color: #6b7280; font-size: 14px;">If you did not request a password reset, you can safely ignore this email.</p>
  </div>
  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;"><p>Sent from MMGroup EventsHub - Event Management Platform</p></div>
</body></html>`,
    textContent: `Reset your EventsHub password

Hi ${params.recipientName},

Use the link below to set a new password: ${params.resetLink}

${params.expiresIn ? `Note: This reset link will expire in ${params.expiresIn}.` : ""}`,
  }),
};

// ── Legacy compatibility: emailTemplates ───────────────────────────────────────
// Keep the old API working during transition. All callers will be migrated to
// use DB templates with renderTemplate().

export const emailTemplates = {
  userInvitation: (params: Parameters<typeof systemTemplates.userInvitation>[0]) =>
    systemTemplates.userInvitation(params),
  passwordReset: (params: Parameters<typeof systemTemplates.passwordReset>[0]) =>
    systemTemplates.passwordReset(params),
};

// ── Helper to load event template from DB (with fallback to default) ───────────

export async function getEventTemplate(
  eventId: string,
  slug: string
): Promise<{ subject: string; htmlContent: string; textContent: string } | null> {
  // Lazy import to avoid circular dependency (db → logger → email)
  const { db } = await import("./db");

  const dbTemplate = await db.emailTemplate.findUnique({
    where: { eventId_slug: { eventId, slug } },
    select: { subject: true, htmlContent: true, textContent: true, isActive: true },
  });

  if (dbTemplate && !dbTemplate.isActive) {
    apiLogger.info({ msg: "Email template is disabled, falling back to default", eventId, slug });
  }

  if (dbTemplate?.isActive) {
    return {
      subject: dbTemplate.subject,
      htmlContent: dbTemplate.htmlContent,
      textContent: dbTemplate.textContent || "",
    };
  }

  // Fallback to default template
  const def = getDefaultTemplate(slug);
  if (!def) {
    apiLogger.error({ msg: "No default email template found for slug", slug, eventId });
    return null;
  }

  return { subject: def.subject, htmlContent: def.htmlContent, textContent: def.textContent };
}

// ── Helper function to send registration confirmation ──────────────────────────

export async function sendRegistrationConfirmation(params: {
  to: string;
  firstName: string;
  eventName: string;
  eventDate: Date;
  eventVenue: string;
  eventCity: string;
  ticketType: string;
  registrationId: string;
  qrCode: string;
  eventId?: string;
}) {
  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(params.eventDate));

  const vars = {
    firstName: params.firstName,
    lastName: "",
    eventName: params.eventName,
    eventDate,
    eventVenue: [params.eventVenue, params.eventCity].filter(Boolean).join(", "),
    ticketType: params.ticketType,
    registrationId: params.registrationId,
  };

  // Try DB template first, fall back to default
  let tpl: { subject: string; htmlContent: string; textContent: string } | null | undefined = null;

  if (params.eventId) {
    tpl = await getEventTemplate(params.eventId, "registration-confirmation");
  }
  if (!tpl) {
    const def = getDefaultTemplate("registration-confirmation");
    if (!def) {
      apiLogger.error({ msg: "No registration-confirmation template found" });
      return { success: false, error: "Email template not found" };
    }
    tpl = def;
  }

  const subject = renderTemplatePlain(tpl.subject, vars);
  const htmlContent = renderTemplate(tpl.htmlContent, vars);
  const textContent = renderTemplatePlain(tpl.textContent, vars);

  return sendEmail({
    to: [{ email: params.to, name: params.firstName }],
    subject,
    htmlContent,
    textContent,
  });
}
