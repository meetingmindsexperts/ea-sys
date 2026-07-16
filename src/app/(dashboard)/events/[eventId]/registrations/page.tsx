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
  Mail,
  ListChecks,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatDate, formatPersonName } from "@/lib/utils";
import { formatSerialId } from "@/lib/registration-serial";
import { toCsvRow } from "@/lib/csv-escape";
import { useRegistrations, useTickets, useEvent, useBulkTagRegistrations, useBulkUpdateRegistrationType, useSendCompletionEmails, useEventTags } from "@/hooks/use-api";
import { displayRegistrationType } from "@/lib/faculty-filter";
import { formatAttendeeRole } from "@/lib/schemas";
import { TagFilter } from "@/components/registrations/tag-filter";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import type { Registration, TicketType } from "./types";
import { isWebinar } from "@/lib/webinar";
import {
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_DISPLAY_ORDER,
  PAYMENT_STATUS_LABELS,
  REGISTRATION_STATUS_COLORS,
  REGISTRATION_STATUS_DISPLAY_ORDER,
  REGISTRATION_STATUS_LABELS,
} from "./registration-enums";
import { RegistrationDetailSheet } from "./registration-detail-sheet";
import { ImportContactsButton } from "@/components/contacts/import-contacts-button";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { BulkEmailDialog, type BulkEmailEffectiveFilters } from "@/components/bulk-email-dialog";
import { excludesCancelledByDefault } from "@/lib/bulk-email-audience";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { BarcodeImportDialog } from "./barcode-import-dialog";
import { BadgeDialog } from "./badge-dialog";
import { resolvePastedIds } from "./resolve-pasted-ids";

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

export default function RegistrationsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";
  // Registration-desk operators (ONSITE + MEMBER) can add registrations, print
  // badges, check in, and edit/record-payment via the detail sheet — but NOT
  // the bulk/import/share write actions on this list (those stay admin/
  // organizer). MEMBER additionally has full read elsewhere; ONSITE is
  // nav-restricted. On this list both get the same (no-bulk) treatment.
  const isOnsite = userSession?.user?.role === "ONSITE";
  const isMember = userSession?.user?.role === "MEMBER";
  const isDeskOperator = isOnsite || isMember;

  // Tag filter state declared up here so useRegistrations can read it.
  // Empty array = no filter (URL omits the `tags=` param).
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  // React Query hooks
  // NOTE: tags filter is threaded into the URL params here (NOT into
  // the client-side filteredRegistrations array) because Prisma can do
  // the tags.hasSome match more efficiently than pulling every row +
  // filtering in JS. The status/payment/ticket filters stay client-side
  // for now — refactoring those would invalidate cached pages on every
  // filter flip.
  const registrationsQuery = useRegistrations(
    eventId,
    tagFilter.length > 0 ? { tags: tagFilter.join(",") } : undefined,
  );
  const registrations = (registrationsQuery.data ?? []) as Registration[];
  const { isLoading: loading, isFetching, refetch: refetchRegistrations } = registrationsQuery;
  const ticketsQuery = useTickets(eventId);
  const { data: ticketTypes = [] } = ticketsQuery;
  const { data: event } = useEvent(eventId);
  const eventIsWebinar = isWebinar(event ?? undefined);
  const tagsQuery = useEventTags(eventId);

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
  // "Select by IDs" — paste a list (registration #, full ID, or email) copied
  // from a CSV and have it populate the selection, so the existing bulk
  // Email / Tag / Change-Type actions run on exactly those rows (mirrors the
  // EventsAir paste-IDs-then-bulk workflow).
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const [pasteIds, setPasteIds] = useState("");
  const [matchResult, setMatchResult] = useState<{ matched: string[]; unmatched: string[] } | null>(null);

  const bulkTagRegistrations = useBulkTagRegistrations(eventId);
  const bulkUpdateType = useBulkUpdateRegistrationType(eventId);
  const sendCompletionEmails = useSendCompletionEmails(eventId);
  const [changeTypeDialogOpen, setChangeTypeDialogOpen] = useState(false);
  const [targetTypeId, setTargetTypeId] = useState<string>("");
  // "Send registration form" confirmation: the action posts to a 5/hr
  // rate-limited route + writes EmailLog rows, so a single fat-finger
  // can blow the bucket. The confirm step + count display is the
  // friction we want.
  const [sendFormConfirmOpen, setSendFormConfirmOpen] = useState(false);

  const handleRowClick = (registration: Registration) => {
    setSelectedRegistration(registration);
    setSheetOpen(true);
  };

  const exportToCSV = () => {
    const headers = [
      "Registration ID",
      "Serial ID",
      "Title",
      "Role",
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
      "Pricing Tier",
      "Payer",
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
      formatSerialId(r.serialId),
      r.attendee.title || "",
      formatAttendeeRole(r.attendee.role, ""),
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
      displayRegistrationType({ ticketTypeName: r.ticketType?.name, isFaculty: r.ticketType?.isFaculty, attendeeRegistrationType: r.attendee.registrationType }, ""),
      r.pricingTier?.name ?? "",
      // Third-party payer; blank = attendee self-pays. Redacted server-side
      // for non-finance roles (the field simply isn't in their payload).
      r.billingAccount?.name ?? "",
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

    const csvContent = [headers.join(","), ...rows.map((row) => toCsvRow(row))].join("\n");

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
    const matchesTicket = ticketFilter === "all" || r.ticketType?.id === ticketFilter;

    return matchesSearch && matchesStatus && matchesPayment && matchesTicket;
  });

  // Live recipient count for the bulk-email dialog's "all" mode. Mirrors the
  // SEND semantics (status + payment + ticket) and deliberately EXCLUDES the
  // search box — free-text search isn't sent to the backend, so counting it
  // would over-report vs what actually goes out. paymentStatus may be a
  // comma-separated multi-value list.
  const countRegistrationsForEmail = (f: BulkEmailEffectiveFilters): number => {
    const payStatuses =
      f.paymentStatus && f.paymentStatus !== "all"
        ? f.paymentStatus.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
    return registrations.filter((r) => {
      if (f.status && f.status !== "all" && r.status !== f.status) return false;
      // Same rule the server applies to build the audience — imported, not
      // restated, so this count cannot drift from the actual send.
      if (excludesCancelledByDefault(f.emailType, f.status) && r.status === "CANCELLED")
        return false;
      if (payStatuses && !payStatuses.includes(r.paymentStatus)) return false;
      if (f.ticketTypeIds && f.ticketTypeIds.length > 0 && !(r.ticketType?.id && f.ticketTypeIds.includes(r.ticketType.id))) return false;
      if (f.badgeTypes && f.badgeTypes.length > 0 && !(r.badgeType && f.badgeTypes.includes(r.badgeType))) return false;
      if (f.tags && f.tags.length > 0 && !f.tags.some((t) => r.attendee.tags.includes(t))) return false;
      if (f.excludeFaculty && r.ticketType?.isFaculty) return false;
      return true;
    }).length;
  };

  // Distinct non-empty badge types present on the loaded registrations —
  // feeds the dialog's in-dialog Badge type checkbox list.
  const badgeOptionsForEmail = Array.from(
    new Set(
      registrations
        .map((r) => r.badgeType)
        .filter((b): b is string => !!b && b.trim().length > 0),
    ),
  ).sort();

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
    paid: registrations.filter((r) => r.paymentStatus === "PAID" || r.paymentStatus === "COMPLIMENTARY").length,
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

  const handleMatchPastedIds = () => setMatchResult(resolvePastedIds(pasteIds, registrations));

  const applyPastedSelection = () => {
    const result = matchResult ?? resolvePastedIds(pasteIds, registrations);
    if (result.matched.length === 0) {
      toast.error("No matching registrations found for those IDs.");
      return;
    }
    setSelectedIds(new Set(result.matched));
    setSelectByIdsOpen(false);
    setPasteIds("");
    setMatchResult(null);
    toast.success(
      `Selected ${result.matched.length} registration${result.matched.length !== 1 ? "s" : ""}` +
        (result.unmatched.length ? ` · ${result.unmatched.length} not found` : ""),
    );
  };

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
          {!isReviewer && !isDeskOperator && (
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
              {/* Management-only actions — hidden for ONSITE (desk staff). */}
              {!isDeskOperator && registrations.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setMatchResult(null); setSelectByIdsOpen(true); }}
                >
                  <ListChecks className="mr-2 h-4 w-4" />
                  Select by IDs
                </Button>
              )}
              {!isDeskOperator && registrations.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setBulkEmailOpen(true)}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {selectedIds.size > 0 ? `Email (${selectedIds.size})` : "Email All"}
                </Button>
              )}
              {!isDeskOperator && <CSVImportButton eventId={eventId} entityType="registrations" />}
              {/* DTCM barcode import is Dubai-only — only surface it when the
                  event is flagged (Settings → Registration). Keeps the import
                  path consistent with the now-gated DTCM field. */}
              {!isDeskOperator && event?.requiresDtcmBarcode && <BarcodeImportDialog eventId={eventId} />}
              {/* ONSITE keeps badge printing + add registration. */}
              <BadgeDialog eventId={eventId} selectedIds={selectedIds} totalCount={registrations.length} />
              {!isDeskOperator && <ImportContactsButton eventId={eventId} mode="registration" />}
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
      {selectedIds.size > 0 && !isReviewer && !isDeskOperator && (
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
              variant="outline"
              onClick={() => setSendFormConfirmOpen(true)}
              disabled={sendCompletionEmails.isPending}
            >
              <Mail className="mr-2 h-4 w-4" />
              Send Registration Form
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
                {REGISTRATION_STATUS_DISPLAY_ORDER.map((status) => (
                  <SelectItem key={status} value={status}>
                    {REGISTRATION_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={paymentFilter} onValueChange={(v) => { setPaymentFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Payment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Payment</SelectItem>
                {PAYMENT_STATUS_DISPLAY_ORDER.map((status) => (
                  <SelectItem key={status} value={status}>
                    {PAYMENT_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
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
            <TagFilter
              tags={tagsQuery.data?.tags}
              isLoading={tagsQuery.isLoading}
              selected={tagFilter}
              onChange={(next) => { setTagFilter(next); setPage(1); }}
            />
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
                  {!isReviewer && !isDeskOperator && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all registrations on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Attendee</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Payer</TableHead>
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
                    {!isReviewer && !isDeskOperator && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(registration.id)}
                          onCheckedChange={() => toggleSelect(registration.id)}
                          aria-label={`Select ${registration.attendee.firstName} ${registration.attendee.lastName}`}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatSerialId(registration.serialId)}
                      </span>
                    </TableCell>
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
                        {formatAttendeeRole(registration.attendee.role, "-")}
                      </span>
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
                      <Badge variant="outline">{displayRegistrationType({ ticketTypeName: registration.ticketType?.name, isFaculty: registration.ticketType?.isFaculty, attendeeRegistrationType: registration.attendee.registrationType })}</Badge>
                    </TableCell>
                    <TableCell>
                      {registration.pricingTier?.name ? (
                        <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">
                          {registration.pricingTier.name}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Third-party payer ("Charge to another account"). "—" =
                          self-pay, or the field was finance-redacted server-side. */}
                      {registration.billingAccount?.name ? (
                        <Badge variant="outline" className="bg-sky-50 text-sky-800 border-sky-200">
                          {registration.billingAccount.name}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={REGISTRATION_STATUS_COLORS[registration.status]} variant="outline">
                        {registration.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge className={PAYMENT_STATUS_COLORS[registration.paymentStatus]} variant="outline">
                          {registration.paymentStatus}
                        </Badge>
                        {registration.attendanceMode === "VIRTUAL" && (
                          <Badge variant="outline" className="bg-sky-100 text-sky-700 border-sky-200">
                            Virtual
                          </Badge>
                        )}
                        {eventIsWebinar && registration.webinarFirstJoinedAt && (
                          <Badge variant="outline" className="bg-emerald-100 text-emerald-700 border-emerald-200">
                            Joined
                          </Badge>
                        )}
                      </div>
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
        requiresDtcmBarcode={event?.requiresDtcmBarcode ?? false}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      {/* Select by IDs — paste a list, populate the selection */}
      <Dialog open={selectByIdsOpen} onOpenChange={(o) => { setSelectByIdsOpen(o); if (!o) setMatchResult(null); }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="h-5 w-5" />
              Select by IDs
            </DialogTitle>
            <DialogDescription>
              Paste registration numbers, full IDs, or emails — one per line or separated by commas.
              The matching registrations get selected so you can bulk-email, tag, or change their type.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-2">
              <Label htmlFor="paste-ids">IDs / emails</Label>
              <Textarea
                id="paste-ids"
                value={pasteIds}
                onChange={(e) => { setPasteIds(e.target.value); setMatchResult(null); }}
                placeholder={"002\n005\njane@example.com"}
                rows={7}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Matches a registration #, the full registration ID, or the attendee email.
                {(statusFilter !== "all" || paymentFilter !== "all" || ticketFilter !== "all" || tagFilter.length > 0)
                  ? " Note: only currently-loaded rows are matched — clear filters to match across all registrations."
                  : ""}
              </p>
            </div>
            {matchResult && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">
                  {matchResult.matched.length} matched
                  {matchResult.unmatched.length > 0 && ` · ${matchResult.unmatched.length} not found`}
                </p>
                {matchResult.unmatched.length > 0 && (
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    Not found: {matchResult.unmatched.slice(0, 30).join(", ")}
                    {matchResult.unmatched.length > 30 ? ` … (+${matchResult.unmatched.length - 30})` : ""}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSelectByIdsOpen(false); setMatchResult(null); }}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={handleMatchPastedIds} disabled={!pasteIds.trim()}>
              Match
            </Button>
            <Button onClick={applyPastedSelection} disabled={!pasteIds.trim()}>
              Select{matchResult ? ` ${matchResult.matched.length}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Tag Dialog */}
      <BulkTagDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        selectedCount={selectedIds.size}
        entityLabel="registration"
        // Use the canonical aggregated list from /api/events/[id]/tags
        // rather than aggregating in-page over `registrations`. The
        // in-page approach was correct only for unfiltered views — it
        // missed tags on registrations that the active status/payment/
        // tag filters had already excluded, so operators got an
        // incomplete suggestions pool exactly when they were applying
        // a narrow filter. The aggregated API is event-wide and
        // independent of any client-side filter state.
        existingTags={(tagsQuery.data?.tags ?? []).map((t) => t.tag)}
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
        paymentStatusFilter={paymentFilter}
        ticketTypeFilter={ticketFilter}
        tagsFilter={tagFilter}
        badgeOptions={badgeOptionsForEmail}
        recipientCountFor={countRegistrationsForEmail}
      />

      {/* Send Registration Form confirmation. The backend route silently
          skips registrations that already have a linked user (no email
          fired), so we surface the rate-limit + recipient count up-front
          rather than waiting for a 429 response after the user clicks. */}
      <Dialog open={sendFormConfirmOpen} onOpenChange={setSendFormConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send registration form</DialogTitle>
            <DialogDescription>
              Each selected registrant will receive an email with a 7-day
              token link to fill in their own details. Registrations that
              already have a linked user account will be skipped silently.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            About to email <span className="font-medium text-foreground">{selectedIds.size}</span>{" "}
            registrant{selectedIds.size !== 1 ? "s" : ""}. This call counts
            against the 5-per-hour bulk-send limit.
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendFormConfirmOpen(false)}
              disabled={sendCompletionEmails.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                try {
                  const result = await sendCompletionEmails.mutateAsync(
                    Array.from(selectedIds),
                  );
                  setSendFormConfirmOpen(false);
                  clearSelection();
                  const skippedMsg =
                    result.skipped > 0
                      ? ` (${result.skipped} skipped — already completed)`
                      : "";
                  toast.success(
                    `Sent ${result.sent} registration form${result.sent === 1 ? "" : "s"}${skippedMsg}`,
                  );
                  if (result.errors.length > 0) {
                    toast.error(
                      `${result.errors.length} failed — see logs for details`,
                    );
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Send failed";
                  toast.error(msg);
                }
              }}
              disabled={sendCompletionEmails.isPending || selectedIds.size === 0}
            >
              {sendCompletionEmails.isPending
                ? "Sending..."
                : `Send to ${selectedIds.size}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
