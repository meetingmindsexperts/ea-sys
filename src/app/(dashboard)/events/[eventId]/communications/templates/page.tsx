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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Loader2, Mail, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useEmailTemplates, useCreateEmailTemplate, useDeleteEmailTemplate } from "@/hooks/use-api";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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

type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  subject: string;
  isActive: boolean;
  updatedAt: string;
};

type StatusFilter = "all" | "active" | "disabled";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function TemplateCard({
  template,
  isCustom,
  eventId,
  onDelete,
  deleting,
}: {
  template: TemplateRow;
  isCustom: boolean;
  eventId: string;
  onDelete: (id: string, name: string) => void;
  deleting: boolean;
}) {
  const href = `/events/${eventId}/communications/templates/${template.id}`;
  return (
    <Card
      className={cn(
        "flex h-full flex-col transition-all duration-200 hover:shadow-md hover:border-primary/50",
        isCustom && "border-primary/20",
      )}
    >
      <Link href={href} className="group flex-1 block">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base group-hover:text-primary transition-colors">
              {template.name}
            </CardTitle>
            <div className="flex shrink-0 items-center gap-1.5">
              {isCustom && <Badge variant="outline">Custom</Badge>}
              {template.isActive ? (
                <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
                  Active
                </Badge>
              ) : (
                <Badge variant="secondary">Disabled</Badge>
              )}
            </div>
          </div>
          <CardDescription>
            {isCustom ? template.slug : TEMPLATE_DESCRIPTIONS[template.slug] || template.slug}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Subject:</span> {template.subject}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Last updated: {new Date(template.updatedAt).toLocaleDateString()}
          </div>
        </CardContent>
      </Link>
      <div className="flex items-center justify-between border-t px-6 py-2">
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Pencil className="h-3 w-3" /> Edit
        </Link>
        {isCustom && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-destructive hover:text-destructive"
                disabled={deleting}
                aria-label={`Delete ${template.name}`}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{template.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes this custom template. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(template.id, template.name)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </Card>
  );
}

export default function EmailTemplatesPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data, isLoading } = useEmailTemplates(eventId);
  const createMutation = useCreateEmailTemplate(eventId);
  const deleteMutation = useDeleteEmailTemplate(eventId);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleDelete = async (id: string, name: string) => {
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync(id);
      toast.success(`Deleted “${name}”`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete template");
    } finally {
      setDeletingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  const templates = (data?.templates || []) as TemplateRow[];

  // Search (name / subject / slug) + status filter, then classify with the
  // SAME shared helper the send dialogs use, so "Custom Templates" here is
  // exactly what appears in the bulk-email / single-registration send pickers.
  const q = search.trim().toLowerCase();
  const matches = (t: TemplateRow) =>
    (statusFilter === "all" || (statusFilter === "active" ? t.isActive : !t.isActive)) &&
    (!q ||
      t.name.toLowerCase().includes(q) ||
      t.subject.toLowerCase().includes(q) ||
      t.slug.toLowerCase().includes(q));

  const filtered = templates.filter(matches);
  const systemTemplates = filtered.filter((t) => !isCustomTemplateSlug(t.slug));
  const customTemplates = filtered.filter((t) => isCustomTemplateSlug(t.slug));

  const hasFilters = q !== "" || statusFilter !== "all";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link
              href={`/events/${eventId}/communications`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="flex items-center gap-2 text-3xl font-bold">
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
                    Slug: <code className="rounded bg-muted px-1">{slugify(newName)}</code>
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

      {/* Toolbar: search + status filter */}
      {templates.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, subject, or slug…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
            {(["all", "active", "disabled"] as const).map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? "secondary" : "ghost"}
                size="sm"
                className="h-7 capitalize"
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {filtered.length} of {templates.length} shown
          </span>
        </div>
      )}

      {/* System templates */}
      {systemTemplates.length > 0 && (
        <div className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            System Templates
            <span className="text-sm font-normal text-muted-foreground">({systemTemplates.length})</span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {systemTemplates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isCustom={false}
                eventId={eventId}
                onDelete={handleDelete}
                deleting={deletingId === template.id}
              />
            ))}
          </div>
        </div>
      )}

      {/* Custom templates */}
      {customTemplates.length > 0 && (
        <div className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            Custom Templates
            <span className="text-sm font-normal text-muted-foreground">({customTemplates.length})</span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {customTemplates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isCustom={true}
                eventId={eventId}
                onDelete={handleDelete}
                deleting={deletingId === template.id}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty states */}
      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Mail className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">No email templates found. They will be created automatically.</p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Search className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">No templates match your filters.</p>
            {hasFilters && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
