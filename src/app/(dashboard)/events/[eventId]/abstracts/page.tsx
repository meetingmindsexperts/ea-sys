"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useAbstracts, useSpeakers, useTracks, queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
}

interface Abstract {
  id: string;
  title: string;
  content: string;
  status: string;
  reviewNotes: string | null;
  reviewScore: number | null;
  submittedAt: string;
  reviewedAt: string | null;
  speaker: Speaker;
  track: Track | null;
  eventSession: { id: string; name: string } | null;
}

export default function AbstractsPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const queryClient = useQueryClient();

  // React Query hooks - data is cached and shared across navigations
  const { data: abstractsData = [], isLoading: loading, isFetching } = useAbstracts(eventId);
  const { data: speakersData = [] } = useSpeakers(eventId);
  const { data: tracksData = [] } = useTracks(eventId);

  const abstracts = abstractsData as Abstract[];
  const speakers = speakersData as Speaker[];
  const tracks = tracksData as Track[];

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [selectedAbstract, setSelectedAbstract] = useState<Abstract | null>(null);
  const [formData, setFormData] = useState({
    speakerId: "",
    title: "",
    content: "",
    trackId: "",
    status: "SUBMITTED",
  });
  const [reviewData, setReviewData] = useState({
    status: "",
    reviewNotes: "",
    reviewScore: "",
  });

  // Create abstract mutation
  const createAbstractMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await fetch(`/api/events/${eventId}/abstracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          trackId: data.trackId || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to create abstract");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      setIsDialogOpen(false);
      resetForm();
      toast.success("Abstract submitted successfully");
    },
    onError: () => toast.error("Failed to submit abstract"),
  });

  // Review abstract mutation
  const reviewAbstractMutation = useMutation({
    mutationFn: async ({ abstractId, data }: { abstractId: string; data: typeof reviewData }) => {
      const res = await fetch(`/api/events/${eventId}/abstracts/${abstractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: data.status,
          reviewNotes: data.reviewNotes || undefined,
          reviewScore: data.reviewScore ? parseInt(data.reviewScore) : undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to review abstract");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.abstracts(eventId) });
      setIsReviewDialogOpen(false);
      setSelectedAbstract(null);
      toast.success("Review saved successfully");
    },
    onError: () => toast.error("Failed to save review"),
  });

  const isSubmitting = createAbstractMutation.isPending || reviewAbstractMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    createAbstractMutation.mutate(formData);
  };

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAbstract) return;
    reviewAbstractMutation.mutate({ abstractId: selectedAbstract.id, data: reviewData });
  };

  const openReviewDialog = (abstract: Abstract) => {
    setSelectedAbstract(abstract);
    setReviewData({
      status: abstract.status,
      reviewNotes: abstract.reviewNotes || "",
      reviewScore: abstract.reviewScore?.toString() || "",
    });
    setIsReviewDialogOpen(true);
  };

  const resetForm = () => {
    setFormData({
      speakerId: "",
      title: "",
      content: "",
      trackId: "",
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
  };

  const stats = {
    total: abstracts.length,
    submitted: abstracts.filter((a) => a.status === "SUBMITTED").length,
    underReview: abstracts.filter((a) => a.status === "UNDER_REVIEW").length,
    accepted: abstracts.filter((a) => a.status === "ACCEPTED").length,
    rejected: abstracts.filter((a) => a.status === "REJECTED").length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
              Abstracts
              {isFetching && !loading && (
                <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </h1>
          </div>
          <p className="text-muted-foreground">
            Manage abstract submissions and reviews
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Abstract
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Submit Abstract</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="speaker">Speaker</Label>
                <Select
                  value={formData.speakerId}
                  onValueChange={(value) =>
                    setFormData({ ...formData, speakerId: value })
                  }
                >
                  <SelectTrigger>
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
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="content">Abstract Content</Label>
                <Textarea
                  id="content"
                  value={formData.content}
                  onChange={(e) =>
                    setFormData({ ...formData, content: e.target.value })
                  }
                  rows={6}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="track">Track</Label>
                  <Select
                    value={formData.trackId}
                    onValueChange={(value) =>
                      setFormData({ ...formData, trackId: value })
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
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="SUBMITTED">Submitted</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Submit Abstract
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
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
      </div>

      {/* Review Dialog */}
      <Dialog
        open={isReviewDialogOpen}
        onOpenChange={(open) => {
          setIsReviewDialogOpen(open);
          if (!open) setSelectedAbstract(null);
        }}
      >
        <DialogContent className="sm:max-w-[600px]">
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
                <div className="space-y-2">
                  <Label htmlFor="reviewScore">Score (0-100)</Label>
                  <Input
                    id="reviewScore"
                    type="number"
                    min="0"
                    max="100"
                    value={reviewData.reviewScore}
                    onChange={(e) =>
                      setReviewData({ ...reviewData, reviewScore: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reviewNotes">Review Notes</Label>
                  <Textarea
                    id="reviewNotes"
                    value={reviewData.reviewNotes}
                    onChange={(e) =>
                      setReviewData({ ...reviewData, reviewNotes: e.target.value })
                    }
                    rows={4}
                    placeholder="Feedback for the speaker..."
                  />
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
                    Save Review
                  </Button>
                </div>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Abstracts List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">All Abstracts</h2>
        {abstracts.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No abstracts yet. Click &quot;Add Abstract&quot; to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {abstracts.map((abstract) => (
              <Card
                key={abstract.id}
                className="hover:border-primary transition-colors"
              >
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">{abstract.title}</h3>
                        <Badge
                          className={statusColors[abstract.status]}
                          variant="outline"
                        >
                          {abstract.status.replace("_", " ")}
                        </Badge>
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
                        <div className="flex items-center gap-1">
                          <User className="h-4 w-4" />
                          {abstract.speaker.firstName} {abstract.speaker.lastName}
                        </div>
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          Submitted {formatDate(abstract.submittedAt)}
                        </div>
                        {abstract.reviewScore !== null && (
                          <div>Score: {abstract.reviewScore}/100</div>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {abstract.content}
                      </p>

                      {abstract.reviewNotes && (
                        <div className="mt-3 p-3 bg-muted rounded-lg">
                          <p className="text-xs font-medium text-muted-foreground mb-1">
                            Review Notes:
                          </p>
                          <p className="text-sm">{abstract.reviewNotes}</p>
                        </div>
                      )}

                      {abstract.eventSession && (
                        <div className="mt-3">
                          <Badge variant="secondary">
                            Session: {abstract.eventSession.name}
                          </Badge>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
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
                                reviewNotes: "",
                                reviewScore: "",
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
                                reviewNotes: "",
                                reviewScore: "",
                              });
                              setIsReviewDialogOpen(true);
                            }}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
