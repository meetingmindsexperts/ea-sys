"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  ArrowLeft,
  Save,
  Loader2,
  Send,
  Trash2,
} from "lucide-react";
import { useTracks, queryKeys } from "@/hooks/use-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { formatDate } from "@/lib/utils";
import Link from "next/link";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  { ssr: false, loading: () => <div className="h-[300px] border rounded-md animate-pulse bg-muted/50" /> }
);

interface Track {
  id: string;
  name: string;
  color: string;
}

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  UNDER_REVIEW: "bg-amber-100 text-amber-700",
  ACCEPTED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
  REVISION_REQUESTED: "bg-orange-100 text-orange-700",
};

const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];

// Inner form component — only mounts after abstract data is loaded
function EditForm({ abstract, eventId, abstractId, tracks }: {
  abstract: Record<string, unknown>;
  eventId: string;
  abstractId: string;
  tracks: Track[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [editData, setEditData] = useState({
    title: (abstract.title as string) || "",
    content: (abstract.content as string) || "",
    specialty: (abstract.specialty as string) || "",
    presentationType: (abstract.presentationType as string) || "",
    trackId: (abstract.track as { id: string } | null)?.id || "",
  });

  const canEdit = editableStatuses.includes(abstract.status as string);

  const updateMutation = useMutation({
    mutationFn: async (data: typeof editData & { status?: string }) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.title,
          content: data.content,
          specialty: data.specialty || undefined,
          presentationType: data.presentationType || undefined,
          trackId: data.trackId || undefined,
          ...(data.status && { status: data.status }),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update abstract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      queryClient.invalidateQueries({ queryKey: ["abstract", abstractId] });
      toast.success("Abstract updated");
      router.push(`/events/${eventId}/abstracts`);
    },
    onError: (err: Error) => {
      console.error("[EditAbstract] Update failed:", err.message);
      toast.error(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete abstract");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      toast.success("Abstract deleted");
      router.push(`/events/${eventId}/abstracts`);
    },
    onError: () => toast.error("Failed to delete abstract"),
  });

  const isPending = updateMutation.isPending || deleteMutation.isPending;
  const speaker = abstract.speaker as { firstName: string; lastName: string; email: string } | null;
  const reviewNotes = abstract.reviewNotes as string | null;
  const reviewScore = abstract.reviewScore as number | null;
  const status = abstract.status as string;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/events/${eventId}/abstracts`}>
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            {canEdit ? "Edit Abstract" : "View Abstract"}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge className={statusColors[status]} variant="outline">
              {status.replace("_", " ")}
            </Badge>
            {(abstract.presentationType as string) && (
              <Badge variant="secondary" className="text-xs">
                {(abstract.presentationType as string) === "ORAL" ? "Oral" : "Poster"}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Submitted {formatDate(abstract.submittedAt as string)}
            </span>
          </div>
        </div>
      </div>

      {/* Review feedback */}
      {reviewNotes && (
        <Card className={status === "REVISION_REQUESTED" ? "border-orange-300 bg-orange-50/50" : "border-green-300 bg-green-50/50"}>
          <CardContent className="pt-5 pb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Reviewer Feedback</h3>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{reviewNotes}</p>
            {reviewScore != null && (
              <p className="text-sm text-slate-500 mt-2">Score: <span className="font-semibold">{reviewScore}/100</span></p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Form */}
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title" className="text-sm font-semibold">
                  Abstract Title <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="title"
                  value={editData.title}
                  onChange={(e) => setEditData({ ...editData, title: e.target.value })}
                  placeholder="Enter your abstract title"
                  className="text-base h-12 font-medium"
                  disabled={!canEdit}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-2">
              <Label className="text-sm font-semibold">
                Abstract Content <span className="text-red-400">*</span>
              </Label>
              <div className="min-h-[350px]">
                {canEdit ? (
                  <TiptapEditor
                    content={editData.content}
                    onChange={(html) => setEditData({ ...editData, content: html })}
                  />
                ) : (
                  <div className="prose prose-sm prose-slate max-w-none border rounded-md p-4 min-h-[200px]"
                    dangerouslySetInnerHTML={{ __html: editData.content }} />
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {canEdit && (
            <Card className="border-primary/20 bg-primary/[0.02]">
              <CardContent className="pt-5 space-y-3">
                {status === "DRAFT" && (
                  <Button
                    className="w-full btn-gradient font-semibold h-11"
                    disabled={isPending}
                    onClick={() => updateMutation.mutate({ ...editData, status: "SUBMITTED" })}
                  >
                    {updateMutation.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting…</>
                    ) : (
                      <><Send className="mr-2 h-4 w-4" /> Submit for Review</>
                    )}
                  </Button>
                )}
                <Button
                  variant={status === "DRAFT" ? "outline" : "default"}
                  className={status !== "DRAFT" ? "w-full btn-gradient font-semibold h-11" : "w-full"}
                  disabled={isPending}
                  onClick={() => updateMutation.mutate(editData)}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
                {status === "DRAFT" && (
                  <Button
                    variant="outline"
                    className="w-full text-red-600 hover:bg-red-50"
                    disabled={isPending}
                    onClick={() => {
                      if (confirm("Delete this abstract? This cannot be undone.")) {
                        deleteMutation.mutate();
                      }
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete Draft
                  </Button>
                )}
                <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                  {status === "DRAFT"
                    ? "Save as draft or submit when ready."
                    : status === "REVISION_REQUESTED"
                      ? "Address the reviewer feedback and resubmit."
                      : "Save your changes."}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-5 space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Details</h3>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Presentation Type</Label>
                <Select
                  value={editData.presentationType}
                  onValueChange={(value) => setEditData({ ...editData, presentationType: value })}
                  disabled={!canEdit}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ORAL">Oral Presentation</SelectItem>
                    <SelectItem value="POSTER">Poster Presentation</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Specialty</Label>
                <SpecialtySelect
                  value={editData.specialty}
                  onChange={(specialty) => setEditData({ ...editData, specialty })}
                />
              </div>

              {tracks.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Track</Label>
                  <Select
                    value={editData.trackId}
                    onValueChange={(value) => setEditData({ ...editData, trackId: value })}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Select track" />
                    </SelectTrigger>
                    <SelectContent>
                      {tracks.map((track) => (
                        <SelectItem key={track.id} value={track.id}>
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: track.color }} />
                            {track.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {speaker && (
                <div className="pt-3 border-t">
                  <p className="text-xs text-muted-foreground">Speaker</p>
                  <p className="text-sm font-medium">{speaker.firstName} {speaker.lastName}</p>
                  <p className="text-xs text-muted-foreground">{speaker.email}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function EditAbstractPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const abstractId = params.abstractId as string;

  const { data: tracksData = [] } = useTracks(eventId);
  const tracks = tracksData as Track[];

  const { data: abstract, isLoading } = useQuery({
    queryKey: ["abstract", abstractId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`);
      if (!res.ok) throw new Error("Failed to fetch abstract");
      return res.json();
    },
  });

  if (isLoading || !abstract) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return <EditForm abstract={abstract} eventId={eventId} abstractId={abstractId} tracks={tracks} />;
}
