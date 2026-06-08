"use client";

/**
 * Event-scoped Reset Password page.
 *
 *   /e/[slug]/reset-password?token=…&email=…
 *
 * Lands here from the reset email when the original forgot-password
 * request came from /e/[slug]/forgot-password (event-scoped). The
 * forgot-password API threads eventSlug into the email link so the
 * reset stays in event context end-to-end.
 *
 * Same form + token-validation logic as /(auth)/reset-password but
 * with:
 *   - event branding banner + info strip (mirrors /e/[slug]/login)
 *   - post-reset redirect to /e/[slug]/login (not generic /login)
 *   - "back to sign in" link points to event login
 *
 * If the token/email is invalid or the event is missing, we degrade
 * gracefully — the form shows an "invalid link" panel + a link back
 * to event login. We don't fall through to the generic page.
 */

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import {
  AlertCircle,
  Calendar,
  Clock,
  Loader2,
  Lock,
  MapPin,
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

const resetPasswordSchema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(6, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;

function EventResetPasswordInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const token = searchParams.get("token") ?? "";
  const email = searchParams.get("email") ?? "";

  const [event, setEvent] = useState<EventBranding | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [isLoadingEvent, setIsLoadingEvent] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [isLinkValid, setIsLinkValid] = useState(false);

  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  // Fetch event metadata for branding. If the event isn't found, we
  // still show the form (the token might be valid even on a deleted
  // event), but the surrounding chrome falls back to minimal.
  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          setEventError("Event not found");
          return;
        }
        const data = await res.json();
        setEvent(data);
      } catch (err) {
        console.error("event-reset-password:fetch-event-failed", err);
        setEventError("Failed to load event details");
      } finally {
        setIsLoadingEvent(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug]);

  // Validate the reset token against the API. Mirrors the generic
  // page's logic so we get the same error messages on bad/expired
  // tokens.
  useEffect(() => {
    async function validateToken() {
      if (!token || !email) {
        setIsLinkValid(false);
        setIsValidating(false);
        return;
      }
      try {
        const res = await fetch(
          `/api/auth/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`,
        );
        setIsLinkValid(res.ok);
      } catch (err) {
        console.error("event-reset-password:validate-token-failed", err);
        setIsLinkValid(false);
      } finally {
        setIsValidating(false);
      }
    }
    validateToken();
  }, [token, email]);

  async function onSubmit(data: ResetPasswordForm) {
    if (!token || !email) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          email,
          password: data.password,
          confirmPassword: data.confirmPassword,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Surface the API's error message + log so it appears in
        // browser console for debugging. Matches the "every failure
        // path must log" rule applied to the client side.
        console.warn("event-reset-password:request-failed", { status: response.status, error: payload?.error });
        toast.error(payload?.error || "Unable to reset password");
        return;
      }
      toast.success("Password reset successful. Please sign in.");
      // Event-scoped redirect — this is the critical behavioral
      // change vs the generic page.
      router.push(`/e/${slug}/login`);
    } catch (err) {
      console.error("event-reset-password:network-failed", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoadingEvent) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  if (eventError || !event) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{eventError || "Event not found"}</h2>
          <p className="text-slate-500 text-sm">
            <Link href={`/e/${slug}/login`} className="text-primary hover:underline">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* Banner — same pattern as /e/[slug]/login + forgot-password */}
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
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Clock className="h-3.5 w-3.5 text-primary/70" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
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
                <Lock className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Reset password</h2>
                <p className="text-sm text-slate-500">Choose a new password for your account.</p>
              </div>
            </div>

            {isValidating ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : !isLinkValid ? (
              <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-sm text-red-900">
                    This reset link is invalid or has expired. Reset links are valid for 1 hour.
                  </p>
                </div>
                <Link href={`/e/${slug}/forgot-password`}>
                  <Button variant="outline" className="w-full">Request a new link</Button>
                </Link>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField control={form.control} name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">New password</FormLabel>
                        <FormControl>
                          <Input type="password" placeholder="At least 6 characters" className="text-base" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  <FormField control={form.control} name="confirmPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">Confirm password</FormLabel>
                        <FormControl>
                          <Input type="password" placeholder="Re-enter password" className="text-base" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  <Button type="submit" className="w-full btn-gradient font-semibold h-11 text-base" disabled={isLoading}>
                    {isLoading ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Resetting…</>
                    ) : (
                      "Reset password"
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

export default function EventResetPasswordPage() {
  // Suspense wrapper because useSearchParams requires it under Next 16's
  // strict Suspense rules during streaming SSR. Falls back to a quick
  // spinner so the page doesn't blank-flash on initial load.
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      }
    >
      <EventResetPasswordInner />
    </Suspense>
  );
}
