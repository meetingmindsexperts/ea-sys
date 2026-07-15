"use client";

/**
 * Compose + send a CRM email — either to an EVENT's sponsors, or to ONE deal's
 * contacts (chosen by the `target` prop). One dialog, one send pipeline.
 *
 * "Recipients" = the deduped contacts the target resolves to. The list is
 * REVIEWABLE (deselect anyone) and always sent as an explicit selection, so the
 * audience is exactly what's on screen — the CRM's narrow-never-widen rule, made
 * visible. The body is personalized ({{firstName}} etc.), can be pre-filled from a
 * built-in template, and attachments (the prospectus) ride along.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, Send, Users, X } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmEmailRecipients, useSendCrmEmail, type CrmEmailTarget } from "@/crm/hooks/use-crm-api";
import { CRM_EMAIL_TEMPLATES } from "@/crm/lib/crm-email-templates";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  {
    ssr: false,
    loading: () => <div className="h-40 animate-pulse rounded-md border bg-muted/30" />,
  },
);

const MAX_FILES = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB total
const TOKENS = ["{{firstName}}", "{{lastName}}", "{{companyName}}", "{{eventName}}"];
const BLANK = "__blank__";

interface LocalAttachment {
  name: string;
  content: string; // base64
  contentType?: string;
  size: number;
}

export function CrmEmailDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: CrmEmailTarget | null;
}) {
  const { data, isLoading, isError } = useCrmEmailRecipients(open ? target : null);
  const send = useSendCrmEmail();

  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  // Tiptap reads `content` only on mount — bump this to remount it when a template
  // is applied so the editor shows the new body.
  const [editorNonce, setEditorNonce] = useState(0);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  // Contacts the sender has UNticked. Everyone starts selected.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const recipients = useMemo(() => data?.recipients ?? [], [data]);
  const selectedIds = useMemo(
    () => recipients.filter((r) => !deselected.has(r.crmContactId)).map((r) => r.crmContactId),
    [recipients, deselected],
  );
  const totalAttachmentSize = attachments.reduce((s, a) => s + a.size, 0);
  const isDeal = data?.target.kind === "deal";

  function resetAndClose() {
    setSubject("");
    setMessage("");
    setEditorNonce((n) => n + 1);
    setAttachments([]);
    setDeselected(new Set());
    onOpenChange(false);
  }

  function applyTemplate(id: string) {
    if (id === BLANK) {
      setSubject("");
      setMessage("");
    } else {
      const tpl = CRM_EMAIL_TEMPLATES.find((t) => t.id === id);
      if (!tpl) return;
      setSubject(tpl.subject);
      setMessage(tpl.body);
    }
    setEditorNonce((n) => n + 1); // remount the editor with the new body
  }

  function toggle(id: string) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAll(selected: boolean) {
    setDeselected(selected ? new Set() : new Set(recipients.map((r) => r.crmContactId)));
  }

  async function handleFileAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    const remaining = MAX_FILES - attachments.length;
    for (const file of Array.from(files).slice(0, remaining)) {
      if (totalAttachmentSize + file.size > MAX_ATTACHMENT_SIZE) {
        toast.error("Total attachment size exceeds 10MB");
        break;
      }
      const base64 = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? null);
        reader.onerror = () => {
          toast.error(`Failed to read ${file.name}`);
          resolve(null);
        };
        reader.readAsDataURL(file);
      });
      if (!base64) continue;
      setAttachments((prev) => [
        ...prev,
        { name: file.name, content: base64, contentType: file.type || undefined, size: file.size },
      ]);
    }
    e.target.value = "";
  }

  async function handleSend() {
    if (!target) return;
    if (!subject.trim()) {
      toast.error("Add a subject");
      return;
    }
    // Tiptap emits "<p></p>" for an empty body.
    if (!message.trim() || message.replace(/<[^>]*>/g, "").trim() === "") {
      toast.error("Write a message");
      return;
    }
    if (selectedIds.length === 0) {
      toast.error("Select at least one recipient");
      return;
    }

    setSending(true);
    try {
      const result = await send.mutateAsync({
        [target.kind === "deal" ? "dealId" : "eventId"]: target.id,
        subject: subject.trim(),
        message,
        contactIds: selectedIds,
        attachments: attachments.map((a) => ({ name: a.name, content: a.content, contentType: a.contentType })),
      });
      if (result.failureCount > 0) {
        toast.warning(`Sent to ${result.successCount} of ${result.total}`, {
          description: `${result.failureCount} failed — check the contacts' email history.`,
        });
      } else {
        toast.success(`Email sent to ${result.successCount} contact${result.successCount === 1 ? "" : "s"}`);
      }
      resetAndClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the email");
    } finally {
      setSending(false);
    }
  }

  const skipped = data?.skipped;
  const skippedTotal = (skipped?.noEmail ?? 0) + (skipped?.archivedContacts ?? 0);
  const title = data?.target
    ? `${isDeal ? "Email deal contacts" : "Email sponsors"} — ${data.target.name}`
    : "Email";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : resetAndClose())}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <span>
              {isDeal
                ? "Send a personalized email to the people on this deal."
                : "Send a personalized cover email + attachment to the contacts on this event's active deals."}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {/* ── Recipients ─────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Recipients
                {recipients.length > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {selectedIds.length} of {recipients.length} selected
                  </span>
                )}
              </Label>
              {recipients.length > 0 && (
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
                    All
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAll(false)}>
                    None
                  </Button>
                </div>
              )}
            </div>

            {isLoading ? (
              <div className="h-40 animate-pulse rounded-md border bg-muted/30" />
            ) : isError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                Couldn&apos;t load the contact list. Close and try again.
              </p>
            ) : recipients.length === 0 ? (
              <p className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
                {isDeal
                  ? "No contacts on this deal yet. Add the people you're talking to first."
                  : "No sponsor contacts for this event yet. Add contacts to its deals first."}
              </p>
            ) : (
              <ScrollArea className="h-52 rounded-md border">
                <ul className="divide-y">
                  {recipients.map((r) => {
                    const checked = !deselected.has(r.crmContactId);
                    return (
                      <li key={r.crmContactId}>
                        <label className="flex cursor-pointer items-center gap-3 p-2.5 hover:bg-muted/40">
                          <Checkbox checked={checked} onCheckedChange={() => toggle(r.crmContactId)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {r.firstName} {r.lastName}
                              {r.companyName && (
                                <span className="font-normal text-muted-foreground"> · {r.companyName}</span>
                              )}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{r.email}</span>
                          </span>
                          {r.dealCount > 1 && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {r.dealCount} deals
                            </Badge>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}

            {skippedTotal > 0 && (
              <p className="text-xs text-muted-foreground">
                {skipped?.noEmail ? `${skipped.noEmail} contact(s) skipped (no email)` : ""}
                {skipped?.noEmail && skipped?.archivedContacts ? " · " : ""}
                {skipped?.archivedContacts ? `${skipped.archivedContacts} archived` : ""}
              </p>
            )}
          </div>

          {/* ── Template ───────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Start from a template
            </Label>
            <Select onValueChange={applyTemplate}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Blank — write your own" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BLANK}>Blank — write your own</SelectItem>
                {CRM_EMAIL_TEMPLATES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Subject ────────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label htmlFor="crm-email-subject">
              Subject <span className="text-destructive">*</span>
            </Label>
            <Input
              id="crm-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Sponsorship opportunities — {{eventName}}"
            />
          </div>

          {/* ── Body ───────────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>
              Message <span className="text-destructive">*</span>
            </Label>
            <TiptapEditor
              key={editorNonce}
              content={message}
              onChange={setMessage}
              placeholder="Dear {{firstName}}, we'd love to have {{companyName}} on board for…"
            />
            <p className="text-xs text-muted-foreground">
              Personalize with{" "}
              {TOKENS.map((t, i) => (
                <span key={t}>
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{t}</code>
                  {i < TOKENS.length - 1 ? " " : ""}
                </span>
              ))}
              . A greeting is added automatically.
            </p>
          </div>

          {/* ── Attachments ────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              Attachments{" "}
              <span className="text-xs text-muted-foreground">
                (up to {MAX_FILES} files, 10MB total)
              </span>
            </Label>
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((a, i) => (
                  <li
                    key={`${a.name}-${i}`}
                    className="flex items-center justify-between rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="mx-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {(a.size / 1024).toFixed(0)} KB
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {attachments.length < MAX_FILES && (
              <Input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg"
                onChange={handleFileAdd}
                className="cursor-pointer"
              />
            )}
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={resetAndClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={sending || recipients.length === 0}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send to {selectedIds.length} contact{selectedIds.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
