/**
 * The default subject and bodies of every system email template, keyed by the
 * slug the registry declares. `Record<SystemTemplateSlug, …>` means a template
 * added to one file and not the other fails to compile.
 *
 * Bodies are fragments (no document wrapper): branding is applied at render
 * time by `wrapWithBranding`. Edit wording here; an event that has already
 * seeded its own row keeps that row (see docs/ROADMAP.md, Phase 3).
 */
import {
  SYSTEM_DEFAULT_SUBJECT as CERT_SINGLE_DEFAULT_SUBJECT,
  SYSTEM_DEFAULT_BODY_ATTENDANCE as CERT_ATTENDANCE_DEFAULT_BODY,
  SYSTEM_DEFAULT_BODY_APPRECIATION as CERT_APPRECIATION_DEFAULT_BODY,
} from "@/lib/certificates/email-tokens";
import type { SystemTemplateSlug } from "@/lib/email-template-registry";

export interface DefaultTemplateBody {
  subject: string;
  htmlContent: string;
  textContent: string;
}

export const DEFAULT_TEMPLATE_BODIES: Readonly<Record<SystemTemplateSlug, DefaultTemplateBody>> = {
  "registration-confirmation": {
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
    {{organizerSignature}}
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

See you at the event!

{{organizerSignature}}`,
  },
  "speaker-invitation": {
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
    <p>Your participation is covered by our <strong>speaker agreement</strong> — please take a moment to review and accept it.</p>
    {{agreementBlock}}
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

Your participation is covered by our speaker agreement — please take a moment to review and accept it.
{{agreementBlockText}}

Best regards,
{{organizerName}}
{{organizerEmail}}

{{organizerSignature}}`,
  },
  "speaker-agreement": {
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
{{organizerEmail}}

{{organizerSignature}}`,
  },
  "presenter-agreement": {
    subject: "Presenter Agreement — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Presenter Agreement</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{presenterName}}</strong>,</p>
    <p>Thank you for submitting your work to <strong>{{eventName}}</strong>. On behalf of {{organizerName}}, please find attached the <strong>Presenter Agreement</strong> covering the presentation of your accepted abstract(s) at the event.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151; font-size: 15px;">Your submission(s)</h3>
      <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.6;">{{abstractTitles}}</p>
    </div>
    <p><strong>Your personalized Agreement is attached to this email as a PDF.</strong> Please review it and confirm your acceptance by clicking the button below — no printing or signing is required.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{agreementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">Review &amp; Accept Agreement</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; text-align: center;">This link is unique to you and will expire in 30 days.</p>
    <p>{{personalMessage}}</p>
    <p>If you have any questions about the Agreement, please reach out before confirming.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong><br><a href="mailto:{{organizerEmail}}" style="color: #00aade;">{{organizerEmail}}</a></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Presenter Agreement — {{eventName}}

Dear {{presenterName}},

Thank you for submitting your work to {{eventName}}. On behalf of {{organizerName}}, please find attached the Presenter Agreement covering the presentation of your accepted abstract(s) at the event.

Your submission(s):
{{abstractTitles}}

Your personalized Agreement is attached to this email as a PDF. Please review it and confirm your acceptance here — no printing or signing required:
{{agreementLink}}

This link is unique to you and will expire in 30 days.

{{personalMessage}}

If you have any questions about the Agreement, please reach out before confirming.

Best regards,
{{organizerName}}
{{organizerEmail}}

{{organizerSignature}}`,
  },
  "event-reminder": {
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
    {{organizerSignature}}
  </div>`,
    textContent: `Reminder: {{eventName}} is coming up!

Dear {{title}} {{lastName}},

This is a friendly reminder that {{eventName}} is coming up in {{daysUntilEvent}} days!

Event Details:
- Date: {{eventDate}}
- Venue: {{eventVenue}}

We look forward to seeing you!

{{organizerSignature}}`,
  },
  "abstract-submission-confirmation": {
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
        <tr><td style="padding: 8px 0; color: #6b7280;">Abstract #:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractNumber}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{abstractTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Status:</td><td style="padding: 8px 0; font-weight: 500;">Submitted</td></tr>
      </table>
    </div>
    <p>You can view the status of your abstract, make edits, and see reviewer feedback using the link below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Abstract</a>
    </div>
    <p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; font-size: 14px;"><strong>Important:</strong> Save this email! The link above is your personal access link to manage your submission.</p>
    {{travelGrantBlock}}
    {{organizerSignature}}
  </div>`,
    textContent: `Abstract Submitted - {{eventName}}

Dear {{title}} {{lastName}},

Your abstract has been successfully submitted for {{eventName}}.

Submission Details:
- Abstract #: {{abstractNumber}}
- Title: {{abstractTitle}}
- Status: Submitted

View Your Abstract: {{managementLink}}

Important: Save this email! The link above is your personal access link to manage your submission.

{{travelGrantBlockText}}

{{organizerSignature}}`,
  },
  "session-proposal-confirmation": {
    subject: "Session Proposal Received - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Session Proposal Received!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Thank you for proposing a session for <strong>{{eventName}}</strong>. Your proposal has been received and the organizing team will review it.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Proposal Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6b7280;">Proposal #:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalNumber}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Title:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalTitle}}</td></tr>
        <tr><td style="padding: 8px 0; color: #6b7280;">Duration:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalDuration}}</td></tr>
      </table>
    </div>
    <p>You can view your proposal any time using the link below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{managementLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">View Your Proposal</a>
    </div>
    <p>The organizing team will contact you about the next steps.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Session Proposal Received - {{eventName}}

Dear {{title}} {{lastName}},

Thank you for proposing a session for {{eventName}}. Your proposal has been received and the organizing team will review it.

Proposal Details:
- Proposal #: {{proposalNumber}}
- Title: {{proposalTitle}}
- Duration: {{proposalDuration}}

View Your Proposal: {{managementLink}}

The organizing team will contact you about the next steps.

{{organizerSignature}}`,
  },
  "group-registration-confirmation": {
    subject: "Group Registration Received - {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Group Registration Received!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{coordinatorName}}</strong>,</p>
    <p>Thank you for registering your group for <strong>{{eventName}}</strong> ({{eventDate}}, {{eventVenue}}). The registration below is billed to <strong>{{payerName}}</strong> — the consolidated invoice is attached to this email.</p>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
      <h3 style="margin-top: 0; color: #374151;">Your Group ({{memberCount}} members)</h3>
      {{memberSummary}}
      <p style="margin: 12px 0 0 0; font-size: 15px;"><strong>Total: {{totalAmount}}</strong></p>
    </div>
    <p>Invoice <strong>{{invoiceNumber}}</strong> is attached. Registration is confirmed on receipt of payment — bank details are on the invoice. Each member has received their own confirmation email with their entry barcode.</p>
    <p style="margin: 24px 0;"><a href="{{manageGroupLink}}" style="background: #00aade; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 600;">View your group</a></p>
    <p style="color: #6b7280; font-size: 13px;">Sign in with this email address to see everyone's status, pay by card, or download the invoice again.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Group Registration Received - {{eventName}}

Dear {{coordinatorName}},

Thank you for registering your group for {{eventName}} ({{eventDate}}, {{eventVenue}}). The registration is billed to {{payerName}} — the consolidated invoice is attached.

Your Group ({{memberCount}} members):
{{memberSummaryText}}

Total: {{totalAmount}}

Invoice {{invoiceNumber}} is attached. Registration is confirmed on receipt of payment — bank details are on the invoice. Each member has received their own confirmation email with their entry barcode.

View your group: {{manageGroupLink}}
Sign in with this email address to see everyone's status, pay by card, or download the invoice again.

{{organizerSignature}}`,
  },
  "abstract-status-update": {
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
    {{organizerSignature}}
  </div>`,
    textContent: `{{statusHeading}} - {{eventName}}

Dear {{title}} {{lastName}},

{{statusMessage}}

Abstract Details:
- Title: {{abstractTitle}}
- Status: {{newStatus}}

{{reviewNotes}}

View Your Abstract: {{managementLink}}

{{organizerSignature}}`,
  },
  "submitter-welcome": {
    subject: "Welcome to {{eventName}} - Account Created",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Welcome!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your account has been created successfully for <strong>{{eventName}}</strong>. You can now log in to submit your abstracts.</p>
    {{presenterFeeBlock}}
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{loginLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Log In &amp; Submit Abstract</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you did not create this account, you can safely ignore this email.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Welcome to {{eventName}} - Account Created

Dear {{title}} {{lastName}},

Your account has been created successfully for {{eventName}}. You can now log in to submit your abstracts.

{{presenterFeeBlockText}}

Log In: {{loginLink}}

{{organizerSignature}}`,
  },
  "session-proposal-welcome": {
    subject: "Welcome to {{eventName}} - Account Created",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Welcome!</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Your account has been created successfully for <strong>{{eventName}}</strong>. You can now log in to propose a session.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{loginLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Log In &amp; Propose a Session</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you did not create this account, you can safely ignore this email.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Welcome to {{eventName}} - Account Created

Dear {{title}} {{lastName}},

Your account has been created successfully for {{eventName}}. You can now log in to propose a session.

Log In: {{loginLink}}

{{organizerSignature}}`,
  },
  "reviewer-assignment": {
    subject: "You've been assigned an abstract to review — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">Abstract Review Assignment</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{firstName}} {{lastName}}</strong>,</p>
    <p>You have been assigned as <strong>{{role}}</strong> to review the following abstract for <strong>{{eventName}}</strong>:</p>
    <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0; font-weight: 600; color: #111827;">{{abstractTitle}}</p>
    </div>
    <p>Please log in to your reviewer portal to read the abstract and submit your scores and feedback.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{reviewLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Review Abstract</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you believe you have a conflict of interest with this abstract, please let the event organizer know.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Abstract Review Assignment - {{eventName}}

Dear {{firstName}} {{lastName}},

You have been assigned as {{role}} to review the following abstract for {{eventName}}:

  {{abstractTitle}}

Please log in to your reviewer portal to read the abstract and submit your scores and feedback.

Review Abstract: {{reviewLink}}

If you believe you have a conflict of interest with this abstract, please let the event organizer know.

{{organizerSignature}}`,
  },
  "reviewer-pool-invitation": {
    subject: "You've been added as a reviewer — {{eventName}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">You're a Reviewer</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{firstName}} {{lastName}}</strong>,</p>
    <p>You have been added as a reviewer for <strong>{{eventName}}</strong>. You can now review the abstracts submitted to this event and record your scores and feedback.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{reviewLink}}" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Go to My Reviews</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">If you have any questions, please contact the event organizer.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `You've been added as a reviewer - {{eventName}}

Dear {{firstName}} {{lastName}},

You have been added as a reviewer for {{eventName}}. You can now review the abstracts submitted to this event and record your scores and feedback.

Go to My Reviews: {{reviewLink}}

If you have any questions, please contact the event organizer.

{{organizerSignature}}`,
  },
  "abstract-reminder": {
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
    {{organizerSignature}}
  </div>`,
    textContent: `Abstract Submission Reminder - {{eventName}}

Dear {{title}} {{lastName}},

This is a friendly reminder to submit your abstract for {{eventName}}.

If you have already submitted, please check your dashboard for any updates or revision requests.

View Your Abstracts: {{managementLink}}

{{organizerSignature}}`,
  },
  "custom-notification": {
    subject: "{{subject}}",
    htmlContent: `<div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb;">
    <h1 style="margin: 0 0 4px 0; font-size: 22px; color: #111827;">{{subject}}</h1>
    <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 14px;">{{eventName}}</p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <div style="white-space: pre-wrap;">{{message}}</div>
    {{organizerSignature}}
  </div>`,
    textContent: `{{subject}}

Dear {{title}} {{lastName}},

{{message}}

{{organizerSignature}}`,
  },
  "payment-confirmation": {
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
  "refund-confirmation": {
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
  "payment-reminder": {
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
    {{organizerSignature}}
  </div>`,
    textContent: `Payment Reminder — {{eventName}}

Dear {{title}} {{lastName}},

This is a friendly reminder that your registration payment is still pending. Please complete your payment to secure your spot.

Event: {{eventName}}
Date: {{eventDate}}
Registration Type: {{ticketType}}
Amount Due: {{amount}}

{{paymentBlock}}

If you have already made the payment, please disregard this email.

{{organizerSignature}}`,
  },
  "webinar-confirmation": {
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
    {{calendarBlock}}
    <p style="color: #6b7280; font-size: 13px;">You can join up to 15 minutes before the scheduled start time. We'll also send you reminders 24 hours and 1 hour before the webinar begins.</p>
    <p style="margin-bottom: 0;">See you online!</p>
    {{organizerSignature}}
  </div>`,
    textContent: `You're registered for {{eventName}}

Dear {{title}} {{lastName}},

You're confirmed for {{eventName}}.

Date: {{webinarDate}}
Time: {{webinarTime}}

Join link: {{joinUrl}}
{{passcodeBlock}}

{{calendarBlockText}}

You can join up to 15 minutes before the scheduled start time. We'll send reminders 24 hours and 1 hour before the webinar begins.

{{organizerSignature}}`,
  },
  "webinar-reminder-24h": {
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
    {{organizerSignature}}
  </div>`,
    textContent: `Tomorrow: {{eventName}}

Hi {{firstName}},

Just a reminder that {{eventName}} starts tomorrow.

Date: {{webinarDate}}
Time: {{webinarTime}}

Join link: {{joinUrl}}
{{passcodeBlock}}

{{organizerSignature}}`,
  },
  "webinar-reminder-1h": {
    subject: "Starting in 1 hour: {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{firstName}}</strong>,</p>
    <p><strong>{{eventName}}</strong> starts in about 1 hour. Get ready!</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">Join Webinar</a>
    </div>
    {{passcodeBlock}}
    <p style="color: #6b7280; font-size: 13px;">Doors open 15 minutes before the scheduled start. See you there.</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Starting in 1 hour: {{eventName}}

Hi {{firstName}},

{{eventName}} starts in about 1 hour. Get ready!

Join link: {{joinUrl}}
{{passcodeBlock}}

Doors open 15 minutes before the scheduled start.

{{organizerSignature}}`,
  },
  "webinar-live-now": {
    subject: "We're live: {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Hi <strong>{{firstName}}</strong>,</p>
    <p><strong>{{eventName}}</strong> is starting now. Click below to join.</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{joinUrl}}" style="display: inline-block; background: #dc2626; color: #ffffff; padding: 16px 40px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 18px;">Join Now</a>
    </div>
    {{passcodeBlock}}
    {{organizerSignature}}
  </div>`,
    textContent: `We're live: {{eventName}}

Hi {{firstName}},

{{eventName}} is starting now.

Join now: {{joinUrl}}
{{passcodeBlock}}

{{organizerSignature}}`,
  },
  "webinar-thank-you": {
    subject: "Thank you for joining {{eventName}}",
    htmlContent: `<div style="padding: 20px 0;">
    <p>Dear <strong>{{title}} {{lastName}}</strong>,</p>
    <p>Thank you for joining <strong>{{eventName}}</strong>. We hope you found it valuable.</p>
    {{recordingBlock}}
    <p>If you have any feedback, we'd love to hear from you.</p>
    <p style="margin-bottom: 0;">See you at the next one!</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Thank you for joining {{eventName}}

Dear {{title}} {{lastName}},

Thank you for joining {{eventName}}. We hope you found it valuable.

{{recordingBlock}}

If you have any feedback, we'd love to hear from you.

{{organizerSignature}}`,
  },
  "webinar-panelist-invitation": {
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
  "survey-invitation": {
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
  "survey-thankyou": {
    // Sent automatically by the public POST handler immediately on
    // successful submit. Also cert-neutral by default — CME events
    // override to add their cert-delivery language.
    subject: "Thank you for your feedback — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>Thank you for completing the post-event survey for <strong>{{eventName}}</strong>. Your feedback has been recorded and will help us shape future events.</p>
    <p style="margin-bottom: 0;">— The {{eventName}} team</p>
    {{organizerSignature}}
  </div>`,
    textContent: `Thank you for your feedback — {{eventName}}

Dear {{firstName}},

Thank you for completing the post-event survey for {{eventName}}. Your feedback has been recorded and will help us shape future events.

— The {{eventName}} team

{{organizerSignature}}`,
  },
  "certificate-attendance-delivery": {
    // The cover email for an email carrying ONE Certificate of Attendance
    // (Sep 17, 2026, owner request: the default belongs under Email
    // Templates, not only inside the certificate editor). A certificate
    // template's own saved cover still wins over this; see
    // pickSingleCoverEmail in certificates/email-tokens.ts. The subject and
    // body ARE the previous hardcoded default, imported rather than copied,
    // so nothing changes until an organizer edits this template. Tokens
    // resolve per recipient through the certificate cover-email resolver,
    // which does not know {{organizerSignature}}, so it is left out.
    subject: CERT_SINGLE_DEFAULT_SUBJECT,
    htmlContent: CERT_ATTENDANCE_DEFAULT_BODY,
    textContent: `Your {{certificateType}} — {{eventName}}

Dear {{recipientName}},

We are pleased to share your {{certificateType}} for {{eventName}} ({{eventDateRange}}), attached as a PDF.

Certificate serial: {{certificateSerial}}

Thank you for attending.

Best regards,
{{organizationName}}`,
  },
  "certificate-appreciation-delivery": {
    // The APPRECIATION counterpart of the template above (speakers, chairs,
    // committee). Same precedence and same imported default.
    subject: CERT_SINGLE_DEFAULT_SUBJECT,
    htmlContent: CERT_APPRECIATION_DEFAULT_BODY,
    textContent: `Your {{certificateType}} — {{eventName}}

Dear {{recipientName}},

Thank you for your contribution to {{eventName}} ({{eventDateRange}}). Please find your {{certificateType}} attached.

{{abstractTitle}}

Certificate serial: {{certificateSerial}}

Best regards,
{{organizationName}}`,
  },
  "certificate-bundle-delivery": {
    // The cover email for any send carrying 2+ certificate PDFs in ONE email
    // (per-person Issue multi-select, Communications certificate send, survey
    // auto-issue bundles; the Issue-tab multi-run dialog pre-fills from it).
    // A SINGLE-certificate email uses that certificate template's own saved
    // cover instead (edited in the cert template editor). Content below is
    // byte-equal to the previous hardcoded bundle default, so nothing changes
    // until an organizer edits this template. Cert tokens resolve per
    // recipient at send time via the cert cover-email resolver.
    subject: "Your certificates — {{eventName}}",
    htmlContent: `<p>Dear {{recipientName}},</p>
<p>Thank you for being part of {{eventName}} ({{eventDateRange}}). Please find your certificates attached:</p>
{{certificateList}}
<p>Best regards,<br/>{{organizationName}}</p>`,
    textContent: `Your certificates — {{eventName}}

Dear {{recipientName}},

Thank you for being part of {{eventName}} ({{eventDateRange}}). Please find your certificates attached:
{{certificateList}}

Best regards,
{{organizationName}}`,
  },
  "document-delivery": {
    // The cover email for a finance document PDF sent on its own: a manual
    // invoice Send, the MCP send_invoice tool, and the credit-note issue
    // flow's "email to attendee" checkbox. ONE template for all three
    // document types — {{documentType}} / {{documentTypeLower}} carry the
    // label ("Invoice" / "Payment Receipt" / "Credit Note"). Content is
    // wording-equal to the previously-hardcoded buildInvoiceEmailHtml body
    // in invoice-service.ts, so nothing changes until an organizer edits
    // this template. The combined post-payment email (invoice + receipt
    // after a payment settles) is separate — it uses payment-confirmation.
    // Deliberately NO {{organizerSignature}} — pure transactional, same
    // owner exclusion as payment-confirmation / refund-confirmation.
    subject: "{{documentType}} {{documentNumber}} — {{eventName}}",
    htmlContent: `<h2 style="color: #1e293b; margin-bottom: 8px;">{{documentType}} {{documentNumber}}</h2>
<p style="color: #475569; font-size: 14px;">Dear {{firstName}},</p>
<p style="color: #475569; font-size: 14px;">Please find your {{documentTypeLower}} for <strong>{{eventName}}</strong> attached to this email as a PDF.</p>
<p style="color: #475569; font-size: 14px;">If you have any questions regarding this document, please do not hesitate to contact us.</p>
<p style="color: #94a3b8; font-size: 12px; margin-top: 30px;">This is an automated message. The {{documentTypeLower}} is attached as a PDF document.</p>`,
    textContent: `{{documentType}} {{documentNumber}} — {{eventName}}

Dear {{firstName}},

Please find your {{documentTypeLower}} for {{eventName}} attached to this email as a PDF.

If you have any questions regarding this document, please do not hesitate to contact us.

This is an automated message. The {{documentTypeLower}} is attached as a PDF document.`,
  },
  "dinner-rsvp-invitation": {
    // Sent (bulk) to dinner invitees with their personalized {{rsvpLink}}.
    // Editable per-event under Communications → Email Templates; the send
    // dialog previews it. {{personalMessage}} carries the optional note the
    // organizer types at send time.
    subject: "{{rsvpName}} — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{firstName}}</strong>,</p>
    <p>You&apos;re invited to <strong>{{rsvpName}}</strong> at {{eventName}}. Please let us know whether you&apos;ll join us — it only takes a moment.</p>
    {{personalMessage}}
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{rsvpLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">RSVP now</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; margin: 0;">Or copy this link into your browser:<br><span style="word-break: break-all; color: #00aade;">{{rsvpLink}}</span></p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
    {{organizerSignature}}
  </div>`,
    textContent: `You're invited — {{eventName}}

Dear {{firstName}},

You're invited to {{rsvpName}} at {{eventName}}. Please let us know whether you'll join us:
{{rsvpLink}}

{{personalMessage}}

Best regards,
{{organizerName}}

{{organizerSignature}}`,
  },
  "travel-grant-invitation": {
    // Sent from the Travel Grants console when an author needs their link
    // outside the ordinary submission-confirmation flow: they lost the email,
    // or their country was corrected after they submitted. The CTA is the
    // SAME {{travelGrantBlock}} the confirmation email uses, so the button and
    // the organizer's Content -> Abstracts message cannot drift between the
    // two places an author might see them.
    subject: "Travel grant — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>Thank you for submitting your abstract to <strong>{{eventName}}</strong>.</p>
    {{personalMessage}}
    {{travelGrantBlock}}
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Travel grant — {{eventName}}

Dear {{speakerName}},

Thank you for submitting your abstract to {{eventName}}.

{{personalMessage}}

{{travelGrantBlockText}}

Best regards,
{{organizerName}}

{{organizerSignature}}`,
  },
  "speaker-reimbursement-invitation": {
    // Sent (single or batch) to speakers with their personalized
    // {{reimbursementLink}} — the web replacement for the paper
    // "Speaker / Faculty Reimbursement Form". Editable per-event under
    // Communications → Email Templates.
    subject: "Reimbursement form — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>Thank you for taking part in <strong>{{eventName}}</strong>. To arrange your reimbursement (honorarium / speaker fee, flights, hotel and ground transport where agreed), please complete the secure form below and upload your receipts.</p>
    {{personalMessage}}
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{reimbursementLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">Complete the reimbursement form</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; margin: 0 0 16px 0;">Or copy this link into your browser:<br><span style="word-break: break-all; color: #00aade;">{{reimbursementLink}}</span></p>
    <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin: 0 0 16px 0;">
      <p style="margin: 0; font-size: 14px;">Please have ready: your passport photo page, bank transfer details (IBAN / SWIFT), and receipts for every expense you claim. <strong>Expenses without receipts cannot be processed.</strong></p>
    </div>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Reimbursement form — {{eventName}}

Dear {{speakerName}},

Thank you for taking part in {{eventName}}. To arrange your reimbursement, please complete the secure form and upload your receipts:
{{reimbursementLink}}

{{personalMessage}}

Please have ready: your passport photo page, bank transfer details (IBAN / SWIFT), and receipts for every expense you claim. Expenses without receipts cannot be processed.

Best regards,
{{organizerName}}

{{organizerSignature}}`,
  },
  "speaker-profile-form-request": {
    // Sent from the speaker page with the speaker's personalized
    // {{profileFormLink}} — asks for their photo, passport photocopy,
    // optional cover letter and bio. Editable per-event under
    // Communications → Email Templates.
    subject: "Your photo & documents — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>To complete your speaker profile for <strong>{{eventName}}</strong>, please use the secure form below to upload your <strong>photo</strong> and <strong>passport photocopy</strong> (and a cover letter if applicable), and review your bio.</p>
    {{personalMessage}}
    <div style="text-align: center; margin: 28px 0;">
      <a href="{{profileFormLink}}" style="display: inline-block; background: #00aade; color: #ffffff; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: 600;">Complete your speaker profile</a>
    </div>
    <p style="color: #6b7280; font-size: 13px; margin: 0 0 16px 0;">Or copy this link into your browser:<br><span style="word-break: break-all; color: #00aade;">{{profileFormLink}}</span></p>
    <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin: 0 0 16px 0;">
      <p style="margin: 0; font-size: 14px;">Please have ready: a recent headshot photo (JPG/PNG, under 500KB) and a scan or clear phone photo of your passport photo page (PDF/JPG/PNG). The passport copy is required.</p>
    </div>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
    {{organizerSignature}}
  </div>`,
    textContent: `Your photo & documents — {{eventName}}

Dear {{speakerName}},

To complete your speaker profile for {{eventName}}, please use the secure form to upload your photo and passport photocopy (and a cover letter if applicable), and review your bio:
{{profileFormLink}}

{{personalMessage}}

Please have ready: a recent headshot photo (JPG/PNG, under 500KB) and a scan or clear phone photo of your passport photo page (PDF/JPG/PNG). The passport copy is required.

Best regards,
{{organizerName}}

{{organizerSignature}}`,
  },
  "speaker-reimbursement-received": {
    // Automated confirmation to the speaker right after they submit —
    // their timestamped receipt (the declaration promises processing
    // within 45 days of receipt of the completed form + documents).
    // No {{organizerSignature}}: automated send, renders empty anyway.
    subject: "We received your reimbursement form — {{eventName}}",
    htmlContent: `<div style="padding: 24px 0;">
    <p>Dear <strong>{{speakerName}}</strong>,</p>
    <p>We&apos;ve received your reimbursement form for <strong>{{eventName}}</strong>. Here is a summary of your claim:</p>
    {{claimSummary}}
    <p>Payment will be processed by bank wire transfer within <strong>45 days</strong> of receipt of the completed form and all required supporting documents. Please note that bank charges and currency conversion fees are not covered.</p>
    <p style="margin-bottom: 0;">Best regards,<br><strong>{{organizerName}}</strong></p>
  </div>`,
    textContent: `We received your reimbursement form — {{eventName}}

Dear {{speakerName}},

We've received your reimbursement form for {{eventName}}. Summary of your claim:

{{claimSummaryText}}

Payment will be processed by bank wire transfer within 45 days of receipt of the completed form and all required supporting documents. Bank charges and currency conversion fees are not covered.

Best regards,
{{organizerName}}`,
  },
};
