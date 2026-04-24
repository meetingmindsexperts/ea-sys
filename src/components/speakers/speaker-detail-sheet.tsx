"use client";

import Image from "next/image";
import { useState, useRef, useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { RegistrationTypeSelect } from "@/components/ui/registration-type-select";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  MapPin,
  Globe,
  Pencil,
  Save,
  X,
  Trash2,
  Stethoscope,
  Calendar,
  Send,
  FileText,
  ChevronDown,
  Loader2,
  Eye,
} from "lucide-react";
import { formatDate, formatPersonName } from "@/lib/utils";
import { queryKeys, usePreviewEmailBySlug } from "@/hooks/use-api";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { ChangeEmailDialog } from "@/components/change-email-dialog";
import { EmailLogCard } from "@/components/communications/email-log-card";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface Speaker {
  id: string;
  title: string | null;
  email: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  website: string | null;
  photo: string | null;
  city: string | null;
  country: string | null;
  specialty: string | null;
  registrationType: string | null;
  tags: string[];
  status: string;
  agreementAcceptedAt: string | null;
  createdAt: string;
  socialLinks: {
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
  sessions: Array<{
    session: {
      id: string;
      name: string;
      startTime: string;
      track?: { name: string };
    };
  }>;
  abstracts: Array<{
    id: string;
    title: string;
    status: string;
    track?: { name: string };
  }>;
}

interface SpeakerDetailSheetProps {
  eventId: string;
  speakerId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SpeakerDetailSheet({
  eventId,
  speakerId,
  open,
  onOpenChange,
}: SpeakerDetailSheetProps) {
  const queryClient = useQueryClient();
  const [speaker, setSpeaker] = useState<Speaker | null>(null);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const headerPhotoRef = useRef<HTMLInputElement>(null);

  const [editData, setEditData] = useState({
    title: "" as string,
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    organization: "",
    jobTitle: "",
    bio: "",
    website: "",
    photo: null as string | null,
    city: "",
    country: "",
    specialty: "",
    registrationType: "",
    tags: [] as string[],
    status: "INVITED",
  });

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailType, setEmailType] = useState<"invitation" | "agreement" | "custom">("invitation");
  const [customEmailSubject, setCustomEmailSubject] = useState("");
  const [customEmailMessage, setCustomEmailMessage] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const previewMutation = usePreviewEmailBySlug(eventId);

  const handlePreviewEmail = async () => {
    const slugMap: Record<string, string> = {
      invitation: "speaker-invitation",
      agreement: "speaker-agreement",
      custom: "custom-notification",
    };
    try {
      const result = await previewMutation.mutateAsync({
        slug: slugMap[emailType],
        customSubject: emailType === "custom" ? customEmailSubject.trim() || undefined : undefined,
        customMessage: emailType === "custom" ? customEmailMessage.trim() || undefined : undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch {
      toast.error("Failed to generate preview");
    }
  };

  const fetchSpeaker = useCallback(async () => {
    if (!speakerId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`);
      if (res.ok) {
        const data = await res.json();
        setSpeaker(data);
      }
    } catch {
      toast.error("Failed to load speaker");
    } finally {
      setLoading(false);
    }
  }, [eventId, speakerId]);

  useEffect(() => {
    if (open && speakerId) {
      fetchSpeaker();
      setIsEditing(false);
    }
  }, [open, speakerId, fetchSpeaker]);

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

  const startEditing = () => {
    if (!speaker) return;
    setEditData({
      title: speaker.title || "",
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      email: speaker.email,
      phone: speaker.phone || "",
      organization: speaker.organization || "",
      jobTitle: speaker.jobTitle || "",
      bio: speaker.bio || "",
      website: speaker.website || "",
      photo: speaker.photo || null,
      city: speaker.city || "",
      country: speaker.country || "",
      specialty: speaker.specialty || "",
      registrationType: speaker.registrationType || "",
      tags: speaker.tags || [],
      status: speaker.status,
    });
    setIsEditing(true);
  };

  const saveEdits = async () => {
    if (!speaker) return;
    setSaving(true);
    try {
      // Strip email — it's immutable on this path. Use the Change Email
      // dialog (which PATCHes /email) for the cascading update.
      const { email: _ignored, ...editable } = editData;
      void _ignored;
      const res = await fetch(`/api/events/${eventId}/speakers/${speaker.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editable,
          photo: editData.photo ?? null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSpeaker({ ...speaker, ...data });
        setIsEditing(false);
        toast.success("Speaker updated");
        queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to update");
      }
    } catch {
      toast.error("Failed to update speaker");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!speaker) return;
    if (!confirm("Are you sure you want to delete this speaker?")) return;
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speaker.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Speaker deleted");
        onOpenChange(false);
        queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete");
      }
    } catch {
      toast.error("Failed to delete speaker");
    }
  };

  const handleSendEmail = async () => {
    if (!speaker || sendingEmail) return;
    if (emailType === "custom" && (!customEmailSubject || !customEmailMessage)) {
      toast.error("Please provide subject and message");
      return;
    }
    setSendingEmail(true);
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speaker.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: emailType,
          customSubject: customEmailSubject || undefined,
          customMessage: customEmailMessage || undefined,
          includeAgreementLink: emailType === "agreement",
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message || "Email sent");
        setEmailDialogOpen(false);
        setCustomEmailSubject("");
        setCustomEmailMessage("");
      } else {
        toast.error(data.error || "Failed to send email");
      }
    } catch {
      toast.error("Failed to send email");
    } finally {
      setSendingEmail(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) setIsEditing(false);
    onOpenChange(isOpen);
  };

  if (!speaker && !loading) return null;

  const initials = speaker ? `${speaker.firstName[0] ?? ""}${speaker.lastName[0] ?? ""}`.toUpperCase() : "";

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="overflow-y-auto p-0 w-full sm:w-[700px]">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : speaker ? (
            <>
              {/* Header */}
              <div className="sticky top-0 z-10 bg-gradient-to-r from-primary to-primary/70 px-6 py-4 text-white">
                <div className="flex items-start justify-between gap-4 pr-8">
                  <SheetHeader className="flex-1">
                    <SheetTitle className="text-white text-lg">
                      {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
                    </SheetTitle>
                    <SheetDescription asChild>
                      <span className="flex gap-2 mt-1">
                        <Badge className={`${statusColors[speaker.status] || "bg-gray-100 text-gray-800"} border-white/30`} variant="outline">
                          {speaker.status}
                        </Badge>
                        {speaker.agreementAcceptedAt && (
                          <Badge className="bg-emerald-100 text-emerald-800 border-white/30" variant="outline">
                            Agreement Accepted
                          </Badge>
                        )}
                      </span>
                    </SheetDescription>
                  </SheetHeader>
                  {(() => {
                    const photoSrc = isEditing ? editData.photo : speaker.photo;
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

                {/* Quick Actions */}
                <div className="flex flex-wrap gap-2 mt-3">
                  {!isEditing ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={startEditing}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="secondary">
                            <Send className="mr-2 h-4 w-4" /> Send Email
                            <ChevronDown className="ml-1 h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onClick={() => { setEmailType("invitation"); setEmailDialogOpen(true); }}>
                            <Mail className="mr-2 h-4 w-4" /> Speaker Invitation
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setEmailType("agreement"); setEmailDialogOpen(true); }}>
                            <FileText className="mr-2 h-4 w-4" /> Speaker Agreement
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setEmailType("custom"); setEmailDialogOpen(true); }}>
                            <Send className="mr-2 h-4 w-4" /> Custom Email
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-red-600 hover:text-red-700"
                        onClick={handleDelete}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={saveEdits} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white">
                        <Save className="mr-2 h-4 w-4" /> {saving ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setIsEditing(false)} disabled={saving}>
                        <X className="mr-2 h-4 w-4" /> Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="px-6 py-5 space-y-5">
                {/* Speaker Info */}
                <div className="space-y-4">
                  <h3 className="font-semibold">Speaker Information</h3>
                  {isEditing ? (
                    <div className="grid gap-4">
                      <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                        <div className="space-y-2">
                          <Label>Title</Label>
                          <TitleSelect value={editData.title} onChange={(title) => setEditData({ ...editData, title })} />
                        </div>
                        <div className="space-y-2">
                          <Label>First Name *</Label>
                          <Input value={editData.firstName} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} required />
                        </div>
                        <div className="space-y-2">
                          <Label>Last Name *</Label>
                          <Input value={editData.lastName} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} required />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Email</Label>
                          <div className="flex gap-2">
                            <Input value={editData.email} disabled readOnly className="flex-1" />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setChangeEmailOpen(true)}
                            >
                              Change
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Email changes cascade to login + contact records.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Phone</Label>
                          <Input value={editData.phone} onChange={(e) => setEditData({ ...editData, phone: e.target.value })} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Organization</Label>
                          <Input value={editData.organization} onChange={(e) => setEditData({ ...editData, organization: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>Job Title</Label>
                          <Input value={editData.jobTitle} onChange={(e) => setEditData({ ...editData, jobTitle: e.target.value })} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Bio</Label>
                        <Textarea value={editData.bio} onChange={(e) => setEditData({ ...editData, bio: e.target.value })} rows={3} />
                      </div>
                      <div className="space-y-2">
                        <Label>Website</Label>
                        <Input value={editData.website} onChange={(e) => setEditData({ ...editData, website: e.target.value })} placeholder="https://..." />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>City</Label>
                          <Input value={editData.city} onChange={(e) => setEditData({ ...editData, city: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>Country</Label>
                          <CountrySelect value={editData.country} onChange={(country) => setEditData({ ...editData, country })} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Specialty</Label>
                          <SpecialtySelect value={editData.specialty} onChange={(specialty) => setEditData({ ...editData, specialty })} />
                        </div>
                        <div className="space-y-2">
                          <Label>Registration Type</Label>
                          <RegistrationTypeSelect value={editData.registrationType} onChange={(rt) => setEditData({ ...editData, registrationType: rt })} eventId={eventId} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Status</Label>
                        <Select value={editData.status} onValueChange={(value) => setEditData({ ...editData, status: value })}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="INVITED">Invited</SelectItem>
                            <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                            <SelectItem value="DECLINED">Declined</SelectItem>
                            <SelectItem value="CANCELLED">Cancelled</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Tags</Label>
                        <TagInput value={editData.tags} onChange={(tags) => setEditData({ ...editData, tags })} placeholder="Type a tag and press Enter or comma" />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                      <div className="flex items-center gap-3">
                        <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{speaker.email}</span>
                      </div>
                      {speaker.phone ? (
                        <div className="flex items-center gap-3">
                          <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm">{speaker.phone}</span>
                        </div>
                      ) : <div />}
                      {speaker.organization && (
                        <div className="flex items-center gap-3">
                          <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm">{speaker.organization}</span>
                        </div>
                      )}
                      {speaker.jobTitle && (
                        <div className="flex items-center gap-3">
                          <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm">{speaker.jobTitle}</span>
                        </div>
                      )}
                      {(speaker.city || speaker.country) && (
                        <div className="flex items-center gap-3">
                          <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm">{[speaker.city, speaker.country].filter(Boolean).join(", ")}</span>
                        </div>
                      )}
                      {speaker.specialty && (
                        <div className="flex items-center gap-3">
                          <Stethoscope className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div>
                            <div className="text-xs text-muted-foreground">Specialty</div>
                            <div className="text-sm">{speaker.specialty}</div>
                          </div>
                        </div>
                      )}
                      {speaker.website && (
                        <div className="flex items-center gap-3">
                          <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                          <a href={speaker.website} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate">
                            {speaker.website}
                          </a>
                        </div>
                      )}
                      {speaker.registrationType && (
                        <div className="flex items-center gap-3">
                          <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div>
                            <div className="text-xs text-muted-foreground">Registration Type</div>
                            <div className="text-sm">{speaker.registrationType}</div>
                          </div>
                        </div>
                      )}
                      {speaker.bio && (
                        <div className="col-span-2">
                          <div className="text-xs text-muted-foreground">Bio</div>
                          <div className="text-sm whitespace-pre-wrap">{speaker.bio}</div>
                        </div>
                      )}
                      {speaker.tags && speaker.tags.length > 0 && (
                        <div className="col-span-2">
                          <div className="text-xs text-muted-foreground mb-1">Tags</div>
                          <div className="flex flex-wrap gap-1">
                            {speaker.tags.map((tag, i) => (
                              <Badge key={i} variant="secondary" className="text-xs">{tag}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t" />

                {/* Sessions */}
                <div className="space-y-3">
                  <h3 className="font-semibold">Sessions ({speaker.sessions.length})</h3>
                  {speaker.sessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sessions assigned yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {speaker.sessions.map((s) => (
                        <div key={s.session.id} className="flex items-center justify-between p-3 bg-muted rounded-lg text-sm">
                          <div>
                            <div className="font-medium">{s.session.name}</div>
                            <div className="text-muted-foreground">
                              {new Date(s.session.startTime).toLocaleString()}
                              {s.session.track && ` · ${s.session.track.name}`}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t" />

                {/* Abstracts */}
                <div className="space-y-3">
                  <h3 className="font-semibold">Abstracts ({speaker.abstracts.length})</h3>
                  {speaker.abstracts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No abstracts submitted yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {speaker.abstracts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between p-3 bg-muted rounded-lg text-sm">
                          <div>
                            <div className="font-medium">{a.title}</div>
                            <div className="text-muted-foreground">{a.track?.name || "No track"}</div>
                          </div>
                          <Badge variant="outline">{a.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t" />

                {/* Social Links */}
                {(speaker.socialLinks?.twitter || speaker.socialLinks?.linkedin || speaker.socialLinks?.github) && (
                  <div className="space-y-3">
                    <h3 className="font-semibold">Social Links</h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {speaker.socialLinks.twitter && (
                        <a href={`https://twitter.com/${speaker.socialLinks.twitter.replace("@", "")}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          Twitter: {speaker.socialLinks.twitter}
                        </a>
                      )}
                      {speaker.socialLinks.linkedin && (
                        <a href={speaker.socialLinks.linkedin} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          LinkedIn
                        </a>
                      )}
                      {speaker.socialLinks.github && (
                        <a href={`https://github.com/${speaker.socialLinks.github.replace("@", "")}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          GitHub: {speaker.socialLinks.github}
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {/* Timeline */}
                <div className="flex items-center gap-3 text-sm">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="text-muted-foreground">Added</div>
                    <div className="font-medium">{formatDate(speaker.createdAt)}</div>
                  </div>
                </div>
              </div>

              {/* ── Email history ─────────────────────────────────────── */}
              <EmailLogCard entityType="SPEAKER" entityId={speaker.id} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Email Dialog */}
      {speaker && (
        <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
          <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl">
            <DialogHeader>
              <DialogTitle>
                {emailType === "invitation" && "Send Speaker Invitation"}
                {emailType === "agreement" && "Send Speaker Agreement"}
                {emailType === "custom" && "Send Custom Email"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="bg-muted p-3 rounded-lg">
                <p className="text-sm">
                  <strong>To:</strong> {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)} ({speaker.email})
                </p>
              </div>
              {emailType === "invitation" && (
                <p className="text-sm text-muted-foreground">
                  This will send a speaker invitation email with event details and a request to confirm participation.
                </p>
              )}
              {emailType === "agreement" && (
                <p className="text-sm text-muted-foreground">
                  This will send a speaker agreement email with event details, session information, and agreement terms.
                </p>
              )}
              {emailType === "custom" && (
                <>
                  <div className="space-y-2">
                    <Label>Subject</Label>
                    <Input value={customEmailSubject} onChange={(e) => setCustomEmailSubject(e.target.value)} placeholder="Email subject" />
                  </div>
                  <div className="space-y-2">
                    <Label>Message</Label>
                    <Textarea value={customEmailMessage} onChange={(e) => setCustomEmailMessage(e.target.value)} placeholder="Your message..." rows={6} />
                  </div>
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEmailDialogOpen(false)} disabled={sendingEmail}>Cancel</Button>
                <Button variant="outline" onClick={handlePreviewEmail} disabled={previewMutation.isPending || sendingEmail}>
                  {previewMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                  Preview
                </Button>
                <Button onClick={handleSendEmail} disabled={sendingEmail}>
                  {sendingEmail && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {sendingEmail ? "Sending..." : "Send Email"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {previewData && (
        <EmailPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          subject={previewData.subject}
          htmlContent={previewData.htmlContent}
        />
      )}

      {speaker && (
        <ChangeEmailDialog
          open={changeEmailOpen}
          onOpenChange={setChangeEmailOpen}
          currentEmail={speaker.email}
          endpoint={`/api/events/${eventId}/speakers/${speaker.id}/email`}
          entityLabel="speaker"
          onSuccess={() => {
            fetchSpeaker();
            queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
          }}
        />
      )}
    </>
  );
}
