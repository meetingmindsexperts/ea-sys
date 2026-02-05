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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Users,
  Mail,
  Plus,
  Search,
  Filter,
  Download,
  RefreshCw,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useRegistrations, useTickets } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/use-api";
import { toast } from "sonner";

interface Attendee {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  jobTitle: string | null;
  phone: string | null;
}

interface TicketType {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
}

interface Registration {
  id: string;
  status: string;
  paymentStatus: string;
  qrCode: string | null;
  checkedInAt: string | null;
  notes: string | null;
  createdAt: string;
  attendee: Attendee;
  ticketType: TicketType;
}

const registrationStatusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

const paymentStatusColors: Record<string, string> = {
  UNPAID: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  PAID: "bg-green-100 text-green-800",
  REFUNDED: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-800",
};

export default function RegistrationsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();

  // React Query hooks - data is cached and shared across navigations
  const { data: registrations = [], isLoading: loading, isFetching } = useRegistrations(eventId);
  const { data: ticketTypes = [] } = useTickets(eventId);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [ticketFilter, setTicketFilter] = useState<string>("all");

  // New registration dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    ticketTypeId: "",
    email: "",
    firstName: "",
    lastName: "",
    company: "",
    jobTitle: "",
    phone: "",
    dietaryReqs: "",
    notes: "",
  });

  // Create registration mutation
  const createRegistration = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketTypeId: data.ticketTypeId,
          attendee: {
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            company: data.company || undefined,
            jobTitle: data.jobTitle || undefined,
            phone: data.phone || undefined,
            dietaryReqs: data.dietaryReqs || undefined,
          },
          notes: data.notes || undefined,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create registration");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
      setDialogOpen(false);
      setFormData({
        ticketTypeId: "",
        email: "",
        firstName: "",
        lastName: "",
        company: "",
        jobTitle: "",
        phone: "",
        dietaryReqs: "",
        notes: "",
      });
      toast.success("Registration created successfully");
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    createRegistration.mutate(formData);
  };

  const exportToCSV = () => {
    const headers = [
      "First Name",
      "Last Name",
      "Email",
      "Company",
      "Job Title",
      "Phone",
      "Ticket Type",
      "Status",
      "Payment Status",
      "Registered Date",
      "Checked In Date",
    ];

    const rows = filteredRegistrations.map((r) => [
      r.attendee.firstName,
      r.attendee.lastName,
      r.attendee.email,
      r.attendee.company || "",
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
      (r.attendee.company &&
        r.attendee.company.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus =
      statusFilter === "all" || r.status === statusFilter;
    const matchesPayment =
      paymentFilter === "all" || r.paymentStatus === paymentFilter;
    const matchesTicket =
      ticketFilter === "all" || r.ticketType.id === ticketFilter;

    return matchesSearch && matchesStatus && matchesPayment && matchesTicket;
  });

  const stats = {
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === "CONFIRMED").length,
    pending: registrations.filter((r) => r.status === "PENDING").length,
    checkedIn: registrations.filter((r) => r.status === "CHECKED_IN").length,
    paid: registrations.filter((r) => r.paymentStatus === "PAID").length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Registration
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Add New Registration</DialogTitle>
                <DialogDescription>
                  Register a new attendee for this event
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit}>
                <div className="grid gap-4 py-4">
                  {/* Ticket Type */}
                  <div className="space-y-2">
                    <Label htmlFor="ticketType">Ticket Type *</Label>
                    {ticketTypes.length === 0 ? (
                      <p className="text-sm text-muted-foreground p-3 bg-muted rounded">
                        No ticket types available. Please create a ticket type first.
                      </p>
                    ) : (
                      <Select
                        value={formData.ticketTypeId}
                        onValueChange={(value) =>
                          setFormData({ ...formData, ticketTypeId: value })
                        }
                        required
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a ticket type" />
                        </SelectTrigger>
                        <SelectContent className="z-[100]">
                          {ticketTypes.map((ticket) => (
                            <SelectItem
                              key={ticket.id}
                              value={ticket.id}
                              disabled={ticket.soldCount >= ticket.quantity}
                            >
                              {ticket.name} - ${ticket.price}
                              {ticket.soldCount >= ticket.quantity
                                ? " (Sold out)"
                                : ` (${ticket.quantity - ticket.soldCount} available)`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">First Name *</Label>
                      <Input
                        id="firstName"
                        value={formData.firstName}
                        onChange={(e) =>
                          setFormData({ ...formData, firstName: e.target.value })
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName">Last Name *</Label>
                      <Input
                        id="lastName"
                        value={formData.lastName}
                        onChange={(e) =>
                          setFormData({ ...formData, lastName: e.target.value })
                        }
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">Email *</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) =>
                        setFormData({ ...formData, email: e.target.value })
                      }
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="company">Company</Label>
                      <Input
                        id="company"
                        value={formData.company}
                        onChange={(e) =>
                          setFormData({ ...formData, company: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="jobTitle">Job Title</Label>
                      <Input
                        id="jobTitle"
                        value={formData.jobTitle}
                        onChange={(e) =>
                          setFormData({ ...formData, jobTitle: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        value={formData.phone}
                        onChange={(e) =>
                          setFormData({ ...formData, phone: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dietaryReqs">Dietary Requirements</Label>
                      <Input
                        id="dietaryReqs"
                        value={formData.dietaryReqs}
                        onChange={(e) =>
                          setFormData({ ...formData, dietaryReqs: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Input
                      id="notes"
                      value={formData.notes}
                      onChange={(e) =>
                        setFormData({ ...formData, notes: e.target.value })
                      }
                    />
                  </div>

                  {formError && (
                    <div className="text-sm text-red-600 bg-red-50 p-3 rounded">
                      {formError}
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createRegistration.isPending}>
                    {createRegistration.isPending ? "Creating..." : "Create Registration"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Registrations
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
            <div className="text-2xl font-bold text-green-600">
              {stats.confirmed}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {stats.pending}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Checked In
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {stats.checkedIn}
            </div>
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
                  placeholder="Search by name, email, or company..."
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
                <SelectValue placeholder="Ticket Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tickets</SelectItem>
                {ticketTypes.map((ticket) => (
                  <SelectItem key={ticket.id} value={ticket.id}>
                    {ticket.name}
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

      {/* Registrations List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {filteredRegistrations.length === registrations.length
              ? `All Registrations (${registrations.length})`
              : `Showing ${filteredRegistrations.length} of ${registrations.length}`}
          </h2>
        </div>
        {filteredRegistrations.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                {registrations.length === 0
                  ? "No registrations yet. Click 'Add Registration' to register your first attendee."
                  : "No registrations match your filters."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredRegistrations.map((registration) => (
              <Card
                key={registration.id}
                className="hover:border-primary transition-colors"
              >
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3">
                        <div>
                          <h3 className="text-lg font-semibold">
                            {registration.attendee.firstName}{" "}
                            {registration.attendee.lastName}
                          </h3>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                            <Mail className="h-4 w-4" />
                            {registration.attendee.email}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 mb-3">
                        <Badge
                          className={registrationStatusColors[registration.status]}
                          variant="outline"
                        >
                          {registration.status}
                        </Badge>
                        <Badge
                          className={paymentStatusColors[registration.paymentStatus]}
                          variant="outline"
                        >
                          {registration.paymentStatus}
                        </Badge>
                        <Badge variant="outline">
                          {registration.ticketType.name}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        {registration.attendee.company && (
                          <div>
                            <div className="text-muted-foreground">Company</div>
                            <div className="font-medium">
                              {registration.attendee.company}
                            </div>
                          </div>
                        )}
                        {registration.attendee.jobTitle && (
                          <div>
                            <div className="text-muted-foreground">Job Title</div>
                            <div className="font-medium">
                              {registration.attendee.jobTitle}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="text-muted-foreground">Registered</div>
                          <div className="font-medium">
                            {formatDate(registration.createdAt)}
                          </div>
                        </div>
                        {registration.checkedInAt && (
                          <div>
                            <div className="text-muted-foreground">Checked In</div>
                            <div className="font-medium">
                              {formatDate(registration.checkedInAt)}
                            </div>
                          </div>
                        )}
                      </div>

                      {registration.notes && (
                        <div className="mt-3 p-2 bg-muted rounded text-sm">
                          <div className="text-muted-foreground font-medium mb-1">
                            Notes
                          </div>
                          <p>{registration.notes}</p>
                        </div>
                      )}
                    </div>

                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`/events/${eventId}/registrations/${registration.id}`}
                      >
                        View Details
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
