"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Mail, Pencil } from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useEmailTemplates } from "@/hooks/use-api";

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "registration-confirmation": "Sent when someone registers for the event",
  "speaker-invitation": "Sent when inviting a speaker to the event",
  "speaker-agreement": "Sent with speaker agreement terms",
  "event-reminder": "Sent as a reminder before the event",
  "abstract-submission-confirmation": "Sent when a speaker submits an abstract",
  "abstract-status-update": "Sent when an abstract status changes (accepted, rejected, etc.)",
  "submitter-welcome": "Sent when a submitter creates an account",
  "custom-notification": "Template for custom/ad-hoc emails",
};

export default function EmailTemplatesPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data, isLoading } = useEmailTemplates(eventId);

  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  const templates = data?.templates || [];

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Link
            href={`/events/${eventId}/settings`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mail className="h-8 w-8" />
            Email Templates
          </h1>
        </div>
        <p className="text-muted-foreground">
          Customize the emails sent to attendees, speakers, and reviewers. Use {"{{variables}}"} for personalization.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {templates.map((template) => (
          <Link key={template.id} href={`/events/${eventId}/email-templates/${template.id}`}>
            <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base">{template.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    {!template.isActive && (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                <CardDescription>
                  {TEMPLATE_DESCRIPTIONS[template.slug] || template.slug}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Subject:</span>{" "}
                  {template.subject}
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  Last updated: {new Date(template.updatedAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {templates.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Mail className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No email templates found. They will be created automatically.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
