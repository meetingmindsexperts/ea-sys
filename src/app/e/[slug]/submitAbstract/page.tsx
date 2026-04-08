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
  ChevronLeft,
  AlertCircle,
  ArrowLeft,
  Check,
  Mail,
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
  organization: { name: string; logo: string | null };
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

const STEPS = [
  { id: "identity", label: "Identity" },
  { id: "details", label: "Details" },
  { id: "security", label: "Account" },
] as const;

const STEP_FIELDS: Record<string, (keyof RegisterForm)[]> = {
  identity: ["firstName", "lastName", "email"],
  details: [],
  security: ["password", "confirmPassword"],
};

export default function SubmitAbstractPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "",
      organization: "", jobTitle: "", phone: "",
      city: "", country: "", specialty: "",
      password: "", confirmPassword: "",
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

  const isLastStep = step === STEPS.length - 1;

  async function handleNext() {
    const currentStepId = STEPS[step].id;
    const fieldsToValidate = STEP_FIELDS[currentStepId] || [];
    if (fieldsToValidate.length > 0) {
      const isValid = await form.trigger(fieldsToValidate);
      if (!isValid) return;
    }
    if (isLastStep) {
      form.handleSubmit(onSubmit)();
    } else {
      setStep((s) => s + 1);
    }
  }

  function handleBack() {
    if (step > 0) setStep((s) => s - 1);
  }

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

      let result;
      try {
        result = await res.json();
      } catch {
        console.error("[submitAbstract] Non-JSON response:", res.status);
        toast.error("Server error. Please try again.");
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        console.warn("[submitAbstract] Registration rejected:", res.status, result.error);
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
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
          <p className="text-slate-500 text-sm mb-6">Please check the link or contact the event organizer.</p>
          {event && (
            <Link href={`/e/${slug}`}>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Event
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
        <div className="relative bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Account Created!</h2>
          <p className="text-slate-500 text-sm leading-relaxed mb-2">
            Your speaker account has been created. Log in to submit your abstract for
          </p>
          <p className="font-semibold text-slate-800 mb-6">{event.name}</p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6 border border-slate-100">
            <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2">Next Steps</p>
            <ol className="space-y-2">
              {["Log in with your email and password", "Find this event in your dashboard", "Submit your abstract for review"].map(
                (s, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
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
            <Button className="btn-gradient w-full h-11 font-semibold rounded-xl gap-2">
              Log In to Continue <ChevronRight className="h-4 w-4" />
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
            <Image src={event.bannerImage} alt={event.name} width={1400} height={500}
              className="w-full h-48 sm:h-56 object-contain object-center opacity-40" unoptimized />
            <div className="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/70 to-slate-900" />
          </>
        )}
        <div className={cn("relative max-w-5xl mx-auto px-4 sm:px-6", event.bannerImage ? "py-6 -mt-6" : "py-10")}>
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1 leading-tight">{event.name}</h1>
          <p className="text-primary/80 text-sm font-medium mb-4">Abstract Submission Portal</p>
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1 text-xs text-white/90">
              <Calendar className="h-3 w-3 text-primary" />
              {format(new Date(event.startDate), "MMM d, yyyy")}
            </div>
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1 text-xs text-white/90">
              <Clock className="h-3 w-3 text-primary" />
              {format(new Date(event.startDate), "h:mm a")}
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1 text-xs text-white/90">
                <MapPin className="h-3 w-3 text-primary" />
                {locationParts.join(", ")}
              </div>
            )}
            {event.abstractSettings?.abstractDeadline && (
              <div className="flex items-center gap-1.5 bg-amber-500/20 border border-amber-400/30 rounded-full px-3 py-1 text-xs text-amber-200">
                <FileText className="h-3 w-3" />
                Deadline: {format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          {/* Header + step indicator */}
          <div className="px-6 py-5 border-b border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900">Create Your Speaker Account</h2>
            <p className="text-sm text-slate-500 mt-0.5">Step {step + 1} of {STEPS.length}</p>
            <div className="flex items-center gap-2 mt-4">
              {STEPS.map((s, i) => {
                const isCurrent = i === step;
                const isCompleted = i < step;
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    {i > 0 && <div className={cn("h-px w-6 sm:w-10", isCompleted ? "bg-primary" : "bg-slate-200")} />}
                    <div className="flex items-center gap-1.5">
                      <div className={cn(
                        "h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors",
                        isCompleted ? "bg-primary text-white" :
                        isCurrent ? "bg-primary/10 text-primary border-2 border-primary" :
                        "bg-slate-100 text-slate-400"
                      )}>
                        {isCompleted ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </div>
                      <span className={cn(
                        "text-xs font-medium hidden sm:inline",
                        isCurrent ? "text-slate-800" : isCompleted ? "text-primary" : "text-slate-400"
                      )}>{s.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <Form {...form}>
            <form onSubmit={(e) => { e.preventDefault(); handleNext(); }}>
              <div className="p-6 space-y-4">

                {/* Step 1: Identity */}
                {STEPS[step].id === "identity" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="firstName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600">
                              First Name <span className="text-red-400">*</span>
                            </FormLabel>
                            <FormControl><Input placeholder="John" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="lastName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600">
                              Last Name <span className="text-red-400">*</span>
                            </FormLabel>
                            <FormControl><Input placeholder="Doe" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                    <FormField control={form.control} name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                            <Mail className="h-3 w-3" /> Email <span className="text-red-400">*</span>
                          </FormLabel>
                          <FormControl><Input type="email" placeholder="john@university.edu" className="rounded-lg border-slate-200" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </>
                )}

                {/* Step 2: Professional Details */}
                {STEPS[step].id === "details" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="organization"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                              <Building2 className="h-3 w-3" /> Institution
                            </FormLabel>
                            <FormControl><Input placeholder="University of..." className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="jobTitle"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                              <User className="h-3 w-3" /> Position
                            </FormLabel>
                            <FormControl><Input placeholder="Professor, Researcher..." className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                    <FormField control={form.control} name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                            <Phone className="h-3 w-3" /> Phone
                          </FormLabel>
                          <FormControl><Input placeholder="+1 234 567 8900" className="rounded-lg border-slate-200" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="specialty"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                            <Stethoscope className="h-3 w-3" /> Specialty
                          </FormLabel>
                          <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                          <FormMessage />
                        </FormItem>
                      )} />
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="city"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> City
                            </FormLabel>
                            <FormControl><Input placeholder="New York" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="country"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                              <Globe className="h-3 w-3" /> Country
                            </FormLabel>
                            <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                  </>
                )}

                {/* Step 3: Account Security */}
                {STEPS[step].id === "security" && (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <Lock className="h-4 w-4 text-slate-400" />
                      <p className="text-xs font-semibold tracking-widest uppercase text-slate-400">
                        Account Security
                      </p>
                    </div>
                    <p className="text-xs text-slate-500">
                      Create a password to access your account and manage your submissions.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600">
                              Password <span className="text-red-400">*</span>
                            </FormLabel>
                            <FormControl><Input type="password" placeholder="Min. 6 characters" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600">
                              Confirm Password <span className="text-red-400">*</span>
                            </FormLabel>
                            <FormControl><Input type="password" placeholder="Repeat password" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>

                    {/* Summary */}
                    <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 mt-2">
                      <p className="text-xs font-medium text-slate-500 mb-1">Registering as</p>
                      <p className="text-sm font-semibold text-slate-800">
                        {form.getValues("firstName")} {form.getValues("lastName")}
                      </p>
                      <p className="text-xs text-slate-500">{form.getValues("email")}</p>
                    </div>
                  </>
                )}
              </div>

              {/* Navigation */}
              <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
                {step > 0 ? (
                  <Button type="button" variant="outline" onClick={handleBack} className="rounded-lg">
                    <ChevronLeft className="mr-1 h-4 w-4" /> Back
                  </Button>
                ) : (
                  <div />
                )}
                <Button type="submit" disabled={submitting}
                  className={cn("rounded-lg font-semibold", isLastStep ? "btn-gradient px-8" : "px-6")}>
                  {submitting ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating Account…</>
                  ) : isLastStep ? (
                    <>Create Account <ChevronRight className="ml-1 h-4 w-4" /></>
                  ) : (
                    <>Continue <ChevronRight className="ml-1 h-4 w-4" /></>
                  )}
                </Button>
              </div>

              <div className="px-6 pb-5 text-center">
                <p className="text-xs text-slate-400">
                  Already have an account?{" "}
                  <Link href={`/e/${slug}/login?redirect=abstracts`}
                    className="text-primary hover:underline font-medium">Log in</Link>
                </p>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
