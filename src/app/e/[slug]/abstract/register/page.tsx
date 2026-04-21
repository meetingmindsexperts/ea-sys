"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
  Clock,
  Loader2,
  CheckCircle2,
  FileText,
  Lock,
  ChevronRight,
  ChevronLeft,
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
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  footerHtml: string | null;
  abstractWelcomeHtml: string | null;
  organization: { name: string; logo: string | null };
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

const registerSchema = z.object({
  email: z.string().email("Valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
  title: z.string().min(1, "Title is required"),
  role: z.string().min(1, "Role is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  additionalEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
  organization: z.string().min(1, "Organization is required"),
  jobTitle: z.string().min(1, "Position is required"),
  phone: z.string().min(1, "Mobile number is required"),
  city: z.string().min(1, "City is required"),
  country: z.string().min(1, "Country is required"),
  specialty: z.string().min(1, "Specialty is required"),
  customSpecialty: z.string().optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

type RegisterForm = z.infer<typeof registerSchema>;

export default function AbstractRegisterPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [emailCheck, setEmailCheck] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "conflict"; reason: "already_registered" }
  >({ state: "idle" });

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email: "", password: "", confirmPassword: "",
      title: "", role: "", firstName: "", lastName: "",
      additionalEmail: "", organization: "", jobTitle: "",
      phone: "", city: "", country: "",
      specialty: "", customSpecialty: "",
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
        console.error("[abstract/register] Failed to load event:", err);
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
          title: data.title || undefined,
          role: data.role || undefined,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          additionalEmail: data.additionalEmail || undefined,
          password: data.password,
          organization: data.organization || undefined,
          jobTitle: data.jobTitle || undefined,
          phone: data.phone || undefined,
          city: data.city || undefined,
          country: data.country || undefined,
          specialty: data.specialty || undefined,
          customSpecialty: data.customSpecialty || undefined,
        }),
      });

      let result;
      try {
        result = await res.json();
      } catch {
        console.error("[abstract/register] Non-JSON response:", res.status);
        toast.error("Server error. Please try again.");
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        console.warn("[abstract/register] Registration rejected:", res.status, result.error);
        toast.error(result.error || "Registration failed");
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error("[abstract/register] Submission failed:", err);
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-10 w-10 rounded-full border-2 border-primary/20" />
            <Loader2 className="h-10 w-10 animate-spin text-primary absolute inset-0" />
          </div>
          <p className="text-slate-400 text-base">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
          <p className="text-slate-500 text-base">Please check the link or contact the event organizer.</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Account Created!</h2>
          <p className="text-slate-500 text-base leading-relaxed mb-2">
            Your speaker account has been created. Log in to submit your abstract for
          </p>
          <p className="font-semibold text-slate-800 mb-6">{event.name}</p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6 border border-slate-100">
            <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2">Next Steps</p>
            <ol className="space-y-2">
              {["Log in with your email and password", "Find this event in your dashboard", "Submit your abstract for review"].map(
                (s, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-base text-slate-600">
                    <span className="shrink-0 h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold mt-0.5">
                      {i + 1}
                    </span>
                    {s}
                  </li>
                )
              )}
            </ol>
          </div>
          <Link href={`/e/${slug}/login?redirect=abstracts`}>
            <Button className="btn-gradient w-full h-11 font-semibold rounded-xl gap-2 text-base">
              Log In to Continue <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb] text-base">
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
            <div className="flex items-center gap-1.5 text-base text-slate-500">
              <Calendar className="h-4 w-4 text-primary/70" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-1.5 text-base text-slate-500">
              <Clock className="h-4 w-4 text-primary/70" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 text-base text-slate-500">
                <MapPin className="h-4 w-4 text-primary/70" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
            {event.abstractSettings?.abstractDeadline && (
              <div className="flex items-center gap-1.5 text-base text-amber-600 font-medium">
                <FileText className="h-4 w-4" />
                <span>Deadline: {format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">Abstract Submission — Speaker Registration</h2>
            <p className="text-base text-slate-500 mt-1">
              {step === 1 ? "Create your account to get started." : "Fill in your details to complete registration."}
            </p>
            <div className="flex items-center gap-2 mt-4">
              <div className={cn("h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold",
                step === 1 ? "bg-primary/10 text-primary border-2 border-primary" : "bg-primary text-white"
              )}>{step > 1 ? "✓" : "1"}</div>
              <span className={cn("text-sm font-medium", step === 1 ? "text-slate-800" : "text-primary")}>Account</span>
              <div className={cn("h-px w-8", step > 1 ? "bg-primary" : "bg-slate-200")} />
              <div className={cn("h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold",
                step === 2 ? "bg-primary/10 text-primary border-2 border-primary" : "bg-slate-100 text-slate-400"
              )}>2</div>
              <span className={cn("text-sm font-medium", step === 2 ? "text-slate-800" : "text-slate-400")}>Details</span>
            </div>
          </div>

          <div className="p-6 sm:px-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

                {/* ── STEP 1: Account ── */}
                {step === 1 && (
                  <div className="space-y-5">
                    {/* Welcome text — full width */}
                    {event.abstractWelcomeHtml && (
                      <div className="prose prose-slate max-w-none [&>*]:mb-4 [&>*:last-child]:mb-0"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.abstractWelcomeHtml) }} />
                    )}

                    {/* Account form — narrower centered */}
                    <div className="max-w-md mx-auto space-y-5 pt-4">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Lock className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-slate-800">Create your speaker account</h3>
                        <p className="text-sm text-slate-500">You&apos;ll use these credentials to sign in and submit your abstract.</p>
                      </div>
                    </div>

                    <FormField control={form.control} name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Email Address <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input type="email" placeholder="john@university.edu" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                    <FormField control={form.control} name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Password <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input type="password" placeholder="Min. 6 characters" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                    <FormField control={form.control} name="confirmPassword"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Confirm Password <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input type="password" placeholder="Re-enter password" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                    {emailCheck.state === "conflict" && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                        You&apos;ve already signed up as a submitter for this event.{" "}
                        <a
                          href={`/e/${slug}/login?redirect=abstracts&email=${encodeURIComponent(form.getValues("email"))}`}
                          className="underline font-medium"
                        >
                          Sign in instead
                        </a>
                        .
                      </div>
                    )}

                    <Button type="button" className="w-full rounded-lg font-semibold btn-gradient py-3 text-base"
                      disabled={emailCheck.state === "checking"}
                      onClick={async () => {
                        const valid = await form.trigger(["email", "password", "confirmPassword"]);
                        if (!valid) return;
                        setEmailCheck({ state: "checking" });
                        try {
                          const res = await fetch(`/api/public/events/${slug}/check-email`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ email: form.getValues("email") }),
                          });
                          if (res.ok) {
                            const data = await res.json();
                            if (data.exists && data.reason === "already_registered") {
                              setEmailCheck({ state: "conflict", reason: "already_registered" });
                              return;
                            }
                          }
                        } catch (err) {
                          console.warn("[abstract/register] check-email failed, continuing", err);
                        }
                        setEmailCheck({ state: "idle" });
                        setStep(2);
                      }}>
                      {emailCheck.state === "checking" ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking…</>
                      ) : (
                        <>Continue <ChevronRight className="ml-1 h-5 w-5" /></>
                      )}
                    </Button>

                    <p className="text-center text-sm text-slate-400">
                      Already have an account?{" "}
                      <a href={`/e/${slug}/login?redirect=abstracts`} className="text-primary hover:underline font-medium">Sign in</a>
                    </p>
                    </div>
                  </div>
                )}

                {/* ── STEP 2: Contact Details ── */}
                {step === 2 && (
                  <>
                    <div className="space-y-5">
                      <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Contact Details</h3>

                      <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                        <FormField control={form.control} name="title"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Title <span className="text-red-400">*</span></FormLabel>
                              <TitleSelect value={field.value} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">First Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="John" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Last Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="Doe" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="jobTitle"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Position <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="Professor, Researcher..." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="organization"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Organization <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="University of..." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="phone"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Mobile Number <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="+1 234 567 8900" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="additionalEmail"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Additional Email</FormLabel>
                              <FormControl><Input type="email" placeholder="alternate@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="country"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Country <span className="text-red-400">*</span></FormLabel>
                              <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">City <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="Dubai" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="specialty"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Specialty <span className="text-red-400">*</span></FormLabel>
                              <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="role"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Role <span className="text-red-400">*</span></FormLabel>
                              <RoleSelect value={field.value} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <FormField control={form.control} name="customSpecialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Specialty (Specific)</FormLabel>
                            <FormControl><Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>

                    {/* Navigation */}
                    <div className="flex items-center justify-between pt-2">
                      <Button type="button" variant="outline" className="rounded-lg text-base" onClick={() => setStep(1)}>
                        <ChevronLeft className="mr-1 h-4 w-4" /> Back
                      </Button>
                      <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 py-3 text-base">
                        {submitting ? (
                          <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Creating Account…</>
                        ) : (
                          <>Create Account <ChevronRight className="ml-1 h-5 w-5" /></>
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </form>
            </Form>
          </div>
        </div>
      </div>

      {/* Footer */}
      {event.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center px-4 py-6">
          <div className="prose prose-slate max-w-none mx-auto [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
        </div>
      )}
    </div>
  );
}
