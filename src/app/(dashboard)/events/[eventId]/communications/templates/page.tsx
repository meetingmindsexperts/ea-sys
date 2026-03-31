"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ArrowLeft, Loader2, Mail, Pencil, Plus } from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useEmailTemplates, useCreateEmailTemplate } from "@/hooks/use-api";
import { toast } from "sonner";

const DEFAULT_SLUGS = new Set([
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "custom-notification",
]);

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function EmailTemplatesPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data, isLoading } = useEmailTemplates(eventId);
  const createMutation = useCreateEmailTemplate(eventId);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSubject, setNewSubject] = useState("");

  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  const handleCreate = async () => {
    const name = newName.trim();
    const subject = newSubject.trim();
    if (!name || !subject) {
      toast.error("Name and subject are required");
      return;
    }

    const slug = slugify(name);
    if (!slug) {
      toast.error("Name must contain at least one alphanumeric character");
      return;
    }

    try {
      await createMutation.mutateAsync({
        slug,
        name,
        subject,
        htmlContent: `<h2 style="margin: 0 0 5px 0; font-size: 22px; color: #333;">${name}</h2>
  <p style="color: #6b7280; margin: 0 0 20px 0;">{{eventName}}</p>
  <p>Dear <strong>{{firstName}}</strong>,</p>
  <p>Your content here...</p>`,
        textContent: `${name}\n\nDear {{firstName}},\n\nYour content here...`,
      });
      toast.success("Template created");
      setCreateOpen(false);
      setNewName("");
      setNewSubject("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create template");
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  const templates = data?.templates || [];
  const systemTemplates = templates.filter((t: { slug: string }) => DEFAULT_SLUGS.has(t.slug));
  const customTemplates = templates.filter((t: { slug: string }) => !DEFAULT_SLUGS.has(t.slug));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}/communications`}
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
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Template
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Email Template</DialogTitle>
              <DialogDescription>
                Create a custom email template for this event. You can edit the HTML content after creating it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="template-name">Template Name</Label>
                <Input
                  id="template-name"
                  placeholder="e.g. VIP Welcome"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={100}
                />
                {newName.trim() && (
                  <p className="text-xs text-muted-foreground">
                    Slug: <code className="bg-muted px-1 rounded">{slugify(newName)}</code>
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="template-subject">Default Subject Line</Label>
                <Input
                  id="template-subject"
                  placeholder="e.g. Welcome VIP - {{eventName}}"
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  className="font-mono text-sm"
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !newName.trim() || !newSubject.trim()}
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* System templates */}
      {systemTemplates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">System Templates</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {systemTemplates.map((template: { id: string; slug: string; name: string; subject: string; isActive: boolean; updatedAt: string }) => (
              <Link key={template.id} href={`/events/${eventId}/communications/templates/${template.id}`}>
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
        </div>
      )}

      {/* Custom templates */}
      {customTemplates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Custom Templates</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {customTemplates.map((template: { id: string; slug: string; name: string; subject: string; isActive: boolean; updatedAt: string }) => (
              <Link key={template.id} href={`/events/${eventId}/communications/templates/${template.id}`}>
                <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full border-primary/20">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">{template.name}</CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">Custom</Badge>
                        {!template.isActive && (
                          <Badge variant="secondary">Disabled</Badge>
                        )}
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <CardDescription>{template.slug}</CardDescription>
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
        </div>
      )}

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
