"use client";

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
  Clock,
  Loader2,
  CheckCircle2,
  FileText,
  Lock,
  User,
  Building2,
  Phone,
  Globe,
  Stethoscope,
  ChevronRight,
  AlertCircle,
  ArrowLeft,
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
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  organization: {
    name: string;
    logo: string | null;
  };
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

const registerSchema = z
  .object({
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().min(1, "Last name is required"),
    email: z.string().email("Valid email is required"),
    organization: z.string().optional(),
    jobTitle: z.string().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    specialty: z.string().optional(),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type RegisterForm = z.infer<typeof registerSchema>;

export default function SubmitAbstractPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      organization: "",
      jobTitle: "",
      phone: "",
      city: "",
      country: "",
      specialty: "",
      password: "",
      confirmPassword: "",
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

        if (!data.abstractSettings?.allowAbstractSubmissions) {
          setError("Abstract submissions are not open for this event");
        }

        if (data.abstractSettings?.abstractDeadline) {
          const deadline = new Date(data.abstractSettings.abstractDeadline);
          if (new Date() > deadline) {
            setError("The abstract submission deadline has passed");
          }
        }
      } catch (err) {
        console.error("[submitAbstract] Failed to load event:", err);
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }

    if (slug) fetchEvent();
  }, [slug]);

  async function onSubmit(data: RegisterForm) {
    setSubmitting(true);

    try {
      const res = await fetch(`/api/public/events/${slug}/submitter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          password: data.password,
          organization: data.organization || undefined,
          jobTitle: data.jobTitle || undefined,
          phone: data.phone || undefined,
          city: data.city || undefined,
          country: data.country || undefined,
          specialty: data.specialty || undefined,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        toast.error(result.error || "Registration failed");
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error("[submitAbstract] Submission failed:", err);
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border-2 border-primary/20" />
            <Loader2 className="h-12 w-12 animate-spin text-primary absolute inset-0" />
          </div>
          <p className="text-slate-400 text-sm tracking-wide">Loading…</p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-amber-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            {error || "Event not found"}
          </h2>
          <p className="text-slate-500 text-sm mb-6">
            Please check the link or contact the event organizer.
          </p>
          {event && (
            <Link href={`/e/${slug}`}>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Event
              </Button>
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-dot-pattern opacity-5" />
        <div className="relative bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">
            Account Created!
          </h2>
          <p className="text-slate-500 text-sm leading-relaxed mb-2">
            Your speaker account has been created. Log in to submit your abstract for
          </p>
          <p className="font-semibold text-slate-800 mb-6">{event.name}</p>

          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6 border border-slate-100">
            <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2">
              Next Steps
            </p>
            <ol className="space-y-2">
              {["Log in with your email and password", "Find this event in your dashboard", "Submit your abstract for review"].map(
                (step, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                    <span className="shrink-0 h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold mt-0.5">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                )
              )}
            </ol>
          </div>

          <Link href={`/login?callbackUrl=${encodeURIComponent("/events")}`}>
            <Button className="btn-gradient w-full h-11 font-semibold rounded-xl gap-2">
              Log In to Continue
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Hero */}
      <div className="relative bg-slate-900 overflow-hidden">
        {event.bannerImage && (
          <>
            <Image
              src={event.bannerImage}
              alt={event.name}
              width={1400}
              height={500}
              className="w-full h-52 sm:h-64 object-contain object-center opacity-40"
              unoptimized
            />
            <div className="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/70 to-slate-900" />
          </>
        )}
        {!event.bannerImage && (
          <div className="absolute inset-0 opacity-5 bg-dot-pattern" />
        )}

        <div
          className={cn(
            "relative max-w-3xl mx-auto px-4 sm:px-6",
            event.bannerImage ? "py-8 -mt-8" : "py-12"
          )}
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-medium tracking-widest uppercase text-primary/80">
              {event.organization.name}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2 leading-tight">
            {event.name}
          </h1>
          <p className="text-primary/80 text-sm font-medium mb-6">
            Abstract Submission Portal
          </p>

          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
                <MapPin className="h-3.5 w-3.5 text-primary" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
            {event.abstractSettings?.abstractDeadline && (
              <div className="flex items-center gap-1.5 bg-amber-500/20 border border-amber-400/30 rounded-full px-3 py-1.5 text-sm text-amber-200">
                <FileText className="h-3.5 w-3.5" />
                <span>
                  Deadline:{" "}
                  {format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step indicator */}
      <div className="bg-white border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                <span className="text-xs font-bold text-white">1</span>
              </div>
              <span className="text-sm font-semibold text-slate-900">Create Account</span>
            </div>
            <ChevronRight className="h-4 w-4 text-slate-300" />
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-full border-2 border-slate-200 flex items-center justify-center">
                <span className="text-xs font-bold text-slate-400">2</span>
              </div>
              <span className="text-sm text-slate-400">Submit Abstract</span>
            </div>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 flex-1 w-full">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900">
              Create Your Speaker Account
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              You&apos;ll use this account to submit and manage your abstracts
            </p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              {/* Profile section */}
              <div className="p-6 space-y-4">
                <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                  Profile Information
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600">
                          First Name <span className="text-red-400">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="John"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
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
                        <FormLabel className="text-xs font-medium text-slate-600">
                          Last Name <span className="text-red-400">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Doe"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs font-medium text-slate-600">
                        Email Address <span className="text-red-400">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="john@university.edu"
                          className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="organization"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          Institution
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="University of..."
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="jobTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <User className="h-3 w-3" />
                          Position
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Professor, Researcher..."
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          Phone
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="+1 234 567 8900"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="specialty"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <Stethoscope className="h-3 w-3" />
                          Specialty
                        </FormLabel>
                        <SpecialtySelect
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          City
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="New York"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          Country
                        </FormLabel>
                        <CountrySelect
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Password section */}
              <div className="px-6 py-5 bg-slate-50 border-t border-slate-100 space-y-4">
                <div className="flex items-center gap-2 mb-1">
                  <Lock className="h-4 w-4 text-slate-400" />
                  <p className="text-xs font-semibold tracking-widest uppercase text-slate-400">
                    Account Security
                  </p>
                </div>
                <p className="text-xs text-slate-500 -mt-2">
                  Create a password to access your account and manage your submissions.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600">
                          Password <span className="text-red-400">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="Min. 6 characters"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30 bg-white"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-slate-600">
                          Confirm Password <span className="text-red-400">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="Repeat password"
                            className="rounded-lg border-slate-200 focus-visible:ring-primary/30 bg-white"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Submit */}
              <div className="px-6 py-5 border-t border-slate-100 space-y-3">
                <Button
                  type="submit"
                  className="w-full btn-gradient h-11 font-semibold text-sm rounded-xl shadow-sm hover:shadow-md transition-shadow"
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating Account…
                    </>
                  ) : (
                    <>
                      Create Account &amp; Continue
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </>
                  )}
                </Button>

                <p className="text-center text-xs text-slate-400">
                  Already have an account?{" "}
                  <Link
                    href={`/login?callbackUrl=${encodeURIComponent("/events")}`}
                    className="text-primary hover:underline font-medium"
                  >
                    Log in
                  </Link>
                </p>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
