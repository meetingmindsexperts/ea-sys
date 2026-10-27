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
import { Eye, FileText, Loader2, Paperclip, Pencil, Send, Users, X } from "lucide-react";
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
import {
  useCrmDealDocuments,
  useCrmEmailRecipients,
  useSendCrmEmail,
  useCrmEmailTemplates,
  useUploadCrmDealDocument,
  crmEmailTargetField,
  type CrmEmailTarget,
} from "@/crm/hooks/use-crm-api";
import { CRM_EMAIL_INLINE_ATTACHMENT_BUDGET } from "@/lib/body-limits";
import { CRM_EMAIL_TOKENS } from "@/crm/lib/crm-email-tokens";
import { CrmEmailPreviewPane } from "@/crm/components/crm-email-preview-pane";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  {
    ssr: false,
    loading: () => <div className="h-40 animate-pulse rounded-md border bg-muted/30" />,
  },
);

const MAX_FILES = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB total
/** Files sent inside the request travel as base64, a third bigger than on disk. */
const INLINE_MB = Math.floor((CRM_EMAIL_INLINE_ATTACHMENT_BUDGET * 3) / 4 / 1_048_576);
const BLANK = "__blank__";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function recipientListState(
  isLoading: boolean,
  isError: boolean,
  count: number,
): "loading" | "error" | "empty" | "list" {
  if (isLoading) return "loading";
  if (isError) return "error";
  if (count === 0) return "empty";
  return "list";
}

/** Split a comma/space/semicolon-separated address field into valid + invalid. */
function parseAddressField(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)) {
    (EMAIL_RE.test(part) ? emails : invalid).push(part);
  }
  return { emails, invalid };
}

function encodedSize(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function readBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? null);
    reader.onerror = () => {
      toast.error(`Failed to read ${file.name}`);
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

/** The deal whose documents a send can attach: the deal itself, or a reply's conversation's deal. */
function documentDealId(target: CrmEmailTarget | null): string | null {
  if (target?.kind === "deal") return target.id;
  if (target?.kind === "thread") return target.dealId;
  return null;
}

/** A reply starts as "Re: <subject>", once. */
function defaultSubject(target: CrmEmailTarget | null): string {
  if (target?.kind !== "thread") return "";
  return /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`;
}

const TITLES = { deal: "Email deal contacts", event: "Email sponsors", thread: "Reply" } as const;

const DESCRIPTIONS = {
  deal: "Send a personalized email to the people on this deal.",
  event: "Send a personalized cover email + attachment to the contacts on this event's active deals.",
  thread: "Reply in this conversation. It joins the same thread in their mail client, and their answer comes back here.",
} as const;

const EMPTY_RECIPIENTS = {
  deal: "No contacts on this deal yet. Add the people you're talking to first.",
  event: "No sponsor contacts for this event yet. Add contacts to its deals first.",
  thread: "This conversation has nobody to reply to.",
} as const;

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
  const { data, isLoading, isError, error: recipientsError } = useCrmEmailRecipients(open ? target : null);
  const { data: templates = [] } = useCrmEmailTemplates();
  // Files stored ON the deal (the prospectus etc.) — offered as opt-in
  // attachments on deal sends, resolved server-side (no re-upload per send).
  const dealId = documentDealId(target);
  const { data: dealDocuments = [] } = useCrmDealDocuments(open ? dealId : null);
  const send = useSendCrmEmail();
  const uploadDoc = useUploadCrmDealDocument(dealId ?? "");

  const [subject, setSubject] = useState(() => defaultSubject(target));
  const [message, setMessage] = useState("");
  // Tiptap reads `content` only on mount — bump this to remount it when a template
  // is applied so the editor shows the new body.
  const [editorNonce, setEditorNonce] = useState(0);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  // Stored deal documents the sender HAS ticked (opt-in — owner decision).
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  // Contacts the sender has UNticked. Everyone starts selected.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  // CC/BCC (manual) + "send me a copy" (auto-BCC the sender, default ON).
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [copyToSender, setCopyToSender] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Preview swaps the form for the rendered email; the form stays mounted
  // (hidden) so the editor and every field keep what was typed.
  const [previewing, setPreviewing] = useState(false);

  const recipients = useMemo(() => data?.recipients ?? [], [data]);
  const selectedIds = useMemo(
    () => recipients.filter((r) => !deselected.has(r.crmContactId)).map((r) => r.crmContactId),
    [recipients, deselected],
  );
  const selectedDocs = dealDocuments.filter((d) => selectedDocIds.has(d.id));
  const totalAttachmentSize =
    attachments.reduce((s, a) => s + a.size, 0) + selectedDocs.reduce((s, d) => s + d.size, 0);
  const totalFileCount = attachments.length + selectedDocs.length;
  const inlineEncoded = attachments.reduce((s, a) => s + a.content.length, 0);
  const kind = target?.kind ?? "event";
  const listState = recipientListState(isLoading, isError, recipients.length);

  function resetAndClose() {
    setSubject(defaultSubject(target));
    setMessage("");
    setEditorNonce((n) => n + 1);
    setAttachments([]);
    setSelectedDocIds(new Set());
    setDeselected(new Set());
    setCc("");
    setBcc("");
    setCopyToSender(true);
    setPreviewing(false);
    onOpenChange(false);
  }

  function toggleDoc(id: string) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyTemplate(id: string) {
    if (id === BLANK) {
      setSubject("");
      setMessage("");
    } else {
      const tpl = templates.find((t) => t.id === id);
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

  /**
   * On a deal, a PDF is saved to the deal's documents and ticked, so it is
   * attached on the server and never rides the send request (Oct 27, 2026: a
   * 10MB PDF became a 13MB request that nginx refused). Anything else, and every
   * file on an event-wide send, goes inline and must fit the encoded budget.
   */
  async function saveToDeal(file: File): Promise<boolean> {
    try {
      const { document } = await uploadDoc.mutateAsync({ file, kind: "OTHER" });
      setSelectedDocIds((prev) => new Set(prev).add(document.id));
      return true;
    } catch {
      return false; // the upload hook toasts the reason
    }
  }

  async function handleFileAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    let total = totalAttachmentSize;
    let inline = inlineEncoded;
    setUploading(true);
    try {
      for (const file of files.slice(0, MAX_FILES - totalFileCount)) {
        if (total + file.size > MAX_ATTACHMENT_SIZE) {
          toast.error("Total attachment size exceeds 10MB");
          break;
        }
        if (dealId && file.type === "application/pdf") {
          if (await saveToDeal(file)) total += file.size;
          continue;
        }
        if (inline + encodedSize(file.size) > CRM_EMAIL_INLINE_ATTACHMENT_BUDGET) {
          const what = dealId ? "files other than PDFs" : "attachments";
          toast.error(`${file.name} does not fit: ${what} can add up to ${INLINE_MB}MB`);
          break;
        }
        const base64 = await readBase64(file);
        if (!base64) continue;
        total += file.size;
        inline += base64.length;
        setAttachments((prev) => [
          ...prev,
          { name: file.name, content: base64, contentType: file.type || undefined, size: file.size },
        ]);
      }
    } finally {
      setUploading(false);
    }
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

    if (totalFileCount > MAX_FILES) {
      toast.error(`At most ${MAX_FILES} attachments (deal documents included)`);
      return;
    }

    const ccParsed = parseAddressField(cc);
    const bccParsed = parseAddressField(bcc);
    const firstInvalid = ccParsed.invalid[0] ?? bccParsed.invalid[0];
    if (firstInvalid) {
      toast.error(`Not a valid CC/BCC email: ${firstInvalid}`);
      return;
    }

    setSending(true);
    try {
      const result = await send.mutateAsync({
        [crmEmailTargetField(target)]: target.id,
        subject: subject.trim(),
        message,
        contactIds: selectedIds,
        attachments: attachments.map((a) => ({ name: a.name, content: a.content, contentType: a.contentType })),
        ...(dealId && selectedDocIds.size > 0 ? { documentIds: [...selectedDocIds] } : {}),
        ...(ccParsed.emails.length ? { cc: ccParsed.emails } : {}),
        ...(bccParsed.emails.length ? { bcc: bccParsed.emails } : {}),
        copyToSender,
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
  const title = data?.target ? `${TITLES[kind]} — ${data.target.name}` : "Email";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : resetAndClose())}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <span>{DESCRIPTIONS[kind]}</span>
          </DialogDescription>
        </DialogHeader>

        {previewing && target && (
          <CrmEmailPreviewPane
            target={target}
            recipients={recipients.filter((r) => !deselected.has(r.crmContactId))}
            subject={subject}
            message={message}
          />
        )}
        <div className={previewing ? "hidden" : "flex-1 space-y-4 overflow-y-auto pr-1"}>
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

            {listState === "loading" && <div className="h-40 animate-pulse rounded-md border bg-muted/30" />}
            {listState === "error" && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {/* The server's reason when it gave one (a reply on an archived deal's conversation). */}
                {recipientsError instanceof Error && recipientsError.message !== "Request failed"
                  ? recipientsError.message
                  : "Couldn't load the contact list. Close and try again."}
              </p>
            )}
            {listState === "empty" && (
              <p className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
                {EMPTY_RECIPIENTS[kind]}
              </p>
            )}
            {listState === "list" && (
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

          {/* ── CC / BCC + copy-to-me ──────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="crm-email-cc">CC</Label>
                <Input
                  id="crm-email-cc"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="manager@…, teammate@…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="crm-email-bcc">BCC</Label>
                <Input
                  id="crm-email-bcc"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="hidden@…"
                />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={copyToSender}
                onCheckedChange={(v) => setCopyToSender(v === true)}
              />
              Send a copy to me — so it shows in my Outlook too
            </label>
            <p className="text-xs text-muted-foreground">
              Separate multiple addresses with commas. CC/BCC applies to every recipient.
            </p>
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
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
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
              {CRM_EMAIL_TOKENS.map((t, i) => (
                <span key={t}>
                  <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{t}</code>
                  {i < CRM_EMAIL_TOKENS.length - 1 ? " " : ""}
                </span>
              ))}
              . A greeting is added automatically.
            </p>
          </div>

          {/* ── Stored deal documents (opt-in) ─────────────────────────────── */}
          {!!dealId && dealDocuments.length > 0 && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Deal documents
                <span className="text-xs font-normal text-muted-foreground">
                  — tick to attach (stored on the deal, nothing to re-upload)
                </span>
              </Label>
              <ul className="space-y-1">
                {dealDocuments.map((d) => (
                  <li key={d.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-md border bg-muted/20 px-2.5 py-1.5 text-sm hover:bg-muted/40">
                      <Checkbox checked={selectedDocIds.has(d.id)} onCheckedChange={() => toggleDoc(d.id)} />
                      <span className="min-w-0 flex-1 truncate">
                        {d.kind === "PROSPECTUS" && (
                          <Badge variant="outline" className="mr-2 border-sky-200 bg-sky-50 text-[10px] text-sky-700">
                            Prospectus
                          </Badge>
                        )}
                        {d.kind === "QUOTE" && (
                          <Badge variant="outline" className="mr-2 border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                            Quote
                          </Badge>
                        )}
                        {d.label || d.filename}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {(d.size / 1024).toFixed(0)} KB
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Attachments ────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              Attachments{" "}
              <span className="text-xs text-muted-foreground">
                {dealId
                  ? `(up to ${MAX_FILES} files, 10MB total; PDFs are saved to the deal's documents)`
                  : `(up to ${MAX_FILES} files, ${INLINE_MB}MB total)`}
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
            {totalFileCount < MAX_FILES && (
              <Input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg"
                onChange={handleFileAdd}
                disabled={uploading}
                className="cursor-pointer"
              />
            )}
            {uploading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Adding files…
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={resetAndClose} disabled={sending}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => setPreviewing((p) => !p)} disabled={sending || !target}>
            {previewing ? <Pencil className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {previewing ? "Edit" : "Preview"}
          </Button>
          <Button onClick={handleSend} disabled={sending || uploading || recipients.length === 0}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send to {selectedIds.length} contact{selectedIds.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
