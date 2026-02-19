"use client";

import { useCallback, useEffect, useState } from "react";
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
  Mic,
  Save,
  Mail,
  Building,
  Globe,
  Trash2,
  Send,
  FileText,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

const statusColors = {
  INVITED: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface Speaker {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  organization: string | null;
  jobTitle: string | null;
  website: string | null;
  photo: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  status: keyof typeof statusColors;
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
  const [formData, setFormData] = useState({
    email: "",
    firstName: "",
    lastName: "",
    bio: "",
    organization: "",
    jobTitle: "",
    website: "",
    photo: null as string | null,
    city: "",
    country: "",
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
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  const fetchSpeaker = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`);
      if (res.ok) {
        const data = await res.json();
        setSpeaker(data);
        setFormData({
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          bio: data.bio || "",
          organization: data.organization || "",
          jobTitle: data.jobTitle || "",
          website: data.website || "",
          photo: data.photo || null,
          city: data.city || "",
          country: data.country || "",
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
    } catch {
      setError("Failed to load speaker");
    } finally {
      setLoading(false);
    }
  }, [eventId, speakerId]);

  useEffect(() => {
    fetchSpeaker();
  }, [fetchSpeaker]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        const data = await res.json();
        setSpeaker({ ...speaker!, ...data });
        setIsEditing(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save speaker");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this speaker?")) return;

    try {
      const res = await fetch(`/api/events/${eventId}/speakers/${speakerId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        router.push(`/events/${eventId}/speakers`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete speaker");
      }
    } catch {
      setError("An error occurred. Please try again.");
    }
  };

  const handleSendEmail = async () => {
    if (sendingEmail) return;

    if (emailType === "custom" && (!customEmailSubject || !customEmailMessage)) {
      setError("Please provide subject and message for custom email");
      return;
    }

    setSendingEmail(true);
    setError(null);
    setEmailSuccess(null);

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
        setEmailSuccess(data.message || "Email sent successfully!");
        setIsEmailDialogOpen(false);
        setCustomEmailSubject("");
        setCustomEmailMessage("");
      } else {
        setError(data.error || "Failed to send email");
      }
    } catch {
      setError("An error occurred while sending email");
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}/speakers`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Mic className="h-8 w-8" />
              {speaker.firstName} {speaker.lastName}
            </h1>
            <Badge className={statusColors[speaker.status]} variant="outline">
              {speaker.status}
            </Badge>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            {speaker.email && (
              <div className="flex items-center gap-1">
                <Mail className="h-4 w-4" />
                {speaker.email}
              </div>
            )}
            {speaker.organization && (
              <div className="flex items-center gap-1">
                <Building className="h-4 w-4" />
                {speaker.organization}
              </div>
            )}
            {speaker.website && (
              <a
                href={speaker.website}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-foreground"
              >
                <Globe className="h-4 w-4" />
                Website
              </a>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!isEditing && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Send className="mr-2 h-4 w-4" />
                    Send Email
                    <ChevronDown className="ml-2 h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setEmailType("invitation");
                      setIsEmailDialogOpen(true);
                    }}
                  >
                    <Mail className="mr-2 h-4 w-4" />
                    Speaker Invitation
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setEmailType("agreement");
                      setIsEmailDialogOpen(true);
                    }}
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    Speaker Agreement
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setEmailType("custom");
                      setIsEmailDialogOpen(true);
                    }}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Custom Email
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {emailSuccess && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          {emailSuccess}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content */}
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Speaker Information</CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">First Name</Label>
                      <Input
                        id="firstName"
                        value={formData.firstName}
                        onChange={(e) =>
                          setFormData({ ...formData, firstName: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName">Last Name</Label>
                      <Input
                        id="lastName"
                        value={formData.lastName}
                        onChange={(e) =>
                          setFormData({ ...formData, lastName: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) =>
                        setFormData({ ...formData, email: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="organization">Organization</Label>
                      <Input
                        id="organization"
                        value={formData.organization}
                        onChange={(e) =>
                          setFormData({ ...formData, organization: e.target.value })
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
                  <div className="space-y-2">
                    <Label htmlFor="bio">Bio</Label>
                    <Textarea
                      id="bio"
                      value={formData.bio}
                      onChange={(e) =>
                        setFormData({ ...formData, bio: e.target.value })
                      }
                      rows={4}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="website">Website</Label>
                    <Input
                      id="website"
                      type="url"
                      value={formData.website}
                      onChange={(e) =>
                        setFormData({ ...formData, website: e.target.value })
                      }
                      placeholder="https://..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Photo</Label>
                    <PhotoUpload
                      value={formData.photo}
                      onChange={(photo) => setFormData({ ...formData, photo })}
                    />
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={formData.city}
                        onChange={(e) =>
                          setFormData({ ...formData, city: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="country">Country</Label>
                      <CountrySelect
                        value={formData.country}
                        onChange={(country) => setFormData({ ...formData, country })}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tags">Tags</Label>
                    <Input
                      id="tags"
                      value={formData.tags.join(", ")}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          tags: e.target.value.split(",").map(t => t.trim()).filter(t => t)
                        })
                      }
                      placeholder="e.g., Keynote, Panelist, VIP"
                    />
                    <p className="text-xs text-muted-foreground">
                      Add tags separated by commas
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={formData.status}
                      onValueChange={(value) =>
                        setFormData({ ...formData, status: value })
                      }
                    >
                      <SelectTrigger>
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
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setIsEditing(false)}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving}>
                      <Save className="mr-2 h-4 w-4" />
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {speaker.bio && (
                    <div>
                      <h4 className="font-medium mb-1">Bio</h4>
                      <p className="text-muted-foreground whitespace-pre-wrap">
                        {speaker.bio}
                      </p>
                    </div>
                  )}
                  {speaker.jobTitle && (
                    <div>
                      <h4 className="font-medium mb-1">Job Title</h4>
                      <p className="text-muted-foreground">{speaker.jobTitle}</p>
                    </div>
                  )}
                  {speaker.tags && speaker.tags.length > 0 && (
                    <div>
                      <h4 className="font-medium mb-1">Tags</h4>
                      <div className="flex flex-wrap gap-1">
                        {speaker.tags.map((tag, index) => (
                          <Badge key={index} variant="secondary">{tag}</Badge>
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
                <p className="text-muted-foreground">No sessions assigned yet.</p>
              ) : (
                <div className="space-y-2">
                  {speaker.sessions.map((s) => (
                    <div
                      key={s.session.id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{s.session.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(s.session.startTime).toLocaleString()}
                          {s.session.track && ` • ${s.session.track.name}`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Abstracts */}
          <Card>
            <CardHeader>
              <CardTitle>Abstracts ({speaker.abstracts.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {speaker.abstracts.length === 0 ? (
                <p className="text-muted-foreground">No abstracts submitted yet.</p>
              ) : (
                <div className="space-y-2">
                  {speaker.abstracts.map((abstract) => (
                    <div
                      key={abstract.id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{abstract.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {abstract.track?.name || "No track assigned"}
                        </p>
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
          {speaker.photo && (
            <Card>
              <CardContent className="pt-6">
                <Image
                  src={speaker.photo}
                  alt={`${speaker.firstName} ${speaker.lastName}`}
                  width={400}
                  height={400}
                  className="w-full rounded-lg"
                  unoptimized
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Social Links</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                {speaker.socialLinks?.twitter && (
                  <a
                    href={`https://twitter.com/${speaker.socialLinks.twitter.replace("@", "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-600 hover:underline"
                  >
                    Twitter: {speaker.socialLinks.twitter}
                  </a>
                )}
                {speaker.socialLinks?.linkedin && (
                  <a
                    href={speaker.socialLinks.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-600 hover:underline"
                  >
                    LinkedIn
                  </a>
                )}
                {speaker.socialLinks?.github && (
                  <a
                    href={`https://github.com/${speaker.socialLinks.github.replace("@", "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-600 hover:underline"
                  >
                    GitHub: {speaker.socialLinks.github}
                  </a>
                )}
                {!speaker.socialLinks?.twitter &&
                  !speaker.socialLinks?.linkedin &&
                  !speaker.socialLinks?.github && (
                    <p className="text-muted-foreground">No social links added.</p>
                  )}
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
                <strong>To:</strong> {speaker.firstName} {speaker.lastName} ({speaker.email})
              </p>
            </div>

            {emailType === "invitation" && (
              <p className="text-sm text-muted-foreground">
                This will send a speaker invitation email with event details and a request to confirm participation.
              </p>
            )}

            {emailType === "agreement" && (
              <p className="text-sm text-muted-foreground">
                This will send a speaker agreement email with event details, session information (if assigned), and agreement terms.
              </p>
            )}

            {emailType === "custom" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="emailSubject">Subject</Label>
                  <Input
                    id="emailSubject"
                    value={customEmailSubject}
                    onChange={(e) => setCustomEmailSubject(e.target.value)}
                    placeholder="Email subject"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emailMessage">Message</Label>
                  <Textarea
                    id="emailMessage"
                    value={customEmailMessage}
                    onChange={(e) => setCustomEmailMessage(e.target.value)}
                    placeholder="Your message to the speaker..."
                    rows={6}
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setIsEmailDialogOpen(false)}
                disabled={sendingEmail}
              >
                Cancel
              </Button>
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
