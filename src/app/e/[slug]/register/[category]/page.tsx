"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import Link from "next/link";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
  Clock,
  Loader2,
  FileText,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  Lock,
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
import { Checkbox } from "@/components/ui/checkbox";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DEFAULT_REGISTRATION_TERMS_HTML } from "@/lib/default-terms";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface PricingTierData {
  id: string;
  name: string;
  price: string;
  currency: string;
  quantity: number;
  soldCount: number;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  salesStarted: boolean;
  salesEnded: boolean;
}

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  category: string;
  price: string;
  currency: string;
  quantity: number;
  soldCount: number;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  salesStarted: boolean;
  salesEnded: boolean;
  pricingTiers?: PricingTierData[];
}

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
  footerHtml: string | null;
  supportEmail: string | null;
  registrationTermsHtml: string | null;
  registrationWelcomeHtml: string | null;
  organization: { name: string; logo: string | null };
  ticketTypes: TicketType[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

/** A registration type option within the matched tier */
interface RegTypeOption {
  ticketTypeId: string;
  pricingTierId: string;
  regTypeName: string;
  description: string | null;
  price: number;
  currency: string;
  available: number;
  canPurchase: boolean;
}

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1, "Please select a category"),
  pricingTierId: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  role: z.string().min(1, "Role is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  additionalEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().min(1, "Country is required"),
  specialty: z.string().min(1, "Specialty is required"),
  customSpecialty: z.string().optional(),
  dietaryReqs: z.string().optional(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
  agreeTerms: z.literal(true, { message: "You must agree to the terms and conditions" }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type RegistrationForm = z.infer<typeof registrationSchema>;

export default function CategoryRegistrationPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const categorySlug = params.category as string;

  const searchParams = useSearchParams();

  const [event, setEvent] = useState<Event | null>(null);
  const [formLabel, setFormLabel] = useState<string | null>(null);
  const [regTypeOptions, setRegTypeOptions] = useState<RegTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  // Capture referral tracking on first load
  const trackingRef = useRef({
    referrer: typeof document !== "undefined" ? document.referrer || null : null,
    utmSource: null as string | null,
    utmMedium: null as string | null,
    utmCampaign: null as string | null,
  });

  useEffect(() => {
    trackingRef.current.utmSource = searchParams.get("utm_source");
    trackingRef.current.utmMedium = searchParams.get("utm_medium");
    trackingRef.current.utmCampaign = searchParams.get("utm_campaign");
  }, [searchParams]);

  const form = useForm<RegistrationForm>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      ticketTypeId: "", pricingTierId: "", title: "", role: "",
      firstName: "", lastName: "", email: "", additionalEmail: "",
      organization: "", jobTitle: "", phone: "", city: "",
      country: "", specialty: "", customSpecialty: "", dietaryReqs: "",
      password: "", confirmPassword: "",
      agreeTerms: undefined as unknown as true,
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
        const data: Event = await res.json();
        setEvent(data);

        const hasPricingTiers = data.ticketTypes.some((tt) => tt.pricingTiers && tt.pricingTiers.length > 0);

        if (hasPricingTiers) {
          const options: RegTypeOption[] = [];
          for (const tt of data.ticketTypes) {
            const tier = tt.pricingTiers?.find((t) => toSlug(t.name) === categorySlug);
            if (tier) {
              options.push({
                ticketTypeId: tt.id,
                pricingTierId: tier.id,
                regTypeName: tt.name,
                description: tt.description,
                price: Number(tier.price),
                currency: tier.currency,
                available: tier.available,
                canPurchase: tier.canPurchase,
              });
            }
          }

          if (options.length === 0) {
            setError("Invalid registration form");
            return;
          }

          const tierName = data.ticketTypes
            .flatMap((tt) => tt.pricingTiers ?? [])
            .find((t) => toSlug(t.name) === categorySlug)?.name ?? categorySlug;

          setFormLabel(tierName);
          setRegTypeOptions(options);

          // Auto-select if only one purchasable
          const purchasable = options.filter((o) => o.canPurchase);
          if (purchasable.length === 1) {
            form.setValue("ticketTypeId", purchasable[0].ticketTypeId);
            form.setValue("pricingTierId", purchasable[0].pricingTierId);
          }
        } else {
          // Legacy flow
          const matchedCategory = data.ticketTypes.find(
            (t) => toSlug(t.category || "Standard") === categorySlug
          )?.category;

          if (!matchedCategory) {
            setError("Invalid registration form");
            return;
          }

          setFormLabel(matchedCategory);

          const options: RegTypeOption[] = data.ticketTypes
            .filter((t) => (t.category || "Standard") === matchedCategory)
            .map((t) => ({
              ticketTypeId: t.id,
              pricingTierId: "",
              regTypeName: t.name,
              description: t.description,
              price: Number(t.price),
              currency: t.currency,
              available: t.available,
              canPurchase: t.canPurchase,
            }));

          setRegTypeOptions(options);

          const purchasable = options.filter((o) => o.canPurchase);
          if (purchasable.length === 1) {
            form.setValue("ticketTypeId", purchasable[0].ticketTypeId);
          }
        }
      } catch (err) {
        console.error("[register] Failed to load event:", err);
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug, categorySlug, form]);

  async function onSubmit(data: RegistrationForm) {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          referrer: trackingRef.current.referrer || undefined,
          utmSource: trackingRef.current.utmSource || undefined,
          utmMedium: trackingRef.current.utmMedium || undefined,
          utmCampaign: trackingRef.current.utmCampaign || undefined,
        }),
      });
      let result;
      try {
        result = await res.json();
      } catch {
        console.error("[register] Non-JSON response from API:", res.status, res.statusText);
        toast.error("Server error. Please try again.");
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        console.warn("[register] Registration rejected:", res.status, result.error);
        toast.error(result.error || "Registration failed");
        setSubmitting(false);
        return;
      }
      const reg = result.registration;
      const confirmParams = new URLSearchParams({
        id: reg.id,
        name: data.firstName,
        ...(reg.ticketPrice > 0 ? { price: String(reg.ticketPrice), currency: reg.ticketCurrency } : {}),
      });
      router.push(`/e/${slug}/confirmation?${confirmParams.toString()}`);
    } catch (err) {
      console.error("[register] Registration submission failed:", err);
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-10 w-10 rounded-full border-2 border-primary/20" />
            <Loader2 className="h-10 w-10 animate-spin text-primary absolute inset-0" />
          </div>
          <p className="text-slate-400 text-sm">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !event || !formLabel) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Registration not available"}</h2>
          <p className="text-slate-500 text-sm mb-4">Please check the link and try again.</p>
          <Link href={`/e/${slug}/register`} className="text-primary text-sm font-medium hover:underline">
            View all registration forms
          </Link>
        </div>
      </div>
    );
  }

  const purchasableOptions = regTypeOptions.filter((o) => o.canPurchase);
  const selectedTicketId = form.watch("ticketTypeId");
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);
  const isClosed = purchasableOptions.length === 0;

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
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
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

      {/* Main Content */}
      <div className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 py-5 border-b border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900">{formLabel} Registration</h2>
            <p className="text-sm text-slate-500 mt-1">
              {step === 1 ? "Create your account to get started." : "Fill in the details below to complete your registration."}
            </p>
            {/* Step indicator */}
            <div className="flex items-center gap-2 mt-3">
              <div className={cn("h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold",
                step === 1 ? "bg-primary/10 text-primary border-2 border-primary" : "bg-primary text-white"
              )}>{step > 1 ? "✓" : "1"}</div>
              <span className={cn("text-xs font-medium", step === 1 ? "text-slate-800" : "text-primary")}>Account</span>
              <div className={cn("h-px w-8", step > 1 ? "bg-primary" : "bg-slate-200")} />
              <div className={cn("h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold",
                step === 2 ? "bg-primary/10 text-primary border-2 border-primary" : "bg-slate-100 text-slate-400"
              )}>2</div>
              <span className={cn("text-xs font-medium", step === 2 ? "text-slate-800" : "text-slate-400")}>Details</span>
            </div>
          </div>

          <div className="p-6">
            {isClosed ? (
              <div className="text-center py-12">
                <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-50 flex items-center justify-center">
                  <AlertCircle className="h-7 w-7 text-slate-400" />
                </div>
                <p className="font-medium text-slate-700">{formLabel} registration is currently closed</p>
                <p className="text-sm text-slate-400 mt-1">Check back later or contact the organizer.</p>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

                  {/* ── STEP 1: Create Account ── */}
                  {step === 1 && (
                    <div className="space-y-5">
                      {/* Welcome text from organizer */}
                      {event.registrationWelcomeHtml && (
                        <div className="prose prose-sm prose-slate max-w-none"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.registrationWelcomeHtml) }} />
                      )}

                      <div className="flex items-center gap-3 mb-2">
                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <Lock className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-slate-800">Create your account</h3>
                          <p className="text-xs text-slate-500">You&apos;ll use these credentials to sign in, manage your registration, and make payments.</p>
                        </div>
                      </div>

                      <FormField control={form.control} name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Email Address <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input type="email" placeholder="john@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
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

                      <Button type="button" className="w-full rounded-lg font-semibold btn-gradient py-3 text-base"
                        onClick={async () => {
                          const valid = await form.trigger(["email", "password", "confirmPassword"]);
                          if (valid) setStep(2);
                        }}>
                        Continue <ChevronRight className="ml-1 h-5 w-5" />
                      </Button>

                      <p className="text-center text-xs text-slate-400">
                        Already have an account?{" "}
                        <a href={`/login?callbackUrl=${encodeURIComponent(`/my-registration`)}`} className="text-primary hover:underline font-medium">Sign in</a>
                      </p>
                    </div>
                  )}

                  {/* ── STEP 2: Personal Details + Category + Terms ── */}
                  {step === 2 && (
                  <>
                  {/* Section: Contact Details */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider border-b border-slate-100 pb-2">Contact Details</h3>

                    <div className="grid grid-cols-[100px_1fr_1fr] gap-3">
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

                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="jobTitle"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Position</FormLabel>
                            <FormControl><Input placeholder="Physician" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="organization"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Organization</FormLabel>
                            <FormControl><Input placeholder="Acme Inc." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>

                    <FormField control={form.control} name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Mobile Number</FormLabel>
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

                    <div className="grid grid-cols-2 gap-3">
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
                            <FormLabel className="text-sm font-medium text-slate-600">City</FormLabel>
                            <FormControl><Input placeholder="Dubai" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
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

                    <FormField control={form.control} name="dietaryReqs"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Dietary Requirements</FormLabel>
                          <FormControl><Input placeholder="e.g. Vegetarian, Halal" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  {/* Section: Select Your Category */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider border-b border-slate-100 pb-2">Select Your Category</h3>
                    <p className="text-xs text-slate-500">You will have the option to pay now or you can select to pay at a later stage.</p>

                    <FormField control={form.control} name="ticketTypeId"
                      render={({ field }) => (
                        <FormItem>
                          <div className="space-y-3">
                            {purchasableOptions.map((opt) => {
                              const isSelected = field.value === opt.ticketTypeId;
                              return (
                                <button key={opt.ticketTypeId} type="button"
                                  onClick={() => {
                                    field.onChange(opt.ticketTypeId);
                                    if (opt.pricingTierId) {
                                      form.setValue("pricingTierId", opt.pricingTierId);
                                    }
                                  }}
                                  className={cn(
                                    "w-full text-left rounded-xl border-2 p-4 transition-all duration-150",
                                    isSelected
                                      ? "border-primary bg-primary/[0.03] shadow-sm"
                                      : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
                                  )}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <div className={cn(
                                        "h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all shrink-0",
                                        isSelected ? "border-primary bg-primary" : "border-slate-300"
                                      )}>
                                        {isSelected && <div className="h-2 w-2 rounded-full bg-white" />}
                                      </div>
                                      <div>
                                        <p className="font-semibold text-slate-900">{opt.regTypeName}</p>
                                        {opt.description && (
                                          <div className="text-xs text-slate-500 mt-0.5" dangerouslySetInnerHTML={{ __html: sanitizeHtml(opt.description) }} />
                                        )}
                                      </div>
                                    </div>
                                    <div className="text-right shrink-0 ml-4">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Amount</div>
                                      <div className={cn("text-lg font-bold", isSelected ? "text-primary" : "text-slate-800")}>
                                        {opt.price === 0 ? "Free" : `${opt.currency} ${opt.price.toFixed(2)}`}
                                      </div>
                                    </div>
                                  </div>
                                  {opt.available <= 0 && (
                                    <p className="text-xs text-red-500 mt-1 ml-8">Sold out</p>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          <FormMessage className="mt-2" />
                        </FormItem>
                      )}
                    />

                    {selectedTicketId && (
                      <p className="text-xs text-slate-500 italic">
                        Your professional ID may be required at the time of check-in. Always carry your ID to avoid inconvenience.
                      </p>
                    )}
                  </div>

                  {/* Section: Terms & Conditions */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider border-b border-slate-100 pb-2">Terms and Conditions</h3>
                    <div className="max-h-[300px] overflow-y-auto bg-slate-50 rounded-lg border border-slate-200 p-4">
                      <div className="prose prose-sm prose-slate max-w-none text-xs leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.registrationTermsHtml || DEFAULT_REGISTRATION_TERMS_HTML) }} />
                    </div>

                    <FormField control={form.control} name="agreeTerms"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={field.value === true}
                              onCheckedChange={(checked) => field.onChange(checked === true ? true : undefined)}
                              className="mt-0.5"
                            />
                            <FormLabel className="text-sm text-slate-700 font-normal cursor-pointer leading-snug">
                              I agree to the terms and conditions
                            </FormLabel>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  {/* Navigation */}
                  <div className="flex items-center justify-between pt-2">
                    <Button type="button" variant="outline" className="rounded-lg" onClick={() => setStep(1)}>
                      <ChevronLeft className="mr-1 h-4 w-4" /> Back
                    </Button>
                    <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 py-3 text-base">
                      {submitting ? (
                        <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Registering…</>
                      ) : (
                        <>Complete Registration <ChevronRight className="ml-1 h-5 w-5" /></>
                      )}
                    </Button>
                  </div>

                  {event.supportEmail && (
                    <p className="text-center text-xs text-slate-400">
                      Need help?{" "}
                      <a href={`mailto:${event.supportEmail}`} className="text-primary hover:underline">
                        {event.supportEmail}
                      </a>
                    </p>
                  )}
                  </>
                  )}
                </form>
              </Form>
            )}
          </div>
        </div>

        {/* Sidebar links */}
        <div className="grid sm:grid-cols-2 gap-3 mt-4">
          <Link href={`/e/${slug}/schedule`} className="block group">
            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                  <Calendar className="h-4 w-4 text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 text-sm">View Programme</p>
                  <p className="text-xs text-slate-400">Full agenda</p>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary shrink-0" />
              </div>
            </div>
          </Link>
          {event.abstractSettings?.allowAbstractSubmissions && (
            <Link href={`/e/${slug}/abstract/register`} className="block group">
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <FileText className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 text-sm">Call for Abstracts</p>
                    <p className="text-xs text-slate-400">
                      {event.abstractSettings.abstractDeadline
                        ? `Deadline: ${format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}`
                        : "Submit your abstract"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary shrink-0" />
                </div>
              </div>
            </Link>
          )}
        </div>
      </div>

      {/* Footer */}
      {event.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center px-4 py-6">
          <div className="prose prose-sm prose-slate max-w-none mx-auto [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
        </div>
      )}
    </div>
  );
}
