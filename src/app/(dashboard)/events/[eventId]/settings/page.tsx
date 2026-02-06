"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Image,
  Code,
} from "lucide-react";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
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
    startDate: "",
    endDate: "",
    timezone: "UTC",
    venue: "",
    address: "",
    city: "",
    country: "",
    status: "DRAFT",
  });

  const [registrationSettings, setRegistrationSettings] = useState({
    registrationOpen: true,
    waitlistEnabled: false,
    requireApproval: false,
    maxAttendees: 0,
    showRemainingTickets: true,
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
  });

  useEffect(() => {
    fetchEvent();
  }, [eventId]);

  const fetchEvent = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}`);
      if (res.ok) {
        const data = await res.json();
        setEvent(data);

        setGeneralFormData({
          name: data.name,
          slug: data.slug,
          description: data.description || "",
          startDate: new Date(data.startDate).toISOString().slice(0, 16),
          endDate: new Date(data.endDate).toISOString().slice(0, 16),
          timezone: data.timezone,
          venue: data.venue || "",
          address: data.address || "",
          city: data.city || "",
          country: data.country || "",
          status: data.status,
        });

        const settings = data.settings || {};
        setRegistrationSettings({
          registrationOpen: settings.registrationOpen ?? true,
          waitlistEnabled: settings.waitlistEnabled ?? false,
          requireApproval: settings.requireApproval ?? false,
          maxAttendees: settings.maxAttendees ?? 0,
          showRemainingTickets: settings.showRemainingTickets ?? true,
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
        });
      }
    } catch (error) {
      console.error("Error fetching event:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveGeneral = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...generalFormData,
          startDate: new Date(generalFormData.startDate).toISOString(),
          endDate: new Date(generalFormData.endDate).toISOString(),
        }),
      });

      if (res.ok) {
        fetchEvent();
      }
    } catch (error) {
      console.error("Error saving event:", error);
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
            ...abstractSettings,
            ...notificationSettings,
            abstractDeadline: abstractSettings.abstractDeadline
              ? new Date(abstractSettings.abstractDeadline).toISOString()
              : null,
          },
        }),
      });

      if (res.ok) {
        fetchEvent();
      }
    } catch (error) {
      console.error("Error saving settings:", error);
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
        }),
      });

      if (res.ok) {
        fetchEvent();
      }
    } catch (error) {
      console.error("Error saving branding:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEvent = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        router.push("/events");
      }
    } catch (error) {
      console.error("Error deleting event:", error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <Image className="h-4 w-4" />
            Branding
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
                    <img
                      src={brandingSettings.bannerImage}
                      alt="Banner preview"
                      className="w-full h-48 object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="footerHtml">Custom Footer HTML</Label>
                <Textarea
                  id="footerHtml"
                  value={brandingSettings.footerHtml}
                  onChange={(e) =>
                    setBrandingSettings({
                      ...brandingSettings,
                      footerHtml: e.target.value,
                    })
                  }
                  placeholder="<p>© 2024 Your Organization. All rights reserved.</p>"
                  rows={6}
                  className="font-mono text-sm"
                />
                <p className="text-sm text-muted-foreground">
                  Add custom HTML for the footer of your public event pages. Supports basic HTML tags.
                </p>
                {brandingSettings.footerHtml && (
                  <div className="mt-4">
                    <Label className="text-sm">Preview:</Label>
                    <div
                      className="mt-2 p-4 border rounded-lg bg-muted/50"
                      dangerouslySetInnerHTML={{ __html: brandingSettings.footerHtml }}
                    />
                  </div>
                )}
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
