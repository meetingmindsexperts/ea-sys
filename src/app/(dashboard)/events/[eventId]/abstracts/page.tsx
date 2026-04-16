"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  Plus,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Clock,
  User,
  Loader2,
  Pencil,
  Trash2,
  Copy,
  Check,
  Link2,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useAbstracts, useSpeakers, useTracks, useEvent, queryKeys } from "@/hooks/use-api";
import { AbstractThemeSelect } from "@/components/abstracts/abstract-theme-select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CSVImportButton } from "@/components/import/csv-import-dialog";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { BulkEmailDialog } from "@/components/bulk-email-dialog";

/** Strip HTML tags for display (handles legacy HTML content) */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

interface Track {
  id: string;
  name: string;
  color: string;
}

interface Speaker {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  userId: string | null;
}

interface Abstract {
  id: string;
  title: string;
  content: string;
  specialty: string | null;
  presentationType: string | null;
  status: string;
  submittedAt: string;
  reviewedAt: string | null;
  speaker: Speaker;
  track: Track | null;
  theme: { id: string; name: string } | null;
  eventSession: { id: string; name: string } | null;
  /** Server-computed aggregate from AbstractReviewSubmission rows (Sprint B) */
  reviewCount?: number;
  meanOverallScore?: number | null;
}

export default function AbstractsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const isSubmitter  = session?.user?.role === "SUBMITTER";
  const isReviewer   = session?.user?.role === "REVIEWER";
  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";
  const isAdmin      = isSuperAdmin || session?.user?.role === "ADMIN";
  const canReview    = isAdmin || isReviewer;

  const [copied, setCopied] = useState(false);

  // React Query hooks - data is cached and shared across navigations
  const { data: abstractsData = [], isLoading: loading, isFetching, refetch: refetchAbstracts } = useAbstracts(eventId);
  const { data: speakersData = [] } = useSpeakers(eventId);
  const { data: tracksData = [] } = useTracks(eventId);
  const { data: event } = useEvent(eventId);

  const abstracts = abstractsData as Abstract[];
  const speakers = speakersData as Speaker[];
  const tracks = tracksData as Track[];

  // For SUBMITTER: find their speaker record
  const mySpeaker = isSubmitter
    ? speakers.find((s) => s.userId === session?.user?.id)
    : null;

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [selectedAbstract, setSelectedAbstract] = useState<Abstract | null>(null);

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === abstracts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(abstracts.map((a) => a.id)));
    }
  };
  const [formData, setFormData] = useState({
    speakerId: "",
    title: "",
    content: "",
    specialty: "",
    presentationType: "" as string,
    trackId: "",
    themeId: "" as string,
    status: "SUBMITTED",
  });
  const [editData, setEditData] = useState({
    title: "",
    content: "",
    specialty: "",
    presentationType: "" as string,
    trackId: "",
    themeId: "" as string,
  });
  // Sprint B: per-reviewer scoring moved to AbstractReviewSubmission rows
  // (see /submissions route + reviewer portal). This dialog now only handles
  // status transitions on the abstract itself. forceStatus lets admins bypass
  // the requiredReviewCount gate.
  const [reviewData, setReviewData] = useState({
    status: "",
    forceStatus: false,
  });

  // Create abstract mutation
  const createAbstractMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      // For submitters, always use their own speaker ID
      const speakerId = isSubmitter && mySpeaker ? mySpeaker.id : data.speakerId;
      const res = await fetch(`/api/events/${eventId}/abstracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          speakerId,
          trackId: data.trackId || undefined,
          themeId: data.themeId || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Extract field-level errors from Zod flatten() if present
        const fieldErrors = err.details?.fieldErrors as Record<string, string[]> | undefined;
        const firstFieldError = fieldErrors
          ? Object.entries(fieldErrors).find(([, msgs]) => msgs && msgs.length > 0)
          : undefined;
        const message = firstFieldError
          ? `${firstFieldError[0]}: ${firstFieldError[1][0]}`
          : err.error || "Failed to create abstract";
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      setIsDialogOpen(false);
      resetForm();
      toast.success("Abstract submitted successfully");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to submit abstract"),
  });

  // Edit abstract mutation (for submitters)
  const editAbstractMutation = useMutation({
    mutationFn: async ({ abstractId, data }: { abstractId: string; data: typeof editData }) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.title,
          content: data.content,
          specialty: data.specialty || undefined,
          presentationType: data.presentationType || undefined,
          trackId: data.trackId || undefined,
          themeId: data.themeId || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update abstract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      setIsEditDialogOpen(false);
      setSelectedAbstract(null);
      toast.success("Abstract updated successfully");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update abstract"),
  });

  // Sprint B: status transitions validated against event.settings.requiredReviewCount
  // by the server; use forceStatus=true to override (logged as chair-override).
  const reviewAbstractMutation = useMutation({
    mutationFn: async ({ abstractId, data }: { abstractId: string; data: typeof reviewData }) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: data.status,
          ...(data.forceStatus && { forceStatus: true }),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.code === "INSUFFICIENT_REVIEWS") {
          throw new Error(
            `Not enough reviews to ${data.status}: ${err.currentCount}/${err.required}. Use force override if needed.`,
          );
        }
        throw new Error(err.error || "Failed to update status");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      setIsReviewDialogOpen(false);
      setSelectedAbstract(null);
      toast.success("Status updated");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to save review"),
  });

  // Delete abstract mutation (SUPER_ADMIN only)
  const deleteAbstractMutation = useMutation({
    mutationFn: async (abstractId: string) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete abstract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      toast.success("Abstract deleted");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete abstract"),
  });

  const handleDelete = (abstractId: string) => {
    if (!confirm("Delete this abstract? This cannot be undone.")) return;
    deleteAbstractMutation.mutate(abstractId);
  };

  const isSubmitting = createAbstractMutation.isPending || reviewAbstractMutation.isPending || editAbstractMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSubmitter && !formData.speakerId) {
      toast.error("Please select a speaker");
      return;
    }
    if (!formData.title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!formData.content.trim()) {
      toast.error("Abstract content is required");
      return;
    }
    createAbstractMutation.mutate(formData);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAbstract) return;
    editAbstractMutation.mutate({ abstractId: selectedAbstract.id, data: editData });
  };

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAbstract) return;
    reviewAbstractMutation.mutate({ abstractId: selectedAbstract.id, data: reviewData });
  };

  const openEditDialog = (abstract: Abstract) => {
    setSelectedAbstract(abstract);
    setEditData({
      title: abstract.title,
      content: abstract.content,
      specialty: abstract.specialty || "",
      presentationType: abstract.presentationType || "",
      trackId: abstract.track?.id || "",
      themeId: abstract.theme?.id || "",
    });
    setIsEditDialogOpen(true);
  };

  const openReviewDialog = (abstract: Abstract) => {
    setSelectedAbstract(abstract);
    setReviewData({
      status: abstract.status,
      forceStatus: false,
    });
    setIsReviewDialogOpen(true);
  };

  const resetForm = () => {
    setFormData({
      speakerId: isSubmitter && mySpeaker ? mySpeaker.id : "",
      title: "",
      content: "",
      specialty: "",
      presentationType: "",
      trackId: "",
      themeId: "",
      status: "SUBMITTED",
    });
  };

  const statusColors: Record<string, string> = {
    DRAFT: "bg-gray-100 text-gray-800",
    SUBMITTED: "bg-blue-100 text-blue-800",
    UNDER_REVIEW: "bg-yellow-100 text-yellow-800",
    ACCEPTED: "bg-green-100 text-green-800",
    REJECTED: "bg-red-100 text-red-800",
    REVISION_REQUESTED: "bg-orange-100 text-orange-800",
    WITHDRAWN: "bg-gray-100 text-gray-500",
  };

  const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];

  const stats = {
    total: abstracts.length,
    submitted: abstracts.filter((a) => a.status === "SUBMITTED").length,
    underReview: abstracts.filter((a) => a.status === "UNDER_REVIEW").length,
    accepted: abstracts.filter((a) => a.status === "ACCEPTED").length,
    rejected: abstracts.filter((a) => a.status === "REJECTED").length,
    withdrawn: abstracts.filter((a) => a.status === "WITHDRAWN").length,
  };

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
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
              <FileText className="h-8 w-8" />
              {isSubmitter ? "My Abstracts" : "Abstracts"}
              {isFetching && !loading && (
                <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </h1>
          </div>
          <p className="text-muted-foreground">
            {isSubmitter
              ? "Submit and manage your abstracts"
              : "Manage abstract submissions and reviews"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetchAbstracts()}
            disabled={isFetching}
            title="Refresh data"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {!isSubmitter && !isReviewer && (
            <CSVImportButton eventId={eventId} entityType="abstracts" />
          )}
          {!isSubmitter && !isReviewer && abstracts.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setBulkEmailOpen(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              {selectedIds.size > 0 ? `Email (${selectedIds.size})` : "Email All"}
            </Button>
          )}
        {/* Submitter: full page form. Admin: dialog. Reviewer: no button. */}
        {isSubmitter && (
          <Button asChild>
            <Link href={`/events/${eventId}/abstracts/new`}>
              <Plus className="mr-2 h-4 w-4" />
              Submit Abstract
            </Link>
          </Button>
        )}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          {!isSubmitter && !isReviewer && (
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Abstract
            </Button>
          </DialogTrigger>
          )}
          <DialogContent className="sm:max-w-[720px] max-h-[90vh] flex flex-col p-0 gap-0">
            <DialogHeader className="px-6 py-4 border-b shrink-0">
              <DialogTitle>Submit Abstract</DialogTitle>
              <DialogDescription>
                Add a new abstract to this event. Fields marked with * are required.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                {/* Section: Abstract Details */}
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Abstract Details
                  </h3>
                  {!isSubmitter && (
                    <div className="space-y-2">
                      <Label htmlFor="speaker">Speaker <span className="text-red-500">*</span></Label>
                      <Select
                        value={formData.speakerId}
                        onValueChange={(value) =>
                          setFormData({ ...formData, speakerId: value })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select speaker" />
                        </SelectTrigger>
                        <SelectContent>
                          {speakers.map((speaker) => (
                            <SelectItem key={speaker.id} value={speaker.id}>
                              {speaker.firstName} {speaker.lastName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="title">Title <span className="text-red-500">*</span></Label>
                    <Input
                      id="title"
                      value={formData.title}
                      onChange={(e) =>
                        setFormData({ ...formData, title: e.target.value })
                      }
                      placeholder="Enter a concise, descriptive title"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="content">Abstract Content <span className="text-red-500">*</span></Label>
                    <Textarea
                      id="content"
                      value={formData.content}
                      onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                      rows={6}
                      placeholder="Enter your abstract content..."
                      className="resize-y min-h-[140px]"
                      required
                    />
                  </div>
                </div>

                {/* Section: Categorization */}
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Categorization
                  </h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Specialty</Label>
                      <SpecialtySelect
                        value={formData.specialty}
                        onChange={(specialty) =>
                          setFormData({ ...formData, specialty })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Presentation Type</Label>
                      <Select
                        value={formData.presentationType}
                        onValueChange={(value) =>
                          setFormData({ ...formData, presentationType: value })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ORAL">Oral Presentation</SelectItem>
                          <SelectItem value="POSTER">Poster Presentation</SelectItem>
                          <SelectItem value="VIDEO">Video Presentation</SelectItem>
                          <SelectItem value="WORKSHOP">Workshop Presentation</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="track">Track</Label>
                      <Select
                        value={formData.trackId}
                        onValueChange={(value) =>
                          setFormData({ ...formData, trackId: value })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select track" />
                        </SelectTrigger>
                        <SelectContent>
                          {tracks.map((track) => (
                            <SelectItem key={track.id} value={track.id}>
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-3 h-3 rounded-full"
                                  style={{ backgroundColor: track.color }}
                                />
                                {track.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Theme</Label>
                      <AbstractThemeSelect
                        eventId={eventId}
                        value={formData.themeId || null}
                        onChange={(v) => setFormData({ ...formData, themeId: v ?? "" })}
                      />
                    </div>
                    {!isSubmitter && (
                      <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor="status">Status</Label>
                        <Select
                          value={formData.status}
                          onValueChange={(value) =>
                            setFormData({ ...formData, status: value })
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="DRAFT">Draft</SelectItem>
                            <SelectItem value="SUBMITTED">Submitted</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t bg-muted/30 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Abstract"
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Submitted
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.submitted}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Under Review
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {stats.underReview}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Accepted
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.accepted}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Rejected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.rejected}</div>
          </CardContent>
        </Card>
        {stats.withdrawn > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Withdrawn
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gray-500">{stats.withdrawn}</div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Abstract Submission URL (organizers/admins only) */}
      {!isSubmitter && event?.slug && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              Abstract Submission URL
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Share this link with speakers so they can create an account and submit their abstracts.
              Speakers register with their profile details, then log in to submit and manage their work.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono truncate select-all">
                {process.env.NEXT_PUBLIC_APP_URL || ""}/e/{event.slug}/abstract/register
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  const url = `${window.location.origin}/e/${event.slug}/abstract/register`;
                  navigator.clipboard.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? (
                  <><Check className="h-4 w-4 mr-1 text-green-600" /> Copied</>
                ) : (
                  <><Copy className="h-4 w-4 mr-1" /> Copy</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Review Dialog (admin + reviewer) */}
      {canReview && (
        <Dialog
          open={isReviewDialogOpen}
          onOpenChange={(open) => {
            setIsReviewDialogOpen(open);
            if (!open) setSelectedAbstract(null);
          }}
        >
          <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl">
            <DialogHeader>
              <DialogTitle>Review Abstract</DialogTitle>
            </DialogHeader>
            {selectedAbstract && (
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold">{selectedAbstract.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    By {selectedAbstract.speaker.firstName}{" "}
                    {selectedAbstract.speaker.lastName}
                  </p>
                </div>
                <div className="bg-muted p-4 rounded-lg max-h-48 overflow-y-auto">
                  <p className="text-sm whitespace-pre-wrap">
                    {selectedAbstract.content}
                  </p>
                </div>
                <form onSubmit={handleReview} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reviewStatus">Decision</Label>
                    <Select
                      value={reviewData.status}
                      onValueChange={(value) =>
                        setReviewData({ ...reviewData, status: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                        <SelectItem value="ACCEPTED">Accept</SelectItem>
                        <SelectItem value="REJECTED">Reject</SelectItem>
                        <SelectItem value="REVISION_REQUESTED">
                          Request Revision
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {isAdmin && (
                    <label className="flex items-start gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={reviewData.forceStatus}
                        onChange={(e) =>
                          setReviewData({ ...reviewData, forceStatus: e.target.checked })
                        }
                      />
                      <span>
                        Force status (bypass required-review-count gate). Logged as chair override.
                      </span>
                    </label>
                  )}
                  <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                    Per-reviewer scoring is handled via the new review submission flow
                    (POST /api/events/{eventId}/abstracts/[id]/submissions). MCP tools:
                    <code className="mx-1">submit_abstract_review</code>,
                    <code className="mx-1">get_abstract_scores</code>. The status transition
                    here validates against <code>event.settings.requiredReviewCount</code>.
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsReviewDialogOpen(false)}
                      disabled={isSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={isSubmitting}>
                      {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save Status
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Edit Dialog (for submitters editing their own abstracts) */}
      {isSubmitter && (
        <Dialog
          open={isEditDialogOpen}
          onOpenChange={(open) => {
            setIsEditDialogOpen(open);
            if (!open) setSelectedAbstract(null);
          }}
        >
          <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl">
            <DialogHeader>
              <DialogTitle>Edit Abstract</DialogTitle>
            </DialogHeader>
            {selectedAbstract && (
              <form onSubmit={handleEdit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="editTitle">Title</Label>
                  <Input
                    id="editTitle"
                    value={editData.title}
                    onChange={(e) =>
                      setEditData({ ...editData, title: e.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editContent">Abstract Content</Label>
                  <Textarea
                    id="editContent"
                    value={editData.content}
                    onChange={(e) => setEditData({ ...editData, content: e.target.value })}
                    rows={10}
                    className="resize-y min-h-[200px]"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Specialty</Label>
                  <SpecialtySelect
                    value={editData.specialty}
                    onChange={(specialty) =>
                      setEditData({ ...editData, specialty })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Presentation Type</Label>
                  <Select
                    value={editData.presentationType}
                    onValueChange={(value) =>
                      setEditData({ ...editData, presentationType: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ORAL">Oral Presentation</SelectItem>
                      <SelectItem value="POSTER">Poster Presentation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editTrack">Track</Label>
                  <Select
                    value={editData.trackId}
                    onValueChange={(value) =>
                      setEditData({ ...editData, trackId: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select track" />
                    </SelectTrigger>
                    <SelectContent>
                      {tracks.map((track) => (
                        <SelectItem key={track.id} value={track.id}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: track.color }}
                            />
                            {track.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Theme</Label>
                  <AbstractThemeSelect
                    eventId={eventId}
                    value={editData.themeId || null}
                    onChange={(v) => setEditData({ ...editData, themeId: v ?? "" })}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditDialogOpen(false)}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Changes
                  </Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Abstracts List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">
          {isSubmitter ? "Your Abstracts" : "All Abstracts"}
        </h2>
        {abstracts.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                {isSubmitter
                  ? "You haven't submitted any abstracts yet. Click \"Submit Abstract\" to get started."
                  : "No abstracts yet. Click \"Add Abstract\" to get started."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {/* Bulk selection toolbar */}
            {selectedIds.size > 0 && !isSubmitter && (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3 shadow-sm">
                <Checkbox
                  checked={selectedIds.size === abstracts.length}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all"
                />
                <span className="text-sm font-medium">
                  {selectedIds.size} abstract{selectedIds.size !== 1 ? "s" : ""} selected
                </span>
                <div className="flex gap-2 ml-auto">
                  <Button size="sm" onClick={() => setBulkEmailOpen(true)}>
                    <Send className="mr-2 h-4 w-4" /> Send Email
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                    <X className="mr-2 h-4 w-4" /> Clear
                  </Button>
                </div>
              </div>
            )}
            {abstracts.map((abstract) => (
              <Card
                key={abstract.id}
                className={`transition-all duration-200 hover:border-primary/50 hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.04)] hover:-translate-y-0.5 ${selectedIds.has(abstract.id) ? "border-primary/30 bg-primary/[0.02]" : ""}`}
              >
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      {/* Selection checkbox (admin only) */}
                      {!isSubmitter && !isReviewer && (
                        <Checkbox
                          checked={selectedIds.has(abstract.id)}
                          onCheckedChange={() => toggleSelect(abstract.id)}
                          className="mt-1"
                          aria-label={`Select ${abstract.title}`}
                        />
                      )}
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">{abstract.title}</h3>
                        <Badge
                          className={statusColors[abstract.status]}
                          variant="outline"
                        >
                          {abstract.status.replace("_", " ")}
                        </Badge>
                        {abstract.presentationType && (
                          <Badge variant="secondary" className="text-xs">
                            {abstract.presentationType === "ORAL" ? "Oral"
                              : abstract.presentationType === "POSTER" ? "Poster"
                              : abstract.presentationType === "VIDEO" ? "Video"
                              : "Workshop"}
                          </Badge>
                        )}
                        {abstract.theme && (
                          <Badge variant="outline" className="text-xs border-violet-300 text-violet-700">
                            {abstract.theme.name}
                          </Badge>
                        )}
                        {abstract.track && (
                          <Badge
                            variant="outline"
                            style={{ borderColor: abstract.track.color }}
                          >
                            <div
                              className="w-2 h-2 rounded-full mr-1"
                              style={{ backgroundColor: abstract.track.color }}
                            />
                            {abstract.track.name}
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                        {!isSubmitter && (
                          <div className="flex items-center gap-1">
                            <User className="h-4 w-4" />
                            {abstract.speaker.firstName} {abstract.speaker.lastName}
                          </div>
                        )}
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          Submitted {formatDate(abstract.submittedAt)}
                        </div>
                        {typeof abstract.meanOverallScore === "number" && (
                          <div>
                            Mean score: {abstract.meanOverallScore}/100
                            {typeof abstract.reviewCount === "number" && (
                              <> ({abstract.reviewCount} review{abstract.reviewCount === 1 ? "" : "s"})</>
                            )}
                          </div>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                        {stripHtml(abstract.content)}
                      </p>

                      {abstract.eventSession && (
                        <div className="mt-3">
                          <Badge variant="secondary">
                            Session: {abstract.eventSession.name}
                          </Badge>
                        </div>
                      )}
                    </div>
                    </div>

                    <div className="flex gap-2">
                      {isSubmitter ? (
                        // Submitter actions: Edit/View via full page
                        <Button
                          variant="outline"
                          size="sm"
                          asChild
                        >
                          <Link href={`/events/${eventId}/abstracts/${abstract.id}/edit`}>
                            <Pencil className="mr-1 h-4 w-4" />
                            {editableStatuses.includes(abstract.status) ? "Edit" : "View"}
                          </Link>
                        </Button>
                      ) : canReview ? (
                        // Admin / Reviewer actions
                        <>
                          {isAdmin && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEditDialog(abstract)}
                            >
                              <Pencil className="mr-1 h-4 w-4" />
                              Edit
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openReviewDialog(abstract)}
                          >
                            Review
                          </Button>
                          {abstract.status === "SUBMITTED" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-green-600"
                                onClick={() => {
                                  setSelectedAbstract(abstract);
                                  setReviewData({
                                    status: "ACCEPTED",
                                    forceStatus: false,
                                  });
                                  setIsReviewDialogOpen(true);
                                }}
                              >
                                <CheckCircle className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-red-600"
                                onClick={() => {
                                  setSelectedAbstract(abstract);
                                  setReviewData({
                                    status: "REJECTED",
                                    forceStatus: false,
                                  });
                                  setIsReviewDialogOpen(true);
                                }}
                              >
                                <XCircle className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                          {isSuperAdmin && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-600 hover:bg-red-50"
                              onClick={() => handleDelete(abstract.id)}
                              disabled={deleteAbstractMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Bulk Email Dialog */}
      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        eventId={eventId}
        recipientType="abstracts"
        recipientIds={Array.from(selectedIds)}
        recipientCount={selectedIds.size > 0 ? selectedIds.size : abstracts.length}
        selectionMode={selectedIds.size > 0 ? "selected" : "all"}
      />
    </div>
  );
}
