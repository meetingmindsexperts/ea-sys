"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Video, ExternalLink, Clock, MapPin, Loader2, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import Link from "next/link";

// Dynamically import ZoomEmbed (client-only, ~5MB)
const ZoomEmbed = dynamic(
  () => import("@/components/zoom/zoom-embed").then((m) => ({ default: m.ZoomEmbed })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center min-h-[400px] bg-muted/30 rounded-lg">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <p className="text-sm text-muted-foreground">Loading Zoom...</p>
        </div>
      </div>
    ),
  },
);

interface JoinInfo {
  mode: "sdk" | "url";
  sdkKey?: string;
  signature?: string;
  meetingNumber?: string;
  passcode?: string;
  joinUrl: string;
  meetingType: string;
  sessionName: string;
}

interface SessionInfo {
  name: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  speakers?: { firstName: string; lastName: string; title?: string }[];
}

export default function PublicSessionPage() {
  const params = useParams<{ slug: string; sessionId: string }>();
  const { slug, sessionId } = params;

  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchJoinInfo() {
      try {
        // Fetch join info
        const res = await fetch(`/api/public/events/${slug}/sessions/${sessionId}/zoom-join`);
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Unable to join this session");
          // If there's timing info, show when it becomes joinable
          if (data.joinableAt) {
            setSessionInfo({
              name: "",
              startTime: data.startsAt,
              endTime: data.startsAt,
            });
          }
          return;
        }

        setJoinInfo(data);

        // Fetch session details from public schedule
        try {
          const scheduleRes = await fetch(`/api/public/events/${slug}/schedule`);
          if (scheduleRes.ok) {
            const scheduleData = await scheduleRes.json();
            const session = scheduleData.sessions?.find(
              (s: { id: string }) => s.id === sessionId,
            );
            if (session) {
              setSessionInfo({
                name: session.name,
                description: session.description,
                startTime: session.startTime,
                endTime: session.endTime,
                location: session.location,
              });
            }
          }
        } catch {
          // Non-critical — session info is supplementary
        }
      } catch {
        setError("Failed to connect. Please try again.");
      } finally {
        setLoading(false);
      }
    }

    fetchJoinInfo();
  }, [slug, sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
          <p className="text-muted-foreground">Connecting to session...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="flex flex-col items-center gap-4 pt-8 pb-6 text-center">
            <Video className="h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Session Not Available</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            {sessionInfo?.startTime && (
              <p className="text-sm">
                Starts at:{" "}
                <strong>{format(new Date(sessionInfo.startTime), "MMM d, yyyy 'at' h:mm a")}</strong>
              </p>
            )}
            <Link href={`/e/${slug}/schedule`}>
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to Schedule
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!joinInfo) return null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href={`/e/${slug}/schedule`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="font-semibold">
                {joinInfo.sessionName || sessionInfo?.name || "Live Session"}
              </h1>
              {sessionInfo && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(new Date(sessionInfo.startTime), "h:mm a")} -{" "}
                    {format(new Date(sessionInfo.endTime), "h:mm a")}
                  </span>
                  {sessionInfo.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {sessionInfo.location}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => window.open(joinInfo.joinUrl, "_blank")}
            >
              Open in Zoom
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* Meeting embed */}
      <div className="max-w-7xl mx-auto p-4">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Main — Zoom embed */}
          <div className="lg:col-span-3">
            {joinInfo.mode === "sdk" && joinInfo.sdkKey && joinInfo.signature && joinInfo.meetingNumber ? (
              <ZoomEmbed
                sdkKey={joinInfo.sdkKey}
                signature={joinInfo.signature}
                meetingNumber={joinInfo.meetingNumber}
                passcode={joinInfo.passcode || ""}
                joinUrl={joinInfo.joinUrl}
              />
            ) : (
              <div className="flex flex-col items-center justify-center min-h-[400px] bg-muted/30 rounded-lg gap-4">
                <Video className="h-12 w-12 text-muted-foreground" />
                <p className="text-muted-foreground">This session opens in the Zoom app.</p>
                <Button
                  className="gap-2 bg-blue-600 hover:bg-blue-700"
                  onClick={() => window.open(joinInfo.joinUrl, "_blank")}
                >
                  <Video className="h-4 w-4" />
                  Open in Zoom
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Sidebar — Session info */}
          <div className="space-y-4">
            {sessionInfo?.description && (
              <Card>
                <CardContent className="pt-4">
                  <h3 className="text-sm font-medium mb-2">About this session</h3>
                  <p className="text-sm text-muted-foreground">{sessionInfo.description}</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="pt-4">
                <h3 className="text-sm font-medium mb-2">Meeting Details</h3>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>
                      {joinInfo.meetingType === "WEBINAR" || joinInfo.meetingType === "WEBINAR_SERIES"
                        ? "Webinar"
                        : "Meeting"}
                    </dd>
                  </div>
                  {joinInfo.passcode && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Passcode</dt>
                      <dd className="font-mono text-xs">{joinInfo.passcode}</dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
