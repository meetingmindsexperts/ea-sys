"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AbstractThemesSettings } from "@/components/abstracts/abstract-themes-settings";
import { ReviewCriteriaSettings } from "@/components/abstracts/review-criteria-settings";
import Image from "next/image";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Settings,
  ArrowLeft,
  Save,
  Trash2,
  Globe,
  Bell,
  Shield,
  ImageIcon,
  Ticket,
  History,
  ArrowRight,
  Mail,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useEmailTemplates, useCreateEmailTemplate } from "@/hooks/use-api";
import { toast } from "sonner";
import { Loader2, Pencil, Plus } from "lucide-react";
import dynamic from "next/dynamic";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  { ssr: false, loading: () => <div className="h-[200px] border rounded-md animate-pulse bg-muted/50" /> }
);

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  eventType: string | null;
  tag: string | null;
  specialty: string | null;
  code: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  status: string;
  bannerImage: string | null;
  footerHtml: string | null;
  emailHeaderImage: string | null;
  emailFooterHtml: string | null;
  emailFromAddress: string | null;
  emailFromName: string | null;
  supportEmail: string | null;
  taxRate: number | null;
  taxLabel: string | null;
  bankDetails: string | null;
  badgeVerticalOffset: number;
  settings: {
    registrationOpen?: boolean;
    waitlistEnabled?: boolean;
    requireApproval?: boolean;
    maxAttendees?: number;
    showRemainingTickets?: boolean;
    allowAbstractSubmissions?: boolean;
    abstractDeadline?: string;
    notifyOnRegistration?: boolean;
    notifyOnAbstractSubmission?: boolean;
    programmePublished?: boolean;
  };
}

const timezones = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

const eventStatuses = [
  { value: "DRAFT", label: "Draft" },
  { value: "PUBLISHED", label: "Published" },
  { value: "LIVE", label: "Live" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export default function EventSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [generalFormData, setGeneralFormData] = useState({
    name: "",
    slug: "",
    description: "",
    eventType: "",
    tag: "",
    specialty: "",
    code: "",
    startDate: "",
    endDate: "",
    timezone: "UTC",
    venue: "",
    address: "",
    city: "",
    country: "",
    status: "DRAFT",
    supportEmail: "",
    taxRate: "",
    taxLabel: "VAT",
    bankDetails: "",
    badgeVerticalOffset: 0,
  });

  const [registrationSettings, setRegistrationSettings] = useState({
    registrationOpen: true,
    waitlistEnabled: false,
    requireApproval: false,
    maxAttendees: 0,
    showRemainingTickets: true,
  });

  const [programmeSettings, setProgrammeSettings] = useState({
    programmePublished: false,
  });

  const [abstractSettings, setAbstractSettings] = useState({
    allowAbstractSubmissions: true,
    abstractDeadline: "",
  });

  const [notificationSettings, setNotificationSettings] = useState({
    notifyOnRegistration: true,
    notifyOnAbstractSubmission: true,
  });

  const [brandingSettings, setBrandingSettings] = useState({
    bannerImage: "",
    footerHtml: "",
    emailHeaderImage: "",
    emailFooterHtml: "",
    emailFromAddress: "",
    emailFromName: "",
  });

  const fetchEvent = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}`);
      if (res.ok) {
        const data = await res.json();
        setEvent(data);

        setGeneralFormData({
          name: data.name,
          slug: data.slug,
          description: data.description || "",
          eventType: data.eventType || "",
          tag: data.tag || "",
          specialty: data.specialty || "",
          code: data.code || "",
          startDate: new Date(data.startDate).toISOString().slice(0, 16),
          endDate: new Date(data.endDate).toISOString().slice(0, 16),
          timezone: data.timezone,
          venue: data.venue || "",
          address: data.address || "",
          city: data.city || "",
          country: data.country || "",
          status: data.status,
          supportEmail: data.supportEmail || "",
          taxRate: data.taxRate != null ? String(data.taxRate) : "",
          taxLabel: data.taxLabel || "VAT",
          bankDetails: data.bankDetails || "",
          badgeVerticalOffset: data.badgeVerticalOffset ?? 0,
        });

        const settings = data.settings || {};
        setRegistrationSettings({
          registrationOpen: settings.registrationOpen ?? true,
          waitlistEnabled: settings.waitlistEnabled ?? false,
          requireApproval: settings.requireApproval ?? false,
          maxAttendees: settings.maxAttendees ?? 0,
          showRemainingTickets: settings.showRemainingTickets ?? true,
        });

        setProgrammeSettings({
          programmePublished: settings.programmePublished ?? false,
        });

        setAbstractSettings({
          allowAbstractSubmissions: settings.allowAbstractSubmissions ?? true,
          abstractDeadline: settings.abstractDeadline
            ? new Date(settings.abstractDeadline).toISOString().slice(0, 16)
            : "",
        });

        setNotificationSettings({
          notifyOnRegistration: settings.notifyOnRegistration ?? true,
          notifyOnAbstractSubmission: settings.notifyOnAbstractSubmission ?? true,
        });

        setBrandingSettings({
          bannerImage: data.bannerImage || "",
          footerHtml: data.footerHtml || "",
          emailHeaderImage: data.emailHeaderImage || "",
          emailFooterHtml: data.emailFooterHtml || "",
          emailFromAddress: data.emailFromAddress || "",
          emailFromName: data.emailFromName || "",
        });
      }
    } catch (error) {
      console.error("Error fetching event:", error);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchEvent();
  }, [fetchEvent]);

  const handleSaveGeneral = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...generalFormData,
          eventType: generalFormData.eventType || null,
          tag: generalFormData.tag || null,
          specialty: generalFormData.specialty || null,
          code: generalFormData.code || null,
          venue: generalFormData.venue || null,
          address: generalFormData.address || null,
          city: generalFormData.city || null,
          country: generalFormData.country || null,
          supportEmail: generalFormData.supportEmail || null,
          taxRate: generalFormData.taxRate ? Number(generalFormData.taxRate) : null,
          taxLabel: generalFormData.taxLabel || null,
          bankDetails: generalFormData.bankDetails || null,
          description: generalFormData.description || null,
          startDate: new Date(generalFormData.startDate).toISOString(),
          endDate: new Date(generalFormData.endDate).toISOString(),
        }),
      });

      if (res.ok) {
        toast.success("General settings saved");
        fetchEvent();
      } else {
        const data = await res.json().catch(() => ({}));
        const fieldErrors = data.details?.fieldErrors;
        if (fieldErrors) {
          const fields = Object.entries(fieldErrors)
            .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
            .join("; ");
          toast.error(`Validation failed — ${fields}`);
        } else {
          toast.error(data.error || "Failed to save general settings");
        }
      }
    } catch (error) {
      console.error("Error saving event:", error);
      toast.error("Failed to save general settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            ...registrationSettings,
            ...programmeSettings,
            ...abstractSettings,
            ...notificationSettings,
            abstractDeadline: abstractSettings.abstractDeadline
              ? new Date(abstractSettings.abstractDeadline).toISOString()
              : null,
          },
        }),
      });

      if (res.ok) {
        toast.success("Settings saved");
        fetchEvent();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save settings");
      }
    } catch (error) {
      console.error("Error saving settings:", error);
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBranding = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bannerImage: brandingSettings.bannerImage || null,
          footerHtml: brandingSettings.footerHtml || null,
          emailHeaderImage: brandingSettings.emailHeaderImage || null,
          emailFooterHtml: brandingSettings.emailFooterHtml || null,
          emailFromAddress: brandingSettings.emailFromAddress || null,
          emailFromName: brandingSettings.emailFromName || null,
        }),
      });

      if (res.ok) {
        toast.success("Branding settings saved");
        fetchEvent();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save branding settings");
      }
    } catch (error) {
      console.error("Error saving branding:", error);
      toast.error("Failed to save branding settings");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEvent = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}?confirm=true`, {
        method: "DELETE",
      });

      if (res.ok) {
        toast.success("Event deleted");
        router.push("/events");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to delete event");
      }
    } catch (error) {
      console.error("Error deleting event:", error);
      toast.error("Failed to delete event");
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

  if (!event) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Event not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Settings className="h-8 w-8" />
              Event Settings
            </h1>
          </div>
          <p className="text-muted-foreground">
            Configure settings for {event.name}
          </p>
        </div>
      </div>

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList>
          <TabsTrigger value="general" className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            General
          </TabsTrigger>
          <TabsTrigger value="registration" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Registration
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="abstract-themes" className="flex items-center gap-2">
            Abstract Themes
          </TabsTrigger>
          <TabsTrigger value="review-criteria" className="flex items-center gap-2">
            Review Criteria
          </TabsTrigger>
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            Branding
          </TabsTrigger>
          <TabsTrigger value="email-branding" className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Email Branding
          </TabsTrigger>
          <TabsTrigger value="email-templates" className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Email Templates
          </TabsTrigger>
          <TabsTrigger value="danger" className="flex items-center gap-2 text-red-600">
            <Trash2 className="h-4 w-4" />
            Danger Zone
          </TabsTrigger>
        </TabsList>

        {/* General Settings */}
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>General Information</CardTitle>
              <CardDescription>
                Basic details about your event
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Event Name</Label>
                  <Input
                    id="name"
                    value={generalFormData.name}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="slug">URL Slug</Label>
                  <Input
                    id="slug"
                    value={generalFormData.slug}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, slug: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Your public registration page: /e/{generalFormData.slug || "your-event-slug"}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={generalFormData.description}
                  onChange={(e) =>
                    setGeneralFormData({ ...generalFormData, description: e.target.value })
                  }
                  rows={4}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="eventType">Event Type</Label>
                  <Select
                    value={generalFormData.eventType}
                    onValueChange={(value) =>
                      setGeneralFormData({ ...generalFormData, eventType: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CONFERENCE">Conference</SelectItem>
                      <SelectItem value="WEBINAR">Webinar</SelectItem>
                      <SelectItem value="HYBRID">Hybrid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tag">Tag</Label>
                  <Input
                    id="tag"
                    placeholder="e.g., Medical, Tech"
                    value={generalFormData.tag}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, tag: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="specialty">Specialty</Label>
                  <SpecialtySelect
                    value={generalFormData.specialty}
                    onChange={(specialty) =>
                      setGeneralFormData({ ...generalFormData, specialty })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="code">Event Code</Label>
                <Input
                  id="code"
                  placeholder="e.g., HFC2026"
                  value={generalFormData.code}
                  onChange={(e) =>
                    setGeneralFormData({ ...generalFormData, code: e.target.value.toUpperCase() })
                  }
                  maxLength={20}
                />
                <p className="text-xs text-muted-foreground">
                  Used as prefix for invoice/receipt/quote numbers (e.g., HFC2026-INV-001)
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date & Time</Label>
                  <Input
                    id="startDate"
                    type="datetime-local"
                    value={generalFormData.startDate}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, startDate: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date & Time</Label>
                  <Input
                    id="endDate"
                    type="datetime-local"
                    value={generalFormData.endDate}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, endDate: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Select
                    value={generalFormData.timezone}
                    onValueChange={(value) =>
                      setGeneralFormData({ ...generalFormData, timezone: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="venue">Venue</Label>
                  <Input
                    id="venue"
                    value={generalFormData.venue}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, venue: e.target.value })
                    }
                    placeholder="e.g., Convention Center"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Address</Label>
                  <Input
                    id="address"
                    value={generalFormData.address}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, address: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={generalFormData.city}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, city: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input
                    id="country"
                    value={generalFormData.country}
                    onChange={(e) =>
                      setGeneralFormData({ ...generalFormData, country: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={generalFormData.status}
                    onValueChange={(value) =>
                      setGeneralFormData({ ...generalFormData, status: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {eventStatuses.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="supportEmail">Support Email</Label>
                <Input
                  id="supportEmail"
                  type="email"
                  placeholder="support@yourorganization.com"
                  value={generalFormData.supportEmail}
                  onChange={(e) =>
                    setGeneralFormData({ ...generalFormData, supportEmail: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">Shown on public registration forms for attendee inquiries</p>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveGeneral} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Registration Settings */}
        <TabsContent value="registration">
          <div className="grid gap-4 md:grid-cols-2 mb-6">
            <Link href={`/events/${eventId}/tickets`} className="group block">
              <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full">
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300 shrink-0">
                    <Ticket className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-sm group-hover:text-primary transition-colors">
                      Registration Types
                    </h3>
                    <p className="text-xs text-muted-foreground">Manage ticket types and pricing</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </CardContent>
              </Card>
            </Link>
            <Link href={`/events/${eventId}/imports`} className="group block">
              <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full">
                <CardContent className="p-5 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300 shrink-0">
                    <History className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-sm group-hover:text-primary transition-colors">
                      Import History
                    </h3>
                    <p className="text-xs text-muted-foreground">View past imports and skipped contacts</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </CardContent>
              </Card>
            </Link>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Registration Settings</CardTitle>
              <CardDescription>
                Configure how attendees can register for your event
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Registration Open</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow new registrations for this event
                  </p>
                </div>
                <Switch
                  checked={registrationSettings.registrationOpen}
                  onCheckedChange={(checked) =>
                    setRegistrationSettings({
                      ...registrationSettings,
                      registrationOpen: checked,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Waitlist</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow attendees to join a waitlist when tickets are sold out
                  </p>
                </div>
                <Switch
                  checked={registrationSettings.waitlistEnabled}
                  onCheckedChange={(checked) =>
                    setRegistrationSettings({
                      ...registrationSettings,
                      waitlistEnabled: checked,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Require Approval</Label>
                  <p className="text-sm text-muted-foreground">
                    Manually approve each registration before confirming
                  </p>
                </div>
                <Switch
                  checked={registrationSettings.requireApproval}
                  onCheckedChange={(checked) =>
                    setRegistrationSettings({
                      ...registrationSettings,
                      requireApproval: checked,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Show Remaining Tickets</Label>
                  <p className="text-sm text-muted-foreground">
                    Display the number of tickets remaining publicly
                  </p>
                </div>
                <Switch
                  checked={registrationSettings.showRemainingTickets}
                  onCheckedChange={(checked) =>
                    setRegistrationSettings({
                      ...registrationSettings,
                      showRemainingTickets: checked,
                    })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxAttendees">Maximum Attendees (0 = unlimited)</Label>
                <Input
                  id="maxAttendees"
                  type="number"
                  min="0"
                  value={registrationSettings.maxAttendees}
                  onChange={(e) =>
                    setRegistrationSettings({
                      ...registrationSettings,
                      maxAttendees: parseInt(e.target.value) || 0,
                    })
                  }
                  className="w-48"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="badgeVerticalOffset">Badge Vertical Offset (points)</Label>
                <Input
                  id="badgeVerticalOffset"
                  type="number"
                  value={generalFormData.badgeVerticalOffset}
                  onChange={(e) =>
                    setGeneralFormData({
                      ...generalFormData,
                      badgeVerticalOffset: parseInt(e.target.value) || 0,
                    })
                  }
                  className="w-48"
                />
                <p className="text-xs text-muted-foreground">
                  Adjust badge position on printed page. Positive = move down, negative = move up. 72 points = 1 inch. Default: 0.
                </p>
              </div>

              <div className="border-t pt-6">
                <h3 className="text-lg font-medium mb-4">Tax & Payment</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="taxRate">Tax Rate (%)</Label>
                      <Input
                        id="taxRate"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={generalFormData.taxRate}
                        onChange={(e) =>
                          setGeneralFormData({ ...generalFormData, taxRate: e.target.value })
                        }
                        placeholder="e.g. 5"
                        className="w-full"
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave empty for no tax. UAE: 5%, KSA: 15%
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="taxLabel">Tax Label</Label>
                      <Input
                        id="taxLabel"
                        value={generalFormData.taxLabel}
                        onChange={(e) =>
                          setGeneralFormData({ ...generalFormData, taxLabel: e.target.value })
                        }
                        placeholder="VAT"
                        className="w-full"
                      />
                      <p className="text-xs text-muted-foreground">
                        Label shown on invoices and quotes (e.g. VAT, GST, Tax)
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bankDetails">Bank Transfer Details</Label>
                    <textarea
                      id="bankDetails"
                      value={generalFormData.bankDetails}
                      onChange={(e) =>
                        setGeneralFormData({ ...generalFormData, bankDetails: e.target.value })
                      }
                      placeholder="Bank Name: ...&#10;Account Name: ...&#10;IBAN: ...&#10;SWIFT: ..."
                      className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                    <p className="text-xs text-muted-foreground">
                      Shown on quotes for bank transfer payments. Leave empty to hide.
                    </p>
                  </div>
                  <div className="flex justify-end">
                    <Button onClick={handleSaveGeneral} disabled={saving}>
                      <Save className="mr-2 h-4 w-4" />
                      {saving ? "Saving..." : "Save Tax & Payment"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="text-lg font-medium mb-4">Programme</h3>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Publish Programme</Label>
                    <p className="text-sm text-muted-foreground">
                      Make the event schedule visible on the public programme page
                    </p>
                  </div>
                  <Switch
                    checked={programmeSettings.programmePublished}
                    onCheckedChange={(checked) =>
                      setProgrammeSettings({
                        ...programmeSettings,
                        programmePublished: checked,
                      })
                    }
                  />
                </div>
              </div>

              <div className="border-t pt-6">
                <h3 className="text-lg font-medium mb-4">Abstract Submissions</h3>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Allow Abstract Submissions</Label>
                      <p className="text-sm text-muted-foreground">
                        Allow speakers to submit abstracts for consideration
                      </p>
                    </div>
                    <Switch
                      checked={abstractSettings.allowAbstractSubmissions}
                      onCheckedChange={(checked) =>
                        setAbstractSettings({
                          ...abstractSettings,
                          allowAbstractSubmissions: checked,
                        })
                      }
                    />
                  </div>

                  {abstractSettings.allowAbstractSubmissions && (
                    <div className="space-y-2">
                      <Label htmlFor="abstractDeadline">Abstract Submission Deadline</Label>
                      <Input
                        id="abstractDeadline"
                        type="datetime-local"
                        value={abstractSettings.abstractDeadline}
                        onChange={(e) =>
                          setAbstractSettings({
                            ...abstractSettings,
                            abstractDeadline: e.target.value,
                          })
                        }
                        className="w-72"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveSettings} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving..." : "Save Settings"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notification Settings */}
        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notification Settings</CardTitle>
              <CardDescription>
                Configure when you receive notifications
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>New Registration Notifications</Label>
                  <p className="text-sm text-muted-foreground">
                    Receive an email when someone registers for this event
                  </p>
                </div>
                <Switch
                  checked={notificationSettings.notifyOnRegistration}
                  onCheckedChange={(checked) =>
                    setNotificationSettings({
                      ...notificationSettings,
                      notifyOnRegistration: checked,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Abstract Submission Notifications</Label>
                  <p className="text-sm text-muted-foreground">
                    Receive an email when a speaker submits an abstract
                  </p>
                </div>
                <Switch
                  checked={notificationSettings.notifyOnAbstractSubmission}
                  onCheckedChange={(checked) =>
                    setNotificationSettings({
                      ...notificationSettings,
                      notifyOnAbstractSubmission: checked,
                    })
                  }
                />
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveSettings} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving..." : "Save Settings"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Abstract Themes */}
        <TabsContent value="abstract-themes">
          <Card>
            <CardHeader>
              <CardTitle>Abstract Themes</CardTitle>
              <CardDescription>
                Define themes that submitters can tag their abstracts with.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AbstractThemesSettings eventId={eventId} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Review Criteria */}
        <TabsContent value="review-criteria">
          <Card>
            <CardHeader>
              <CardTitle>Review Criteria</CardTitle>
              <CardDescription>
                Define weighted scoring criteria for abstract reviews. Weights should total 100%.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewCriteriaSettings eventId={eventId} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Branding Settings */}
        <TabsContent value="branding">
          <Card>
            <CardHeader>
              <CardTitle>Branding Settings</CardTitle>
              <CardDescription>
                Customize the appearance of your public event pages
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="bannerImage">Banner Image URL</Label>
                <Input
                  id="bannerImage"
                  value={brandingSettings.bannerImage}
                  onChange={(e) =>
                    setBrandingSettings({
                      ...brandingSettings,
                      bannerImage: e.target.value,
                    })
                  }
                  placeholder="https://example.com/banner.jpg"
                />
                <p className="text-sm text-muted-foreground">
                  Enter a URL for your event banner image. Recommended size: 1200x400px.
                </p>
                {brandingSettings.bannerImage && (
                  <div className="mt-4 border rounded-lg overflow-hidden">
                    <Image
                      src={brandingSettings.bannerImage}
                      alt="Banner preview"
                      width={1200}
                      height={400}
                      className="w-full h-48 object-contain"
                      unoptimized
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Custom Footer</Label>
                <TiptapEditor
                  content={brandingSettings.footerHtml}
                  onChange={(html) =>
                    setBrandingSettings({
                      ...brandingSettings,
                      footerHtml: html,
                    })
                  }
                  placeholder="Design your public event page footer..."
                />
                <p className="text-sm text-muted-foreground">
                  Customize the footer shown on your public event pages. Use the toolbar for formatting or switch to source mode for raw HTML.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveBranding} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving..." : "Save Branding"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Email Branding */}
        <TabsContent value="email-branding">
          <Card>
            <CardHeader>
              <CardTitle>Email Branding</CardTitle>
              <CardDescription>
                Add a header image and footer to all outgoing emails for this event
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="emailFromAddress">Sender Email Address</Label>
                  <Input
                    id="emailFromAddress"
                    type="email"
                    value={brandingSettings.emailFromAddress}
                    onChange={(e) =>
                      setBrandingSettings({
                        ...brandingSettings,
                        emailFromAddress: e.target.value,
                      })
                    }
                    placeholder="events@yourdomain.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emailFromName">Sender Name</Label>
                  <Input
                    id="emailFromName"
                    value={brandingSettings.emailFromName}
                    onChange={(e) =>
                      setBrandingSettings({
                        ...brandingSettings,
                        emailFromName: e.target.value,
                      })
                    }
                    placeholder="Event Name Team"
                  />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Override the default sender for all emails from this event. The email domain must be verified in your email provider (Brevo/SendGrid). Leave blank to use the system default.
              </p>

              <div className="space-y-2">
                <Label htmlFor="emailHeaderImage">Email Header Image URL</Label>
                <Input
                  id="emailHeaderImage"
                  value={brandingSettings.emailHeaderImage}
                  onChange={(e) =>
                    setBrandingSettings({
                      ...brandingSettings,
                      emailHeaderImage: e.target.value,
                    })
                  }
                  placeholder="https://example.com/email-header.png"
                />
                <p className="text-sm text-muted-foreground">
                  This image appears at the top of all event emails. Recommended size: 600x150px.
                </p>
                {brandingSettings.emailHeaderImage && (
                  <div className="mt-4 border rounded-lg overflow-hidden max-w-[600px]">
                    <Image
                      src={brandingSettings.emailHeaderImage}
                      alt="Email header preview"
                      width={600}
                      height={150}
                      className="w-full h-auto object-cover"
                      unoptimized
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Email Footer</Label>
                <TiptapEditor
                  content={brandingSettings.emailFooterHtml}
                  onChange={(html) =>
                    setBrandingSettings({
                      ...brandingSettings,
                      emailFooterHtml: html,
                    })
                  }
                  placeholder="Design your email footer..."
                />
                <p className="text-sm text-muted-foreground">
                  Custom footer shown at the bottom of all event emails. Leave blank for the default footer.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveBranding} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving..." : "Save Email Branding"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Email Templates */}
        <TabsContent value="email-templates">
          <EmailTemplatesTab eventId={eventId} />
        </TabsContent>

        {/* Danger Zone */}
        <TabsContent value="danger">
          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-red-600">Danger Zone</CardTitle>
              <CardDescription>
                Irreversible and destructive actions
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 border border-red-200 rounded-lg">
                <div>
                  <h4 className="font-medium text-red-600">Delete Event</h4>
                  <p className="text-sm text-muted-foreground">
                    Permanently delete this event and all its data. This action cannot be undone.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete Event
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete the event &quot;{event.name}&quot; and all
                        associated data including registrations, speakers, sessions, and
                        accommodations. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDeleteEvent}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        Delete Event
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Email Templates Tab (inline in settings) ───────────────────────────────────

const DEFAULT_SLUGS = new Set([
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "custom-notification",
]);

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "registration-confirmation": "Sent when someone registers for the event",
  "speaker-invitation": "Sent when inviting a speaker to the event",
  "speaker-agreement": "Sent with speaker agreement terms",
  "event-reminder": "Sent as a reminder before the event",
  "abstract-submission-confirmation": "Sent when a speaker submits an abstract",
  "abstract-status-update": "Sent when an abstract status changes",
  "submitter-welcome": "Sent when a submitter creates an account",
  "custom-notification": "Template for custom/ad-hoc emails",
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function EmailTemplatesTab({ eventId }: { eventId: string }) {
  const { data, isLoading } = useEmailTemplates(eventId);
  const createMutation = useCreateEmailTemplate(eventId);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSubject, setNewSubject] = useState("");

  const handleCreate = async () => {
    const name = newName.trim();
    const subject = newSubject.trim();
    if (!name || !subject) {
      toast.error("Name and subject are required");
      return;
    }
    const slug = slugify(name);
    if (!slug) {
      toast.error("Name must contain at least one alphanumeric character");
      return;
    }
    try {
      await createMutation.mutateAsync({
        slug,
        name,
        subject,
        htmlContent: `<h2 style="margin: 0 0 5px 0; font-size: 22px; color: #333;">${name}</h2>
  <p style="color: #6b7280; margin: 0 0 20px 0;">{{eventName}}</p>
  <p>Dear <strong>{{firstName}}</strong>,</p>
  <p>Your content here...</p>`,
        textContent: `${name}\n\nDear {{firstName}},\n\nYour content here...`,
      });
      toast.success("Template created");
      setCreateOpen(false);
      setNewName("");
      setNewSubject("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create template");
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <ReloadingSpinner />
      </div>
    );
  }

  const templates = data?.templates || [];
  const systemTemplates = templates.filter((t: { slug: string }) => DEFAULT_SLUGS.has(t.slug));
  const customTemplates = templates.filter((t: { slug: string }) => !DEFAULT_SLUGS.has(t.slug));

  return (
    <div className="space-y-6">
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Email Templates</h3>
          <p className="text-sm text-muted-foreground">
            Customize emails sent to attendees, speakers, and reviewers. Use {"{{variables}}"} for personalization.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              New Template
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Email Template</DialogTitle>
              <DialogDescription>
                Create a custom email template. You can edit the content after creating it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="tpl-name">Template Name</Label>
                <Input
                  id="tpl-name"
                  placeholder="e.g. VIP Welcome"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={100}
                />
                {newName.trim() && (
                  <p className="text-xs text-muted-foreground">
                    Slug: <code className="bg-muted px-1 rounded">{slugify(newName)}</code>
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-subject">Default Subject Line</Label>
                <Input
                  id="tpl-subject"
                  placeholder="e.g. Welcome VIP - {{eventName}}"
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  className="font-mono text-sm"
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !newName.trim() || !newSubject.trim()}
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* System templates */}
      {systemTemplates.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">System Templates</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {systemTemplates.map((template: { id: string; slug: string; name: string; subject: string; isActive: boolean; updatedAt: string }) => (
              <Link key={template.id} href={`/events/${eventId}/communications/templates/${template.id}`}>
                <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-sm">{template.name}</CardTitle>
                      <div className="flex items-center gap-1.5">
                        {!template.isActive && <Badge variant="secondary" className="text-xs">Disabled</Badge>}
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    </div>
                    <CardDescription className="text-xs">
                      {TEMPLATE_DESCRIPTIONS[template.slug] || template.slug}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-muted-foreground truncate">
                      <span className="font-medium text-foreground">Subject:</span> {template.subject}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Custom templates */}
      {customTemplates.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Custom Templates</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {customTemplates.map((template: { id: string; slug: string; name: string; subject: string; isActive: boolean; updatedAt: string }) => (
              <Link key={template.id} href={`/events/${eventId}/communications/templates/${template.id}`}>
                <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 cursor-pointer h-full border-primary/20">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-sm">{template.name}</CardTitle>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">Custom</Badge>
                        {!template.isActive && <Badge variant="secondary" className="text-xs">Disabled</Badge>}
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    </div>
                    <CardDescription className="text-xs">{template.slug}</CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-muted-foreground truncate">
                      <span className="font-medium text-foreground">Subject:</span> {template.subject}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {templates.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <Mail className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No email templates found. They will be created automatically.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}