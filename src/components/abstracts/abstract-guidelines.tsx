"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen } from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitize";
import { DEFAULT_ABSTRACT_GUIDELINES_HTML } from "@/lib/default-terms";

/** Last-resort contact email when an event hasn't configured a sender address. */
const FALLBACK_CONTACT_EMAIL = "ehc@meetingmindsexperts.com";

interface AbstractGuidelinesProps {
  /** Per-event override (`Event.abstractGuidelinesHtml`); falls back to the default. */
  html?: string | null;
  /** Event contact/sender email (`Event.emailFromAddress`) merged into `{{contactEmail}}`. */
  contactEmail?: string | null;
  className?: string;
}

/**
 * Renders the abstract-submission guidelines (per-event editable, default
 * fallback) with the `{{contactEmail}}` token merged in. Shared by the
 * submission form (/abstracts/new) and the submitter profile page.
 */
export function AbstractGuidelines({ html, contactEmail, className }: AbstractGuidelinesProps) {
  const source = (html && html.trim()) || DEFAULT_ABSTRACT_GUIDELINES_HTML;
  const email = (contactEmail && contactEmail.trim()) || FALLBACK_CONTACT_EMAIL;
  // Merge the contact-email token BEFORE sanitizing so the resulting mailto link
  // survives the sanitizer's URL-scheme allowlist.
  const merged = source.replace(/\{\{\s*contactEmail\s*\}\}/g, email);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" /> Submission Guidelines
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="prose prose-sm max-w-none [&>*]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(merged) }}
        />
      </CardContent>
    </Card>
  );
}
