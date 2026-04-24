"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, FileText, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface TemplateMeta {
  url: string;
  filename: string;
  uploadedAt: string;
  uploadedBy: string;
}

interface Props {
  eventId: string;
}

const MERGE_TOKENS: Array<{ token: string; description: string }> = [
  { token: "{title}", description: "Speaker title prefix (e.g. Dr.)" },
  { token: "{firstName}", description: "Speaker first name" },
  { token: "{lastName}", description: "Speaker last name" },
  { token: "{speakerName}", description: "Full prefixed name (e.g. Dr. Jane Smith)" },
  { token: "{speakerEmail}", description: "Speaker email" },
  { token: "{eventName}", description: "Event name" },
  { token: "{eventStartDate}", description: "Event start date" },
  { token: "{eventEndDate}", description: "Event end date" },
  { token: "{eventVenue}", description: "Event venue" },
  { token: "{eventAddress}", description: "Event address" },
  { token: "{organizationName}", description: "Organization name" },
  { token: "{sessionTitles}", description: "All sessions the speaker is on (newline-separated)" },
  { token: "{topicTitles}", description: "All topics assigned to the speaker (newline-separated)" },
  { token: "{sessionDateTime}", description: "First session start (formatted)" },
  { token: "{trackNames}", description: "Distinct track names" },
  { token: "{role}", description: "Session roles (Speaker / Moderator / Chairperson / Panelist)" },
];

export function SpeakerAgreementTemplateCard({ eventId }: Props) {
  const [template, setTemplate] = useState<TemplateMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/speaker-agreement-template`);
        if (res.ok) {
          const data = (await res.json()) as { template: TemplateMeta | null };
          setTemplate(data.template);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [eventId]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/events/${eventId}/speaker-agreement-template`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");
      setTemplate(data.template);
      toast.success("Template uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (!confirm("Remove the speaker agreement template? Existing scheduled emails will fail until a new template is uploaded.")) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/speaker-agreement-template`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Delete failed");
      }
      setTemplate(null);
      toast.success("Template removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker Agreement Template (.docx)</CardTitle>
        <CardDescription>
          Optional. Upload a .docx template with merge tokens for a fully-designed Word-format
          attachment. When uploaded, this takes precedence over the inline HTML body.
          <span className="block mt-2 text-xs">
            No .docx uploaded? Each speaker gets a PDF generated from the inline Speaker
            Agreement HTML (edited in <strong>Event → Content → Speaker Agreement</strong>).
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading template...
          </div>
        ) : template ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="flex items-start gap-3">
              <FileText className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div>
                <p className="font-medium text-sm">{template.filename}</p>
                <p className="text-xs text-muted-foreground">
                  Uploaded {new Date(template.uploadedAt).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Replace
              </Button>
              <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 cursor-pointer hover:bg-muted/30"
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-8 w-8 text-muted-foreground" />
            )}
            <div className="text-center">
              <p className="text-sm font-medium">
                {uploading ? "Uploading..." : "Click to upload .docx template"}
              </p>
              <p className="text-xs text-muted-foreground">Max 2MB</p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />

        <div className="rounded-lg bg-muted/50 p-4">
          <p className="text-sm font-medium mb-3">Available merge tokens</p>
          <p className="text-xs text-muted-foreground mb-3">
            Use these tokens with single curly braces in your .docx template. They will be replaced
            with the speaker&apos;s actual data when the email is sent.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {MERGE_TOKENS.map((t) => (
              <div key={t.token} className="flex items-baseline gap-2">
                <code className="font-mono bg-background px-1.5 py-0.5 rounded border">{t.token}</code>
                <span className="text-muted-foreground">{t.description}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
