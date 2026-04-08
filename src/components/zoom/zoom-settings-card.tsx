"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Video, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { useZoomCredentials, useZoomSettings, useUpdateZoomSettings } from "@/hooks/use-api";

interface ZoomSettingsCardProps {
  eventId: string;
}

export function ZoomSettingsCard({ eventId }: ZoomSettingsCardProps) {
  const { data: credentials } = useZoomCredentials();
  const { data: settings, isLoading } = useZoomSettings(eventId);
  const updateSettings = useUpdateZoomSettings(eventId);

  // Only show if org has Zoom configured
  if (!credentials?.configured) return null;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const handleToggle = async (enabled: boolean) => {
    try {
      await updateSettings.mutateAsync({
        enabled,
        defaultMeetingType: settings?.defaultMeetingType || "MEETING",
        autoCreateForSessions: settings?.autoCreateForSessions || false,
      });
      toast.success(enabled ? "Zoom enabled for this event" : "Zoom disabled for this event");
    } catch {
      toast.error("Failed to update Zoom settings");
    }
  };

  const handleMeetingTypeChange = async (value: string) => {
    try {
      await updateSettings.mutateAsync({
        enabled: settings?.enabled ?? false,
        defaultMeetingType: value,
        autoCreateForSessions: settings?.autoCreateForSessions || false,
      });
    } catch {
      toast.error("Failed to update default meeting type");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Video className="h-4 w-4 text-blue-600" />
          Zoom Integration
        </CardTitle>
        <CardDescription>
          Enable Zoom meetings and webinars for event sessions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="zoom-enabled" className="flex-1">
            Enable Zoom for this event
          </Label>
          <Switch
            id="zoom-enabled"
            checked={settings?.enabled ?? false}
            onCheckedChange={handleToggle}
            disabled={updateSettings.isPending}
          />
        </div>

        {settings?.enabled && (
          <>
            <div className="space-y-2">
              <Label htmlFor="zoom-default-type">Default meeting type</Label>
              <Select
                value={settings.defaultMeetingType || "MEETING"}
                onValueChange={handleMeetingTypeChange}
              >
                <SelectTrigger id="zoom-default-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEETING">Meeting</SelectItem>
                  <SelectItem value="WEBINAR">Webinar</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Default type when creating Zoom links for sessions. Can be overridden per session.
              </p>
            </div>

            {/* How to use guide */}
            <div className="rounded-lg border bg-blue-50/50 p-4 space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <Info className="h-4 w-4 text-blue-600" />
                How to create a Zoom session
              </h4>
              <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                <li>
                  Go to the <strong>Schedule</strong> page for this event and create a session (or open an existing one).
                </li>
                <li>
                  On the session card, click the <strong>&ldquo;Create Zoom Meeting&rdquo;</strong> button.
                </li>
                <li>
                  Choose the type:
                  <ul className="ml-5 mt-1 space-y-0.5 list-disc text-xs">
                    <li><strong>Meeting</strong> &mdash; interactive, all participants can share audio/video (up to 1,000 participants).</li>
                    <li><strong>Webinar</strong> &mdash; view-only for attendees, only panelists can speak (up to 10,000 attendees).</li>
                    <li><strong>Webinar Series</strong> &mdash; recurring webinar with multiple occurrences under one registration.</li>
                  </ul>
                </li>
                <li>
                  Optionally set a <strong>passcode</strong>, enable <strong>waiting room</strong>, or turn on <strong>auto-recording</strong>.
                </li>
                <li>
                  Click <strong>Create</strong>. The session will display a Zoom badge and a join link will appear on the public schedule 15 minutes before start.
                </li>
              </ol>

              <div className="text-xs text-muted-foreground pt-1 border-t space-y-1">
                <p>
                  <strong>For webinars:</strong> Session speakers are automatically added as Zoom panelists if &ldquo;Add session speakers as panelists&rdquo; is enabled during creation.
                </p>
                <p>
                  <strong>Attendee experience:</strong> Attendees click &ldquo;Join&rdquo; on the public schedule. If Zoom Meeting SDK is configured (env vars), the session embeds directly in the browser. Otherwise, it opens in the Zoom app.
                </p>
                <p>
                  <strong>Zoom plan note:</strong> Webinar features require a Zoom Webinar add-on on your Zoom account. Standard meetings work with any paid Zoom plan.
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
