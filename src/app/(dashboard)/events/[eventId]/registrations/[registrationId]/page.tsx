"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  User,
  Mail,
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
} from "lucide-react";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";

interface Registration {
  id: string;
  status: string;
  paymentStatus: string;
  qrCode: string | null;
  checkedInAt: string | null;
  notes: string | null;
  createdAt: string;
  attendee: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    company: string | null;
    jobTitle: string | null;
    phone: string | null;
    dietaryReqs: string | null;
    customFields: Record<string, any>;
  };
  ticketType: {
    id: string;
    name: string;
    price: number;
    currency: string;
  };
  payments: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  accommodation: {
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
  } | null;
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

export default function RegistrationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const registrationId = params.registrationId as string;
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRegistration();
  }, [eventId, registrationId]);

  const fetchRegistration = async () => {
    try {
      const res = await fetch(
        `/api/events/${eventId}/registrations/${registrationId}`
      );
      if (res.ok) {
        const data = await res.json();
        setRegistration(data);
      } else {
        setError("Registration not found");
      }
    } catch (err) {
      setError("Failed to load registration");
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/events/${eventId}/registrations/${registrationId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );
      if (res.ok) {
        fetchRegistration();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update status");
      }
    } catch (err) {
      setError("An error occurred");
    } finally {
      setUpdating(false);
    }
  };

  const handlePaymentStatusChange = async (paymentStatus: string) => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/events/${eventId}/registrations/${registrationId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentStatus }),
        }
      );
      if (res.ok) {
        fetchRegistration();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update payment status");
      }
    } catch (err) {
      setError("An error occurred");
    } finally {
      setUpdating(false);
    }
  };

  const handleCheckIn = async () => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/events/${eventId}/registrations/${registrationId}/check-in`,
        {
          method: "POST",
        }
      );
      if (res.ok) {
        fetchRegistration();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to check in");
      }
    } catch (err) {
      setError("An error occurred");
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error && !registration) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600">{error}</p>
        <Button asChild className="mt-4">
          <Link href={`/events/${eventId}/registrations`}>
            Back to Registrations
          </Link>
        </Button>
      </div>
    );
  }

  if (!registration) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}/registrations`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <User className="h-8 w-8" />
              {registration.attendee.firstName} {registration.attendee.lastName}
            </h1>
          </div>
          <div className="flex items-center gap-3">
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
          </div>
        </div>
        {registration.status !== "CHECKED_IN" &&
          registration.status !== "CANCELLED" && (
            <Button
              onClick={handleCheckIn}
              disabled={updating}
              className="bg-green-600 hover:bg-green-700"
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              {updating ? "Processing..." : "Check In"}
            </Button>
          )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Info */}
        <div className="md:col-span-2 space-y-6">
          {/* Attendee Information */}
          <Card>
            <CardHeader>
              <CardTitle>Attendee Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="text-sm text-muted-foreground">Email</div>
                    <div className="font-medium">{registration.attendee.email}</div>
                  </div>
                </div>
                {registration.attendee.phone && (
                  <div className="flex items-center gap-3">
                    <Phone className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="text-sm text-muted-foreground">Phone</div>
                      <div className="font-medium">
                        {registration.attendee.phone}
                      </div>
                    </div>
                  </div>
                )}
                {registration.attendee.company && (
                  <div className="flex items-center gap-3">
                    <Building className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="text-sm text-muted-foreground">Company</div>
                      <div className="font-medium">
                        {registration.attendee.company}
                      </div>
                    </div>
                  </div>
                )}
                {registration.attendee.jobTitle && (
                  <div className="flex items-center gap-3">
                    <Briefcase className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Job Title
                      </div>
                      <div className="font-medium">
                        {registration.attendee.jobTitle}
                      </div>
                    </div>
                  </div>
                )}
                {registration.attendee.dietaryReqs && (
                  <div className="flex items-center gap-3">
                    <Utensils className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Dietary Requirements
                      </div>
                      <div className="font-medium">
                        {registration.attendee.dietaryReqs}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Ticket Information */}
          <Card>
            <CardHeader>
              <CardTitle>Ticket Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Ticket className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="font-medium">{registration.ticketType.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {formatCurrency(
                      Number(registration.ticketType.price),
                      registration.ticketType.currency
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Accommodation */}
          {registration.accommodation && (
            <Card>
              <CardHeader>
                <CardTitle>Accommodation</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3">
                  <Hotel className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <div className="font-medium">
                      {registration.accommodation.roomType.hotel.name}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {registration.accommodation.roomType.name}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {formatDate(registration.accommodation.checkIn)} -{" "}
                      {formatDate(registration.accommodation.checkOut)}
                    </div>
                    <Badge variant="outline" className="mt-2">
                      {registration.accommodation.status}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Payment History */}
          <Card>
            <CardHeader>
              <CardTitle>Payment History</CardTitle>
            </CardHeader>
            <CardContent>
              {registration.payments.length === 0 ? (
                <p className="text-muted-foreground">No payment records</p>
              ) : (
                <div className="space-y-3">
                  {registration.payments.map((payment) => (
                    <div
                      key={payment.id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <CreditCard className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium">
                            {formatCurrency(
                              Number(payment.amount),
                              payment.currency
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {formatDateTime(payment.createdAt)}
                          </div>
                        </div>
                      </div>
                      <Badge
                        className={paymentStatusColors[payment.status]}
                        variant="outline"
                      >
                        {payment.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* QR Code */}
          {registration.qrCode && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <QrCode className="h-5 w-5" />
                  QR Code
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-muted p-4 rounded-lg text-center">
                  <p className="font-mono text-sm break-all">
                    {registration.qrCode}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Status Management */}
          <Card>
            <CardHeader>
              <CardTitle>Manage Registration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Registration Status
                </label>
                <Select
                  value={registration.status}
                  onValueChange={handleStatusChange}
                  disabled={updating}
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
                <label className="text-sm font-medium">Payment Status</label>
                <Select
                  value={registration.paymentStatus}
                  onValueChange={handlePaymentStatusChange}
                  disabled={updating}
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
            </CardContent>
          </Card>

          {/* Timestamps */}
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm text-muted-foreground">
                      Registered
                    </div>
                    <div className="font-medium">
                      {formatDateTime(registration.createdAt)}
                    </div>
                  </div>
                </div>
                {registration.checkedInAt && (
                  <div className="flex items-center gap-3">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Checked In
                      </div>
                      <div className="font-medium">
                        {formatDateTime(registration.checkedInAt)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          {registration.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">
                  {registration.notes}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
