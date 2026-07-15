"use client";

/**
 * Create or edit a CRM email template. `template` present = edit, absent = create.
 * The body is the same rich editor + token set as the send dialog, so what you save
 * here is exactly what "Start from a template" pre-fills there.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateCrmEmailTemplate, useUpdateCrmEmailTemplate } from "@/crm/hooks/use-crm-api";
import type { CrmEmailTemplateRow } from "@/crm/lib/crm-types";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  { ssr: false, loading: () => <div className="h-40 animate-pulse rounded-md border bg-muted/30" /> },
);

const TOKENS = ["{{firstName}}", "{{lastName}}", "{{companyName}}", "{{eventName}}"];

export function CrmEmailTemplateDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template?: CrmEmailTemplateRow | null;
}) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [saving, setSaving] = useState(false);

  const create = useCreateCrmEmailTemplate();
  const update = useUpdateCrmEmailTemplate(template?.id ?? "");

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Give the template a name");
      return;
    }
    if (!subject.trim()) {
      toast.error("Add a subject");
      return;
    }
    if (!body.trim() || body.replace(/<[^>]*>/g, "").trim() === "") {
      toast.error("Write a message body");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await update.mutateAsync({ name: name.trim(), subject: subject.trim(), body });
        toast.success("Template updated");
      } else {
        await create.mutateAsync({ name: name.trim(), subject: subject.trim(), body });
        toast.success("Template created");
      }
      onOpenChange(false);
    } catch {
      // hooks toast the error
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription asChild>
            <span>A reusable starting point for sponsor + deal emails — you can still edit each send.</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor="tpl-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sponsorship prospectus"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-subject">
              Subject <span className="text-destructive">*</span>
            </Label>
            <Input
              id="tpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Sponsorship opportunities — {{eventName}}"
            />
          </div>

          <div className="space-y-2">
            <Label>
              Body <span className="text-destructive">*</span>
            </Label>
            <TiptapEditor
              key={template?.id ?? "new"}
              content={body}
              onChange={setBody}
              placeholder="We'd be delighted to have {{companyName}} partner with us on {{eventName}}…"
            />
            <p className="text-xs text-muted-foreground">
              Personalize with{" "}
              {TOKENS.map((t, i) => (
                <span key={t}>
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{t}</code>
                  {i < TOKENS.length - 1 ? " " : ""}
                </span>
              ))}
              . A greeting (&ldquo;Dear {"{{firstName}}"},&rdquo;) is added automatically on send — don&apos;t repeat it here.
            </p>
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? "Save changes" : "Create template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
