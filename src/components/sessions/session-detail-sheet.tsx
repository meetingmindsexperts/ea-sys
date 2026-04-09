"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Clock,
  MapPin,
  Users,
  Plus,
  Trash2,
  Loader2,
  Save,
} from "lucide-react";
import { formatDate, formatTime } from "@/lib/utils";
import { toast } from "sonner";

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionSpeaker {
  role: string;
  speaker: {
    id: string;
    firstName: string;
    lastName: string;
    status: string;
  };
}

interface TopicSpeaker {
  speaker: {
    id: string;
    firstName: string;
    lastName: string;
    status: string;
  };
}

interface SessionTopic {
  id: string;
  title: string;
  sortOrder: number;
  duration: number | null;
  abstract: { id: string; title: string } | null;
  speakers: TopicSpeaker[];
}

interface SessionData {
  id: string;
  name: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  capacity: number | null;
  status: string;
  track: { id: string; name: string; color: string } | null;
  speakers: SessionSpeaker[];
  topics: SessionTopic[];
}

interface SpeakerOption {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
}

interface TopicForm {
  title: string;
  speakerIds: string[];
  duration: string;
}

interface SessionDetailSheetProps {
  eventId: string;
  sessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSessionUpdated?: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800",
  SCHEDULED: "bg-blue-100 text-blue-800",
  LIVE: "bg-green-100 text-green-800",
  COMPLETED: "bg-slate-100 text-slate-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const SPEAKER_STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-700",
  INVITED: "bg-yellow-100 text-yellow-700",
  DECLINED: "bg-red-100 text-red-700",
};

const ROLE_COLORS: Record<string, string> = {
  SPEAKER: "bg-blue-100 text-blue-700",
  MODERATOR: "bg-purple-100 text-purple-700",
  CHAIRPERSON: "bg-amber-100 text-amber-700",
  PANELIST: "bg-teal-100 text-teal-700",
};

// ── Component ────────────────────────────────────────────────────────────────

export function SessionDetailSheet({
  eventId,
  sessionId,
  open,
  onOpenChange,
  onSessionUpdated,
}: SessionDetailSheetProps) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [topicForms, setTopicForms] = useState<TopicForm[]>([]);

  const fetchSession = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const [sessionRes, speakersRes] = await Promise.all([
        fetch(`/api/events/${eventId}/sessions/${sessionId}`),
        fetch(`/api/events/${eventId}/speakers`),
      ]);
      if (!sessionRes.ok) {
        toast.error("Failed to load session");
        return;
      }
      const sessionData: SessionData = await sessionRes.json();
      setSession(sessionData);
      setTopicForms(
        sessionData.topics.map((t) => ({
          title: t.title,
          speakerIds: t.speakers.map((ts) => ts.speaker.id),
          duration: t.duration?.toString() || "",
        }))
      );
      if (speakersRes.ok) {
        const data = await speakersRes.json();
        setSpeakers(
          (data as SpeakerOption[]).map((s) => ({
            id: s.id,
            firstName: s.firstName,
            lastName: s.lastName,
            status: s.status,
          }))
        );
      }
    } catch (err) {
      console.error("[session-detail-sheet] Failed to load session:", err);
      toast.error("Failed to load session details");
    } finally {
      setLoading(false);
    }
  }, [eventId, sessionId]);

  useEffect(() => {
    if (open && sessionId) {
      setSession(null);
      setTopicForms([]);
      setIsEditing(false);
      fetchSession();
    }
  }, [open, sessionId, fetchSession]);

  const handleSaveTopics = async () => {
    if (!session) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}/sessions/${session.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topics: topicForms.map((t, i) => ({
            title: t.title,
            duration: t.duration ? parseInt(t.duration) : undefined,
            sortOrder: i,
            speakerIds: t.speakerIds,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || "Failed to save");
      }
      const updated: SessionData = await res.json();
      setSession(updated);
      setTopicForms(
        updated.topics.map((t) => ({
          title: t.title,
          speakerIds: t.speakers.map((ts) => ts.speaker.id),
          duration: t.duration?.toString() || "",
        }))
      );
      setIsEditing(false);
      toast.success("Topics updated");
      onSessionUpdated?.();
    } catch (err) {
      console.error("[session-detail-sheet] Failed to save topics:", err);
      toast.error(err instanceof Error ? err.message : "Failed to save topics");
    } finally {
      setSaving(false);
    }
  };

  const addTopic = () => {
    setTopicForms([...topicForms, { title: "", speakerIds: [], duration: "" }]);
  };

  const removeTopic = (idx: number) => {
    setTopicForms(topicForms.filter((_, i) => i !== idx));
  };

  const updateTopic = (idx: number, field: keyof TopicForm, value: string | string[]) => {
    const updated = [...topicForms];
    updated[idx] = { ...updated[idx], [field]: value };
    setTopicForms(updated);
  };

  if (!sessionId) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[600px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{session?.name || "Session Details"}</SheetTitle>
          <SheetDescription asChild>
            <span className="sr-only">Session details and topic management</span>
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : session ? (
          <div className="space-y-6 mt-4">
            {/* ── Status & Track ────────────────────────────────────── */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={STATUS_COLORS[session.status] ?? "bg-gray-100 text-gray-800"}>
                {session.status}
              </Badge>
              {session.track && (
                <Badge
                  variant="outline"
                  style={{ borderColor: session.track.color, color: session.track.color }}
                >
                  {session.track.name}
                </Badge>
              )}
            </div>

            {/* ── Info Grid ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium text-foreground">
                    {formatDate(new Date(session.startTime))}
                  </p>
                  <p>
                    {formatTime(new Date(session.startTime))} – {formatTime(new Date(session.endTime))}
                  </p>
                </div>
              </div>
              {session.location && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="h-4 w-4 shrink-0" />
                  <span className="text-foreground">{session.location}</span>
                </div>
              )}
              {session.capacity && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Users className="h-4 w-4 shrink-0" />
                  <span className="text-foreground">Capacity: {session.capacity}</span>
                </div>
              )}
            </div>

            {session.description && (
              <p className="text-sm text-muted-foreground">{session.description}</p>
            )}

            {/* ── Session Roles ─────────────────────────────────────── */}
            {session.speakers.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Session Roles</h4>
                <div className="space-y-1.5">
                  {session.speakers.map((sp) => (
                    <div
                      key={`${sp.speaker.id}-${sp.role}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Badge
                        variant="outline"
                        className={`text-xs ${ROLE_COLORS[sp.role] ?? ""}`}
                      >
                        {sp.role}
                      </Badge>
                      <span>
                        {sp.speaker.firstName} {sp.speaker.lastName}
                      </span>
                      <Badge
                        variant="secondary"
                        className={`text-xs ml-auto ${SPEAKER_STATUS_COLORS[sp.speaker.status] ?? ""}`}
                      >
                        {sp.speaker.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Topics ────────────────────────────────────────────── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium">
                  Topics {session.topics.length > 0 && `(${session.topics.length})`}
                </h4>
                {!isEditing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEditing(true)}
                  >
                    Edit Topics
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsEditing(false);
                        // Reset to original
                        setTopicForms(
                          session.topics.map((t) => ({
                            title: t.title,
                            speakerIds: t.speakers.map((ts) => ts.speaker.id),
                            duration: t.duration?.toString() || "",
                          }))
                        );
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveTopics} disabled={saving}>
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-1" />
                      )}
                      Save
                    </Button>
                  </div>
                )}
              </div>

              {isEditing ? (
                <div className="space-y-4">
                  {topicForms.map((topic, idx) => (
                    <div
                      key={idx}
                      className="border rounded-lg p-3 space-y-3"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <Label className="text-xs">Title</Label>
                          <Input
                            value={topic.title}
                            onChange={(e) =>
                              updateTopic(idx, "title", e.target.value)
                            }
                            placeholder="Topic title"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="w-20">
                          <Label className="text-xs">Min</Label>
                          <Input
                            type="number"
                            value={topic.duration}
                            onChange={(e) =>
                              updateTopic(idx, "duration", e.target.value)
                            }
                            placeholder="—"
                            className="h-8 text-sm"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 mt-4 text-destructive hover:text-destructive"
                          onClick={() => removeTopic(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div>
                        <Label className="text-xs">Speakers</Label>
                        <MultiSelect
                          options={speakers.map((sp) => ({
                            value: sp.id,
                            label: `${sp.firstName} ${sp.lastName}`,
                            badge: sp.status,
                            badgeClassName:
                              SPEAKER_STATUS_COLORS[sp.status] ??
                              "bg-gray-100 text-gray-700",
                          }))}
                          selected={topic.speakerIds}
                          onChange={(selected) =>
                            updateTopic(idx, "speakerIds", selected)
                          }
                          placeholder="Select speakers..."
                          searchPlaceholder="Search speakers..."
                          emptyMessage="No speakers found."
                        />
                      </div>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addTopic}
                    className="w-full"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add Topic
                  </Button>
                </div>
              ) : session.topics.length > 0 ? (
                <div className="space-y-2">
                  {session.topics.map((topic) => (
                    <div
                      key={topic.id}
                      className="border rounded-lg p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {topic.title}
                        </span>
                        {topic.duration && (
                          <span className="text-xs text-muted-foreground">
                            {topic.duration} min
                          </span>
                        )}
                      </div>
                      {topic.speakers.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {topic.speakers.map((ts) => (
                            <Badge
                              key={ts.speaker.id}
                              variant="secondary"
                              className="text-xs font-normal"
                            >
                              {ts.speaker.firstName} {ts.speaker.lastName}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No topics added yet. Click &quot;Edit Topics&quot; to add topics and assign speakers.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
