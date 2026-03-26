"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Card, CardContent } from "@/components/ui/card";
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
  FileText,
  ArrowLeft,
  Send,
  Save,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useSpeakers, useTracks, useEvent, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import Link from "next/link";

interface Speaker {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  userId: string | null;
}

interface Track {
  id: string;
  name: string;
  color: string;
}

export default function NewAbstractPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const isSubmitter = session?.user?.role === "SUBMITTER";
  const isAdmin = session?.user?.role === "SUPER_ADMIN" || session?.user?.role === "ADMIN";

  const { data: speakersData = [] } = useSpeakers(eventId);
  const { data: tracksData = [] } = useTracks(eventId);
  const { data: event } = useEvent(eventId);

  const speakers = speakersData as Speaker[];
  const tracks = tracksData as Track[];

  const mySpeaker = isSubmitter
    ? speakers.find((s) => s.userId === session?.user?.id)
    : null;

  const [formData, setFormData] = useState({
    speakerId: "",
    title: "",
    content: "",
    specialty: "",
    presentationType: "",
    trackId: "",
    status: "SUBMITTED",
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const speakerId = isSubmitter && mySpeaker ? mySpeaker.id : data.speakerId;
      const res = await fetch(`/api/events/${eventId}/abstracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          speakerId,
          trackId: data.trackId || undefined,
          presentationType: data.presentationType || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit abstract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      toast.success("Abstract submitted successfully!");
      router.push(`/events/${eventId}/abstracts`);
    },
    onError: (err: Error) => {
      console.error("[NewAbstract] Submission failed:", err.message);
      toast.error(err.message);
    },
  });

  const handleSubmit = (asDraft: boolean) => {
    if (!formData.title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!formData.content.trim()) {
      toast.error("Abstract content is required");
      return;
    }
    createMutation.mutate({
      ...formData,
      status: asDraft ? "DRAFT" : "SUBMITTED",
    });
  };

  return (
    <div className="space-y-6 pb-12">
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
            Submit Abstract
          </h1>
          {event && (
            <p className="text-muted-foreground text-sm mt-0.5">{(event as { name: string }).name}</p>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Main content */}
        <div className="space-y-6">
          {/* Title */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title" className="text-sm font-semibold">
                  Abstract Title <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Enter a concise, descriptive title for your abstract"
                  className="text-base h-12 font-medium"
                />
              </div>
            </CardContent>
          </Card>

          {/* Content */}
          <Card>
            <CardContent className="pt-6 space-y-2">
              <Label htmlFor="abstractContent" className="text-sm font-semibold">
                Abstract Content <span className="text-red-400">*</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Include your objective, methodology, results, and conclusions. Aim for 250–300 words.
              </p>
              <Textarea
                id="abstractContent"
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                rows={16}
                placeholder="Enter your abstract content here..."
                className="resize-y min-h-[300px] text-base leading-relaxed"
              />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Submit actions */}
          <Card className="border-primary/20 bg-primary/[0.02]">
            <CardContent className="pt-5 space-y-3">
              <Button
                className="w-full btn-gradient font-semibold h-11"
                disabled={createMutation.isPending}
                onClick={() => handleSubmit(false)}
              >
                {createMutation.isPending ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting…</>
                ) : (
                  <><Send className="mr-2 h-4 w-4" /> Submit for Review</>
                )}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                disabled={createMutation.isPending}
                onClick={() => handleSubmit(true)}
              >
                <Save className="mr-2 h-4 w-4" /> Save as Draft
              </Button>
              <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                Drafts can be edited later. Submitted abstracts go directly for review.
              </p>
            </CardContent>
          </Card>

          {/* Metadata */}
          <Card>
            <CardContent className="pt-5 space-y-4">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Details</h3>

              {/* Speaker (admin only) */}
              {!isSubmitter && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Speaker <span className="text-red-400">*</span></Label>
                  <Select
                    value={formData.speakerId}
                    onValueChange={(value) => setFormData({ ...formData, speakerId: value })}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Select speaker" />
                    </SelectTrigger>
                    <SelectContent>
                      {speakers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.firstName} {s.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Presentation Type */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Presentation Type</Label>
                <Select
                  value={formData.presentationType}
                  onValueChange={(value) => setFormData({ ...formData, presentationType: value })}
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

              {/* Specialty */}
              <div className="space-y-1.5 overflow-visible">
                <Label className="text-xs font-medium">Specialty</Label>
                <SpecialtySelect
                  value={formData.specialty}
                  onChange={(specialty) => setFormData({ ...formData, specialty })}
                />
              </div>

              {/* Track */}
              {tracks.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Track</Label>
                  <Select
                    value={formData.trackId}
                    onValueChange={(value) => setFormData({ ...formData, trackId: value })}
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

              {/* Status (admin only) */}
              {isAdmin && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value) => setFormData({ ...formData, status: value })}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SUBMITTED">Submitted</SelectItem>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tips */}
          <Card className="bg-amber-50/50 border-amber-200/50">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-2">
                <Sparkles className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-amber-800 mb-1">Tips for a great abstract</p>
                  <ul className="text-[11px] text-amber-700 space-y-1 leading-relaxed">
                    <li>• State your objective clearly in the first sentence</li>
                    <li>• Include methodology, results, and conclusions</li>
                    <li>• Keep it concise — aim for 250–300 words</li>
                    <li>• Avoid abbreviations without first defining them</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
