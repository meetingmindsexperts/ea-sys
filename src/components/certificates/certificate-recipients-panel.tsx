"use client";

/**
 * The Recipients tab of the Certificates page: the ONE place to see who gets
 * which certificate, find a person, and assign or remove (owner, Nov 11,
 * 2026: "assigning and viewing and searching can be at one place").
 *
 * It lists everyone at the event, assigned or not: one line per person, one
 * column per certificate, each cell saying where that person stands. Attendance
 * certificates go to registrations and appreciation ones to speakers, so the
 * two are two views of the same table. Search and filter, tick people (or
 * everyone matching), assign.
 *
 * It reads one request (GET .../certificates/recipients?view=people) and
 * filters on the page (src/lib/certificates/people-filter.ts); it assigns and
 * removes through the same two calls every other door uses, so the "this
 * would email certificates now" question is the server's. The states and
 * their wording come from src/lib/certificates/recipient-states.ts, shared
 * with the CSV export and the agent.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, ListPlus, Loader2, Plus, Search, UserPlus, X, Zap } from "lucide-react";
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
import { downloadExport } from "@/lib/export-download";
import { assignmentSourceLabel, MAX_ASSIGNMENT_BATCH } from "@/lib/certificates/assignments";
import {
  EMPTY_PEOPLE_FILTER,
  PEOPLE_FILTER_ALL as ALL,
  isPeopleFilterActive,
  matchesPeopleFilter,
  type PeopleFilter,
  type PeopleStatusFilter,
} from "@/lib/certificates/people-filter";
import {
  RECIPIENT_STATES,
  RECIPIENT_STATE_HINTS,
  RECIPIENT_STATE_LABELS,
  type RecipientState,
} from "@/lib/certificates/recipient-states";
import {
  sendNowRefusalOf,
  useAssignCertificate,
  useCertificatePeople,
  useUnassignCertificate,
  type AssignCertificateResponse,
  type CertificatePerson,
  type CertificatePersonCell,
  type CertificateRecipientsTemplate,
} from "@/hooks/use-api";
import { AssignCertificateDialog } from "./assign-certificate-dialog";

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

/** Who a certificate is assigned to: attendance ones to registrations, appreciation ones to speakers. */
type Kind = "registration" | "speaker";
const kindOf = (category: "ATTENDANCE" | "APPRECIATION"): Kind => (category === "ATTENDANCE" ? "registration" : "speaker");

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

/** A send-now the server asked about, for one person: who, which certificate, how many, in its words. */
interface PendingSend {
  person: CertificatePerson;
  template: CertificateRecipientsTemplate;
  count: number;
  message: string;
}

export function CertificateRecipientsPanel({
  eventId,
  templates,
  templateFilter,
  onTemplateFilterChange,
  canManage,
}: CertificateRecipientsPanelProps) {
  const peopleQuery = useCertificatePeople(eventId);
  const assign = useAssignCertificate(eventId);
  const unassign = useUnassignCertificate(eventId);

  const [kindChoice, setKindChoice] = useState<Kind>("registration");
  const [filters, setFilters] = useState<Omit<PeopleFilter, "templateId">>(EMPTY_PEOPLE_FILTER);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);

  const report = peopleQuery.data;
  const day = useMemo(() => dayFormatter(report?.timezone), [report?.timezone]);

  // A chosen certificate decides whose table this is: its people.
  const chosenTemplate = templates.find((t) => t.id === templateFilter) ?? null;
  const kind: Kind = chosenTemplate ? kindOf(chosenTemplate.category) : kindChoice;
  // Plain values: the React Compiler memoizes them, and a manual useMemo here only gets in its way.
  const columns = (report?.templates ?? []).filter((t) => kindOf(t.category) === kind);
  const shownColumns = chosenTemplate ? columns.filter((t) => t.id === chosenTemplate.id) : columns;
  const everyone = (kind === "registration" ? report?.registrations : report?.speakers) ?? [];
  // A certificate that no longer exists (deleted in another tab) reads as "all".
  const chosenTemplateId = chosenTemplate?.id ?? ALL;
  const filter: PeopleFilter = { ...filters, templateId: chosenTemplateId };
  const columnIds = columns.map((c) => c.id);
  const matching = everyone.filter((p) => matchesPeopleFilter(p, filter, columnIds));
  const registrationTypes = [
    ...new Set((report?.registrations ?? []).flatMap((p) => (p.registrationType ? [p.registrationType] : []))),
  ].sort();

  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = matching.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  /** Any change of what is listed starts again from page one with nobody ticked. */
  function relist(apply: () => void) {
    apply();
    setPage(1);
    setSelected(new Set());
  }
  const setFilter = (patch: Partial<Omit<PeopleFilter, "templateId">>) => relist(() => setFilters((f) => ({ ...f, ...patch })));

  function changeKind(next: Kind) {
    relist(() => {
      // A certificate of the other kind cannot stay chosen.
      if (chosenTemplate && kindOf(chosenTemplate.category) !== next) onTemplateFilterChange(ALL);
      setKindChoice(next);
      setFilters(EMPTY_PEOPLE_FILTER);
    });
  }

  function chooseTemplate(value: string) {
    relist(() => {
      const next = templates.find((t) => t.id === value);
      const nextKind = next ? kindOf(next.category) : kind;
      // The other table has its own filters (a speaker has no registration type).
      if (nextKind !== kind) setFilters(EMPTY_PEOPLE_FILTER);
      setKindChoice(nextKind);
      onTemplateFilterChange(value);
    });
  }

  function showNoList() {
    relist(() => {
      onTemplateFilterChange(ALL);
      setKindChoice("registration");
      setFilters({ ...EMPTY_PEOPLE_FILTER, status: "NO_LIST" });
    });
  }

  const idsBody = (template: { category: "ATTENDANCE" | "APPRECIATION" }, id: string) =>
    kindOf(template.category) === "registration" ? { registrationIds: [id] } : { speakerIds: [id] };

  /** `confirmed`: the count the person agreed to send now; the server asks again if it has grown. */
  async function assignOne(person: CertificatePerson, template: CertificateRecipientsTemplate, confirmed?: number) {
    try {
      const res = await assign.mutateAsync({ templateId: template.id, ...idsBody(template, person.id), confirmSendNow: confirmed });
      setPendingSend(null);
      const sending = res.sendNow > 0 ? ` ${plural(res.sendNow, "certificate is", "certificates are")} being sent now.` : "";
      toast.success(`Assigned "${template.name}" to ${person.name}.${sending}`);
    } catch (err) {
      const refusal = sendNowRefusalOf(err);
      if (refusal) {
        setPendingSend({ person, template, ...refusal });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Could not assign the certificate");
    }
  }

  async function removeOne(person: CertificatePerson, template: CertificateRecipientsTemplate) {
    try {
      const res = await unassign.mutateAsync({ templateId: template.id, ...idsBody(template, person.id) });
      if (res.removed === 0) {
        toast.info(`${person.name} already holds "${template.name}", so they stay on its list. Revoke the certificate to take it back.`);
        return;
      }
      toast.success(`Removed ${person.name} from "${template.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove them");
    }
  }

  async function handleExport() {
    setExporting(true);
    const params = new URLSearchParams({ format: "csv" });
    if (chosenTemplate) params.set("templateId", chosenTemplate.id);
    const res = await downloadExport({
      url: `/api/events/${eventId}/certificates/recipients?${params.toString()}`,
      filename: "certificate-recipients.csv",
      logKey: "cert-recipients:export-failed",
      forbiddenMessage: "You do not have permission to export certificate recipients.",
    });
    setExporting(false);
    if (!res.ok) toast.error(res.error ?? "Export failed.");
  }

  if (peopleQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading recipients
        </CardContent>
      </Card>
    );
  }
  if (peopleQuery.isError || !report) {
    return (
      <Card>
        <CardContent className="py-10 text-sm text-red-700">
          The recipients could not be loaded. Reload the page to try again.
        </CardContent>
      </Card>
    );
  }
  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-sm text-muted-foreground">
          Create a certificate under Templates first. Then come back here to choose who receives it.
        </CardContent>
      </Card>
    );
  }

  const noListCount = report.registrations.filter((p) => p.noList).length;
  const assignedLines = report.templates.reduce((sum, t) => sum + t.assigned, 0);
  const showKindSwitch = report.speakers.length > 0 || report.templates.some((t) => t.category === "APPRECIATION");
  const peopleWord = kind === "registration" ? "people" : "speakers";
  const allOnPage = visible.length > 0 && visible.every((p) => selected.has(p.id));
  const someOnPage = visible.some((p) => selected.has(p.id));
  const tooMany = selected.size > MAX_ASSIGNMENT_BATCH;
  const busy = assign.isPending || unassign.isPending;

  function togglePage(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of visible) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {report.templates.map((t) => (
          <TemplateSummary
            key={t.id}
            template={t}
            active={templateFilter === t.id}
            onClick={() => chooseTemplate(templateFilter === t.id ? ALL : t.id)}
          />
        ))}
      </div>

      {noListCount > 0 && filters.status !== "NO_LIST" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span>
            <strong>{noListNotice(noListCount)}</strong>, so nothing is sent to them.
          </span>
          <Button variant="outline" size="sm" onClick={showNoList}>
            Show them
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Recipients</CardTitle>
              <CardDescription className="max-w-xl">
                Everyone at this event and where they stand on each certificate. Being assigned is what decides who
                receives one: search, tick the people, assign.
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {canManage && (
                <Button variant="outline" size="sm" onClick={() => setEmailsOpen(true)}>
                  <ListPlus className="mr-2 h-4 w-4" />
                  Add from a list of emails
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || assignedLines === 0}>
                {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export CSV
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {showKindSwitch && (
              <div className="inline-flex w-fit rounded-md border p-0.5 text-sm" role="group" aria-label="Who to list">
                {(["registration", "speaker"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => changeKind(k)}
                    className={`rounded px-3 py-1 ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {k === "registration" ? `Attendees (${report.registrations.length})` : `Speakers (${report.speakers.length})`}
                  </button>
                ))}
              </div>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={filters.search}
                onChange={(e) => setFilter({ search: e.target.value })}
                placeholder="Search name or email"
                className="h-9 w-60 pl-8"
                aria-label="Search people"
              />
            </div>
            {kind === "registration" && registrationTypes.length > 1 && (
              <Select value={filters.registrationType} onValueChange={(v) => setFilter({ registrationType: v })}>
                <SelectTrigger className="h-9 w-48" aria-label="Registration type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any registration type</SelectItem>
                  {registrationTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {kind === "registration" && (
              <Select value={filters.attendance} onValueChange={(v) => setFilter({ attendance: v as PeopleFilter["attendance"] })}>
                <SelectTrigger className="h-9 w-44" aria-label="Checked in">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Checked in or not</SelectItem>
                  <SelectItem value="checked-in">Checked in</SelectItem>
                  <SelectItem value="not-checked-in">Not checked in</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select value={filters.survey} onValueChange={(v) => setFilter({ survey: v as PeopleFilter["survey"] })}>
              <SelectTrigger className="h-9 w-44" aria-label="Survey">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Survey: any</SelectItem>
                <SelectItem value="answered">Survey answered</SelectItem>
                <SelectItem value="not-answered">Survey not answered</SelectItem>
              </SelectContent>
            </Select>
            <Select value={chosenTemplateId} onValueChange={chooseTemplate}>
              <SelectTrigger className="h-9 w-52" aria-label="Certificate">
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
            <Select value={filters.status} onValueChange={(v) => setFilter({ status: v as PeopleStatusFilter })}>
              <SelectTrigger className="h-9 w-52" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any status</SelectItem>
                <SelectItem value="NOT_ASSIGNED">Not assigned</SelectItem>
                <SelectItem value="ASSIGNED">Assigned</SelectItem>
                {kind === "registration" && <SelectItem value="NO_LIST">Answered, on no list</SelectItem>}
                {RECIPIENT_STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {RECIPIENT_STATE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isPeopleFilterActive(filter) && (
              <Button variant="ghost" size="sm" onClick={() => relist(() => setFilters(EMPTY_PEOPLE_FILTER))}>
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {matching.length === everyone.length
                ? plural(everyone.length, kind === "registration" ? "person" : "speaker", peopleWord)
                : `${matching.length} of ${everyone.length} ${peopleWord}`}
            </span>
          </div>

          {canManage && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium">{plural(selected.size, "person", "people")} selected</span>
              {allOnPage && selected.size < matching.length && (
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => setSelected(new Set(matching.map((p) => p.id)))}
                >
                  Select all {matching.length} that match
                </button>
              )}
              <span className="ml-auto flex items-center gap-2">
                {tooMany && (
                  <span className="text-xs text-red-700">At most {MAX_ASSIGNMENT_BATCH} at once: narrow the list.</span>
                )}
                <Button size="sm" disabled={tooMany || shownColumns.length === 0} onClick={() => setBulkOpen(true)}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Assign or remove a certificate
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </span>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {columns.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              {kind === "registration"
                ? "This event has no certificate of attendance yet. Create one under Templates to assign it to attendees."
                : "This event has no certificate of appreciation yet. Create one under Templates to assign it to speakers."}
            </p>
          ) : (
            <PeopleTable
              people={visible}
              columns={shownColumns}
              kind={kind}
              day={day}
              canManage={canManage}
              busy={busy}
              selected={selected}
              headerChecked={headerState(allOnPage, someOnPage)}
              onTogglePage={togglePage}
              onToggle={toggleOne}
              onAssign={(person, template) => assignOne(person, template)}
              onRemove={removeOne}
              empty={everyone.length === 0 ? `No ${peopleWord} at this event yet.` : "Nobody matches these filters."}
            />
          )}
          {matching.length > PAGE_SIZE && (
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

      <AssignCertificateDialog
        eventId={eventId}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        kind={kind}
        ids={[...selected]}
        initialTemplateId={chosenTemplate?.id ?? null}
        onDone={() => setSelected(new Set())}
      />

      <Dialog open={pendingSend !== null} onOpenChange={(open) => !open && !assign.isPending && setPendingSend(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send certificates now?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingSend?.template.name}&rdquo; is sent automatically once a person has answered the
              certificate survey, and {pendingSend?.person.name} already has.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>{pendingSend?.message}</strong> They go out within a few minutes, with no review step.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSend(null)} disabled={assign.isPending}>
              Not now
            </Button>
            <Button
              disabled={assign.isPending}
              onClick={() => pendingSend && assignOne(pendingSend.person, pendingSend.template, pendingSend.count)}
            >
              {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Assign and send {plural(pendingSend?.count ?? 0, "certificate", "certificates")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AssignFromEmailsDialog
        eventId={eventId}
        open={emailsOpen}
        onOpenChange={setEmailsOpen}
        templates={templates}
        initialTemplateId={chosenTemplate?.id ?? null}
      />
    </div>
  );
}

/** "3 people have answered the survey and are on no certificate's list": one string, so no space is lost across lines. */
function noListNotice(n: number): string {
  return n === 1
    ? "1 person has answered the survey and is on no certificate's list"
    : `${n} people have answered the survey and are on no certificate's list`;
}

/** The header checkbox: ticked when the whole page is, a dash when part of it is. */
function headerState(all: boolean, some: boolean): boolean | "indeterminate" {
  if (all) return true;
  return some ? "indeterminate" : false;
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
  template: CertificateRecipientsTemplate;
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

/** One line per person, one column per certificate. */
function PeopleTable({
  people,
  columns,
  kind,
  day,
  canManage,
  busy,
  selected,
  headerChecked,
  onTogglePage,
  onToggle,
  onAssign,
  onRemove,
  empty,
}: {
  people: CertificatePerson[];
  columns: CertificateRecipientsTemplate[];
  kind: Kind;
  day: (iso: string | null | undefined) => string;
  canManage: boolean;
  busy: boolean;
  selected: ReadonlySet<string>;
  headerChecked: boolean | "indeterminate";
  onTogglePage: (on: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
  onAssign: (person: CertificatePerson, template: CertificateRecipientsTemplate) => void;
  onRemove: (person: CertificatePerson, template: CertificateRecipientsTemplate) => void;
  empty: string;
}) {
  if (people.length === 0) {
    return <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {canManage && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={headerChecked}
                    onCheckedChange={(c) => onTogglePage(c === true)}
                    aria-label="Select everyone on this page"
                  />
                </TableHead>
              )}
              <TableHead>Person</TableHead>
              {kind === "registration" && <TableHead>Checked in</TableHead>}
              <TableHead>Survey</TableHead>
              {columns.map((t) => (
                <TableHead key={t.id} className="min-w-44">
                  <span className="inline-flex items-center gap-1">
                    {t.name}
                    {t.autoIssueOnSurvey && (
                      <Zap className="h-3 w-3 text-amber-600" aria-label="Sent automatically after the survey" />
                    )}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <TableRow key={p.id} data-state={selected.has(p.id) ? "selected" : undefined}>
                {canManage && (
                  <TableCell>
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={(c) => onToggle(p.id, c === true)}
                      aria-label={`Select ${p.name}`}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[p.email, p.registrationType ?? (kind === "speaker" ? "Speaker" : null)].filter(Boolean).join(" · ")}
                  </div>
                </TableCell>
                {kind === "registration" && (
                  <TableCell className={p.checkedIn ? "" : "text-muted-foreground"}>{p.checkedIn ? "Yes" : "No"}</TableCell>
                )}
                <TableCell>{day(p.surveyAnsweredAt) || <span className="text-muted-foreground">Not yet</span>}</TableCell>
                {columns.map((t) => (
                  <TableCell key={t.id}>
                    <CertificateCell
                      person={p}
                      template={t}
                      cell={p.cells[t.id]}
                      day={day}
                      canManage={canManage}
                      busy={busy}
                      onAssign={() => onAssign(p, t)}
                      onRemove={() => onRemove(p, t)}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}

/** What a cell's tooltip adds to the state: who assigned it and how, and the certificate if there is one. */
function cellDetail(cell: CertificatePersonCell, day: (iso: string | null | undefined) => string): string {
  const by = cell.assignedByName ? `${cell.assignedByName}, ` : "";
  const hours = cell.cmeHours ? ` ${cell.cmeHours} CME hours.` : "";
  return `Assigned ${day(cell.assignedAt)} (${by}${assignmentSourceLabel(cell.source).toLowerCase()}).${hours}`;
}

/** One person on one certificate: where they stand, or the button that puts them on its list. */
function CertificateCell({
  person,
  template,
  cell,
  day,
  canManage,
  busy,
  onAssign,
  onRemove,
}: {
  person: CertificatePerson;
  template: CertificateRecipientsTemplate;
  cell: CertificatePersonCell | undefined;
  day: (iso: string | null | undefined) => string;
  canManage: boolean;
  busy: boolean;
  onAssign: () => void;
  onRemove: () => void;
}) {
  if (!cell) {
    // A cancelled registration is never assigned (and is only listed while on another list).
    if (!canManage || person.cancelled) return <span className="text-xs text-muted-foreground">Not assigned</span>;
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        disabled={busy}
        onClick={onAssign}
        aria-label={`Assign ${template.name} to ${person.name}`}
      >
        <Plus className="mr-1 h-3 w-3" />
        Assign
      </Button>
    );
  }
  // Someone who holds the certificate stays on its list: taking it back is revoking it.
  const holds = cell.certificate !== null && cell.state !== "REVOKED";
  return (
    <div className="flex items-center gap-1">
      <div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className={`cursor-help font-normal ${STATE_STYLES[cell.state]}`}>
              {RECIPIENT_STATE_LABELS[cell.state]}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>{RECIPIENT_STATE_HINTS[cell.state]}</p>
            <p className="mt-1 opacity-80">{cellDetail(cell, day)}</p>
          </TooltipContent>
        </Tooltip>
        {cell.certificate && (
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {cell.certificate.serial} · {day(cell.certificate.issuedAt)}
          </div>
        )}
      </div>
      {canManage && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A span, so the tooltip still shows on a disabled button. */}
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground"
                disabled={busy || holds}
                onClick={onRemove}
                aria-label={`Remove ${person.name} from ${template.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {holds ? "They hold the certificate, so they stay on its list" : "Remove from this certificate's list"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
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
      // The preview showed how many certificates go out at once: that number
      // is the agreement. If more have answered since, the server asks again.
      const res = await assign.mutateAsync({ templateId: chosen.id, emails, confirmSendNow: preview.sendNow });
      const sending = res.sendNow > 0 ? ` ${plural(res.sendNow, "certificate is", "certificates are")} being sent now.` : "";
      toast.success(`Assigned "${res.templateName}" to ${plural(res.assigned, "person", "people")}.${sending}`);
      close(false);
    } catch (err) {
      if (sendNowRefusalOf(err)) {
        toast.warning("More of these people have answered the survey since the list was checked. Here is the new count.");
        await check();
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
              <Button
                onClick={confirm}
                disabled={assign.isPending || preview.assigned === 0 || (preview.sendNow > 0 && !preview.sendNowAllowed)}
              >
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
      {preview.sendNow > 0 && <SendNowNotice preview={preview} />}
      <UnmatchedList title="Not found at this event" emails={preview.unmatched} />
      <UnmatchedList title="Registration cancelled" emails={preview.cancelled} />
    </div>
  );
}

/** What assigning this list sends at once, and whether you may. */
function SendNowNotice({ preview }: { preview: AssignCertificateResponse }) {
  const others = preview.sendNowByTemplate.some((t) => t.templateName !== preview.templateName);
  return (
    <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
      <p>
        <strong>
          {plural(preview.sendNowPeople, "of them has", "of them have")} already answered the survey, so{" "}
          {plural(preview.sendNow, "certificate", "certificates")} will be emailed
        </strong>{" "}
        within a few minutes of assigning, with no review step.
      </p>
      {others && (
        <p className="text-xs">
          {preview.sendNowByTemplate.map((t) => `${t.templateName} (${t.count})`).join(", ")}. That includes certificates
          from other templates they were already owed.
        </p>
      )}
      {!preview.sendNowAllowed && (
        <p className="text-xs font-medium">
          Sending certificates needs the Issue certificates permission. Ask someone who has it to assign this list.
        </p>
      )}
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
