"use client";

/**
 * Event-scoped Forgot Password page.
 *
 *   /e/[slug]/forgot-password
 *
 * Why this exists separately from /(auth)/forgot-password:
 * registrants who reach login via the event-specific URL
 * (/e/[slug]/login) expect to STAY in event-scoped context as they
 * navigate to forgot-password and back. The generic page exists for
 * org-team auth (admins, organizers); this one keeps event branding +
 * sends a reset email whose link returns to /e/[slug]/reset-password
 * (event-scoped reset, post-reset redirects to /e/[slug]/login).
 *
 * Mirrors the visual structure of /e/[slug]/login: banner image,
 * event info strip, centered card with the form. Same fetch path
 * (/api/public/events/${slug}) for the event metadata + same loading
 * + error states.
 *
 * Key difference from the generic page: the form POSTs to the same
 * /api/auth/forgot-password endpoint but includes `eventSlug` in the
 * body — the API uses that to construct the reset link with
 * /e/[slug]/reset-password instead of the generic /reset-password
 * path, so the entire flow stays event-bound from request to reset.
 */

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import {
  Calendar,
  MapPin,
  Loader2,
  KeyRound,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface EventBranding {
  id: string;
  name: string;
  slug: string;
  startDate: string;
  endDate: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  organization: { name: string; logo: string | null };
}

const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email"),
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

export default function EventForgotPasswordPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [event, setEvent] = useState<EventBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const form = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  // Fetch event for branding. Same endpoint the login page hits — if
  // the event is unpublished/deleted/wrong slug, we show the same
  // "event not found" panel rather than letting the user enter their
  // email into a page for an event that doesn't exist.
  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          setError("Event not found");
          return;
        }
        const data = await res.json();
        setEvent(data);
      } catch (err) {
        console.error("event-forgot-password:fetch-event-failed", err);
        setError("Failed to load event details");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug]);

  async function onSubmit(data: ForgotPasswordFormData) {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // eventSlug threads through to the API so the reset link in
        // the email points at /e/[slug]/reset-password, not the
        // generic /reset-password. Backend-compatible: omitting the
        // field keeps the original generic-link behavior for the
        // /(auth)/forgot-password call path.
        body: JSON.stringify({ ...data, eventSlug: slug }),
      });
      if (!res.ok) {
        // The API uses non-enumerating responses (always 200 on
        // valid email), so a non-OK here is a real server error.
        // Log it explicitly so it surfaces in /logs even on the
        // client side.
        console.warn("event-forgot-password:request-failed", { status: res.status });
        toast.error("Unable to process request. Please try again.");
        return;
      }
      toast.success("If an account exists, we sent a reset link to that email.");
      setEmailSent(true);
      form.reset();
    } catch (err) {
      console.error("event-forgot-password:network-failed", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
          <p className="text-slate-500 text-sm">Please check the link and try again.</p>
        </div>
      </div>
    );
  }

  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* Banner — same pattern as /e/[slug]/login */}
      {event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="max-w-[1400px] mx-auto">
            <Image src={event.bannerImage} alt={event.name} width={1400} height={400}
              className="w-full h-auto max-h-[240px] object-contain" priority unoptimized />
          </div>
        </div>
      ) : (
        <div className="bg-white border-b border-slate-100">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}

      {/* Event Info Strip */}
      <div className="bg-white border-b border-slate-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
            <h2 className="text-base font-semibold text-slate-800 mr-auto">{event.name}</h2>
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Calendar className="h-3.5 w-3.5 text-primary/70" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-slate-500">
                <MapPin className="h-3.5 w-3.5 text-primary/70" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Form Card */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm w-full max-w-md overflow-hidden">
          <div className="px-8 pt-8 pb-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Forgot password?</h2>
                <p className="text-sm text-slate-500">We&apos;ll email you a reset link.</p>
              </div>
            </div>

            {emailSent ? (
              <div className="space-y-4">
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
                  <p className="text-sm text-emerald-900">
                    If an account exists with that email, we&apos;ve sent a reset link.
                    The link expires in 1 hour.
                  </p>
                </div>
                <p className="text-sm text-slate-600">
                  Didn&apos;t receive it? Check your spam folder, or{" "}
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setEmailSent(false)}
                  >
                    try again
                  </button>
                  .
                </p>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField control={form.control} name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">Email</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="you@example.com" className="text-base" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                  <Button type="submit" className="w-full btn-gradient font-semibold h-11 text-base" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…</>
                    ) : (
                      "Send reset link"
                    )}
                  </Button>
                </form>
              </Form>
            )}
          </div>

          <div className="bg-slate-50 border-t border-slate-100 px-8 py-6 mt-2">
            <p className="text-sm text-slate-500 text-center">
              Remember your password?{" "}
              <Link href={`/e/${slug}/login`} className="text-primary hover:underline font-medium">
                Back to sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
