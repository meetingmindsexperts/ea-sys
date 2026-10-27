"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MultiSelect } from "@/components/ui/multi-select";
import { StatTile, StatsRow } from "@/components/ui/typography";
import { canEmailListed, emailRecipientIds, matchesKind, type SpeakerKind } from "@/lib/speaker-kinds";
import { abstractStatusColor, abstractStatusLabel } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mic, Plus, RefreshCw, ChevronLeft, ChevronRight, Send, X, Search, Filter, Tag } from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import { formatSerialId } from "@/lib/registration-serial";
import { formatAttendeeRole } from "@/lib/schemas";
import { ImportRegistrationsButton } from "@/components/speakers/import-registrations-button";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { BulkEmailDialog, type BulkEmailEffectiveFilters } from "@/components/bulk-email-dialog";
import { useSpeakers, useEvent, useBulkTagSpeakers } from "@/hooks/use-api";
import { useSession } from "next-auth/react";
import { useCan, type CanStatus } from "@/hooks/use-can";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

const statusColors: Record<string, string> = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface Speaker {
  id: string;
  title: string | null;
  /** Profession / category (AttendeeRole enum: PHYSICIAN, ACADEMIA, …). */
  role: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  organization: string | null;
  jobTitle: string | null;
  bio: string | null;
  tags: string[];
  status: string;
  agreementAcceptedAt: string | null;
  /** Companion/linked registration (Speaker.sourceRegistrationId) — the
   * speaker's attendee facet. Null for speakers without one. */
  sourceRegistration: { serialId: number | null } | null;
  /** Abstracts and proposals are absent without abstracts.read / proposals.read (owner, Oct 27). */
  _count: { sessions: number; topicSpeakers?: number; abstracts?: number };
  abstracts?: { id: string; title: string; status: string }[];
  sessionProposals?: { status: string }[];
  /** The public sign-up door ("abstract" | "proposal" | "both"); null for speakers the organisers added. */
  submitterSource?: string | null;
}

const KIND_LABEL: Record<SpeakerKind, string> = { all: "All speakers", invited: "Invited speakers", submitters: "Abstract submitters", proposers: "Session proposers" };

/** Whether the list carries this field: the route sends it (an empty array included) only to who may read it. */
function sentOrAllowed(speakers: Speaker[], field: "abstracts" | "sessionProposals", answer: CanStatus): boolean {
  if (speakers.length > 0) return speakers.some((s) => s[field] !== undefined);
  return answer === "allowed";
}

/**
 * The tabs a caller can be shown. Telling an invited speaker from a submitter needs the abstracts, and from a
 * proposer the proposals, so a tab whose grouping the caller cannot see is left out rather than shown wrong.
 */
function visibleKinds(readAbstracts: boolean, readProposals: boolean, proposerCount: number): SpeakerKind[] {
  const both = readAbstracts && readProposals;
  return (["all", "invited", "submitters", "proposers"] as const).filter((k) => {
    if (k === "invited") return both;
    if (k === "submitters") return readAbstracts;
    if (k === "proposers") return both && proposerCount > 0;
    return true;
  });
}
const ABSTRACT_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED", "ACCEPTED", "REJECTED", "WITHDRAWN", "DRAFT"] as const;


function bulkEmailLabel(selectedCount: number, statusFilter: string, listed: number | null): string {
  if (selectedCount > 0) return `Email (${selectedCount})`;
  if (listed !== null) return `Email listed (${listed})`;
  if (statusFilter !== "all") return `Email ${statusFilter.charAt(0) + statusFilter.slice(1).toLowerCase()}`;
  return "Email All";
}

function triStateChecked(all: boolean, some: boolean): boolean | "indeterminate" {
  if (all) return true;
  return some ? "indeterminate" : false;
}

function bulkTagVerb(mode: string): string {
  if (mode === "add") return "added to";
  return mode === "remove" ? "removed from" : "replaced on";
}

export default function SpeakersPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";
  const canCreateSpeaker = useCan("speakers.create", eventId) === "allowed";
  const canImportSpeakers = useCan("speakers.import", eventId) === "allowed";
  const canTagSpeakers = useCan("speakers.update", eventId) === "allowed";
  const canSendEmail = useCan("communications.send", eventId) === "allowed";
  const canSelect = canTagSpeakers || canSendEmail;
  const abstractsAnswer = useCan("abstracts.read", eventId);
  const proposalsAnswer = useCan("proposals.read", eventId);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  const bulkTagSpeakers = useBulkTagSpeakers(eventId);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kind, setKind] = useState<SpeakerKind>("all");
  // Speakers with at least one abstract in these statuses; empty means any (submitters tab).
  const [abstractStatuses, setAbstractStatuses] = useState<string[]>([]);

  const { data: event } = useEvent(eventId);
  const { data: speakersData = [], isLoading: loading, isFetching, refetch } = useSpeakers(eventId);
  const speakers = speakersData as Speaker[];
  // The list itself says what the server let through (it is the authority), so the column and tabs show at once
  // instead of waiting on the permission answer; that answer is only needed for an empty list.
  const canReadAbstracts = sentOrAllowed(speakers, "abstracts", abstractsAnswer);
  const canReadProposals = sentOrAllowed(speakers, "sessionProposals", proposalsAnswer);

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  // Filter speakers
  const filteredSpeakers = speakers.filter((s) => {
    const matchesSearch =
      searchQuery === "" ||
      s.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.email && s.email.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (s.organization && s.organization.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === "all" || s.status === statusFilter;
    const matchesAbstract = kind !== "submitters" || abstractStatuses.length === 0 || (s.abstracts ?? []).some((a) => abstractStatuses.includes(a.status));

    return matchesSearch && matchesStatus && matchesKind(s, kind) && matchesAbstract;
  });
  // A tab or abstract filter narrows the list in ways the bulk-email audience cannot express, so "Email" then
  // sends to exactly the speakers listed rather than to every speaker of the status (owner, Oct 27).
  // (The abstract filter lives on the submitters tab, so any tab but "all" is a narrowing.) A search narrows too:
  // "Email" then sends to exactly who is listed on every tab, not only on some (review LOW, Oct 27).
  const narrowed = kind !== "all" || searchQuery.trim() !== "";
  const emailIds = emailRecipientIds(selectedIds, narrowed, filteredSpeakers);
  const kindCount = (k: SpeakerKind) => speakers.filter((s) => matchesKind(s, k)).length;
  const tabKinds = visibleKinds(canReadAbstracts, canReadProposals, kindCount("proposers"));

  // Live recipient count for the bulk-email dialog's "all" mode. Mirrors the
  // SEND semantics and excludes the search box (not sent to the backend). This
  // page only filters speakers by status; agreement/session dims are handled
  // for forward-compat if ever passed.
  const countSpeakersForEmail = (f: BulkEmailEffectiveFilters): number => {
    return speakers.filter((s) => {
      if (f.status && f.status !== "all" && s.status !== f.status) return false;
      if (f.agreementSigned === "signed" && !s.agreementAcceptedAt) return false;
      if (f.agreementSigned === "unsigned" && s.agreementAcceptedAt) return false;
      if (f.hasSession === "yes" && s._count.sessions === 0) return false;
      if (f.hasSession === "no" && s._count.sessions > 0) return false;
      return true;
    }).length;
  };

  // Pagination
  const totalSpeakers = filteredSpeakers.length;
  const totalPages = Math.ceil(totalSpeakers / pageSize);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const paginatedSpeakers = filteredSpeakers.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  // The stats follow the tab and the filters, as the table does.
  const stats = {
    total: filteredSpeakers.length,
    confirmed: filteredSpeakers.filter((s) => s.status === "CONFIRMED").length,
    invited: filteredSpeakers.filter((s) => s.status === "INVITED").length,
    declined: filteredSpeakers.filter((s) => s.status === "DECLINED").length,
    accepted: filteredSpeakers.filter((s) => (s.abstracts ?? []).some((a) => a.status === "ACCEPTED")).length,
  };

  // Selection helpers
  const allOnPageSelected = paginatedSpeakers.length > 0 && paginatedSpeakers.every((s) => selectedIds.has(s.id));
  const someOnPageSelected = paginatedSpeakers.some((s) => selectedIds.has(s.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        paginatedSpeakers.forEach((s) => next.delete(s.id));
      } else {
        paginatedSpeakers.forEach((s) => next.add(s.id));
      }
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Mic className="h-6 w-6 shrink-0 text-primary" />
            Speakers
            {isFetching && !loading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage speakers{event?.name ? ` for ${event.name}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {!isReviewer && (
            <>
              {canSendEmail && canEmailListed(selectedIds.size, narrowed, filteredSpeakers.length, speakers.length) && (
                <Button
                  variant="outline"
                  onClick={() => setBulkEmailOpen(true)}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {bulkEmailLabel(selectedIds.size, statusFilter, narrowed ? filteredSpeakers.length : null)}
                </Button>
              )}
              {canImportSpeakers && <CSVImportButton eventId={eventId} entityType="speakers" />}
              {canImportSpeakers && <ImportRegistrationsButton eventId={eventId} />}
              {canCreateSpeaker && (
                <Button asChild>
                  <Link href={`/events/${eventId}/speakers/new`}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Speaker
                  </Link>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bulk Selection Toolbar */}
      {selectedIds.size > 0 && !isReviewer && canSelect && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3 shadow-sm">
          <span className="text-sm font-medium">
            {selectedIds.size} speaker{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2 ml-auto">
            {canTagSpeakers && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTagDialogOpen(true)}
              >
                <Tag className="mr-2 h-4 w-4" />
                Manage Tags
              </Button>
            )}
            {canSendEmail && (
              <Button
                size="sm"
                onClick={() => setBulkEmailOpen(true)}
              >
                <Send className="mr-2 h-4 w-4" />
                Send Email
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
            >
              <X className="mr-2 h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Invited speakers and abstract submitters, apart (owner, Oct 27). The Session proposers tab only on an
          event that has proposers; no tab bar at all for a caller who can tell no group apart. */}
      {tabKinds.length > 1 && (
        <Tabs value={kind} onValueChange={(v) => { setKind(v as SpeakerKind); setAbstractStatuses([]); setPage(1); setSelectedIds(new Set()); }}>
          <TabsList className="max-w-full justify-start overflow-x-auto">
            {tabKinds.map((k) => (
              <TabsTrigger key={k} value={k}>
                {KIND_LABEL[k]} <span className="ml-1.5 tabular-nums text-muted-foreground">{kindCount(k)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {/* Stats */}
      <Card className="gap-0 py-0">
        <CardContent className="px-5">
          <StatsRow label={KIND_LABEL[kind]} hint={filteredSpeakers.length !== kindCount(kind) ? "Matching the filters" : undefined}>
            <StatTile compact label="Total" value={stats.total} />
            <StatTile compact label="Confirmed" value={stats.confirmed} valueClassName="text-green-600" />
            <StatTile compact label="Awaiting reply" value={stats.invited} valueClassName="text-yellow-600" />
            <StatTile compact label="Declined" value={stats.declined} valueClassName="text-red-600" />
            {canReadAbstracts && (kind === "all" || kind === "submitters") && <StatTile compact label="Abstract accepted" value={stats.accepted} valueClassName="text-blue-600" />}
          </StatsRow>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="speaker-search"
                  aria-label="Search speakers"
                  placeholder="Search by name, email, or organization..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                  className="pl-9"
                />
              </div>
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[150px]">
                <Filter className="mr-2 h-4 w-4" />
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="INVITED">Invited</SelectItem>
                <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                <SelectItem value="DECLINED">Declined</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            {kind === "submitters" && (
              <MultiSelect
                className="w-[220px]"
                options={ABSTRACT_STATUSES.map((st) => ({ value: st, label: abstractStatusLabel(st) }))}
                selected={abstractStatuses}
                onChange={(next) => { setAbstractStatuses(next); setPage(1); }}
                placeholder="Any abstract status"
                searchPlaceholder="Search statuses..."
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
                setAbstractStatuses([]);
              }}
              title="Clear filters"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Speakers Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {totalSpeakers === kindCount(kind)
              ? `${KIND_LABEL[kind]} (${totalSpeakers})`
              : `Showing ${totalSpeakers} of ${kindCount(kind)} ${KIND_LABEL[kind].toLowerCase()}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {speakers.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              {canCreateSpeaker
                ? <>No speakers yet. Click &quot;Add Speaker&quot; to get started.</>
                : "No speakers yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {!isReviewer && canSelect && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={triStateChecked(allOnPageSelected, someOnPageSelected)}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all speakers on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-20">Reg #</TableHead>
                  <TableHead>Speaker</TableHead>
                  <TableHead className="w-48 max-w-48">Organization</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Sessions</TableHead>
                  {canReadAbstracts && <TableHead>Abstracts</TableHead>}
                  <TableHead>Agreement</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedSpeakers.map((speaker) => (
                  <TableRow
                    key={speaker.id}
                    className={`cursor-pointer hover:bg-muted/50 ${selectedIds.has(speaker.id) ? "bg-primary/5" : ""}`}
                    onClick={() => router.push(`/events/${eventId}/speakers/${speaker.id}`)}
                  >
                    {!isReviewer && canSelect && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(speaker.id)}
                          onCheckedChange={() => toggleSelect(speaker.id)}
                          aria-label={`Select ${speaker.firstName} ${speaker.lastName}`}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {formatSerialId(speaker.sourceRegistration?.serialId)}
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">
                          {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                        </div>
                        {speaker.email && (
                          <div className="text-sm text-muted-foreground">{speaker.email}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48">
                      <div className="text-sm">
                        <div className="truncate" title={speaker.organization || undefined}>
                          {speaker.organization || "—"}
                        </div>
                        {speaker.jobTitle && (
                          <div className="text-muted-foreground text-xs truncate" title={speaker.jobTitle}>
                            {speaker.jobTitle}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {formatAttendeeRole(speaker.role, "—")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {speaker.tags && speaker.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {speaker.tags.slice(0, 3).map((tag, index) => (
                            <Badge key={index} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {speaker.tags.length > 3 && (
                            <Badge variant="outline" className="text-xs">+{speaker.tags.length - 3}</Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{speaker._count.sessions}</TableCell>
                    {canReadAbstracts && (
                    <TableCell className="text-center">
                      <div>{speaker._count.abstracts ?? 0}</div>
                      {speaker.abstracts && speaker.abstracts.length > 0 && (
                        <div className="mt-1 flex flex-wrap justify-center gap-1">
                          {[...new Set(speaker.abstracts.map((a) => a.status))].map((st) => (
                            <Badge key={st} variant="outline" className={`text-[10px] ${abstractStatusColor(st)}`}>
                              {abstractStatusLabel(st)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    )}
                    <TableCell>
                      {speaker.agreementAcceptedAt ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          Accepted
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Pending</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[speaker.status] ?? "bg-gray-100 text-gray-800"} variant="outline">
                        {speaker.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

        {/* Pagination */}
        {totalSpeakers > 0 && (
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, totalSpeakers)} of {totalSpeakers}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-muted-foreground">Show</span>
                <select
                  id="speakers-page-size"
                  title="Speakers per page"
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="h-8 text-sm border border-input rounded-md px-2 bg-background cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
                <span className="text-sm text-muted-foreground">per page</span>
              </div>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={safePage === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-3 text-sm text-muted-foreground font-medium tabular-nums">
                  {safePage} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={safePage === totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

      {/* Bulk Tag Dialog */}
      <BulkTagDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        selectedCount={selectedIds.size}
        entityLabel="speaker"
        existingTags={(() => {
          const allTags = new Set<string>();
          speakers.forEach((s) => s.tags?.forEach((t: string) => allTags.add(t)));
          return [...allTags].sort();
        })()}
        isPending={bulkTagSpeakers.isPending}
        onSubmit={async (tags, mode) => {
          await bulkTagSpeakers.mutateAsync({
            speakerIds: [...selectedIds],
            tags,
            mode,
          });
          const verb = bulkTagVerb(mode);
          toast.success(`Tags ${verb} ${selectedIds.size} speaker${selectedIds.size !== 1 ? "s" : ""}`);
          setSelectedIds(new Set());
        }}
      />

      {/* Bulk Email Dialog */}
      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        eventId={eventId}
        recipientType="speakers"
        recipientIds={emailIds}
        recipientCount={selectedIds.size > 0 ? selectedIds.size : filteredSpeakers.length}
        selectionMode={selectedIds.size > 0 || narrowed ? "selected" : "all"}
        statusFilter={statusFilter}
        recipientCountFor={countSpeakersForEmail}
        fixedListOnly={narrowed && selectedIds.size === 0}
      />
    </div>
  );
}
