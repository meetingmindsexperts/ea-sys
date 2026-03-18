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
  title: z.string().optional(),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  organization: z.string().optional(),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  specialty: z.string().optional(),
  registrationType: z.string().optional(),
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
      firstName: "",
      lastName: "",
      email: "",
      organization: "",
      jobTitle: "",
      phone: "",
      city: "",
      country: "",
      specialty: "",
      registrationType: "",
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
      router.push(
        `/e/${slug}/confirmation?id=${result.registration.id}&name=${encodeURIComponent(data.firstName)}`
      );
    } catch {
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
          <p className="text-slate-400 text-sm tracking-wide">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !event || !categoryLabel) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
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

  // Build list of other categories for switching
  const allCategories: string[] = [];
  const seen = new Set<string>();
  for (const t of event.ticketTypes) {
    const cat = t.category || "Standard";
    if (!seen.has(cat) && t.canPurchase) {
      seen.add(cat);
      allCategories.push(cat);
    }
  }
  const otherCategories = allCategories.filter((c) => c !== categoryLabel);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Hero Section */}
      <div className="relative bg-slate-900 overflow-hidden">
        {event.bannerImage && (
          <>
            <Image
              src={event.bannerImage}
              alt={event.name}
              width={1400}
              height={500}
              className="w-full h-52 sm:h-72 object-cover opacity-40"
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
            "relative max-w-6xl mx-auto px-4 sm:px-6",
            event.bannerImage ? "py-8 -mt-8" : "py-12"
          )}
        >
          <div className="flex items-center gap-2 mb-4">
            {event.organization.logo ? (
              <Image
                src={event.organization.logo}
                alt={event.organization.name}
                width={24}
                height={24}
                className="rounded"
                unoptimized
              />
            ) : null}
            <span className="text-xs font-medium tracking-widest uppercase text-primary/80">
              {event.organization.name}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-6 leading-tight max-w-3xl">
            {event.name}
          </h1>

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
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 flex-1 w-full">
        <div className="grid md:grid-cols-5 gap-8 items-start">
          {/* Left: Info sidebar */}
          <div className="md:col-span-2 space-y-5">
            {/* Category switcher */}
            {otherCategories.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
                <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                  Other Categories
                </p>
                <div className="flex flex-wrap gap-2">
                  {otherCategories.map((cat) => (
                    <Link
                      key={cat}
                      href={`/e/${slug}/register/${toSlug(cat)}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 bg-slate-50 hover:bg-primary/10 hover:text-primary border border-slate-200 hover:border-primary/30 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <ArrowLeft className="h-3 w-3" />
                      {cat}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {event.description && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                  About This Event
                </h3>
                <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">
                  {event.description}
                </p>
              </div>
            )}

            <Link href={`/e/${slug}/schedule`} className="block group">
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-primary/40 hover:shadow-md transition-all duration-200">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
                    <Calendar className="h-5 w-5 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 text-sm">View Programme</p>
                    <p className="text-xs text-slate-500 mt-0.5">Full agenda &amp; schedule</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors shrink-0" />
                </div>
              </div>
            </Link>

            {event.abstractSettings?.allowAbstractSubmissions && (
              <Link href={`/e/${slug}/submitAbstract`} className="block group">
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-primary/40 hover:shadow-md transition-all duration-200">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 text-sm">Call for Abstracts</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {event.abstractSettings.abstractDeadline
                          ? `Deadline: ${format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}`
                          : "Submit your abstract for review"}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors shrink-0" />
                  </div>
                </div>
              </Link>
            )}

            {/* Category ticket types overview */}
            {allCategoryTickets.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-4">
                  {categoryLabel} Registration
                </h3>
                <div className="space-y-2">
                  {allCategoryTickets.map((rt) => (
                    <div
                      key={rt.id}
                      className={cn(
                        "flex justify-between items-center text-sm",
                        !rt.canPurchase && "opacity-40"
                      )}
                    >
                      <span className="text-slate-700 font-medium">{rt.name}</span>
                      <span
                        className={cn(
                          "font-semibold",
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
          </div>

          {/* Right: Registration Form */}
          <div className="md:col-span-3">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100">
                <h2 className="text-lg font-semibold text-slate-900">
                  {categoryLabel} Registration
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Complete the form below to secure your spot
                </p>
              </div>

              <div className="p-6">
                {availableTickets.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
                      <AlertCircle className="h-7 w-7 text-slate-400" />
                    </div>
                    <p className="font-medium text-slate-700">
                      {categoryLabel} registration is currently closed
                    </p>
                    <p className="text-sm text-slate-400 mt-1">
                      Check back later or contact the organizer.
                    </p>
                    <Link
                      href={`/e/${slug}/register`}
                      className="text-primary text-sm font-medium hover:underline mt-3 inline-block"
                    >
                      View other registration types →
                    </Link>
                  </div>
                ) : (
                  <Form {...form}>
                    <form
                      onSubmit={form.handleSubmit(onSubmit)}
                      className="space-y-6"
                    >
                      {/* Section: Registration Type */}
                      <div>
                        <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                          Select Your Option
                        </p>
                        <FormField
                          control={form.control}
                          name="ticketTypeId"
                          render={({ field }) => (
                            <FormItem>
                              <div className="grid gap-3">
                                {availableTickets.map((rt) => {
                                  const isSelected = field.value === rt.id;
                                  return (
                                    <button
                                      key={rt.id}
                                      type="button"
                                      onClick={() => field.onChange(rt.id)}
                                      className={cn(
                                        "w-full text-left rounded-xl border-2 p-4 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                                        isSelected
                                          ? "border-primary bg-primary/5 shadow-sm"
                                          : "border-slate-200 hover:border-primary/50 hover:bg-slate-50"
                                      )}
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                          <p className="font-semibold text-slate-900 text-sm">
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
                                              "text-sm font-bold",
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
                                  <FormLabel className="text-xs font-medium text-slate-600">Title</FormLabel>
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
                                    <Globe className="h-3 w-3" /> Country
                                  </FormLabel>
                                  <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <FormField
                              control={form.control}
                              name="specialty"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                    <Stethoscope className="h-3 w-3" /> Specialty
                                  </FormLabel>
                                  <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name="registrationType"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium text-slate-600 flex items-center gap-1">
                                    <FileText className="h-3 w-3" /> Registration Type
                                  </FormLabel>
                                  <FormControl>
                                    <Input placeholder="e.g. Delegate, Speaker, Student" className="rounded-lg border-slate-200 focus-visible:ring-primary/30" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>

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
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
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
                        className="w-full btn-gradient h-11 font-semibold text-sm rounded-xl shadow-sm hover:shadow-md transition-shadow"
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
        </div>
      </div>

      {/* Custom Footer */}
      {event.footerHtml && (
        <div
          className="w-full border-t bg-white"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }}
        />
      )}
    </div>
  );
}
