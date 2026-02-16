"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import {
  Calendar,
  MapPin,
  Clock,
  FileText,
  Loader2,
  AlertCircle,
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
import { toast } from "sonner";

interface Track {
  id: string;
  name: string;
  description: string | null;
}

interface EventData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  organization: {
    name: string;
    logo: string | null;
  };
  tracks: Track[];
  abstractSettings: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

const abstractSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  company: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(10, "Abstract must be at least 10 characters"),
  trackId: z.string().optional(),
});

type AbstractForm = z.infer<typeof abstractSchema>;

export default function SubmitAbstractPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [event, setEvent] = useState<EventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<AbstractForm>({
    resolver: zodResolver(abstractSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      company: "",
      title: "",
      content: "",
      trackId: "",
    },
  });

  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          setError(res.status === 404 ? "Event not found" : "Failed to load event");
          return;
        }
        const data = await res.json();
        setEvent(data);
      } catch {
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }

    if (slug) fetchEvent();
  }, [slug]);

  async function onSubmit(data: AbstractForm) {
    setSubmitting(true);

    try {
      const res = await fetch(`/api/public/events/${slug}/abstracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok) {
        toast.error(result.error || "Submission failed");
        setSubmitting(false);
        return;
      }

      router.push(`/e/${slug}/submit/confirmation`);
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{error || "Event not found"}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check if submissions are open
  const submissionsOpen = event.abstractSettings.allowAbstractSubmissions;
  const deadline = event.abstractSettings.abstractDeadline
    ? new Date(event.abstractSettings.abstractDeadline)
    : null;
  const deadlinePassed = deadline ? new Date() > deadline : false;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Banner */}
      {event.bannerImage && (
        <div className="w-full">
          <Image
            src={event.bannerImage}
            alt={event.name}
            width={1200}
            height={400}
            className="w-full h-48 md:h-64 object-cover"
            unoptimized
          />
        </div>
      )}

      {/* Header */}
      <div className="bg-gradient-primary text-white">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <p className="text-sm opacity-80 mb-2">{event.organization.name}</p>
          <h1 className="text-3xl font-bold mb-4">{event.name}</h1>
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span>{format(new Date(event.startDate), "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
            </div>
            {event.venue && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                <span>
                  {[event.venue, event.city, event.country].filter(Boolean).join(", ")}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 flex-1 w-full">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Submit Abstract
            </CardTitle>
            <CardDescription>
              Submit your abstract for review by the event committee
            </CardDescription>
            {deadline && !deadlinePassed && (
              <p className="text-sm text-amber-600 mt-2">
                Submission deadline: {format(deadline, "MMMM d, yyyy 'at' h:mm a")}
              </p>
            )}
          </CardHeader>
          <CardContent>
            {!submissionsOpen || deadlinePassed ? (
              <div className="text-center py-12">
                <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-lg font-medium mb-2">
                  {deadlinePassed
                    ? "Submission Deadline Has Passed"
                    : "Abstract Submissions Are Closed"}
                </p>
                <p className="text-muted-foreground">
                  {deadlinePassed
                    ? `The deadline was ${format(deadline!, "MMMM d, yyyy 'at' h:mm a")}.`
                    : "Abstract submissions are not currently open for this event."}
                </p>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  {/* Speaker Info */}
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">
                      Your Information
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="firstName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>First Name</FormLabel>
                            <FormControl>
                              <Input placeholder="John" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="lastName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Last Name</FormLabel>
                            <FormControl>
                              <Input placeholder="Doe" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input type="email" placeholder="john@example.com" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="company"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Organization (Optional)</FormLabel>
                            <FormControl>
                              <Input placeholder="Acme Inc." {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  {/* Abstract Details */}
                  <div className="border-t pt-6">
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">
                      Abstract Details
                    </h3>

                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Title</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter your abstract title" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <FormItem className="mt-3">
                          <FormLabel>Abstract</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Enter your abstract content..."
                              className="min-h-[200px]"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {event.tracks.length > 0 && (
                      <FormField
                        control={form.control}
                        name="trackId"
                        render={({ field }) => (
                          <FormItem className="mt-3">
                            <FormLabel>Track (Optional)</FormLabel>
                            <Select
                              onValueChange={field.onChange}
                              value={field.value}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select a track" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {event.tracks.map((track) => (
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
                  </div>

                  <Button
                    type="submit"
                    className="w-full btn-gradient"
                    disabled={submitting}
                  >
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {submitting ? "Submitting..." : "Submit Abstract"}
                  </Button>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
