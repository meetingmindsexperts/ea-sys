"use client";

/**
 * The Recipients tab of the Certificates page (Nov 11, 2026): everyone
 * assigned a certificate at this event and where each person stands, on one
 * row. Assigned, survey answered, certificate sent. It is the report the old
 * tag could not produce, and the place to see who still needs a click.
 *
 * It only reads (GET .../certificates/recipients) and assigns or removes
 * through the same two calls every other door uses. The states and their
 * wording come from src/lib/certificates/recipient-states.ts, shared with the
 * CSV export and the agent.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, ListPlus, Loader2, Search, UserPlus, X, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api-fetch";
import { downloadExport } from "@/lib/export-download";
import { assignmentSourceLabel } from "@/lib/certificates/assignments";
import {
  RECIPIENT_STATES,
  RECIPIENT_STATE_HINTS,
  RECIPIENT_STATE_LABELS,
  type RecipientState,
} from "@/lib/certificates/recipient-states";
import {
  useAssignCertificate,
  useCertificateRecipients,
  useUnassignCertificate,
  type AssignCertificateResponse,
  type CertificateRecipientRow,
  type CertificateRecipientsReport,
} from "@/hooks/use-api";
import { AssignCertificateDialog } from "./assign-certificate-dialog";

const ALL = "all";
const PAGE_SIZE = 50;

const STATE_STYLES: Record<RecipientState, string> = {
  SENT: "border-emerald-200 bg-emerald-50 text-emerald-800",
  ISSUED_NOT_SENT: "border-blue-200 bg-blue-50 text-blue-800",
  SENDING: "border-sky-200 bg-sky-50 text-sky-800",
  WAITING_FOR_SURVEY: "border-amber-200 bg-amber-50 text-amber-800",
  READY: "border-violet-200 bg-violet-50 text-violet-800",
  FAILED: "border-red-200 bg-red-50 text-red-800",
  REVOKED: "border-slate-200 bg-slate-50 text-slate-600",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-600",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface PanelTemplate {
  id: string;
  name: string;
  category: "ATTENDANCE" | "APPRECIATION";
  autoIssueOnSurvey: boolean;
}

interface CertificateRecipientsPanelProps {
  eventId: string;
  templates: PanelTemplate[];
  /** The certificate shown: a template id, or "all". Owned by the page so a template's "Recipients" link can set it. */
  templateFilter: string;
  onTemplateFilterChange: (value: string) => void;
  /** May assign and remove (certificates.templates.manage). */
  canManage: boolean;
}

export function CertificateRecipientsPanel({
  eventId,
  templates,
  templateFilter,
  onTemplateFilterChange,
  canManage,
}: CertificateRecipientsPanelProps) {
  const reportQuery = useCertificateRecipients(eventId);
  const unassign = useUnassignCertificate(eventId);

  const [stateFilter, setStateFilter] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const report = reportQuery.data;
  const day = useMemo(() => dayFormatter(report?.timezone), [report?.timezone]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (report?.rows ?? []).filter(
      (r) =>
        (templateFilter === ALL || r.templateId === templateFilter) &&
        (stateFilter === ALL || r.state === stateFilter) &&
        (needle === "" || r.name.toLowerCase().includes(needle) || (r.email ?? "").toLowerCase().includes(needle)),
    );
  }, [report?.rows, templateFilter, stateFilter, search]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function changeFilter(apply: () => void) {
    apply();
    setPage(1);
  }

  async function handleRemove(row: CertificateRecipientRow) {
    try {
      const res = await unassign.mutateAsync({
        templateId: row.templateId,
        ...(row.registrationId ? { registrationIds: [row.registrationId] } : { speakerIds: [row.speakerId!] }),
      });
      if (res.removed === 0) {
        toast.info(`${row.name} already holds "${row.templateName}", so they stay on its list. Revoke the certificate to take it back.`);
        return;
      }
      toast.success(`Removed ${row.name} from "${row.templateName}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove them");
    }
  }

  async function handleExport() {
    setExporting(true);
    const params = new URLSearchParams({ format: "csv" });
    if (templateFilter !== ALL) params.set("templateId", templateFilter);
    const res = await downloadExport({
      url: `/api/events/${eventId}/certificates/recipients?${params.toString()}`,
      filename: "certificate-recipients.csv",
      logKey: "cert-recipients:export-failed",
      forbiddenMessage: "You do not have permission to export certificate recipients.",
    });
    setExporting(false);
    if (!res.ok) toast.error(res.error ?? "Export failed.");
  }

  if (reportQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading recipients
        </CardContent>
      </Card>
    );
  }
  if (reportQuery.isError || !report) {
    return (
      <Card>
        <CardContent className="py-10 text-sm text-red-700">
          The recipients could not be loaded. Reload the page to try again.
        </CardContent>
      </Card>
    );
  }

  const shownTemplates = report.templates.filter((t) => templateFilter === ALL || t.id === templateFilter);

  return (
    <div className="space-y-6">
      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-sm text-muted-foreground">
            Create a certificate under Templates first. Then assign it to people here, or from the Registrations and
            Speakers pages.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shownTemplates.map((t) => (
              <TemplateSummary
                key={t.id}
                template={t}
                active={templateFilter === t.id}
                onClick={() => changeFilter(() => onTemplateFilterChange(templateFilter === t.id ? ALL : t.id))}
              />
            ))}
          </div>

          <Card>
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Recipients</CardTitle>
                  <CardDescription>
                    One line per person per certificate. Being on this list is what decides who receives a
                    certificate.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canManage && (
                    <Button variant="outline" size="sm" onClick={() => setEmailsOpen(true)}>
                      <ListPlus className="mr-2 h-4 w-4" />
                      Add from a list of emails
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || report.rows.length === 0}>
                    {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    Export CSV
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={templateFilter} onValueChange={(v) => changeFilter(() => onTemplateFilterChange(v))}>
                  <SelectTrigger className="h-9 w-56" aria-label="Certificate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All certificates</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={stateFilter} onValueChange={(v) => changeFilter(() => setStateFilter(v))}>
                  <SelectTrigger className="h-9 w-52" aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any status</SelectItem>
                    {RECIPIENT_STATES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {RECIPIENT_STATE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => changeFilter(() => setSearch(e.target.value))}
                    placeholder="Search name or email"
                    className="h-9 w-60 pl-8"
                    aria-label="Search recipients"
                  />
                </div>
                <span className="ml-auto text-xs text-muted-foreground">
                  {plural(rows.length, "line", "lines")}
                  {rows.length !== report.rows.length ? ` of ${report.rows.length}` : ""}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {report.rows.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                  Nobody is assigned a certificate yet. Select people on the Registrations page (or the Speakers page,
                  for an appreciation certificate) and choose <strong>Assign certificate</strong>, or add them here
                  from a list of emails.
                </p>
              ) : (
                <RecipientsTable
                  rows={visible}
                  day={day}
                  canManage={canManage}
                  removing={unassign.isPending}
                  onRemove={handleRemove}
                />
              )}
              {rows.length > PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                  <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only">Previous page</span>
                  </Button>
                  <span className="text-muted-foreground">
                    Page {currentPage} of {pageCount}
                  </span>
                  <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
                    <ChevronRight className="h-4 w-4" />
                    <span className="sr-only">Next page</span>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <AnsweredNotAssigned eventId={eventId} people={report.answeredNotAssigned} day={day} canManage={canManage} />
        </>
      )}

      <AssignFromEmailsDialog
        eventId={eventId}
        open={emailsOpen}
        onOpenChange={setEmailsOpen}
        templates={templates}
        initialTemplateId={templateFilter === ALL ? null : templateFilter}
      />
    </div>
  );
}

/** A date as the event's own day. */
function dayFormatter(timeZone: string | undefined): (iso: string | null | undefined) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" });
  } catch {
    format = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  return (iso) => (iso ? format.format(new Date(iso)) : "");
}

function TemplateSummary({
  template,
  active,
  onClick,
}: {
  template: CertificateRecipientsReport["templates"][number];
  active: boolean;
  onClick: () => void;
}) {
  const shown = RECIPIENT_STATES.filter((s) => template.counts[s] > 0);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/40"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{template.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{plural(template.assigned, "person", "people")}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {template.category === "ATTENDANCE" ? "Attendance" : "Appreciation"}
        {template.autoIssueOnSurvey && (
          <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
            <Zap className="h-3 w-3" /> sent automatically after the survey
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {shown.length === 0 ? (
          <span className="text-xs text-amber-700">Nobody assigned yet</span>
        ) : (
          shown.map((s) => (
            <span key={s} className={`rounded-full border px-2 py-0.5 text-xs ${STATE_STYLES[s]}`}>
              {RECIPIENT_STATE_LABELS[s]} {template.counts[s]}
            </span>
          ))
        )}
      </div>
    </button>
  );
}

function RecipientsTable({
  rows,
  day,
  canManage,
  removing,
  onRemove,
}: {
  rows: CertificateRecipientRow[];
  day: (iso: string | null | undefined) => string;
  canManage: boolean;
  removing: boolean;
  onRemove: (row: CertificateRecipientRow) => void;
}) {
  if (rows.length === 0) {
    return <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">Nobody matches these filters.</p>;
  }
  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Certificate</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Survey answered</TableHead>
              <TableHead>Certificate no.</TableHead>
              <TableHead className="text-right">CME hours</TableHead>
              <TableHead>Assigned</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.assignmentId}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[r.email, r.registrationType ?? (r.kind === "speaker" ? "Speaker" : null)].filter(Boolean).join(" · ")}
                  </div>
                </TableCell>
                <TableCell>{r.templateName}</TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className={`cursor-help font-normal ${STATE_STYLES[r.state]}`}>
                        {RECIPIENT_STATE_LABELS[r.state]}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{RECIPIENT_STATE_HINTS[r.state]}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>{day(r.surveyAnsweredAt) || <span className="text-muted-foreground">Not yet</span>}</TableCell>
                <TableCell>
                  {r.certificate ? (
                    <>
                      <div className="font-mono text-xs">{r.certificate.serial}</div>
                      <div className="text-xs text-muted-foreground">{day(r.certificate.issuedAt)}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.cmeHours ?? ""}</TableCell>
                <TableCell>
                  <div className="text-xs">{day(r.assignedAt)}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.assignedByName ? `${r.assignedByName} · ` : ""}
                    {assignmentSourceLabel(r.source)}
                  </div>
                </TableCell>
                {canManage && (
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* A span, so the tooltip still shows on a disabled button. */}
                        <span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={removing || r.certificate !== null}
                            onClick={() => onRemove(r)}
                            aria-label={`Remove ${r.name} from ${r.templateName}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {r.certificate ? "They hold the certificate, so they stay on its list" : "Remove from this certificate's list"}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}

/** Answered the certificate survey, and assigned nothing: a tag used to lose these people silently. */
function AnsweredNotAssigned({
  eventId,
  people,
  day,
  canManage,
}: {
  eventId: string;
  people: CertificateRecipientsReport["answeredNotAssigned"];
  day: (iso: string | null | undefined) => string;
  canManage: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  if (people.length === 0) return null;

  const allSelected = people.every((p) => selected.has(p.registrationId));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Answered the survey, not assigned a certificate ({people.length})</CardTitle>
            <CardDescription>
              These people answered the certificate survey and are on no certificate&apos;s list, so nothing is sent
              to them. Assign a certificate if they should receive one.
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" disabled={selected.size === 0} onClick={() => setAssignOpen(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Assign certificate{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-80 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(c) => setSelected(c === true ? new Set(people.map((p) => p.registrationId)) : new Set())}
                      aria-label="Select everyone"
                    />
                  </TableHead>
                )}
                <TableHead>Person</TableHead>
                <TableHead>Registration type</TableHead>
                <TableHead>Survey answered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map((p) => (
                <TableRow key={p.registrationId}>
                  {canManage && (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(p.registrationId)}
                        onCheckedChange={(c) => toggle(p.registrationId, c === true)}
                        aria-label={`Select ${p.name}`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.email}</div>
                  </TableCell>
                  <TableCell>{p.registrationType ?? ""}</TableCell>
                  <TableCell>{day(p.surveyAnsweredAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <AssignCertificateDialog
        eventId={eventId}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        kind="registration"
        ids={[...selected]}
        onDone={() => setSelected(new Set())}
      />
    </Card>
  );
}

/** Addresses out of whatever was pasted: a column from a spreadsheet, a comma list, a whole export. */
export function emailsFromText(text: string): string[] {
  const found = text.match(/[^\s,;<>()"']+@[^\s,;<>()"']+\.[^\s,;<>()"']+/g) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

/**
 * Assign a certificate to the people behind a pasted list of emails: the
 * attendance export from the webinar platform, typically. Two steps, so the
 * addresses that match nobody are seen before anything is assigned.
 */
function AssignFromEmailsDialog({
  eventId,
  open,
  onOpenChange,
  templates,
  initialTemplateId,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: PanelTemplate[];
  initialTemplateId: string | null;
}) {
  const assign = useAssignCertificate(eventId);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<AssignCertificateResponse | null>(null);

  const chosenId = templateId ?? initialTemplateId ?? templates[0]?.id ?? null;
  const chosen = templates.find((t) => t.id === chosenId) ?? null;
  const emails = useMemo(() => emailsFromText(text), [text]);

  function close(next: boolean) {
    if (assign.isPending) return;
    if (!next) {
      setText("");
      setPreview(null);
      setTemplateId(null);
    }
    onOpenChange(next);
  }

  async function check() {
    if (!chosen) return;
    try {
      setPreview(await assign.mutateAsync({ templateId: chosen.id, emails, dryRun: true }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check the list");
    }
  }

  async function confirm() {
    if (!chosen || !preview) return;
    try {
      // The preview showed how many certificates go out at once: that is the agreement.
      const res = await assign.mutateAsync({ templateId: chosen.id, emails, confirmSendNow: true });
      const sending = res.sendNow > 0 ? ` ${plural(res.sendNow, "certificate is", "certificates are")} being sent now.` : "";
      toast.success(`Assigned "${res.templateName}" to ${plural(res.assigned, "person", "people")}.${sending}`);
      close(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRM_SEND_NOW") {
        toast.error("The list changed since it was checked. Check it again.");
        setPreview(null);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Could not assign the certificate");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from a list of emails</DialogTitle>
          <DialogDescription>
            Paste the addresses of the people who should receive the certificate, for example the attendance export
            from your webinar platform. They are matched to this event&apos;s{" "}
            {chosen?.category === "APPRECIATION" ? "speakers" : "registrations"}.
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <EmailListPreview preview={preview} total={emails.length} />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Certificate</Label>
              <Select value={chosenId ?? ""} onValueChange={setTemplateId}>
                <SelectTrigger aria-label="Certificate">
                  <SelectValue placeholder="Choose a certificate" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-emails">Emails</Label>
              <Textarea
                id="cert-emails"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder={"jane@example.com\nsam@example.com"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                One per line, or separated by commas. {plural(emails.length, "address", "addresses")} found.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(null)} disabled={assign.isPending}>
                Back
              </Button>
              <Button onClick={confirm} disabled={assign.isPending || preview.assigned === 0}>
                {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Assign {plural(preview.assigned, "person", "people")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={assign.isPending}>
                Cancel
              </Button>
              <Button onClick={check} disabled={assign.isPending || !chosen || emails.length === 0}>
                {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Check the list
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailListPreview({ preview, total }: { preview: AssignCertificateResponse; total: number }) {
  const matched = preview.assigned + preview.alreadyAssigned;
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-1 rounded-md border p-3">
        <li>
          <strong>{plural(preview.assigned, "person", "people")}</strong> will be assigned.
        </li>
        {preview.alreadyAssigned > 0 && <li>{plural(preview.alreadyAssigned, "person is", "people are")} already assigned.</li>}
        <li className="text-muted-foreground">
          {matched} of {plural(total, "address", "addresses")} matched someone at this event.
        </li>
      </ul>
      {preview.sendNow > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <strong>{plural(preview.sendNow, "of them has", "of them have")} already answered the survey.</strong>{" "}
          {preview.sendNow === 1 ? "Their certificate" : "Their certificates"} will be emailed within a few minutes,
          with no review step.
        </div>
      )}
      <UnmatchedList title="Not found at this event" emails={preview.unmatched} />
      <UnmatchedList title="Registration cancelled" emails={preview.cancelled} />
    </div>
  );
}

function UnmatchedList({ title, emails }: { title: string; emails: string[] }) {
  if (emails.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {title} ({emails.length})
      </div>
      <div className="max-h-28 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {emails.map((e) => (
          <div key={e}>{e}</div>
        ))}
      </div>
    </div>
  );
}
