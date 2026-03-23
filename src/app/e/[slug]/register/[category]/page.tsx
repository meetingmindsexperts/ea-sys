"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
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
  User,
  Building2,
  Phone,
  Globe,
  Utensils,
  Stethoscope,
  AlertCircle,
  ArrowLeft,
  Mail,
  Shield,
  PenLine,
  Check,
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
  ticketTypeId: z.string().min(1, "Please select a registration type"),
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
});

type RegistrationForm = z.infer<typeof registrationSchema>;

const STEPS = [
  { id: "type", label: "Registration Type" },
  { id: "personal", label: "Personal Info" },
  { id: "details", label: "Details" },
] as const;

const STEP_FIELDS: Record<string, (keyof RegistrationForm)[]> = {
  type: ["ticketTypeId"],
  personal: ["title", "firstName", "lastName", "email", "role"],
  details: ["country", "specialty"],
};

export default function CategoryRegistrationPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const categorySlug = params.category as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [formLabel, setFormLabel] = useState<string | null>(null);
  const [regTypeOptions, setRegTypeOptions] = useState<RegTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [skipTypeStep, setSkipTypeStep] = useState(false);

  const form = useForm<RegistrationForm>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      ticketTypeId: "", pricingTierId: "", title: "", role: "",
      firstName: "", lastName: "", email: "", additionalEmail: "",
      organization: "", jobTitle: "", phone: "", city: "",
      country: "", specialty: "", customSpecialty: "", dietaryReqs: "",
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
          // New flow: [category] = pricing tier name slug (e.g., "early-bird")
          // Build options: all registration types that have this tier
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

          // Get the tier name from the first match
          const tierName = data.ticketTypes
            .flatMap((tt) => tt.pricingTiers ?? [])
            .find((t) => toSlug(t.name) === categorySlug)?.name ?? categorySlug;

          setFormLabel(tierName);
          setRegTypeOptions(options);

          const purchasable = options.filter((o) => o.canPurchase);
          if (purchasable.length === 1) {
            form.setValue("ticketTypeId", purchasable[0].ticketTypeId);
            form.setValue("pricingTierId", purchasable[0].pricingTierId);
            setSkipTypeStep(true);
            setStep(1);
          }
        } else {
          // Legacy: [category] = old category slug
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
            setSkipTypeStep(true);
            setStep(1);
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

  const activeSteps = skipTypeStep ? STEPS.filter((s) => s.id !== "type") : [...STEPS];
  const activeStepIndex = activeSteps.findIndex((s) => s.id === STEPS[step].id);
  const isLastStep = activeStepIndex === activeSteps.length - 1;

  async function handleNext() {
    const currentStepId = STEPS[step].id;
    const fieldsToValidate = STEP_FIELDS[currentStepId] || [];
    const isValid = await form.trigger(fieldsToValidate);
    if (!isValid) return;
    if (isLastStep) {
      form.handleSubmit(onSubmit)();
    } else {
      setStep((s) => s + 1);
    }
  }

  function handleBack() {
    if (step > (skipTypeStep ? 1 : 0)) setStep((s) => s - 1);
  }

  async function onSubmit(data: RegistrationForm) {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
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
            ← View all registration forms
          </Link>
        </div>
      </div>
    );
  }

  const purchasableOptions = regTypeOptions.filter((o) => o.canPurchase);
  const selectedTicketId = form.watch("ticketTypeId");
  const selectedOption = regTypeOptions.find((o) => o.ticketTypeId === selectedTicketId);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);
  const isClosed = purchasableOptions.length === 0;

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
        <Link href={`/e/${slug}/register`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-primary transition-colors mb-5">
          <ArrowLeft className="h-3.5 w-3.5" /> All registration forms
        </Link>

        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header + steps */}
          <div className="px-6 py-5 border-b border-slate-100">
            <h2 className="text-lg font-semibold text-slate-900">{formLabel} Registration</h2>
            <div className="flex items-center gap-2 mt-4">
              {activeSteps.map((s, i) => {
                const isCurrent = i === activeStepIndex;
                const isCompleted = i < activeStepIndex;
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
                <form onSubmit={(e) => { e.preventDefault(); handleNext(); }} className="space-y-5">

                  {/* Step: Registration Type Selection */}
                  {STEPS[step].id === "type" && (
                    <div className="space-y-4">
                      <p className="text-sm text-slate-600">Select your registration type:</p>
                      <FormField control={form.control} name="ticketTypeId"
                        render={({ field }) => (
                          <FormItem>
                            <div className="grid gap-3">
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
                                      "w-full text-left rounded-xl border-2 p-5 transition-all duration-150",
                                      isSelected
                                        ? "border-primary bg-primary/[0.03] shadow-sm"
                                        : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
                                    )}>
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <p className="font-semibold text-slate-900">{opt.regTypeName}</p>
                                        {opt.description && <p className="text-xs text-slate-500 mt-0.5">{opt.description}</p>}
                                        {opt.available <= 0 && (
                                          <p className="text-xs text-red-500 mt-1">Sold out</p>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-3">
                                        <span className={cn("text-lg font-bold", isSelected ? "text-primary" : "text-slate-800")}>
                                          {opt.price === 0 ? "Free" : `${opt.currency} ${opt.price}`}
                                        </span>
                                        <div className={cn(
                                          "h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all",
                                          isSelected ? "border-primary bg-primary" : "border-slate-300"
                                        )}>
                                          {isSelected && <div className="h-2 w-2 rounded-full bg-white" />}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                            <FormMessage className="mt-2" />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}

                  {/* Step: Personal Information */}
                  {STEPS[step].id === "personal" && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-[100px_1fr_1fr] gap-3">
                        <FormField control={form.control} name="title"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600">Title <span className="text-red-400">*</span></FormLabel>
                              <TitleSelect value={field.value} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600">First Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="John" className="rounded-lg border-slate-200" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600">Last Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="Doe" className="rounded-lg border-slate-200" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>
                      <FormField control={form.control} name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Mail className="h-3 w-3" /> Email <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input type="email" placeholder="john@example.com" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="additionalEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Mail className="h-3 w-3" /> Additional Email</FormLabel>
                            <FormControl><Input type="email" placeholder="alternate@example.com" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="role"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Shield className="h-3 w-3" /> Role <span className="text-red-400">*</span></FormLabel>
                            <RoleSelect value={field.value} onChange={field.onChange} />
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                  )}

                  {/* Step: Professional & Location Details */}
                  {STEPS[step].id === "details" && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <FormField control={form.control} name="organization"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Building2 className="h-3 w-3" /> Organization</FormLabel>
                              <FormControl><Input placeholder="Acme Inc." className="rounded-lg border-slate-200" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="jobTitle"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><User className="h-3 w-3" /> Job Title</FormLabel>
                              <FormControl><Input placeholder="Physician" className="rounded-lg border-slate-200" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>
                      <FormField control={form.control} name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Phone className="h-3 w-3" /> Phone</FormLabel>
                            <FormControl><Input placeholder="+1 234 567 8900" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <div className="grid grid-cols-2 gap-3">
                        <FormField control={form.control} name="city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><MapPin className="h-3 w-3" /> City</FormLabel>
                              <FormControl><Input placeholder="New York" className="rounded-lg border-slate-200" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="country"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Globe className="h-3 w-3" /> Country <span className="text-red-400">*</span></FormLabel>
                              <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>
                      <FormField control={form.control} name="specialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Stethoscope className="h-3 w-3" /> Specialty <span className="text-red-400">*</span></FormLabel>
                            <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="customSpecialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><PenLine className="h-3 w-3" /> Specialty (Specific)</FormLabel>
                            <FormControl><Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="dietaryReqs"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1"><Utensils className="h-3 w-3" /> Dietary Requirements</FormLabel>
                            <FormControl><Input placeholder="e.g. Vegetarian, Halal" className="rounded-lg border-slate-200" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />

                      {/* Summary */}
                      {selectedOption && (
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                          <div className="flex justify-between items-center">
                            <div>
                              <span className="text-sm text-slate-600">{selectedOption.regTypeName}</span>
                              <span className="text-xs text-slate-400 ml-2">({formLabel})</span>
                            </div>
                            <span className="text-lg font-bold text-slate-900">
                              {selectedOption.price === 0 ? "Free" : `${selectedOption.currency} ${selectedOption.price}`}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Navigation */}
                  <div className="flex items-center justify-between pt-2">
                    {activeStepIndex > 0 ? (
                      <Button type="button" variant="outline" onClick={handleBack} className="rounded-lg">
                        <ChevronLeft className="mr-1 h-4 w-4" /> Back
                      </Button>
                    ) : (
                      <div />
                    )}
                    <Button type="submit" disabled={submitting}
                      className={cn("rounded-lg font-semibold", isLastStep ? "btn-gradient px-8" : "px-6")}>
                      {submitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Registering…</>
                      ) : isLastStep ? (
                        <>Complete Registration <ChevronRight className="ml-1 h-4 w-4" /></>
                      ) : (
                        <>Continue <ChevronRight className="ml-1 h-4 w-4" /></>
                      )}
                    </Button>
                  </div>

                  <p className="text-center text-xs text-slate-400">
                    By registering, you agree to the event terms and conditions.
                  </p>
                  {event.supportEmail && (
                    <p className="text-center text-xs text-slate-400">
                      Need help?{" "}
                      <a href={`mailto:${event.supportEmail}`} className="text-primary hover:underline">
                        {event.supportEmail}
                      </a>
                    </p>
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
            <Link href={`/e/${slug}/submitAbstract`} className="block group">
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
        <div className="w-full border-t border-slate-200/60 bg-white text-center"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
      )}
    </div>
  );
}
