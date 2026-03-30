"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Users,
  Search,
  Filter,
  Download,
  RefreshCw,
  Share2,
  Plus,
  ChevronLeft,
  ChevronRight,
  Send,
  X,
  Tag,
  ArrowRightLeft,
} from "lucide-react";
import { formatDate, formatPersonName } from "@/lib/utils";
import { useRegistrations, useTickets, useEvent, useBulkTagRegistrations, useBulkUpdateRegistrationType } from "@/hooks/use-api";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import type { Registration, TicketType } from "./types";
import { registrationStatusColors, paymentStatusColors } from "./types";
import { RegistrationDetailSheet } from "./registration-detail-sheet";
import { ImportContactsButton } from "@/components/contacts/import-contacts-button";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { BarcodeImportDialog } from "./barcode-import-dialog";
import { BadgeDialog } from "./badge-dialog";

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

export default function RegistrationsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";

  // React Query hooks
  const registrationsQuery = useRegistrations(eventId);
  const registrations = (registrationsQuery.data ?? []) as Registration[];
  const { isLoading: loading, isFetching, refetch: refetchRegistrations } = registrationsQuery;
  const ticketsQuery = useTickets(eventId);
  const { data: ticketTypes = [] } = ticketsQuery;
  const { data: event } = useEvent(eventId);

  const handleRefresh = () => {
    refetchRegistrations();
    ticketsQuery.refetch();
  };

  // Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [ticketFilter, setTicketFilter] = useState<string>("all");

  // Sheet state for registration details
  const [selectedRegistration, setSelectedRegistration] = useState<Registration | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  const bulkTagRegistrations = useBulkTagRegistrations(eventId);
  const bulkUpdateType = useBulkUpdateRegistrationType(eventId);
  const [changeTypeDialogOpen, setChangeTypeDialogOpen] = useState(false);
  const [targetTypeId, setTargetTypeId] = useState<string>("");

  const handleRowClick = (registration: Registration) => {
    setSelectedRegistration(registration);
    setSheetOpen(true);
  };

  const exportToCSV = () => {
    const headers = [
      "Registration ID",
      "Title",
      "First Name",
      "Last Name",
      "Email",
      "Organization",
      "Job Title",
      "Phone",
      "City",
      "Country",
      "Bio",
      "Specialty",
      "Tags",
      "Registration Type",
      "Status",
      "Payment Status",
      "DTCM Barcode",
      "Registered Date",
      "Checked In Date",
      "Source",
      "Medium",
      "Campaign",
      "Referrer",
    ];

    const rows = filteredRegistrations.map((r) => [
      r.id,
      r.attendee.title || "",
      r.attendee.firstName,
      r.attendee.lastName,
      r.attendee.email,
      r.attendee.organization || "",
      r.attendee.jobTitle || "",
      r.attendee.phone || "",
      r.attendee.city || "",
      r.attendee.country || "",
      r.attendee.bio || "",
      r.attendee.specialty || "",
      r.attendee.tags.join(", "),
      r.ticketType.name,
      r.status,
      r.paymentStatus,
      r.dtcmBarcode || "",
      formatDate(r.createdAt),
      r.checkedInAt ? formatDate(r.checkedInAt) : "",
      r.utmSource || "",
      r.utmMedium || "",
      r.utmCampaign || "",
      r.referrer || "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `registrations-${eventId}.csv`;
    link.click();
  };

  // Filter registrations
  const filteredRegistrations = registrations.filter((r) => {
    const matchesSearch =
      searchQuery === "" ||
      r.attendee.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.attendee.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.attendee.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.attendee.organization &&
        r.attendee.organization.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === "all" || r.status === statusFilter;
    const matchesPayment = paymentFilter === "all" || r.paymentStatus === paymentFilter;
    const matchesTicket = ticketFilter === "all" || r.ticketType.id === ticketFilter;

    return matchesSearch && matchesStatus && matchesPayment && matchesTicket;
  });

  // Pagination
  const totalFiltered = filteredRegistrations.length;
  const totalPages = Math.ceil(totalFiltered / pageSize);
  const safePage = Math.min(page, Math.max(1, totalPages));
  const paginatedRegistrations = filteredRegistrations.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  const stats = {
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "CONFIRMED").length,
    pending: registrations.filter((r) => r.status === "PENDING").length,
    checkedIn: registrations.filter((r) => r.status === "CHECKED_IN").length,
    paid: registrations.filter((r) => r.paymentStatus === "PAID").length,
  };

  // Selection helpers
  const allOnPageSelected = paginatedRegistrations.length > 0 && paginatedRegistrations.every((r) => selectedIds.has(r.id));
  const someOnPageSelected = paginatedRegistrations.some((r) => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        paginatedRegistrations.forEach((r) => next.delete(r.id));
      } else {
        paginatedRegistrations.forEach((r) => next.add(r.id));
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

  const showDelayedLoader = useDelayedLoading(loading, 1000);

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
            <Users className="h-8 w-8" />
            Registrations
            {isFetching && !loading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage attendee registrations
          </p>
        </div>
        <div className="ps-4 pl-4 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={isFetching}
            title="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {!isReviewer && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (event?.slug) {
                  const url = `${window.location.origin}/e/${event.slug}`;
                  navigator.clipboard.writeText(url);
                  toast.success("Registration link copied to clipboard");
                } else {
                  toast.error("Event slug not available");
                }
              }}
              disabled={!event?.slug}
            >
              <Share2 className="mr-2 h-4 w-4" />
              Share Link
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
          {!isReviewer && (
            <>
              {registrations.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setBulkEmailOpen(true)}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {selectedIds.size > 0 ? `Email (${selectedIds.size})` : "Email All"}
                </Button>
              )}
              <CSVImportButton eventId={eventId} entityType="registrations" />
              <BarcodeImportDialog eventId={eventId} />
              <BadgeDialog eventId={eventId} selectedIds={selectedIds} totalCount={registrations.length} />
              <ImportContactsButton eventId={eventId} mode="registration" />
              <Button asChild className="btn-gradient shadow-sm">
                <Link href={`/events/${eventId}/registrations/new`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Registration
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
            {selectedIds.size} registration{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setTargetTypeId(""); setChangeTypeDialogOpen(true); }}
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Change Type
            </Button>
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
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total
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
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Checked In
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">{stats.checkedIn}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.paid}</div>
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
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                <SelectItem value="WAITLISTED">Waitlisted</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="CHECKED_IN">Checked In</SelectItem>
              </SelectContent>
            </Select>
            <Select value={paymentFilter} onValueChange={(v) => { setPaymentFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Payment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Payment</SelectItem>
                <SelectItem value="UNPAID">Unpaid</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="REFUNDED">Refunded</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ticketFilter} onValueChange={(v) => { setTicketFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Registration Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {(ticketTypes as TicketType[]).map((regType) => (
                  <SelectItem key={regType.id} value={regType.id}>
                    {regType.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
                setPaymentFilter("all");
                setTicketFilter("all");
              }}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Registrations Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {totalFiltered === registrations.length
              ? `All Registrations (${registrations.length})`
              : `Showing ${totalFiltered} of ${registrations.length}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {totalFiltered === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              {registrations.length === 0
                ? "No registrations yet. Click 'Add Registration' to register your first attendee."
                : "No registrations match your filters."}
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
                        aria-label="Select all registrations on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead>Attendee</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedRegistrations.map((registration) => (
                  <TableRow
                    key={registration.id}
                    className={`cursor-pointer hover:bg-muted/50 ${selectedIds.has(registration.id) ? "bg-primary/5" : ""}`}
                    onClick={() => handleRowClick(registration)}
                  >
                    {!isReviewer && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(registration.id)}
                          onCheckedChange={() => toggleSelect(registration.id)}
                          aria-label={`Select ${registration.attendee.firstName} ${registration.attendee.lastName}`}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div>
                        <div className="font-medium">
                          {formatPersonName(registration.attendee.title, registration.attendee.firstName, registration.attendee.lastName)}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {registration.attendee.email}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {registration.attendee.specialty || "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {registration.attendee.tags && registration.attendee.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {registration.attendee.tags.map((tag, index) => (
                            <Badge key={index} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{registration.ticketType.name}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={registrationStatusColors[registration.status]} variant="outline">
                        {registration.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={paymentStatusColors[registration.paymentStatus]} variant="outline">
                        {registration.paymentStatus}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(registration.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalFiltered > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, totalFiltered)} of {totalFiltered}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">Show</span>
              <select
                title="Rows per page"
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

      {/* Registration Detail Sheet */}
      <RegistrationDetailSheet
        eventId={eventId}
        registration={selectedRegistration}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      {/* Bulk Tag Dialog */}
      <BulkTagDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        selectedCount={selectedIds.size}
        entityLabel="registration"
        existingTags={(() => {
          const allTags = new Set<string>();
          registrations.forEach((r) => r.attendee.tags?.forEach((t: string) => allTags.add(t)));
          return [...allTags].sort();
        })()}
        isPending={bulkTagRegistrations.isPending}
        onSubmit={async (tags, mode) => {
          await bulkTagRegistrations.mutateAsync({
            registrationIds: [...selectedIds],
            tags,
            mode,
          });
          const verb = mode === "add" ? "added to" : mode === "remove" ? "removed from" : "replaced on";
          toast.success(`Tags ${verb} ${selectedIds.size} registration${selectedIds.size !== 1 ? "s" : ""}`);
          setSelectedIds(new Set());
        }}
      />

      {/* Bulk Change Type Dialog */}
      <Dialog open={changeTypeDialogOpen} onOpenChange={setChangeTypeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change Registration Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Move {selectedIds.size} selected registration{selectedIds.size !== 1 ? "s" : ""} to a new type. Cancelled registrations will be skipped.
            </p>
            <Select value={targetTypeId} onValueChange={setTargetTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select target type" />
              </SelectTrigger>
              <SelectContent>
                {(ticketTypes as TicketType[]).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>{rt.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangeTypeDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={!targetTypeId || bulkUpdateType.isPending}
              onClick={async () => {
                try {
                  const result = await bulkUpdateType.mutateAsync({
                    registrationIds: [...selectedIds],
                    ticketTypeId: targetTypeId,
                  }) as { updated: number };
                  const typeName = (ticketTypes as TicketType[]).find((t) => t.id === targetTypeId)?.name;
                  toast.success(`${result.updated} registration${result.updated !== 1 ? "s" : ""} moved to "${typeName}"`);
                  setChangeTypeDialogOpen(false);
                  setSelectedIds(new Set());
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to update");
                }
              }}
            >
              {bulkUpdateType.isPending ? "Updating..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Email Dialog */}
      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        eventId={eventId}
        recipientType="registrations"
        recipientIds={Array.from(selectedIds)}
        recipientCount={selectedIds.size > 0 ? selectedIds.size : filteredRegistrations.length}
        selectionMode={selectedIds.size > 0 ? "selected" : "all"}
        statusFilter={statusFilter}
        ticketTypeFilter={ticketFilter}
      />
    </div>
  );
}
