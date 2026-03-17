"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
import {
  ArrowLeft,
  Save,
  Eye,
  Send,
  RotateCcw,
  Copy,
  Mail,
  Trash2,
} from "lucide-react";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import {
  useEmailTemplate,
  useUpdateEmailTemplate,
  useResetEmailTemplate,
  usePreviewEmailTemplate,
  useDeleteEmailTemplate,
} from "@/hooks/use-api";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { toast } from "sonner";
import { stripDocumentWrapper } from "@/lib/email-utils";

// Lazy-load Tiptap editor to avoid bloating other pages
const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  { ssr: false, loading: () => <div className="h-[350px] border rounded-md animate-pulse bg-muted/50" /> }
);

const SYSTEM_SLUGS = new Set([
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "custom-notification",
]);

export default function EmailTemplateEditorPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const templateId = params.templateId as string;

  const { data, isLoading } = useEmailTemplate(eventId, templateId);
  const updateMutation = useUpdateEmailTemplate(eventId);
  const resetMutation = useResetEmailTemplate(eventId);
  const previewMutation = usePreviewEmailTemplate(eventId);
  const deleteMutation = useDeleteEmailTemplate(eventId);

  // Track the server data version to know when to re-initialize form
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [htmlContent, setHtmlContent] = useState("");
  const [textContent, setTextContent] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Key to force re-mount TiptapEditor when server data reloads
  const [editorKey, setEditorKey] = useState(0);

  // Re-initialize form when server data changes
  const serverUpdatedAt = data?.template?.updatedAt ?? null;
  if (serverUpdatedAt && serverUpdatedAt !== syncedAt && data?.template) {
    setSyncedAt(serverUpdatedAt);
    setSubject(data.template.subject);
    // Strip document wrapper for backwards compat with old full-document templates
    const bodyContent = stripDocumentWrapper(data.template.htmlContent);
    setHtmlContent(bodyContent);
    setTextContent(data.template.textContent || "");
    setIsActive(data.template.isActive);
    setDirty(false);
    setEditorKey((k) => k + 1);
  }

  const handleSave = useCallback(async () => {
    try {
      await updateMutation.mutateAsync({
        templateId,
        data: { subject, htmlContent, textContent, isActive },
      });
      setDirty(false);
      toast.success("Template saved");
    } catch {
      toast.error("Failed to save template");
    }
  }, [updateMutation, templateId, subject, htmlContent, textContent, isActive]);

  const handleReset = useCallback(async () => {
    try {
      await resetMutation.mutateAsync(templateId);
      toast.success("Template reset to default");
    } catch {
      toast.error("Failed to reset template");
    }
  }, [resetMutation, templateId]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(templateId);
      toast.success("Template deleted");
      router.push(`/events/${eventId}/email-templates`);
    } catch {
      toast.error("Failed to delete template");
    }
  }, [deleteMutation, templateId, router, eventId]);

  const handlePreview = useCallback(async () => {
    try {
      // Save first if dirty
      if (dirty) {
        await updateMutation.mutateAsync({
          templateId,
          data: { subject, htmlContent, textContent, isActive },
        });
        setDirty(false);
      }
      const result = await previewMutation.mutateAsync({
        templateId,
        action: "preview",
      });
      if (result.htmlContent) {
        setPreviewHtml(result.htmlContent);
        setPreviewOpen(true);
      }
    } catch {
      toast.error("Failed to generate preview");
    }
  }, [dirty, updateMutation, previewMutation, templateId, subject, htmlContent, textContent, isActive]);

  const handleTestEmail = useCallback(async () => {
    try {
      if (dirty) {
        await updateMutation.mutateAsync({
          templateId,
          data: { subject, htmlContent, textContent, isActive },
        });
        setDirty(false);
      }
      const result = await previewMutation.mutateAsync({
        templateId,
        action: "test",
      });
      if (result.success) {
        toast.success(result.message || "Test email sent");
      } else {
        toast.error(result.message || "Failed to send test email");
      }
    } catch {
      toast.error("Failed to send test email");
    }
  }, [dirty, updateMutation, previewMutation, templateId, subject, htmlContent, textContent, isActive]);

  const insertVariable = useCallback(
    (varKey: string) => {
      setHtmlContent((prev) => prev + `{{${varKey}}}`);
      setDirty(true);
      setEditorKey((k) => k + 1);
    },
    []
  );

  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  if (!data?.template) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Template not found</p>
      </div>
    );
  }

  const template = data.template;
  const variables = data.variables || [];
  const isSystemTemplate = SYSTEM_SLUGS.has(template.slug);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}/settings`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Mail className="h-6 w-6" />
              {template.name}
            </h1>
            {!isActive && <Badge variant="secondary">Disabled</Badge>}
          </div>
          <p className="text-muted-foreground text-sm">
            Slug: <code className="bg-muted px-1 rounded">{template.slug}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSystemTemplate ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset to Default
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset template?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will overwrite your customizations with the default template. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleReset}>Reset</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete template?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete this custom template. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreview}
            disabled={previewMutation.isPending}
          >
            <Eye className="mr-2 h-4 w-4" />
            Preview
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestEmail}
            disabled={previewMutation.isPending}
          >
            <Send className="mr-2 h-4 w-4" />
            Send Test
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending || !dirty}
            size="sm"
          >
            <Save className="mr-2 h-4 w-4" />
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* Editor */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Template Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Active</Label>
                  <p className="text-sm text-muted-foreground">Enable or disable this template</p>
                </div>
                <Switch
                  checked={isActive}
                  onCheckedChange={(checked) => {
                    setIsActive(checked);
                    setDirty(true);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="subject">Subject Line</Label>
                <Input
                  id="subject"
                  value={subject}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Email subject with {{variables}}"
                  className="font-mono text-sm"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Email Content</CardTitle>
              <CardDescription>
                Edit the email body visually or switch to source mode for raw HTML. Use {"{{variableName}}"} for personalization.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TiptapEditor
                key={editorKey}
                content={htmlContent}
                onChange={(html) => {
                  setHtmlContent(html);
                  setDirty(true);
                }}
                placeholder="Start writing your email content..."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Plain Text Fallback</CardTitle>
              <CardDescription>
                Shown to email clients that don&apos;t support HTML.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={textContent}
                onChange={(e) => {
                  setTextContent(e.target.value);
                  setDirty(true);
                }}
                rows={10}
                className="font-mono text-xs"
                placeholder="Plain text version of the email..."
              />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: Variables */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Variables</CardTitle>
              <CardDescription>
                Click to insert into email content
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {variables.map((v: { key: string; description: string }) => (
                  <button
                    key={v.key}
                    onClick={() => insertVariable(v.key)}
                    className="w-full text-left p-2 rounded-md hover:bg-muted transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      <code className="text-xs font-mono text-primary">
                        {`{{${v.key}}}`}
                      </code>
                      <Copy className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {v.description}
                    </p>
                  </button>
                ))}
                {variables.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No predefined variables for this template.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Preview Dialog */}
      <EmailPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        subject={subject}
        htmlContent={previewHtml || ""}
      />
    </div>
  );
}
