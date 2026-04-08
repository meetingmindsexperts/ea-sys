"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  ArrowLeft,
  Save,
  Mail,
  Phone,
  Building,
  Briefcase,
  Globe,
  MapPin,
  Trash2,
  Send,
  FileText,
  Loader2,
  ChevronDown,
  Pencil,
  X,
  Stethoscope,
  Calendar,
} from "lucide-react";
import { CountrySelect } from "@/components/ui/country-select";
import { TitleSelect } from "@/components/ui/title-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { RegistrationTypeSelect } from "@/components/ui/registration-type-select";
import { TagInput } from "@/components/ui/tag-input";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { formatPersonName, formatDate } from "@/lib/utils";
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
  status: keyof typeof statusColors;
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
  topicSpeakers?: Array<{
    topic: {
      id: string;
      title: string;
      duration: number | null;
      session: {
        id: string;
        name: string;
        startTime: string;
      };
    };
  }>;
  abstracts: Array<{
    id: string;
    title: string;
    status: string;
    track?: { name: string };
  }>;
}

export default function SpeakerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const speakerId = params.speakerId as string;
  const [speaker, setSpeaker] = useState<Speaker | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const headerPhotoRef = useRef<HTMLInputElement>(null);
  const [formData, setFormData] = useState({
    title: "",
    email: "",
    firstName: "",
    lastName: "",
    bio: "",
    organization: "",
    jobTitle: "",
    phone: "",
    website: "",
    photo: null as string | null,
    city: "",
    country: "",
    specialty: "",
    registrationType: "",
    tags: [] as string[],
    status: "INVITED",
    socialLinks: {
      twitter: "",
      linkedin: "",
      github: "",
    },
  });
  const [isEmailDialogOpen, setIsEmailDialogOpen] = useState(false);
  const [emailType, setEmailType] = useState<"invitation" | "agreement" | "custom">("invitation");
  const [customEmailSubject, setCustomEmailSubject] = useState("");
  const [customEmailMessage, setCustomEmailMessage] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);

  const fetchSpeaker = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`);
      if (res.ok) {
        const data = await res.json();
        setSpeaker(data);
        setFormData({
          title: data.title || "",
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          bio: data.bio || "",
          organization: data.organization || "",
          jobTitle: data.jobTitle || "",
          phone: data.phone || "",
          website: data.website || "",
          photo: data.photo || null,
          city: data.city || "",
          country: data.country || "",
          specialty: data.specialty || "",
          registrationType: data.registrationType || "",
          tags: data.tags || [],
          status: data.status,
          socialLinks: {
            twitter: data.socialLinks?.twitter || "",
            linkedin: data.socialLinks?.linkedin || "",
            github: data.socialLinks?.github || "",
          },
        });
      } else {
        setError("Speaker not found");
      }
    } catch (err) {
      console.error("[speaker-detail] fetch failed", err);
      setError("Failed to load speaker");
    } finally {
      setLoading(false);
    }
  }, [eventId, speakerId]);

  useEffect(() => {
    fetchSpeaker();
  }, [fetchSpeaker]);

  const handleHeaderPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { toast.error("File size must be under 500KB"); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Only JPEG, PNG, and WebP allowed"); return; }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/upload/photo", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Upload failed"); return; }
      setFormData((prev) => ({ ...prev, photo: data.url }));
      toast.success("Photo uploaded");
    } catch { toast.error("Upload failed"); }
    if (headerPhotoRef.current) headerPhotoRef.current.value = "";
  };

  const startEditing = () => {
    if (!speaker) return;
    setFormData({
      title: speaker.title || "",
      email: speaker.email,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      bio: speaker.bio || "",
      organization: speaker.organization || "",
      jobTitle: speaker.jobTitle || "",
      phone: speaker.phone || "",
      website: speaker.website || "",
      photo: speaker.photo || null,
      city: speaker.city || "",
      country: speaker.country || "",
      specialty: speaker.specialty || "",
      registrationType: speaker.registrationType || "",
      tags: speaker.tags || [],
      status: speaker.status,
      socialLinks: {
        twitter: speaker.socialLinks?.twitter || "",
        linkedin: speaker.socialLinks?.linkedin || "",
        github: speaker.socialLinks?.github || "",
      },
    });
    setIsEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, photo: formData.photo ?? null }),
      });
      if (res.ok) {
        const data = await res.json();
        setSpeaker({ ...speaker!, ...data });
        setIsEditing(false);
        toast.success("Speaker updated");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save speaker");
      }
    } catch {
      toast.error("An error occurred. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this speaker?")) return;
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`, { method: "DELETE" });
      if (res.ok) {
        router.push(`/events/${eventId}/speakers`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete speaker");
      }
    } catch {
      toast.error("An error occurred. Please try again.");
    }
  };

  const handleSendEmail = async () => {
    if (sendingEmail) return;
    if (emailType === "custom" && (!customEmailSubject || !customEmailMessage)) {
      toast.error("Please provide subject and message");
      return;
    }
    setSendingEmail(true);
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}/email`, {
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
        setIsEmailDialogOpen(false);
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

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  if (error && !speaker) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600">{error}</p>
        <Button asChild className="mt-4">
          <Link href={`/events/${eventId}/speakers`}>Back to Speakers</Link>
        </Button>
      </div>
    );
  }

  if (!speaker) return null;

  const initials = `${speaker.firstName[0] ?? ""}${speaker.lastName[0] ?? ""}`.toUpperCase();

  return (
    <div className="space-y-6">
      {/* Gradient Header */}
      <div className="rounded-xl bg-gradient-to-r from-primary to-primary/70 px-6 py-5 text-white">
        <div className="flex items-center gap-2 mb-4">
          <Link href={`/events/${eventId}/speakers`} className="text-white/80 hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-white/60 text-sm font-medium">Back to Speakers</span>
        </div>

        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="flex-1">
            <h1 className="text-2xl font-bold">
              {formatPersonName(speaker.title, speaker.firstName, speaker.lastName)}
            </h1>
            <div className="flex gap-2 mt-2">
              <Badge className={`${statusColors[speaker.status]} border-white/30`} variant="outline">
                {speaker.status}
              </Badge>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 mt-4">
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
                      <DropdownMenuItem onClick={() => { setEmailType("invitation"); setIsEmailDialogOpen(true); }}>
                        <Mail className="mr-2 h-4 w-4" /> Speaker Invitation
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEmailType("agreement"); setIsEmailDialogOpen(true); }}>
                        <FileText className="mr-2 h-4 w-4" /> Speaker Agreement
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setEmailType("custom"); setIsEmailDialogOpen(true); }}>
                        <Send className="mr-2 h-4 w-4" /> Custom Email
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button size="sm" variant="secondary" className="text-red-600 hover:text-red-700" onClick={handleDelete}>
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={handleSave} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white">
                    <Save className="mr-2 h-4 w-4" /> {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setIsEditing(false)} disabled={saving}>
                    <X className="mr-2 h-4 w-4" /> Cancel
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Photo */}
          {(() => {
            const photoSrc = isEditing ? formData.photo : speaker.photo;
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
                    onClick={() => setFormData((prev) => ({ ...prev, photo: null }))}
                    className="mt-1.5 text-xs text-white/80 hover:text-white flex items-center gap-1"
                  >
                    <X className="h-3 w-3" /> Remove
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Content */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Speaker Information */}
          <Card>
            <CardHeader>
              <CardTitle>Speaker Information</CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="grid gap-4">
                  <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <TitleSelect value={formData.title} onChange={(title) => setFormData({ ...formData, title })} />
                    </div>
                    <div className="space-y-2">
                      <Label>First Name *</Label>
                      <Input value={formData.firstName} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} required />
                    </div>
                    <div className="space-y-2">
                      <Label>Last Name *</Label>
                      <Input value={formData.lastName} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} required />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Phone</Label>
                      <Input value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Organization</Label>
                      <Input value={formData.organization} onChange={(e) => setFormData({ ...formData, organization: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Job Title</Label>
                      <Input value={formData.jobTitle} onChange={(e) => setFormData({ ...formData, jobTitle: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Bio</Label>
                    <Textarea value={formData.bio} onChange={(e) => setFormData({ ...formData, bio: e.target.value })} rows={4} />
                  </div>
                  <div className="space-y-2">
                    <Label>Website</Label>
                    <Input type="url" value={formData.website} onChange={(e) => setFormData({ ...formData, website: e.target.value })} placeholder="https://..." />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>City</Label>
                      <Input value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Country</Label>
                      <CountrySelect value={formData.country} onChange={(country) => setFormData({ ...formData, country })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Specialty</Label>
                      <SpecialtySelect value={formData.specialty} onChange={(specialty) => setFormData({ ...formData, specialty })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Registration Type</Label>
                      <RegistrationTypeSelect value={formData.registrationType} onChange={(rt) => setFormData({ ...formData, registrationType: rt })} eventId={eventId} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
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
                    <TagInput value={formData.tags} onChange={(tags) => setFormData({ ...formData, tags })} placeholder="Type a tag and press Enter or comma" />
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
                    <div className="col-span-2 mt-2">
                      <div className="text-xs text-muted-foreground mb-1">Bio</div>
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
            </CardContent>
          </Card>

          {/* Sessions */}
          <Card>
            <CardHeader>
              <CardTitle>Sessions ({speaker.sessions.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {speaker.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions assigned yet.</p>
              ) : (
                <div className="space-y-2">
                  {speaker.sessions.map((s) => (
                    <div key={s.session.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div>
                        <p className="font-medium text-sm">{s.session.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(s.session.startTime).toLocaleString()}
                          {s.session.track && ` · ${s.session.track.name}`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Topics */}
          {speaker.topicSpeakers && speaker.topicSpeakers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Topics ({speaker.topicSpeakers.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {speaker.topicSpeakers.map((ts) => (
                    <div key={ts.topic.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div>
                        <p className="font-medium text-sm">{ts.topic.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {ts.topic.session.name}
                          {" · "}
                          {new Date(ts.topic.session.startTime).toLocaleString()}
                          {ts.topic.duration && ` · ${ts.topic.duration} min`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Abstracts */}
          <Card>
            <CardHeader>
              <CardTitle>Abstracts ({speaker.abstracts.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {speaker.abstracts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No abstracts submitted yet.</p>
              ) : (
                <div className="space-y-2">
                  {speaker.abstracts.map((abstract) => (
                    <div key={abstract.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div>
                        <p className="font-medium text-sm">{abstract.title}</p>
                        <p className="text-sm text-muted-foreground">{abstract.track?.name || "No track assigned"}</p>
                      </div>
                      <Badge variant="outline">{abstract.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Social Links */}
          <Card>
            <CardHeader>
              <CardTitle>Social Links</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                {speaker.socialLinks?.twitter && (
                  <a href={`https://twitter.com/${speaker.socialLinks.twitter.replace("@", "")}`} target="_blank" rel="noopener noreferrer" className="block text-primary hover:underline">
                    Twitter: {speaker.socialLinks.twitter}
                  </a>
                )}
                {speaker.socialLinks?.linkedin && (
                  <a href={speaker.socialLinks.linkedin} target="_blank" rel="noopener noreferrer" className="block text-primary hover:underline">
                    LinkedIn
                  </a>
                )}
                {speaker.socialLinks?.github && (
                  <a href={`https://github.com/${speaker.socialLinks.github.replace("@", "")}`} target="_blank" rel="noopener noreferrer" className="block text-primary hover:underline">
                    GitHub: {speaker.socialLinks.github}
                  </a>
                )}
                {!speaker.socialLinks?.twitter && !speaker.socialLinks?.linkedin && !speaker.socialLinks?.github && (
                  <p className="text-muted-foreground">No social links added.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-muted-foreground">Added</div>
                  <div className="font-medium">{formatDate(speaker.createdAt)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Email Dialog */}
      <Dialog open={isEmailDialogOpen} onOpenChange={setIsEmailDialogOpen}>
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
                  <Textarea value={customEmailMessage} onChange={(e) => setCustomEmailMessage(e.target.value)} placeholder="Your message to the speaker..." rows={6} />
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEmailDialogOpen(false)} disabled={sendingEmail}>Cancel</Button>
              <Button onClick={handleSendEmail} disabled={sendingEmail}>
                {sendingEmail && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {sendingEmail ? "Sending..." : "Send Email"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
