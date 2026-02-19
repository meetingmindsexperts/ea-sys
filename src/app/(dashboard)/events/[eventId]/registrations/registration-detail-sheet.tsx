"use client";

import Image from "next/image";
import { useState } from "react";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import {
  Mail,
  Phone,
  Building,
  Briefcase,
  ClipboardList,
  QrCode,
  CheckCircle,
  Calendar,
  CreditCard,
  Utensils,
  Hotel,
  Send,
  Trash2,
  Pencil,
  Save,
  X,
  MapPin,
} from "lucide-react";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import type { Registration } from "./types";
import { registrationStatusColors, paymentStatusColors } from "./types";

interface RegistrationDetailSheetProps {
  eventId: string;
  registration: Registration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RegistrationDetailSheet({
  eventId,
  registration,
  open,
  onOpenChange,
}: RegistrationDetailSheetProps) {
  const queryClient = useQueryClient();
  const { data: userSession } = useSession();
  const isReviewer = userSession?.user?.role === "REVIEWER";
  const [selectedRegistration, setSelectedRegistration] = useState<Registration | null>(registration);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    organization: "",
    jobTitle: "",
    photo: null as string | null,
    city: "",
    country: "",
    specialty: "",
    tags: [] as string[],
    dietaryReqs: "",
    notes: "",
  });

  // Keep local state in sync with prop
  if (registration !== selectedRegistration && registration !== null) {
    setSelectedRegistration(registration);
    setIsEditing(false);
  }

  const updateRegistration = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
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
      onOpenChange(false);
      setSelectedRegistration(null);
      toast.success("Registration deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const startEditing = () => {
    if (selectedRegistration) {
      setEditData({
        firstName: selectedRegistration.attendee.firstName,
        lastName: selectedRegistration.attendee.lastName,
        phone: selectedRegistration.attendee.phone || "",
        organization: selectedRegistration.attendee.organization || "",
        jobTitle: selectedRegistration.attendee.jobTitle || "",
        photo: selectedRegistration.attendee.photo || null,
        city: selectedRegistration.attendee.city || "",
        country: selectedRegistration.attendee.country || "",
        specialty: selectedRegistration.attendee.specialty || "",
        tags: selectedRegistration.attendee.tags || [],
        dietaryReqs: selectedRegistration.attendee.dietaryReqs || "",
        notes: selectedRegistration.notes || "",
      });
      setIsEditing(true);
    }
  };

  const saveEdits = () => {
    if (selectedRegistration) {
      updateRegistration.mutate({
        id: selectedRegistration.id,
        data: {
          notes: editData.notes || undefined,
          attendee: {
            firstName: editData.firstName,
            lastName: editData.lastName,
            phone: editData.phone || undefined,
            organization: editData.organization || undefined,
            jobTitle: editData.jobTitle || undefined,
            photo: editData.photo || undefined,
            city: editData.city || undefined,
            country: editData.country || undefined,
            specialty: editData.specialty || undefined,
            tags: editData.tags,
            dietaryReqs: editData.dietaryReqs || undefined,
          },
        },
      });
      setIsEditing(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
              {!isReviewer && (
              <div className="flex flex-wrap gap-2">
                {!isEditing ? (
                  <>
                    <Button size="sm" variant="outline" onClick={startEditing}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </Button>
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
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={saveEdits}
                      disabled={updateRegistration.isPending}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {updateRegistration.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsEditing(false)}
                      disabled={updateRegistration.isPending}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Cancel
                    </Button>
                  </>
                )}
              </div>
              )}

              {/* Attendee Info */}
              <div className="space-y-4">
                <h3 className="font-semibold">Attendee Information</h3>
                {isEditing ? (
                  <div className="grid gap-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-firstName">First Name *</Label>
                        <Input
                          id="edit-firstName"
                          value={editData.firstName}
                          onChange={(e) => setEditData({ ...editData, firstName: e.target.value })}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-lastName">Last Name *</Label>
                        <Input
                          id="edit-lastName"
                          value={editData.lastName}
                          onChange={(e) => setEditData({ ...editData, lastName: e.target.value })}
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input value={selectedRegistration.attendee.email} disabled className="bg-muted" />
                      <p className="text-xs text-muted-foreground">Email cannot be changed</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-phone">Phone</Label>
                      <Input
                        id="edit-phone"
                        value={editData.phone}
                        onChange={(e) => setEditData({ ...editData, phone: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-organization">Organization</Label>
                        <Input
                          id="edit-organization"
                          value={editData.organization}
                          onChange={(e) => setEditData({ ...editData, organization: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-jobTitle">Job Title</Label>
                        <Input
                          id="edit-jobTitle"
                          value={editData.jobTitle}
                          onChange={(e) => setEditData({ ...editData, jobTitle: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Photo</Label>
                      <PhotoUpload
                        value={editData.photo}
                        onChange={(photo) => setEditData({ ...editData, photo })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-city">City</Label>
                        <Input
                          id="edit-city"
                          value={editData.city}
                          onChange={(e) => setEditData({ ...editData, city: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-country">Country</Label>
                        <CountrySelect
                          value={editData.country}
                          onChange={(country) => setEditData({ ...editData, country })}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-dietaryReqs">Dietary Requirements</Label>
                      <Input
                        id="edit-dietaryReqs"
                        value={editData.dietaryReqs}
                        onChange={(e) => setEditData({ ...editData, dietaryReqs: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-specialty">Specialty</Label>
                      <Input
                        id="edit-specialty"
                        value={editData.specialty}
                        onChange={(e) => setEditData({ ...editData, specialty: e.target.value })}
                        placeholder="e.g., Cardiology, Neurology"
                      />
                      <p className="text-xs text-muted-foreground">Categorize attendee by specialty</p>
                    </div>
                    {!isReviewer && (
                      <div className="space-y-2">
                        <Label htmlFor="edit-tags">Tags</Label>
                        <Input
                          id="edit-tags"
                          value={editData.tags.join(", ")}
                          onChange={(e) => setEditData({ ...editData, tags: e.target.value.split(",").map(t => t.trim()).filter(t => t) })}
                          placeholder="e.g., VIP, Speaker, Sponsor"
                        />
                        <p className="text-xs text-muted-foreground">Add tags separated by commas</p>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="edit-notes">Notes</Label>
                      <Input
                        id="edit-notes"
                        value={editData.notes}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                      />
                    </div>
                  </div>
                ) : (
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
                    {selectedRegistration.attendee.photo && (
                      <div className="flex items-center gap-3">
                        <Image
                          src={selectedRegistration.attendee.photo}
                          alt="Photo"
                          width={64}
                          height={64}
                          className="rounded-full object-cover border"
                          unoptimized
                        />
                      </div>
                    )}
                    {selectedRegistration.attendee.organization && (
                      <div className="flex items-center gap-3">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.organization}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.jobTitle && (
                      <div className="flex items-center gap-3">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.jobTitle}</span>
                      </div>
                    )}
                    {(selectedRegistration.attendee.city || selectedRegistration.attendee.country) && (
                      <div className="flex items-center gap-3">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span>
                          {[selectedRegistration.attendee.city, selectedRegistration.attendee.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </div>
                    )}
                    {selectedRegistration.attendee.dietaryReqs && (
                      <div className="flex items-center gap-3">
                        <Utensils className="h-4 w-4 text-muted-foreground" />
                        <span>{selectedRegistration.attendee.dietaryReqs}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.specialty && (
                      <div className="flex items-center gap-3">
                        <ClipboardList className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="text-xs text-muted-foreground">Specialty</div>
                          <div>{selectedRegistration.attendee.specialty}</div>
                        </div>
                      </div>
                    )}
                    {selectedRegistration.attendee.tags && selectedRegistration.attendee.tags.length > 0 && (
                      <div className="flex items-start gap-3">
                        <ClipboardList className="h-4 w-4 text-muted-foreground mt-1" />
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Tags</div>
                          <div className="flex flex-wrap gap-1">
                            {selectedRegistration.attendee.tags.map((tag, index) => (
                              <Badge key={index} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Registration Type Info */}
              <div className="space-y-4">
                <h3 className="font-semibold">Registration Type</h3>
                <div className="flex items-center gap-3">
                  <ClipboardList className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{selectedRegistration.ticketType.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatCurrency(Number(selectedRegistration.ticketType.price), selectedRegistration.ticketType.currency)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Status Management */}
              {!isReviewer && (
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
              )}

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
              {!isEditing && selectedRegistration.notes && (
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
  );
}
