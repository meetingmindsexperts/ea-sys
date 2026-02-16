import {
  TransactionalEmailsApi,
  TransactionalEmailsApiApiKeys,
  SendSmtpEmail,
} from "@getbrevo/brevo";
import { apiLogger } from "./logger";

// Lazy-initialize Brevo API client to avoid module-level overhead
let apiInstance: TransactionalEmailsApi | null = null;

function getApiInstance(): TransactionalEmailsApi {
  if (!apiInstance) {
    apiInstance = new TransactionalEmailsApi();
    apiInstance.setApiKey(
      TransactionalEmailsApiApiKeys.apiKey,
      process.env.BREVO_API_KEY || ""
    );
  }
  return apiInstance;
}

const DEFAULT_FROM_EMAIL = process.env.EMAIL_FROM || "krishna@meetingmindsdubai.com";
const DEFAULT_FROM_NAME = process.env.EMAIL_FROM_NAME || "Event Management System";

interface SendEmailParams {
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

export async function sendEmail(params: SendEmailParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!process.env.BREVO_API_KEY) {
    apiLogger.warn({ msg: "BREVO_API_KEY not configured, skipping email send" });
    return { success: false, error: "Email service not configured" };
  }

  try {
    const sendSmtpEmail = new SendSmtpEmail();

    sendSmtpEmail.sender = {
      email: DEFAULT_FROM_EMAIL,
      name: DEFAULT_FROM_NAME,
    };

    sendSmtpEmail.to = params.to.map((recipient) => ({
      email: recipient.email,
      name: recipient.name || recipient.email,
    }));

    sendSmtpEmail.subject = params.subject;
    sendSmtpEmail.htmlContent = params.htmlContent;

    if (params.textContent) {
      sendSmtpEmail.textContent = params.textContent;
    }

    if (params.replyTo) {
      sendSmtpEmail.replyTo = params.replyTo;
    }

    if (params.attachments && params.attachments.length > 0) {
      sendSmtpEmail.attachment = params.attachments.map((att) => ({
        name: att.name,
        content: att.content,
        contentType: att.contentType,
      }));
    }

    const result = await getApiInstance().sendTransacEmail(sendSmtpEmail);

    apiLogger.info({
      msg: "Email sent successfully",
      to: params.to.map((r) => r.email),
      subject: params.subject,
      messageId: result.body.messageId,
    });

    return { success: true, messageId: result.body.messageId };
  } catch (error) {
    apiLogger.error({
      msg: "Failed to send email",
      error: error instanceof Error ? error.message : "Unknown error",
      to: params.to.map((r) => r.email),
      subject: params.subject,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email"
    };
  }
}

// Email template generators
export const emailTemplates = {
  speakerAgreement: (params: {
    speakerName: string;
    eventName: string;
    eventDate: string;
    eventVenue: string;
    sessionDetails?: string;
    agreementLink?: string;
    organizerName: string;
    organizerEmail: string;
  }) => ({
    subject: `Speaker Agreement - ${params.eventName}`,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Speaker Agreement</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Speaker Agreement</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.speakerName}</strong>,</p>

    <p>Thank you for agreeing to speak at <strong>${params.eventName}</strong>. We are excited to have you as part of our event!</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Event:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Date:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventDate}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Venue:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventVenue}</td>
        </tr>
        ${params.sessionDetails ? `
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Session:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.sessionDetails}</td>
        </tr>
        ` : ""}
      </table>
    </div>

    <p>Please review and acknowledge the speaker agreement terms. By participating as a speaker, you agree to:</p>

    <ul style="color: #4b5563;">
      <li>Deliver your presentation as scheduled</li>
      <li>Provide presentation materials in advance if requested</li>
      <li>Allow the event to record and distribute your session (if applicable)</li>
      <li>Adhere to the event's code of conduct</li>
    </ul>

    ${params.agreementLink ? `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.agreementLink}" style="display: inline-block; background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View & Sign Agreement</a>
    </div>
    ` : ""}

    <p>If you have any questions, please don't hesitate to reach out.</p>

    <p style="margin-bottom: 0;">
      Best regards,<br>
      <strong>${params.organizerName}</strong><br>
      <a href="mailto:${params.organizerEmail}" style="color: #667eea;">${params.organizerEmail}</a>
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding ${params.eventName}</p>
  </div>
</body>
</html>
    `,
    textContent: `
Speaker Agreement - ${params.eventName}

Dear ${params.speakerName},

Thank you for agreeing to speak at ${params.eventName}. We are excited to have you as part of our event!

Event Details:
- Event: ${params.eventName}
- Date: ${params.eventDate}
- Venue: ${params.eventVenue}
${params.sessionDetails ? `- Session: ${params.sessionDetails}` : ""}

Please review and acknowledge the speaker agreement terms.

${params.agreementLink ? `View & Sign Agreement: ${params.agreementLink}` : ""}

Best regards,
${params.organizerName}
${params.organizerEmail}
    `,
  }),

  speakerInvitation: (params: {
    speakerName: string;
    eventName: string;
    eventDate: string;
    eventVenue: string;
    personalMessage?: string;
    confirmationLink?: string;
    organizerName: string;
    organizerEmail: string;
  }) => ({
    subject: `Speaker Invitation - ${params.eventName}`,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Speaker Invitation</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">You're Invited to Speak!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.speakerName}</strong>,</p>

    <p>We would be honored to have you as a speaker at <strong>${params.eventName}</strong>!</p>

    ${params.personalMessage ? `<p style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9;">${params.personalMessage}</p>` : ""}

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Event:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Date:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventDate}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Venue:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventVenue}</td>
        </tr>
      </table>
    </div>

    ${params.confirmationLink ? `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.confirmationLink}" style="display: inline-block; background: #11998e; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Confirm Your Participation</a>
    </div>
    ` : ""}

    <p>Please let us know if you're interested in speaking at our event. We look forward to hearing from you!</p>

    <p style="margin-bottom: 0;">
      Best regards,<br>
      <strong>${params.organizerName}</strong><br>
      <a href="mailto:${params.organizerEmail}" style="color: #11998e;">${params.organizerEmail}</a>
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding ${params.eventName}</p>
  </div>
</body>
</html>
    `,
    textContent: `
Speaker Invitation - ${params.eventName}

Dear ${params.speakerName},

We would be honored to have you as a speaker at ${params.eventName}!

${params.personalMessage ? `Message: ${params.personalMessage}` : ""}

Event Details:
- Event: ${params.eventName}
- Date: ${params.eventDate}
- Venue: ${params.eventVenue}

${params.confirmationLink ? `Confirm Your Participation: ${params.confirmationLink}` : ""}

Please let us know if you're interested in speaking at our event.

Best regards,
${params.organizerName}
${params.organizerEmail}
    `,
  }),

  registrationConfirmation: (params: {
    attendeeName: string;
    eventName: string;
    eventDate: string;
    eventVenue: string;
    ticketType: string;
    registrationId: string;
    qrCodeUrl?: string;
    additionalInfo?: string;
  }) => ({
    subject: `Registration Confirmed - ${params.eventName}`,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registration Confirmation</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Registration Confirmed!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.attendeeName}</strong>,</p>

    <p>Your registration for <strong>${params.eventName}</strong> has been confirmed. We look forward to seeing you!</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Registration Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Confirmation #:</td>
          <td style="padding: 8px 0; font-weight: 500; font-family: monospace;">${params.registrationId}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Event:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Date:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventDate}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Venue:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventVenue}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Ticket Type:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.ticketType}</td>
        </tr>
      </table>
    </div>

    ${params.qrCodeUrl ? `
    <div style="text-align: center; margin: 20px 0;">
      <p style="color: #6b7280; margin-bottom: 10px;">Show this QR code at check-in:</p>
      <img src="${params.qrCodeUrl}" alt="Check-in QR Code" style="max-width: 200px; border: 1px solid #e5e7eb; border-radius: 8px;">
    </div>
    ` : ""}

    ${params.additionalInfo ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b;">${params.additionalInfo}</p>` : ""}

    <p>If you have any questions, please don't hesitate to contact us.</p>

    <p style="margin-bottom: 0;">See you at the event!</p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding your registration for ${params.eventName}</p>
  </div>
</body>
</html>
    `,
    textContent: `
Registration Confirmed - ${params.eventName}

Dear ${params.attendeeName},

Your registration for ${params.eventName} has been confirmed. We look forward to seeing you!

Registration Details:
- Confirmation #: ${params.registrationId}
- Event: ${params.eventName}
- Date: ${params.eventDate}
- Venue: ${params.eventVenue}
- Ticket Type: ${params.ticketType}

${params.additionalInfo ? `Important: ${params.additionalInfo}` : ""}

If you have any questions, please don't hesitate to contact us.

See you at the event!
    `,
  }),

  eventReminder: (params: {
    recipientName: string;
    eventName: string;
    eventDate: string;
    eventVenue: string;
    eventAddress?: string;
    daysUntilEvent: number;
  }) => ({
    subject: `Reminder: ${params.eventName} is ${params.daysUntilEvent === 1 ? "tomorrow" : `in ${params.daysUntilEvent} days`}!`,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Event Reminder</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">${params.daysUntilEvent === 1 ? "See You Tomorrow!" : `${params.daysUntilEvent} Days to Go!`}</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.recipientName}</strong>,</p>

    <p>This is a friendly reminder that <strong>${params.eventName}</strong> is ${params.daysUntilEvent === 1 ? "tomorrow" : `coming up in ${params.daysUntilEvent} days`}!</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Date:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventDate}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Venue:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventVenue}</td>
        </tr>
        ${params.eventAddress ? `
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Address:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.eventAddress}</td>
        </tr>
        ` : ""}
      </table>
    </div>

    <p>Don't forget to bring your registration confirmation or QR code for check-in.</p>

    <p style="margin-bottom: 0;">We look forward to seeing you!</p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding ${params.eventName}</p>
  </div>
</body>
</html>
    `,
    textContent: `
Reminder: ${params.eventName} is ${params.daysUntilEvent === 1 ? "tomorrow" : `in ${params.daysUntilEvent} days`}!

Dear ${params.recipientName},

This is a friendly reminder that ${params.eventName} is ${params.daysUntilEvent === 1 ? "tomorrow" : `coming up in ${params.daysUntilEvent} days`}!

Event Details:
- Date: ${params.eventDate}
- Venue: ${params.eventVenue}
${params.eventAddress ? `- Address: ${params.eventAddress}` : ""}

Don't forget to bring your registration confirmation or QR code for check-in.

We look forward to seeing you!
    `,
  }),

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
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Invitation</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">You're Invited!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Join ${params.organizationName} on MMGroup EventsHub</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi <strong>${params.recipientName}</strong>,</p>

    <p><strong>${params.inviterName}</strong> has invited you to join <strong>${params.organizationName}</strong> on MMGroup EventsHub as a <strong>${params.role}</strong>.</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Invitation Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Organization:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.organizationName}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Your Role:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.role}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Your Email:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.recipientEmail}</td>
        </tr>
      </table>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.setupLink}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Accept Invitation & Set Password</a>
    </div>

    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This invitation will expire in ${params.expiresIn}.</p>` : ""}

    <p style="color: #6b7280; font-size: 14px;">If you didn't expect this invitation, you can safely ignore this email.</p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>Sent from MMGroup EventsHub - Event Management Platform</p>
  </div>
</body>
</html>
    `,
    textContent: `
You've been invited to join ${params.organizationName}

Hi ${params.recipientName},

${params.inviterName} has invited you to join ${params.organizationName} on MMGroup EventsHub as a ${params.role}.

Invitation Details:
- Organization: ${params.organizationName}
- Your Role: ${params.role}
- Your Email: ${params.recipientEmail}

Accept Invitation & Set Password: ${params.setupLink}

${params.expiresIn ? `Note: This invitation will expire in ${params.expiresIn}.` : ""}

If you didn't expect this invitation, you can safely ignore this email.
    `,
  }),

  passwordReset: (params: {
    recipientName: string;
    resetLink: string;
    expiresIn?: string;
  }) => ({
    subject: "Reset your EventsHub password",
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Reset Your Password</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">We received a request to reset your password.</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi <strong>${params.recipientName}</strong>,</p>

    <p>Use the button below to set a new password for your MMGroup EventsHub account.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.resetLink}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Reset Password</a>
    </div>

    ${params.expiresIn ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Note:</strong> This reset link will expire in ${params.expiresIn}.</p>` : ""}

    <p style="color: #6b7280; font-size: 14px;">If you did not request a password reset, you can safely ignore this email.</p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>Sent from MMGroup EventsHub - Event Management Platform</p>
  </div>
</body>
</html>
    `,
    textContent: `
Reset your EventsHub password

Hi ${params.recipientName},

Use the link below to set a new password for your MMGroup EventsHub account:

${params.resetLink}

${params.expiresIn ? `Note: This reset link will expire in ${params.expiresIn}.` : ""}

If you did not request a password reset, you can safely ignore this email.
    `,
  }),

  abstractSubmissionConfirmation: (params: {
    recipientName: string;
    recipientEmail: string;
    eventName: string;
    abstractTitle: string;
    managementLink: string;
  }) => ({
    subject: `Abstract Submitted - ${params.eventName}`,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Abstract Submitted</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Abstract Submitted!</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.recipientName}</strong>,</p>

    <p>Your abstract has been successfully submitted for <strong>${params.eventName}</strong>.</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Submission Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Title:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.abstractTitle}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Status:</td>
          <td style="padding: 8px 0; font-weight: 500;">Submitted</td>
        </tr>
      </table>
    </div>

    <p>You can view the status of your abstract, make edits, and see reviewer feedback using the link below:</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.managementLink}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>

    <p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Important:</strong> Save this email! The link above is your personal access link to manage your submission.</p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding your abstract submission for ${params.eventName}</p>
  </div>
</body>
</html>
    `,
    textContent: `
Abstract Submitted - ${params.eventName}

Dear ${params.recipientName},

Your abstract has been successfully submitted for ${params.eventName}.

Submission Details:
- Title: ${params.abstractTitle}
- Status: Submitted

You can view the status of your abstract, make edits, and see reviewer feedback at:
${params.managementLink}

Important: Save this email! The link above is your personal access link to manage your submission.
    `,
  }),

  abstractStatusUpdate: (params: {
    recipientName: string;
    recipientEmail: string;
    eventName: string;
    abstractTitle: string;
    newStatus: string;
    reviewNotes?: string;
    reviewScore?: number;
    managementLink: string;
  }) => {
    const statusMessages: Record<string, { heading: string; body: string; gradient: string }> = {
      UNDER_REVIEW: {
        heading: "Abstract Under Review",
        body: "Your abstract is now being reviewed by our committee. We will notify you once a decision has been made.",
        gradient: "linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)",
      },
      ACCEPTED: {
        heading: "Abstract Accepted!",
        body: "Congratulations! Your abstract has been accepted. We look forward to your presentation.",
        gradient: "linear-gradient(135deg, #10b981 0%, #34d399 100%)",
      },
      REJECTED: {
        heading: "Abstract Decision",
        body: "Thank you for your submission. After careful review, we are unable to accept your abstract for this event.",
        gradient: "linear-gradient(135deg, #6b7280 0%, #9ca3af 100%)",
      },
      REVISION_REQUESTED: {
        heading: "Revision Requested",
        body: "The review committee has requested revisions to your abstract. Please update your submission using the link below.",
        gradient: "linear-gradient(135deg, #f97316 0%, #fb923c 100%)",
      },
    };

    const status = statusMessages[params.newStatus] || {
      heading: "Abstract Status Update",
      body: `Your abstract status has been updated to: ${params.newStatus}.`,
      gradient: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)",
    };

    return {
      subject: `${status.heading} - ${params.eventName}`,
      htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${status.heading}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${status.gradient}; padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">${status.heading}</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.recipientName}</strong>,</p>

    <p>${status.body}</p>

    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Abstract Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Title:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.abstractTitle}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Status:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.newStatus.replace(/_/g, " ")}</td>
        </tr>
        ${params.reviewScore !== undefined ? `
        <tr>
          <td style="padding: 8px 0; color: #6b7280;">Score:</td>
          <td style="padding: 8px 0; font-weight: 500;">${params.reviewScore}/10</td>
        </tr>
        ` : ""}
      </table>
    </div>

    ${params.reviewNotes ? `
    <div style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;">
      <strong>Reviewer Notes:</strong><br>
      <span style="white-space: pre-wrap;">${params.reviewNotes}</span>
    </div>
    ` : ""}

    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.managementLink}" style="display: inline-block; background: linear-gradient(135deg, #00aade 0%, #7dd3fc 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p>This email was sent regarding your abstract submission for ${params.eventName}</p>
  </div>
</body>
</html>
      `,
      textContent: `
${status.heading} - ${params.eventName}

Dear ${params.recipientName},

${status.body}

Abstract Details:
- Title: ${params.abstractTitle}
- Status: ${params.newStatus.replace(/_/g, " ")}
${params.reviewScore !== undefined ? `- Score: ${params.reviewScore}/10` : ""}
${params.reviewNotes ? `\nReviewer Notes:\n${params.reviewNotes}` : ""}

View Your Abstract: ${params.managementLink}
      `,
    };
  },

  customNotification: (params: {
    recipientName: string;
    subject: string;
    message: string;
    eventName?: string;
    ctaText?: string;
    ctaLink?: string;
  }) => ({
    subject: params.subject,
    htmlContent: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${params.subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">${params.subject}</h1>
    ${params.eventName ? `<p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${params.eventName}</p>` : ""}
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Dear <strong>${params.recipientName}</strong>,</p>

    <div style="white-space: pre-wrap;">${params.message}</div>

    ${params.ctaText && params.ctaLink ? `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${params.ctaLink}" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">${params.ctaText}</a>
    </div>
    ` : ""}
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    ${params.eventName ? `<p>This email was sent regarding ${params.eventName}</p>` : ""}
  </div>
</body>
</html>
    `,
    textContent: `
${params.subject}

Dear ${params.recipientName},

${params.message}

${params.ctaText && params.ctaLink ? `${params.ctaText}: ${params.ctaLink}` : ""}
    `,
  }),
};

// Helper function to send registration confirmation
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
}) {
  const template = emailTemplates.registrationConfirmation({
    attendeeName: params.firstName,
    eventName: params.eventName,
    eventDate: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(params.eventDate)),
    eventVenue: [params.eventVenue, params.eventCity].filter(Boolean).join(", "),
    ticketType: params.ticketType,
    registrationId: params.registrationId,
  });

  return sendEmail({
    to: [{ email: params.to, name: params.firstName }],
    subject: template.subject,
    htmlContent: template.htmlContent,
    textContent: template.textContent,
  });
}
