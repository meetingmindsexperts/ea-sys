"use client";

import { Suspense, useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import {
  Calendar,
  MapPin,
  Clock,
  Loader2,
  Lock,
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

interface Event {
  id: string;
  name: string;
  slug: string;
  startDate: string;
  endDate: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  footerHtml: string | null;
  organization: { name: string; logo: string | null };
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
  };
}

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

type LoginFormData = z.infer<typeof loginSchema>;

function EventLoginForm() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const redirectParam = searchParams.get("redirect"); // "registration" | "abstracts" | null

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          setError("Event not found");
          return;
        }
        setEvent(await res.json());
      } catch (err) {
        console.error("[event-login] Failed to load event:", err);
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug]);

  async function onSubmit(data: LoginFormData) {
    setIsSubmitting(true);
    try {
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      });

      if (result?.error) {
        toast.error("Invalid email or password");
        setIsSubmitting(false);
        return;
      }

      toast.success("Welcome back!");
      // Route based on context: registration → my-registration, abstracts → events
      if (redirectParam === "registration") {
        router.push("/my-registration");
      } else if (redirectParam === "abstracts") {
        router.push("/events");
      } else {
        // Default: middleware will auto-redirect based on role
        router.push("/dashboard");
      }
      router.refresh();
    } catch {
      toast.error("Something went wrong. Please try again.");
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
      {/* Banner */}
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

      {/* Login Form */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm w-full max-w-md overflow-hidden">
          <div className="px-8 pt-8 pb-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Sign In</h2>
                <p className="text-sm text-slate-500">Access your registration, abstracts, or reviews</p>
              </div>
            </div>

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

                <FormField control={form.control} name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-slate-600">Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" className="text-base" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                <Button type="submit" className="w-full btn-gradient font-semibold h-11 text-base" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…</>
                  ) : (
                    "Sign In"
                  )}
                </Button>

                <div className="text-right">
                  <Link href="/forgot-password" className="text-sm text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>
              </form>
            </Form>
          </div>

          {/* Register links */}
          <div className="bg-slate-50 border-t border-slate-100 px-8 py-5 space-y-2">
            <p className="text-sm text-slate-500 text-center mb-3">Don&apos;t have an account?</p>
            <div className="flex gap-3">
              <Link href={`/e/${slug}/register`} className="flex-1">
                <Button variant="outline" className="w-full text-sm">
                  Register for Event
                </Button>
              </Link>
              {event.abstractSettings?.allowAbstractSubmissions && (
                <Link href={`/e/${slug}/abstract/register`} className="flex-1">
                  <Button variant="outline" className="w-full text-sm">
                    Submit Abstract
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      {event.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center px-4 py-6">
          <div className="prose prose-slate max-w-none mx-auto [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: event.footerHtml }} />
        </div>
      )}
    </div>
  );
}

export default function EventLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    }>
      <EventLoginForm />
    </Suspense>
  );
}
