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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  Mail,
  Plus,
  Search,
  Filter,
  Download,
  RefreshCw,
  Phone,
  Building,
  Briefcase,
  Ticket,
  QrCode,
  CheckCircle,
  Calendar,
  CreditCard,
  Utensils,
  Hotel,
  Send,
  Trash2,
  Share2,
} from "lucide-react";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { useRegistrations, useTickets, useEvent, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface Attendee {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  jobTitle: string | null;
  phone: string | null;
  dietaryReqs: string | null;
  customFields?: Record<string, unknown>;
}

interface TicketType {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
}

interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface Accommodation {
  id: string;
  checkIn: string;
  checkOut: string;
  status: string;
  roomType: {
    name: string;
    hotel: {
      name: string;
    };
  };
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
  payments?: Payment[];
  accommodation?: Accommodation | null;
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

  // React Query hooks
  const { data: registrations = [], isLoading: loading, isFetching } = useRegistrations(eventId);
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

  // Mutations
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
      resetForm();
      toast.success("Registration created successfully");
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const updateRegistration = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Registration> }) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update registration");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSelectedRegistration(data);
      toast.success("Registration updated");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const checkInRegistration = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${id}/check-in`, {
        method: "POST",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to check in");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSelectedRegistration(data);
      toast.success("Attendee checked in successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const sendEmail = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${id}/email`, {
        method: "POST",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to send email");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Confirmation email sent");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteRegistration = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete registration");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      setSheetOpen(false);
      setSelectedRegistration(null);
      toast.success("Registration deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const resetForm = () => {
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
    setFormError(null);
  };

  const handleRowClick = (registration: Registration) => {
    // Use data directly from the list - no need to fetch again
    setSelectedRegistration(registration);
    setSheetOpen(true);
  };

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
                  <TableHead>Ticket</TableHead>
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
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="overflow-y-auto p-6">
          {selectedRegistration ? (
            <>
              <SheetHeader className="pr-8">
                <SheetTitle className="flex items-center gap-2">
                  {selectedRegistration.attendee.firstName} {selectedRegistration.attendee.lastName}
                </SheetTitle>
                <SheetDescription>
                  <div className="flex gap-2 mt-2">
                    <Badge className={registrationStatusColors[selectedRegistration.status]} variant="outline">
                      {selectedRegistration.status}
                    </Badge>
                    <Badge className={paymentStatusColors[selectedRegistration.paymentStatus]} variant="outline">
                      {selectedRegistration.paymentStatus}
                    </Badge>
                  </div>
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Quick Actions */}
                <div className="flex flex-wrap gap-2">
                  {selectedRegistration.status !== "CHECKED_IN" &&
                    selectedRegistration.status !== "CANCELLED" && (
                      <Button
                        size="sm"
                        onClick={() => checkInRegistration.mutate(selectedRegistration.id)}
                        disabled={checkInRegistration.isPending}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Check In
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendEmail.mutate(selectedRegistration.id)}
                    disabled={sendEmail.isPending}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Send Email
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => {
                      if (confirm("Are you sure you want to delete this registration?")) {
                        deleteRegistration.mutate(selectedRegistration.id);
                      }
                    }}
                    disabled={deleteRegistration.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>

                {/* Attendee Info */}
                <div className="space-y-4">
                  <h3 className="font-semibold">Attendee Information</h3>
                  <div className="grid gap-3">
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span>{selectedRegistration.attendee.email}</span>
                    </div>
                    {selectedRegistration.attendee.phone && (
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.phone}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.company && (
                      <div className="flex items-center gap-3">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.company}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.jobTitle && (
                      <div className="flex items-center gap-3">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.jobTitle}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.dietaryReqs && (
                      <div className="flex items-center gap-3">
                        <Utensils className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.dietaryReqs}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Ticket Info */}
                <div className="space-y-4">
                  <h3 className="font-semibold">Ticket</h3>
                  <div className="flex items-center gap-3">
                    <Ticket className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{selectedRegistration.ticketType.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {formatCurrency(Number(selectedRegistration.ticketType.price), selectedRegistration.ticketType.currency)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Status Management */}
                <div className="space-y-4">
                  <h3 className="font-semibold">Manage Status</h3>
                  <div className="grid gap-3">
                    <div className="space-y-2">
                      <Label>Registration Status</Label>
                      <Select
                        value={selectedRegistration.status}
                        onValueChange={(value) =>
                          updateRegistration.mutate({
                            id: selectedRegistration.id,
                            data: { status: value },
                          })
                        }
                        disabled={updateRegistration.isPending}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="PENDING">Pending</SelectItem>
                          <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                          <SelectItem value="WAITLISTED">Waitlisted</SelectItem>
                          <SelectItem value="CANCELLED">Cancelled</SelectItem>
                          <SelectItem value="CHECKED_IN">Checked In</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Payment Status</Label>
                      <Select
                        value={selectedRegistration.paymentStatus}
                        onValueChange={(value) =>
                          updateRegistration.mutate({
                            id: selectedRegistration.id,
                            data: { paymentStatus: value },
                          })
                        }
                        disabled={updateRegistration.isPending}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="UNPAID">Unpaid</SelectItem>
                          <SelectItem value="PENDING">Pending</SelectItem>
                          <SelectItem value="PAID">Paid</SelectItem>
                          <SelectItem value="REFUNDED">Refunded</SelectItem>
                          <SelectItem value="FAILED">Failed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* QR Code */}
                {selectedRegistration.qrCode && (
                  <div className="space-y-4">
                    <h3 className="font-semibold flex items-center gap-2">
                      <QrCode className="h-4 w-4" />
                      QR Code
                    </h3>
                    <div className="bg-muted p-4 rounded-lg text-center">
                      <p className="font-mono text-sm break-all">{selectedRegistration.qrCode}</p>
                    </div>
                  </div>
                )}

                {/* Accommodation */}
                {selectedRegistration.accommodation && (
                  <div className="space-y-4">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Hotel className="h-4 w-4" />
                      Accommodation
                    </h3>
                    <div className="bg-muted p-4 rounded-lg">
                      <div className="font-medium">{selectedRegistration.accommodation.roomType.hotel.name}</div>
                      <div className="text-sm text-muted-foreground">{selectedRegistration.accommodation.roomType.name}</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {formatDate(selectedRegistration.accommodation.checkIn)} - {formatDate(selectedRegistration.accommodation.checkOut)}
                      </div>
                      <Badge variant="outline" className="mt-2">{selectedRegistration.accommodation.status}</Badge>
                    </div>
                  </div>
                )}

                {/* Payment History */}
                {selectedRegistration.payments && selectedRegistration.payments.length > 0 && (
                  <div className="space-y-4">
                    <h3 className="font-semibold flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      Payment History
                    </h3>
                    <div className="space-y-2">
                      {selectedRegistration.payments.map((payment) => (
                        <div key={payment.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                          <div>
                            <div className="font-medium">{formatCurrency(Number(payment.amount), payment.currency)}</div>
                            <div className="text-sm text-muted-foreground">{formatDateTime(payment.createdAt)}</div>
                          </div>
                          <Badge className={paymentStatusColors[payment.status]} variant="outline">
                            {payment.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Timeline */}
                <div className="space-y-4">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Timeline
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 text-sm">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground">Registered</div>
                        <div className="font-medium">{formatDateTime(selectedRegistration.createdAt)}</div>
                      </div>
                    </div>
                    {selectedRegistration.checkedInAt && (
                      <div className="flex items-center gap-3 text-sm">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <div>
                          <div className="text-muted-foreground">Checked In</div>
                          <div className="font-medium">{formatDateTime(selectedRegistration.checkedInAt)}</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Notes */}
                {selectedRegistration.notes && (
                  <div className="space-y-4">
                    <h3 className="font-semibold">Notes</h3>
                    <p className="text-sm whitespace-pre-wrap bg-muted p-3 rounded-lg">
                      {selectedRegistration.notes}
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
