"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useRegistrations, useTickets, useEvent } from "@/hooks/use-api";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import type { Registration, TicketType } from "./types";
import { registrationStatusColors, paymentStatusColors } from "./types";
import { RegistrationDetailSheet } from "./registration-detail-sheet";
import { AddRegistrationDialog } from "./add-registration-dialog";
import { ImportContactsButton } from "@/components/contacts/import-contacts-button";

export default function RegistrationsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";

  // React Query hooks
  const registrationsQuery = useRegistrations(eventId);
  const registrations = (registrationsQuery.data ?? []) as Registration[];
  const { isLoading: loading, isFetching } = registrationsQuery;
  const { data: ticketTypes = [] } = useTickets(eventId);
  const { data: event } = useEvent(eventId);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [ticketFilter, setTicketFilter] = useState<string>("all");

  // Sheet state for registration details
  const [selectedRegistration, setSelectedRegistration] = useState<Registration | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleRowClick = (registration: Registration) => {
    setSelectedRegistration(registration);
    setSheetOpen(true);
  };

  const exportToCSV = () => {
    const headers = [
      "First Name",
      "Last Name",
      "Email",
      "Organization",
      "Job Title",
      "Phone",
      "Registration Type",
      "Status",
      "Payment Status",
      "Registered Date",
      "Checked In Date",
    ];

    const rows = filteredRegistrations.map((r) => [
      r.attendee.firstName,
      r.attendee.lastName,
      r.attendee.email,
      r.attendee.organization || "",
      r.attendee.jobTitle || "",
      r.attendee.phone || "",
      r.ticketType.name,
      r.status,
      r.paymentStatus,
      formatDate(r.createdAt),
      r.checkedInAt ? formatDate(r.checkedInAt) : "",
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

  const stats = {
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "CONFIRMED").length,
    pending: registrations.filter((r) => r.status === "PENDING").length,
    checkedIn: registrations.filter((r) => r.status === "CHECKED_IN").length,
    paid: registrations.filter((r) => r.paymentStatus === "PAID").length,
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
        <div className="flex gap-2">
          {!isReviewer && (
            <Button
              variant="outline"
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
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          {!isReviewer && (
            <>
              <ImportContactsButton eventId={eventId} mode="registration" />
              <AddRegistrationDialog
                eventId={eventId}
                ticketTypes={ticketTypes as TicketType[]}
              />
            </>
          )}
        </div>
      </div>

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
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
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
            <Select value={paymentFilter} onValueChange={setPaymentFilter}>
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
            <Select value={ticketFilter} onValueChange={setTicketFilter}>
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
            {filteredRegistrations.length === registrations.length
              ? `All Registrations (${registrations.length})`
              : `Showing ${filteredRegistrations.length} of ${registrations.length}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredRegistrations.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              {registrations.length === 0
                ? "No registrations yet. Click 'Add Registration' to register your first attendee."
                : "No registrations match your filters."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Attendee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRegistrations.map((registration) => (
                  <TableRow
                    key={registration.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => handleRowClick(registration)}
                  >
                    <TableCell>
                      <div>
                        <div className="font-medium">
                          {registration.attendee.firstName} {registration.attendee.lastName}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {registration.attendee.email}
                        </div>
                      </div>
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

      {/* Registration Detail Sheet */}
      <RegistrationDetailSheet
        eventId={eventId}
        registration={selectedRegistration}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
