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
import { CountrySelect } from "@/components/ui/country-select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Mail,
  Phone,
  Building,
  Briefcase,
  MapPin,
  Pencil,
  Save,
  X,
  Trash2,
  Stethoscope,
  Calendar,
} from "lucide-react";
import { formatDate, formatPersonName } from "@/lib/utils";
import { useContact, useUpdateContact, useDeleteContact, queryKeys } from "@/hooks/use-api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const TAG_COLORS = [
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

interface ContactDetailSheetProps {
  contactId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContactDetailSheet({
  contactId,
  open,
  onOpenChange,
}: ContactDetailSheetProps) {
  const queryClient = useQueryClient();
  const { data: contactData } = useContact(contactId ?? "");
  const contact = contactData?.contact;
  const eventHistory = contactData?.eventHistory ?? [];
  const updateContact = useUpdateContact(contactId ?? "");
  const deleteContact = useDeleteContact();

  const [isEditing, setIsEditing] = useState(false);
  const headerPhotoRef = useRef<HTMLInputElement>(null);
  const [editData, setEditData] = useState({
    title: "" as string,
    firstName: "",
    lastName: "",
    email: "",
    additionalEmail: "",
    phone: "",
    organization: "",
    jobTitle: "",
    photo: null as string | null,
    city: "",
    country: "",
    bio: "",
    specialty: "",
    tags: [] as string[],
    notes: "",
  });

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

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) setIsEditing(false);
    onOpenChange(isOpen);
  };

  const startEditing = () => {
    if (contact) {
      setEditData({
        title: contact.title || "",
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        additionalEmail: contact.additionalEmail || "",
        phone: contact.phone || "",
        organization: contact.organization || "",
        jobTitle: contact.jobTitle || "",
        photo: contact.photo || null,
        city: contact.city || "",
        country: contact.country || "",
        bio: contact.bio || "",
        specialty: contact.specialty || "",
        tags: contact.tags || [],
        notes: contact.notes || "",
      });
      setIsEditing(true);
    }
  };

  const saveEdits = async () => {
    try {
      await updateContact.mutateAsync({
        title: editData.title || undefined,
        firstName: editData.firstName,
        lastName: editData.lastName,
        additionalEmail: editData.additionalEmail || undefined,
        phone: editData.phone || undefined,
        organization: editData.organization || undefined,
        jobTitle: editData.jobTitle || undefined,
        photo: editData.photo ?? null,
        city: editData.city || undefined,
        country: editData.country || undefined,
        bio: editData.bio || undefined,
        specialty: editData.specialty || undefined,
        tags: editData.tags,
        notes: editData.notes || undefined,
      });
      toast.success("Contact updated");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update contact");
    }
  };

  const handleDelete = async () => {
    if (!contactId) return;
    if (!confirm("Are you sure you want to delete this contact?")) return;
    try {
      await deleteContact.mutateAsync(contactId);
      toast.success("Contact deleted");
      onOpenChange(false);
    } catch {
      toast.error("Failed to delete contact");
    }
  };

  if (!contact) return null;

  const initials = `${contact.firstName[0] ?? ""}${contact.lastName[0] ?? ""}`.toUpperCase();

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="overflow-y-auto p-0 w-full sm:w-[700px]">
        {/* Header with actions */}
        <div className="sticky top-0 z-10 bg-gradient-to-r from-primary to-primary/70 px-6 py-4 text-white">
          <div className="flex items-start justify-between gap-4 pr-8">
            <SheetHeader className="flex-1">
              <SheetTitle className="text-white text-lg">
                {formatPersonName(contact.title, contact.firstName, contact.lastName)}
              </SheetTitle>
              <SheetDescription>
                {contact.tags && contact.tags.length > 0 && (
                  <span className="flex flex-wrap gap-1 mt-1">
                    {contact.tags.map((tag: string) => (
                      <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}>
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </SheetDescription>
            </SheetHeader>
            {(() => {
              const photoSrc = isEditing ? editData.photo : contact.photo;
              const avatar = photoSrc ? (
                <Image src={photoSrc} alt="" width={112} height={112} className="w-28 h-28 rounded-full object-cover ring-2 ring-white/40 shrink-0" unoptimized />
              ) : (
                <div className="w-28 h-28 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-2xl shrink-0">
                  {initials}
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
          <div className="flex flex-wrap gap-2 mt-3">
            {!isEditing ? (
              <>
                <Button size="sm" variant="secondary" onClick={startEditing}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-red-600 hover:text-red-700"
                  onClick={handleDelete}
                  disabled={deleteContact.isPending}
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
                  disabled={updateContact.isPending}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateContact.isPending ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setIsEditing(false)}
                  disabled={updateContact.isPending}
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Contact Info */}
          <div className="space-y-4">
            <h3 className="font-semibold">Contact Information</h3>
            {isEditing ? (
              <div className="grid gap-4">
                <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                  <div className="space-y-2">
                    <Label>Title</Label>
                    <TitleSelect
                      value={editData.title}
                      onChange={(title) => setEditData({ ...editData, title })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>First Name *</Label>
                    <Input
                      value={editData.firstName}
                      onChange={(e) => setEditData({ ...editData, firstName: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Last Name *</Label>
                    <Input
                      value={editData.lastName}
                      onChange={(e) => setEditData({ ...editData, lastName: e.target.value })}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input value={editData.email} disabled className="bg-muted" />
                  <p className="text-xs text-muted-foreground">Email cannot be changed</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      value={editData.phone}
                      onChange={(e) => setEditData({ ...editData, phone: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Additional Email</Label>
                    <Input
                      type="email"
                      value={editData.additionalEmail || ""}
                      onChange={(e) => setEditData({ ...editData, additionalEmail: e.target.value })}
                      placeholder="alternate@example.com"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Organization</Label>
                    <Input
                      value={editData.organization}
                      onChange={(e) => setEditData({ ...editData, organization: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Job Title</Label>
                    <Input
                      value={editData.jobTitle}
                      onChange={(e) => setEditData({ ...editData, jobTitle: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input
                      value={editData.city}
                      onChange={(e) => setEditData({ ...editData, city: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Country</Label>
                    <CountrySelect
                      value={editData.country}
                      onChange={(country) => setEditData({ ...editData, country })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Specialty</Label>
                  <SpecialtySelect
                    value={editData.specialty}
                    onChange={(specialty) => setEditData({ ...editData, specialty })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Bio</Label>
                  <textarea
                    placeholder="Short biography"
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={editData.bio}
                    onChange={(e) => setEditData({ ...editData, bio: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tags</Label>
                  <TagInput
                    value={editData.tags}
                    onChange={(tags) => setEditData({ ...editData, tags })}
                    placeholder="Type a tag and press Enter or comma"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <textarea
                    placeholder="Internal notes"
                    className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={editData.notes}
                    onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <a href={`mailto:${contact.email}`} className="text-sm hover:text-primary transition-colors truncate">
                    {contact.email}
                  </a>
                </div>
                {contact.phone ? (
                  <div className="flex items-center gap-3">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm">{contact.phone}</span>
                  </div>
                ) : <div />}
                {contact.organization && (
                  <div className="flex items-center gap-3">
                    <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm">{contact.organization}</span>
                  </div>
                )}
                {contact.jobTitle && (
                  <div className="flex items-center gap-3">
                    <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm">{contact.jobTitle}</span>
                  </div>
                )}
                {(contact.city || contact.country) && (
                  <div className="flex items-center gap-3">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm">
                      {[contact.city, contact.country].filter(Boolean).join(", ")}
                    </span>
                  </div>
                )}
                {contact.specialty && (
                  <div className="flex items-center gap-3">
                    <Stethoscope className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-xs text-muted-foreground">Specialty</div>
                      <div className="text-sm">{contact.specialty}</div>
                    </div>
                  </div>
                )}
                {contact.bio && (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Bio</div>
                    <div className="text-sm whitespace-pre-wrap">{contact.bio}</div>
                  </div>
                )}
                {contact.notes && (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Notes</div>
                    <div className="text-sm whitespace-pre-wrap bg-muted p-3 rounded-lg">{contact.notes}</div>
                  </div>
                )}
                {contact.tags && contact.tags.length > 0 && (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground mb-1">Tags</div>
                    <div className="flex flex-wrap gap-1">
                      {contact.tags.map((tag: string) => (
                        <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Timeline */}
          <div className="flex items-center gap-3 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-muted-foreground">Added</div>
              <div className="font-medium">{formatDate(contact.createdAt)}</div>
            </div>
          </div>

          {/* Event History */}
          {eventHistory.length > 0 && (
            <div className="space-y-3">
              <h3 className="font-semibold">Event History ({eventHistory.length})</h3>
              <div className="space-y-2">
                {eventHistory.map((item: { eventId: string; eventName: string; role: string; status: string; createdAt: string }, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-muted rounded-lg text-sm">
                    <div>
                      <div className="font-medium">{item.eventName}</div>
                      <div className="text-muted-foreground">{item.role}</div>
                    </div>
                    <Badge variant="outline">{item.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
