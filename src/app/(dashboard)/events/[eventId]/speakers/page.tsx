"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ImportRegistrationsButton } from "@/components/speakers/import-registrations-button";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";
import { useSpeakers, useEvent, useBulkTagSpeakers } from "@/hooks/use-api";
import { useSession } from "next-auth/react";
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
  firstName: string;
  lastName: string;
  email: string | null;
  organization: string | null;
  jobTitle: string | null;
  bio: string | null;
  tags: string[];
  status: string;
  _count: { sessions: number; abstracts: number };
}

export default function SpeakersPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  const bulkTagSpeakers = useBulkTagSpeakers(eventId);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: event } = useEvent(eventId);
  const { data: speakersData = [], isLoading: loading, isFetching, refetch } = useSpeakers(eventId);
  const speakers = speakersData as Speaker[];

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

    return matchesSearch && matchesStatus;
  });

  // Pagination
  const totalSpeakers = filteredSpeakers.length;
  const totalPages = Math.ceil(totalSpeakers / pageSize);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const paginatedSpeakers = filteredSpeakers.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  const stats = {
    total: speakers.length,
    confirmed: speakers.filter((s) => s.status === "CONFIRMED").length,
    invited: speakers.filter((s) => s.status === "INVITED").length,
    declined: speakers.filter((s) => s.status === "DECLINED").length,
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
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mic className="h-8 w-8" />
            Speakers
            {isFetching && !loading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
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
              {speakers.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setBulkEmailOpen(true)}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {selectedIds.size > 0 ? `Email (${selectedIds.size})` : statusFilter !== "all" ? `Email ${statusFilter.charAt(0) + statusFilter.slice(1).toLowerCase()}` : "Email All"}
                </Button>
              )}
              <CSVImportButton eventId={eventId} entityType="speakers" />
              <ImportRegistrationsButton eventId={eventId} />
              <Button asChild>
                <Link href={`/events/${eventId}/speakers/new`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Speaker
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bulk Selection Toolbar */}
      {selectedIds.size > 0 && !isReviewer && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3 shadow-sm">
          <span className="text-sm font-medium">
            {selectedIds.size} speaker{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTagDialogOpen(true)}
            >
              <Tag className="mr-2 h-4 w-4" />
              Manage Tags
            </Button>
            <Button
              size="sm"
              onClick={() => setBulkEmailOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              Send Email
            </Button>
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

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Speakers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Confirmed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.confirmed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Invited
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.invited}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Declined
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.declined}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
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
            {totalSpeakers === speakers.length
              ? `All Speakers (${speakers.length})`
              : `Showing ${totalSpeakers} of ${speakers.length}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {speakers.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No speakers yet. Click &quot;Add Speaker&quot; to get started.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {!isReviewer && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all speakers on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead>Speaker</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Abstracts</TableHead>
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
                    {!isReviewer && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(speaker.id)}
                          onCheckedChange={() => toggleSelect(speaker.id)}
                          aria-label={`Select ${speaker.firstName} ${speaker.lastName}`}
                        />
                      </TableCell>
                    )}
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
                    <TableCell>
                      <div className="text-sm">
                        {speaker.organization || "—"}
                        {speaker.jobTitle && (
                          <div className="text-muted-foreground text-xs">{speaker.jobTitle}</div>
                        )}
                      </div>
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
                    <TableCell className="text-center">{speaker._count.abstracts}</TableCell>
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
          const verb = mode === "add" ? "added to" : mode === "remove" ? "removed from" : "replaced on";
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
        recipientIds={Array.from(selectedIds)}
        recipientCount={selectedIds.size > 0 ? selectedIds.size : filteredSpeakers.length}
        selectionMode={selectedIds.size > 0 ? "selected" : "all"}
        statusFilter={statusFilter}
      />
    </div>
  );
}
