"use client";

import Image from "next/image";
import { useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { TagInput } from "@/components/ui/tag-input";
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
import { CountrySelect } from "@/components/ui/country-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Mail,
  Phone,
  Building,
  Briefcase,
  ClipboardList,
  Barcode,
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
  ChevronDown,
  Download,
  IdCard,
  Loader2,
} from "lucide-react";
import { formatCurrency, formatDate, formatDateTime, formatPersonName } from "@/lib/utils";
import { queryKeys, useTickets } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import type { Registration, TicketType } from "./types";
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
  const { data: regTypes = [] } = useTickets(eventId);
  const [selectedRegistration, setSelectedRegistration] = useState<Registration | null>(registration);
  const [isEditing, setIsEditing] = useState(false);
  const [printingBadge, setPrintingBadge] = useState(false);
  const headerPhotoRef = useRef<HTMLInputElement>(null);

  const handleHeaderPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { toast.error("File size must be under 500KB"); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Only JPEG, PNG, and WebP allowed"); return; }
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/upload/photo", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Upload failed"); return; }
      setEditData((prev) => ({ ...prev, photo: data.url }));
      toast.success("Photo uploaded");
    } catch { toast.error("Upload failed"); }
    if (headerPhotoRef.current) headerPhotoRef.current.value = "";
  };
  const [editData, setEditData] = useState({
    title: "" as string,
    firstName: "",
    lastName: "",
    phone: "",
    organization: "",
    jobTitle: "",
    photo: null as string | null,
    city: "",
    country: "",
    bio: "",
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
    mutationFn: async ({ id, type }: { id: string; type: string }) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to send email");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Email sent");
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
        title: selectedRegistration.attendee.title || "",
        firstName: selectedRegistration.attendee.firstName,
        lastName: selectedRegistration.attendee.lastName,
        phone: selectedRegistration.attendee.phone || "",
        organization: selectedRegistration.attendee.organization || "",
        jobTitle: selectedRegistration.attendee.jobTitle || "",
        photo: selectedRegistration.attendee.photo || null,
        city: selectedRegistration.attendee.city || "",
        country: selectedRegistration.attendee.country || "",
        bio: selectedRegistration.attendee.bio || "",
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
            title: editData.title || undefined,
            firstName: editData.firstName,
            lastName: editData.lastName,
            phone: editData.phone || undefined,
            organization: editData.organization || undefined,
            jobTitle: editData.jobTitle || undefined,
            photo: editData.photo ?? null,
            city: editData.city || undefined,
            country: editData.country || undefined,
            bio: editData.bio || undefined,
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
      <SheetContent className="overflow-y-auto p-0 w-full sm:w-[700px]">
        {selectedRegistration ? (
          <>
            {/* Header with actions */}
            <div className="sticky top-0 z-10 bg-gradient-to-r from-[#00aade] to-[#47c1e8] px-6 py-4 text-white">
              <div className="flex items-start justify-between gap-4 pr-8">
                <SheetHeader className="flex-1">
                  <SheetTitle className="text-white text-lg">
                    {formatPersonName(selectedRegistration.attendee.title, selectedRegistration.attendee.firstName, selectedRegistration.attendee.lastName)}
                  </SheetTitle>
                  <SheetDescription>
                    <div className="flex gap-2 mt-1">
                      <Badge className={`${registrationStatusColors[selectedRegistration.status]} border-white/30`} variant="outline">
                        {selectedRegistration.status}
                      </Badge>
                      <Badge className={`${paymentStatusColors[selectedRegistration.paymentStatus]} border-white/30`} variant="outline">
                        {selectedRegistration.paymentStatus}
                      </Badge>
                    </div>
                  </SheetDescription>
                </SheetHeader>
                {(() => {
                  const photoSrc = isEditing ? editData.photo : selectedRegistration.attendee.photo;
                  const avatar = photoSrc ? (
                    <Image src={photoSrc} alt="" width={112} height={112} className="w-28 h-28 rounded-full object-cover ring-2 ring-white/40 shrink-0" unoptimized />
                  ) : (
                    <div className="w-28 h-28 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-2xl shrink-0">
                      {selectedRegistration.attendee.firstName[0]}{selectedRegistration.attendee.lastName[0]}
                    </div>
                  );
                  if (!isEditing) return avatar;
                  return (
                    <div className="shrink-0 flex flex-col items-center">
                      <div className="relative group">
                        <input ref={headerPhotoRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleHeaderPhotoChange} className="hidden" aria-label="Upload photo" />
                        <button type="button" title="Change photo" onClick={() => headerPhotoRef.current?.click()} className="block rounded-full cursor-pointer">
                          {avatar}
                          <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <Pencil className="h-5 w-5 text-white" />
                          </div>
                        </button>
                      </div>
                      {photoSrc && (
                        <button
                          type="button"
                          onClick={() => setEditData((prev) => ({ ...prev, photo: null }))}
                          className="mt-1.5 text-xs text-white/80 hover:text-white flex items-center gap-1"
                        >
                          <X className="h-3 w-3" /> Remove
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Quick Actions in header */}
              {!isReviewer && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {!isEditing ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={startEditing}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                      {selectedRegistration.status !== "CHECKED_IN" &&
                        selectedRegistration.status !== "CANCELLED" && (
                          <Button
                            size="sm"
                            onClick={() => checkInRegistration.mutate(selectedRegistration.id)}
                            disabled={checkInRegistration.isPending}
                            className="bg-green-600 hover:bg-green-700 text-white"
                          >
                            <CheckCircle className="mr-2 h-4 w-4" />
                            Check In
                          </Button>
                        )}
                      <Button
                        size="sm"
                        variant="secondary"
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
                        className="bg-green-600 hover:bg-green-700 text-white"
                      >
                        <Save className="mr-2 h-4 w-4" />
                        {updateRegistration.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
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
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Attendee Info */}
              <div className="space-y-4">
                <h3 className="font-semibold">Attendee Information</h3>
                {isEditing ? (
                  <div className="grid gap-4">
                    <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-title">Title</Label>
                        <TitleSelect
                          value={editData.title}
                          onChange={(title) => setEditData({ ...editData, title })}
                        />
                      </div>
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
                      <Label htmlFor="edit-bio">Bio</Label>
                      <textarea
                        id="edit-bio"
                        placeholder="Short biography"
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={editData.bio}
                        onChange={(e) => setEditData({ ...editData, bio: e.target.value })}
                      />
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
                      <SpecialtySelect
                        value={editData.specialty}
                        onChange={(specialty) => setEditData({ ...editData, specialty })}
                      />
                    </div>
                    {!isReviewer && (
                      <div className="space-y-2">
                        <Label>Tags</Label>
                        <TagInput
                          value={editData.tags}
                          onChange={(tags) => setEditData({ ...editData, tags })}
                          placeholder="Type a tag and press Enter or comma"
                        />
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
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{selectedRegistration.attendee.email}</span>
                    </div>
                    {selectedRegistration.attendee.phone ? (
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.phone}</span>
                      </div>
                    ) : <div />}
                    {selectedRegistration.attendee.organization && (
                      <div className="flex items-center gap-3">
                        <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.organization}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.jobTitle && (
                      <div className="flex items-center gap-3">
                        <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.jobTitle}</span>
                      </div>
                    )}
                    {(selectedRegistration.attendee.city || selectedRegistration.attendee.country) && (
                      <div className="flex items-center gap-3">
                        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>
                          {[selectedRegistration.attendee.city, selectedRegistration.attendee.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </div>
                    )}
                    {selectedRegistration.attendee.specialty && (
                      <div className="flex items-center gap-3">
                        <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <div className="text-xs text-muted-foreground">Specialty</div>
                          <div>{selectedRegistration.attendee.specialty}</div>
                        </div>
                      </div>
                    )}
                    {selectedRegistration.attendee.dietaryReqs && (
                      <div className="flex items-center gap-3">
                        <Utensils className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>{selectedRegistration.attendee.dietaryReqs}</span>
                      </div>
                    )}
                    {selectedRegistration.attendee.tags && selectedRegistration.attendee.tags.length > 0 && (
                      <div className="flex items-start gap-3 col-span-2">
                        <ClipboardList className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
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
                    {selectedRegistration.attendee.bio && (
                      <div className="col-span-2">
                        <div className="text-xs text-muted-foreground">Bio</div>
                        <div className="text-sm whitespace-pre-wrap">{selectedRegistration.attendee.bio}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t" />

              {/* Registration Type + Badge Type (side by side) */}
              {!isReviewer ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Registration Type</Label>
                    <Select
                      value={selectedRegistration.ticketType.id}
                      onValueChange={(value) =>
                        updateRegistration.mutate({
                          id: selectedRegistration.id,
                          data: { ticketTypeId: value },
                        })
                      }
                      disabled={updateRegistration.isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(regTypes as TicketType[]).map((rt) => (
                          <SelectItem key={rt.id} value={rt.id}>
                            {rt.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Badge Type</Label>
                    {(() => {
                      const BADGE_TYPES = ["Delegate", "Faculty", "Exhibitor", "Committee", "Chairman", "Co-Chairman"];
                      const currentBadge = selectedRegistration.badgeType || "Delegate";
                      const isCustom = !BADGE_TYPES.includes(currentBadge) && currentBadge !== "Custom";
                      return (
                        <>
                          <Select
                            value={isCustom ? "Custom" : currentBadge}
                            onValueChange={(value) => {
                              if (value === "Custom") {
                                updateRegistration.mutate({
                                  id: selectedRegistration.id,
                                  data: { badgeType: "" },
                                });
                              } else {
                                updateRegistration.mutate({
                                  id: selectedRegistration.id,
                                  data: { badgeType: value },
                                });
                              }
                            }}
                            disabled={updateRegistration.isPending}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BADGE_TYPES.map((bt) => (
                                <SelectItem key={bt} value={bt}>{bt}</SelectItem>
                              ))}
                              <SelectItem value="Custom">Custom...</SelectItem>
                            </SelectContent>
                          </Select>
                          {(isCustom || currentBadge === "" || currentBadge === "Custom") && (
                            <Input
                              placeholder="Enter custom badge type"
                              defaultValue={isCustom ? currentBadge : ""}
                              onBlur={(e) => {
                                if (e.target.value.trim()) {
                                  updateRegistration.mutate({
                                    id: selectedRegistration.id,
                                    data: { badgeType: e.target.value.trim() },
                                  });
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                                  updateRegistration.mutate({
                                    id: selectedRegistration.id,
                                    data: { badgeType: (e.target as HTMLInputElement).value.trim() },
                                  });
                                }
                              }}
                            />
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <ClipboardList className="h-4 w-4 text-muted-foreground" />
                  <div className="font-medium">{selectedRegistration.ticketType.name}</div>
                </div>
              )}

              {/* Registration Status + Payment Status (side by side) */}
              {!isReviewer && (
                <div className="grid grid-cols-2 gap-3">
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
                        <SelectItem value="COMPLIMENTARY">Complimentary</SelectItem>
                        <SelectItem value="REFUNDED">Refunded</SelectItem>
                        <SelectItem value="FAILED">Failed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="border-t" />

              {/* Event Barcode + DTCM Barcode (side by side if both exist) */}
              {(selectedRegistration.qrCode || selectedRegistration.dtcmBarcode) && (
                <div className={`grid gap-3 ${selectedRegistration.qrCode && selectedRegistration.dtcmBarcode ? "grid-cols-2" : "grid-cols-1"}`}>
                  {selectedRegistration.qrCode && (
                    <div className="space-y-2">
                      <div className="font-semibold text-sm flex items-center gap-2">
                        <Barcode className="h-4 w-4" />
                        Event Barcode
                      </div>
                      <div className="bg-muted p-3 rounded-lg text-center">
                        <p className="font-mono text-sm break-all">{selectedRegistration.qrCode}</p>
                      </div>
                    </div>
                  )}
                  {selectedRegistration.dtcmBarcode && (
                    <div className="space-y-2">
                      <div className="font-semibold text-sm flex items-center gap-2">
                        <Barcode className="h-4 w-4" />
                        DTCM Barcode
                      </div>
                      <div className="bg-muted p-3 rounded-lg text-center">
                        <p className="font-mono text-sm break-all">{selectedRegistration.dtcmBarcode}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Print Badge + Download Quote + Send Email (3 buttons in a row) */}
              {!isReviewer && !isEditing && (
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={printingBadge}
                    onClick={async () => {
                      setPrintingBadge(true);
                      try {
                        const res = await fetch(`/api/events/${eventId}/registrations/badges`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ registrationIds: [selectedRegistration.id] }),
                        });
                        if (!res.ok) {
                          const data = await res.json();
                          toast.error(data.error || "Badge generation failed");
                          return;
                        }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `badge-${selectedRegistration.id.slice(-8)}.pdf`;
                        link.click();
                        URL.revokeObjectURL(url);
                        toast.success("Badge downloaded");
                      } catch {
                        toast.error("Badge generation failed");
                      } finally {
                        setPrintingBadge(false);
                      }
                    }}
                  >
                    {printingBadge ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <IdCard className="mr-2 h-4 w-4" />}
                    Print Badge
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/events/${eventId}/registrations/${selectedRegistration.id}/quote`} download>
                      <Download className="mr-2 h-4 w-4" /> Download Quote
                    </a>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" disabled={sendEmail.isPending}>
                        <Send className="mr-2 h-4 w-4" />
                        {sendEmail.isPending ? "Sending..." : "Send Email"}
                        <ChevronDown className="ml-1 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => sendEmail.mutate({ id: selectedRegistration.id, type: "confirmation" })}>
                        Registration Confirmation
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => sendEmail.mutate({ id: selectedRegistration.id, type: "reminder" })}>
                        Event Reminder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => sendEmail.mutate({ id: selectedRegistration.id, type: "payment-reminder" })}>
                        Payment Reminder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => sendEmail.mutate({ id: selectedRegistration.id, type: "custom" })}>
                        Custom Notification
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

              <div className="border-t" />

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

              {/* Source / Tracking */}
              {(selectedRegistration.referrer || selectedRegistration.utmSource) && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Source</h3>
                  <div className="bg-muted rounded-lg p-3 space-y-1.5 text-sm">
                    {selectedRegistration.utmSource && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Source</span>
                        <span className="font-medium">{selectedRegistration.utmSource}</span>
                      </div>
                    )}
                    {selectedRegistration.utmMedium && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Medium</span>
                        <span className="font-medium">{selectedRegistration.utmMedium}</span>
                      </div>
                    )}
                    {selectedRegistration.utmCampaign && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Campaign</span>
                        <span className="font-medium">{selectedRegistration.utmCampaign}</span>
                      </div>
                    )}
                    {selectedRegistration.referrer && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Referrer</span>
                        <span className="font-medium text-xs truncate max-w-[200px]">{selectedRegistration.referrer}</span>
                      </div>
                    )}
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
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
