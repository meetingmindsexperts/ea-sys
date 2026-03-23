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

/** Convert a category name to a URL-safe slug */
function toSlug(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
  organization: {
    name: string;
    logo: string | null;
  };
  ticketTypes: TicketType[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1, "Please select a registration type"),
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

export default function CategoryRegistrationPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const categorySlug = params.category as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [categoryLabel, setCategoryLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RegistrationForm>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      ticketTypeId: "",
      title: "",
      role: "",
      firstName: "",
      lastName: "",
      email: "",
      additionalEmail: "",
      organization: "",
      jobTitle: "",
      phone: "",
      city: "",
      country: "",
      specialty: "",
      customSpecialty: "",
      dietaryReqs: "",
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

        // Find the category that matches this URL slug
        const matchedCategory = data.ticketTypes.find(
          (t) => toSlug(t.category || "Standard") === categorySlug
        )?.category;

        if (!matchedCategory) {
          setError("Invalid registration category");
          return;
        }

        setCategoryLabel(matchedCategory);

        const categoryTickets = data.ticketTypes.filter(
          (t) => t.canPurchase && (t.category || "Standard") === matchedCategory
        );
        if (categoryTickets.length === 1) {
          form.setValue("ticketTypeId", categoryTickets[0].id);
        }
      } catch {
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }

    if (slug) {
      fetchEvent();
    }
  }, [slug, categorySlug, form]);

  async function onSubmit(data: RegistrationForm) {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
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
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  /* ── Loading state ──────────────────────────────────────────────────────── */
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

  /* ── Error state ────────────────────────────────────────────────────────── */
  if (error || !event || !categoryLabel) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            {error || "Registration not available"}
          </h2>
          <p className="text-slate-500 text-sm mb-4">
            Please check the link and try again.
          </p>
          <Link
            href={`/e/${slug}/register`}
            className="text-primary text-sm font-medium hover:underline"
          >
            ← View all registration types
          </Link>
        </div>
      </div>
    );
  }

  const availableTickets = event.ticketTypes.filter(
    (t) => t.canPurchase && (t.category || "Standard") === categoryLabel
  );
  const allCategoryTickets = event.ticketTypes.filter(
    (t) => (t.category || "Standard") === categoryLabel
  );
  const selectedTicketId = form.watch("ticketTypeId");
  const selectedTicket = event.ticketTypes.find((t) => t.id === selectedTicketId);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* ── Banner — full-width edge-to-edge ───────────────────────────────── */}
      {event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="max-w-[1400px] mx-auto">
            <Image
              src={event.bannerImage}
              alt={event.name}
              width={1400}
              height={400}
              className="w-full h-auto max-h-[280px] object-contain"
              priority
              unoptimized
            />
          </div>
        </div>
      ) : (
        /* No banner — clean header with accent */
        <div className="bg-white border-b border-slate-100">
          <div className="h-1 bg-gradient-primary" />
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">
              {event.name}
            </h1>
          </div>
        </div>
      )}

      {/* ── Event Info Strip ────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
            {event.bannerImage && (
              <h2 className="w-full text-base font-semibold text-slate-800 sm:w-auto sm:mr-4">
                {event.name}
              </h2>
            )}
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

      {/* ── Main Content ────────────────────────────────────────────────────── */}
      <div className="flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 py-8">
        {/* Back link */}
        <Link
          href={`/e/${slug}/register`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-primary transition-colors mb-6"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All registration types
        </Link>

        <div className="grid lg:grid-cols-3 gap-6 items-start">
          {/* ── Left column: Form ─────────────────────────────────────────── */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
              {/* Form header */}
              <div className="px-6 py-5 border-b border-slate-100">
                <h2 className="text-lg font-semibold text-slate-900">
                  {categoryLabel} Registration
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Complete the form below to register
                </p>
              </div>

              <div className="p-6">
                {availableTickets.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-50 flex items-center justify-center">
                      <AlertCircle className="h-7 w-7 text-slate-400" />
                    </div>
                    <p className="font-medium text-slate-700">
                      {categoryLabel} registration is currently closed
                    </p>
                    <p className="text-sm text-slate-400 mt-1">
                      Check back later or contact the organizer.
                    </p>
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      onSubmit={form.handleSubmit(onSubmit)}
                      className="space-y-6"
                    >
                      {/* Section: Registration Type */}
                      {availableTickets.length > 1 && (
                        <div>
                          <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                            Select Your Option
                          </p>
                          <FormField
                            control={form.control}
                            name="ticketTypeId"
                            render={({ field }) => (
                              <FormItem>
                                <div className="grid gap-2.5">
                                  {availableTickets.map((rt) => {
                                    const isSelected = field.value === rt.id;
                                    return (
                                      <button
                                        key={rt.id}
                                        type="button"
                                        onClick={() => field.onChange(rt.id)}
                                        className={cn(
                                          "w-full text-left rounded-lg border p-4 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                                          isSelected
                                            ? "border-primary bg-primary/[0.03] ring-1 ring-primary/30"
                                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50/50"
                                        )}
                                      >
                                        <div className="flex items-center justify-between gap-3">
                                          <div className="flex-1 min-w-0">
                                            <p className="font-medium text-slate-900 text-sm">
                                              {rt.name}
                                            </p>
                                            {rt.description && (
                                              <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                                                {rt.description}
                                              </p>
                                            )}
                                          </div>
                                          <div className="flex items-center gap-3 shrink-0">
                                            <span
                                              className={cn(
                                                "text-sm font-semibold",
                                                isSelected ? "text-primary" : "text-slate-700"
                                              )}
                                            >
                                              {Number(rt.price) === 0
                                                ? "Free"
                                                : `${rt.currency} ${rt.price}`}
                                            </span>
                                            <div
                                              className={cn(
                                                "h-4 w-4 rounded-full border-2 flex items-center justify-center transition-all",
                                                isSelected
                                                  ? "border-primary bg-primary"
                                                  : "border-slate-300"
                                              )}
                                            >
                                              {isSelected && (
                                                <div className="h-1.5 w-1.5 rounded-full bg-white" />
                                              )}
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

                      {/* Hidden ticket selector when only one option */}
                      {availableTickets.length === 1 && (
                        <FormField
                          control={form.control}
                          name="ticketTypeId"
                          render={() => (
                            <FormItem className="hidden">
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {/* Section: Personal Information */}
                      <div>
                        <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                          Personal Information
                        </p>
                        <div className="space-y-4">
                          <div className="grid grid-cols-[100px_1fr_1fr] gap-3">
                            <FormField
                              control={form.control}
                              name="title"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium text-slate-600">
                                    Title <span className="text-red-400">*</span>
                                  </FormLabel>
                                  <TitleSelect value={field.value} onChange={field.onChange} />
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name="firstName"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium text-slate-600">
                                    First Name <span className="text-red-400">*</span>
                                  </FormLabel>
                                  <FormControl>
                                    <Input placeholder="John" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
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
                                    <Input placeholder="Doe" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
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
                                  <Input type="email" placeholder="john@example.com" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="additionalEmail"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <Mail className="h-3 w-3" /> Additional Email
                                </FormLabel>
                                <FormControl>
                                  <Input type="email" placeholder="alternate@example.com" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="role"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <Shield className="h-3 w-3" /> Role <span className="text-red-400">*</span>
                                </FormLabel>
                                <RoleSelect value={field.value} onChange={field.onChange} />
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
                                    <Building2 className="h-3 w-3" /> Organization
                                  </FormLabel>
                                  <FormControl>
                                    <Input placeholder="Acme Inc." className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
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
                                    <User className="h-3 w-3" /> Job Title
                                  </FormLabel>
                                  <FormControl>
                                    <Input placeholder="Physician" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>

                          <FormField
                            control={form.control}
                            name="phone"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <Phone className="h-3 w-3" /> Phone
                                </FormLabel>
                                <FormControl>
                                  <Input placeholder="+1 234 567 8900" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <div className="grid grid-cols-2 gap-3">
                            <FormField
                              control={form.control}
                              name="city"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                    <MapPin className="h-3 w-3" /> City
                                  </FormLabel>
                                  <FormControl>
                                    <Input placeholder="New York" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
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
                                    <Globe className="h-3 w-3" /> Country <span className="text-red-400">*</span>
                                  </FormLabel>
                                  <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>

                          <FormField
                            control={form.control}
                            name="specialty"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <Stethoscope className="h-3 w-3" /> Specialty <span className="text-red-400">*</span>
                                </FormLabel>
                                <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="customSpecialty"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <PenLine className="h-3 w-3" /> Specialty (Specific)
                                </FormLabel>
                                <FormControl>
                                  <Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="dietaryReqs"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                  <Utensils className="h-3 w-3" /> Dietary Requirements
                                </FormLabel>
                                <FormControl>
                                  <Input placeholder="e.g. Vegetarian, Halal, Gluten-free" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      </div>

                      {/* Summary & Submit */}
                      {selectedTicket && (
                        <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-600">{selectedTicket.name}</span>
                            <span className="font-bold text-slate-900">
                              {Number(selectedTicket.price) === 0
                                ? "Free"
                                : `${selectedTicket.currency} ${selectedTicket.price}`}
                            </span>
                          </div>
                        </div>
                      )}

                      <Button
                        type="submit"
                        className="w-full btn-gradient h-11 font-semibold text-sm rounded-lg shadow-sm hover:shadow-md transition-shadow"
                        disabled={submitting}
                      >
                        {submitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Registering…
                          </>
                        ) : (
                          <>
                            Complete Registration
                            <ChevronRight className="ml-1 h-4 w-4" />
                          </>
                        )}
                      </Button>

                      <p className="text-center text-xs text-slate-400">
                        By registering, you agree to the event terms and conditions.
                      </p>
                    </form>
                  </Form>
                )}
              </div>
            </div>
          </div>

          {/* ── Right column: Sidebar ────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Event details card */}
            {event.description && (
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2.5">
                  About This Event
                </h3>
                <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap line-clamp-6">
                  {event.description}
                </p>
              </div>
            )}

            {/* Registration types overview */}
            {allCategoryTickets.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                  {categoryLabel} Options
                </h3>
                <div className="space-y-2">
                  {allCategoryTickets.map((rt) => (
                    <div
                      key={rt.id}
                      className={cn(
                        "flex justify-between items-center text-sm py-1",
                        !rt.canPurchase && "opacity-40"
                      )}
                    >
                      <span className="text-slate-600">{rt.name}</span>
                      <span
                        className={cn(
                          "font-semibold text-xs",
                          rt.canPurchase ? "text-primary" : "text-slate-400"
                        )}
                      >
                        {rt.soldOut || rt.salesEnded
                          ? "Closed"
                          : !rt.salesStarted
                          ? "Soon"
                          : Number(rt.price) === 0
                          ? "Free"
                          : `${rt.currency} ${rt.price}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick links */}
            <Link href={`/e/${slug}/schedule`} className="block group">
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all duration-200">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                    <Calendar className="h-4 w-4 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 text-sm">View Programme</p>
                    <p className="text-xs text-slate-400">Full agenda</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary transition-colors shrink-0" />
                </div>
              </div>
            </Link>

            {event.abstractSettings?.allowAbstractSubmissions && (
              <Link href={`/e/${slug}/submitAbstract`} className="block group">
                <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all duration-200">
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
                    <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary transition-colors shrink-0" />
                  </div>
                </div>
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ── Custom Footer ──────────────────────────────────────────────────── */}
      {event.footerHtml && (
        <div
          className="w-full border-t border-slate-200/60 bg-white text-center"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }}
        />
      )}
    </div>
  );
}
