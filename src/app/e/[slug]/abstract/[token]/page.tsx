"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import {
  FileText,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  Pencil,
  Save,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface AbstractData {
  id: string;
  title: string;
  content: string;
  status: string;
  reviewNotes: string | null;
  reviewScore: number | null;
  submittedAt: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  track: { id: string; name: string } | null;
  speaker: {
    firstName: string;
    lastName: string;
    email: string;
    company: string | null;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    tracks: { id: string; name: string }[];
  };
  isEditable: boolean;
  deadlinePassed: boolean;
}

const editSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().min(10, "Abstract must be at least 10 characters"),
  trackId: z.string().optional(),
});

type EditForm = z.infer<typeof editSchema>;

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ComponentType<{ className?: string }> }> = {
  DRAFT: { label: "Draft", variant: "secondary", icon: Pencil },
  SUBMITTED: { label: "Submitted", variant: "default", icon: Clock },
  UNDER_REVIEW: { label: "Under Review", variant: "outline", icon: Eye },
  ACCEPTED: { label: "Accepted", variant: "default", icon: CheckCircle2 },
  REJECTED: { label: "Rejected", variant: "destructive", icon: XCircle },
  REVISION_REQUESTED: { label: "Revision Requested", variant: "secondary", icon: AlertTriangle },
};

export default function AbstractManagementPage() {
  const params = useParams();
  const token = params.token as string;

  const [abstract, setAbstract] = useState<AbstractData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: { title: "", content: "", trackId: "" },
  });

  useEffect(() => {
    async function fetchAbstract() {
      try {
        const res = await fetch(`/api/public/abstracts/${token}`);
        if (!res.ok) {
          setError(res.status === 404 ? "Abstract not found" : "Failed to load abstract");
          return;
        }
        const data = await res.json();
        setAbstract(data);
        form.reset({
          title: data.title,
          content: data.content,
          trackId: data.track?.id || "",
        });
      } catch {
        setError("Failed to load abstract");
      } finally {
        setLoading(false);
      }
    }

    if (token) fetchAbstract();
  }, [token, form]);

  async function onSubmit(data: EditForm) {
    setSaving(true);
    try {
      const res = await fetch(`/api/public/abstracts/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok) {
        toast.error(result.error || "Failed to update");
        setSaving(false);
        return;
      }

      // Update local state
      setAbstract((prev) =>
        prev
          ? {
              ...prev,
              title: result.title,
              content: result.content,
              status: result.status,
              trackId: result.trackId,
              track: result.trackId
                ? prev.event.tracks.find((t) => t.id === result.trackId) || prev.track
                : null,
              updatedAt: result.updatedAt,
            }
          : null
      );
      setEditing(false);
      toast.success("Abstract updated successfully");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !abstract) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{error || "Abstract not found"}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const config = statusConfig[abstract.status] || statusConfig.SUBMITTED;
  const StatusIcon = config.icon;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-gradient-primary text-white">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <p className="text-sm opacity-80 mb-1">{abstract.event.name}</p>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6" />
            Abstract Submission
          </h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 flex-1 w-full space-y-6">
        {/* Revision Requested Banner */}
        {abstract.status === "REVISION_REQUESTED" && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-lg">
            <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Revision Requested</p>
              <p className="text-sm mt-1">
                The review committee has requested changes to your abstract.
                Please update your submission below.
              </p>
            </div>
          </div>
        )}

        {/* Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Status</CardTitle>
                <CardDescription>
                  Submitted on {format(new Date(abstract.submittedAt), "MMMM d, yyyy")}
                </CardDescription>
              </div>
              <Badge variant={config.variant} className="flex items-center gap-1.5 px-3 py-1">
                <StatusIcon className="h-3.5 w-3.5" />
                {config.label}
              </Badge>
            </div>
          </CardHeader>

          {/* Review feedback */}
          {abstract.reviewedAt && (abstract.reviewNotes || abstract.reviewScore !== null) && (
            <CardContent className="border-t pt-4">
              <h3 className="text-sm font-medium mb-2">Review Feedback</h3>
              {abstract.reviewScore !== null && (
                <p className="text-sm text-muted-foreground mb-1">
                  Score: <span className="font-medium text-foreground">{abstract.reviewScore}/10</span>
                </p>
              )}
              {abstract.reviewNotes && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{abstract.reviewNotes}</p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                Reviewed on {format(new Date(abstract.reviewedAt), "MMMM d, yyyy")}
              </p>
            </CardContent>
          )}
        </Card>

        {/* Abstract Content */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your Abstract</CardTitle>
              {abstract.isEditable && !editing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    form.reset({
                      title: abstract.title,
                      content: abstract.content,
                      trackId: abstract.track?.id || "",
                    });
                    setEditing(true);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-1" />
                  Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {editing ? (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="content"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Abstract</FormLabel>
                        <FormControl>
                          <Textarea className="min-h-[200px]" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {abstract.event.tracks.length > 0 && (
                    <FormField
                      control={form.control}
                      name="trackId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Track</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a track" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {abstract.event.tracks.map((track) => (
                                <SelectItem key={track.id} value={track.id}>
                                  {track.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  <div className="flex gap-2">
                    <Button type="submit" disabled={saving}>
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      <Save className="mr-1 h-4 w-4" />
                      Save Changes
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setEditing(false)}
                    >
                      <X className="mr-1 h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </form>
              </Form>
            ) : (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">{abstract.title}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    by {abstract.speaker.firstName} {abstract.speaker.lastName}
                    {abstract.speaker.company && ` - ${abstract.speaker.company}`}
                  </p>
                </div>

                {abstract.track && (
                  <div>
                    <span className="text-sm text-muted-foreground">Track: </span>
                    <Badge variant="outline">{abstract.track.name}</Badge>
                  </div>
                )}

                <div className="border-t pt-4">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {abstract.content}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Back to event link */}
        <div className="text-center">
          <Link
            href={`/e/${abstract.event.slug}`}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to {abstract.event.name}
          </Link>
        </div>
      </div>
    </div>
  );
}
