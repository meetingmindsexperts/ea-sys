"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Video, Loader2 } from "lucide-react";
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
        )}
      </CardContent>
    </Card>
  );
}
