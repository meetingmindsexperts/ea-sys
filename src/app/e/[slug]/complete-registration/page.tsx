"use client";

import { showsField, type FormFieldVisibility } from "@/lib/registration-form-fields";
import { Suspense, useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { EventBannerBand } from "@/components/public/event-banner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import Link from "next/link";
import { scrollToFirstFormError } from "@/lib/form-error-scroll";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
  Loader2,
  AlertCircle,
  Lock,
  CheckCircle,
  ChevronRight,
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
import { readIdentityEvidencePolicy, missingIdentityEvidence } from "@/lib/identity-evidence";
import { Checkbox } from "@/components/ui/checkbox";
import { CountrySelect } from "@/components/ui/country-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { toast } from "sonner";
import { DEFAULT_REGISTRATION_TERMS_HTML } from "@/lib/default-terms";
import {
  BillingDetailsSection,
  SupportingDocumentField,
  missingBillingFields,
  type UploadedDocument,
} from "@/components/public/registration-form-extras";
import {
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentInstructions,
  supportingDocumentLabel,
  type SupportingDocumentPolicy,
} from "@/lib/supporting-document";

interface PrefilledData {
  alreadyCompleted: boolean;
  registration: { id: string; status: string; ticketTypeId: string | null };
  attendee: {
    firstName: string;
    lastName: string;
    email: string;
    title: string | null;
    role: string | null;
    organization: string | null;
    jobTitle: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
    specialty: string | null;
    customSpecialty: string | null;
    dietaryReqs: string | null;
    associationName: string | null;
    memberId: string | null;
    studentId: string | null;
    studentIdExpiry: string | null;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    startDate: string;
    endDate: string;
    venue: string | null;
    city: string | null;
    country: string | null;
    bannerImage: string | null;
    bannerImageMobile?: string | null;
    registrationTermsHtml: string | null;
    supportEmail: string | null;
    organization: { name: string; logo: string | null };
    /** Optional attendee fields the organiser left on the form; absent = all shown. */
    formFields?: Partial<FormFieldVisibility>;
  };
  // Null when the registration has no registration type yet (e.g. imported
  // from a file with no registrationType column). Reading `.name` off this
  // unguarded used to throw during render — a white screen for the registrant,
  // with no way to complete.
  ticketType:
    | {
        id: string;
        name: string;
        // Identity-evidence switches, so the form asks for exactly what the
        // route enforces.
        requiresMemberId?: boolean;
        requiresStudentId?: boolean;
        requiresStudentIdExpiry?: boolean;
        /** The type's own price; billing is hidden when it is free and no other type is offered. */
        price?: number | string;
      } & SupportingDocumentPolicy
    | null;
  /** Populated only when `ticketType` is null — the types this person may
   *  choose from, priced at whichever tier is on sale today. Display only:
   *  the server re-resolves the price on submit. */
  selectableTicketTypes?: ({
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    tierName: string | null;
    available: boolean;
    requiresMemberId?: boolean;
    requiresStudentId?: boolean;
    requiresStudentIdExpiry?: boolean;
  } & SupportingDocumentPolicy)[];
  /** The rate the link carries (docs/REGISTRATION_FORM_LINKS_PLAN.md); null on older links. */
  linkRate?: { name: string; closed: boolean } | null;
}

const completionSchema = z.object({
  /** Only asked for when the registration has no type yet (imported without
   *  one). Required-ness is enforced in `onSubmit`, since it depends on data
   *  the schema can't see. */
  ticketTypeId: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  role: z.string().min(1, "Role is required"),
  jobTitle: z.string().min(1, "Position is required"),
  organization: z.string().min(1, "Organization is required"),
  phone: z.string().min(1, "Mobile number is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  country: z.string().min(1, "Country is required"),
  specialty: z.string().min(1, "Specialty is required"),
  customSpecialty: z.string().optional(),
  dietaryReqs: z.string().optional(),
  associationName: z.string().optional(),
  memberId: z.string().optional(),
  studentId: z.string().optional(),
  studentIdExpiry: z.string().optional(),
  // As on the public form (docs/ONSITE_DESK_PLAN.md §3.3).
  additionalEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
  taxNumber: z.string().optional(),
  billingFirstName: z.string().optional(),
  billingLastName: z.string().optional(),
  billingEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
  billingPhone: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZipCode: z.string().optional(),
  billingCountry: z.string().optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional().or(z.literal("")),
  confirmPassword: z.string().optional(),
  agreeTerms: z.literal(true, { message: "You must agree to the terms and conditions" }),
}).refine((data) => !data.password || data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

type CompletionForm = z.infer<typeof completionSchema>;

function CompleteRegistrationContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const token = searchParams.get("token");
  // The onsite desk's shared tablet (docs/ONSITE_DESK_PLAN.md §5.3): no password,
  // no autofill kept between people, and a hand-back screen instead of the
  // confirmation page.
  const tablet = searchParams.get("mode") === "tablet";
  const fieldAutoComplete = (value: string) => (tablet ? "off" : value);

  const [data, setData] = useState<PrefilledData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // What stopped the last Complete Registration tap, shown by the button.
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  // The supporting document and billing, as on the public form.
  const [supportingDoc, setSupportingDoc] = useState<UploadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [billingSame, setBillingSame] = useState(true);
  // Tablet mode: what the hand-back screen shows once the form is in.
  const [handedBack, setHandedBack] = useState<HandBackDetails | null>(null);
  // Tablet mode: an abandoned form is cleared, so the next person never sees it.
  const [idledOut, setIdledOut] = useState(false);

  const form = useForm<CompletionForm>({
    resolver: zodResolver(completionSchema),
    // The page scrolls to the first error itself (form-error-scroll.ts); the
    // library's jump focused a lower text field first (review L4).
    shouldFocusError: false,
    defaultValues: {
      ticketTypeId: "",
      title: "", role: "", jobTitle: "", organization: "", phone: "",
      city: "", state: "", zipCode: "", country: "",
      specialty: "", customSpecialty: "", dietaryReqs: "",
      associationName: "", memberId: "", studentId: "", studentIdExpiry: "",
      additionalEmail: "", taxNumber: "",
      billingFirstName: "", billingLastName: "", billingEmail: "", billingPhone: "", billingAddress: "",
      billingCity: "", billingState: "", billingZipCode: "", billingCountry: "",
      password: "", confirmPassword: "",
      agreeTerms: undefined as unknown as true,
    },
  });
  // The notice describes the LAST tap; once the person changes anything it is
  // out of date (review of e7cd2b2d: picking the missing category left it up).
  useEffect(() => {
    const sub = form.watch(() => setSubmitNotice(null));
    return () => sub.unsubscribe();
  }, [form]);

  useEffect(() => {
    async function fetchData() {
      if (!token) {
        setError("No token provided. Please use the link from your email.");
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`/api/public/events/${slug}/complete-registration?token=${encodeURIComponent(token)}`);
        const result = await res.json();
        if (!res.ok) {
          setError(result.error || "Invalid link");
          return;
        }
        if (result.alreadyCompleted) {
          setError("This registration has already been completed. Your confirmation and barcode were sent by email; if you set a password, you can also sign in to manage it.");
          return;
        }
        // The link's rate has closed: nothing to complete at it (owner D3).
        if (result.linkRate?.closed) {
          setError(`The ${result.linkRate.name} rate in your link has closed. Please contact the organising team for a new link.`);
          return;
        }
        setData(result);
        // Pre-fill editable fields from existing data
        const a = result.attendee;
        form.reset({
          title: a.title || "",
          role: a.role || "",
          jobTitle: a.jobTitle || "",
          organization: a.organization || "",
          phone: a.phone || "",
          city: a.city || "",
          state: a.state || "",
          zipCode: a.zipCode || "",
          country: a.country || "",
          specialty: a.specialty || "",
          customSpecialty: a.customSpecialty || "",
          dietaryReqs: a.dietaryReqs || "",
          associationName: a.associationName || "",
          memberId: a.memberId || "",
          studentId: a.studentId || "",
          studentIdExpiry: a.studentIdExpiry ? new Date(a.studentIdExpiry).toISOString().split("T")[0] : "",
          // Every field the form renders starts as a string, so none switches from uncontrolled (review LOW).
          additionalEmail: "", taxNumber: "",
          billingFirstName: "", billingLastName: "", billingEmail: "", billingPhone: "", billingAddress: "",
          billingCity: "", billingState: "", billingZipCode: "", billingCountry: "",
          password: "",
          confirmPassword: "",
          agreeTerms: undefined as unknown as true,
          // A link with a rate starts on the person's current type; they may change it.
          ...(result.linkRate && result.registration.ticketTypeId ? { ticketTypeId: result.registration.ticketTypeId } : {}),
        });
      } catch {
        setError("Failed to load registration details");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [token, slug, form]);

  // A tap that did not go through: scroll to the first error once it has
  // rendered (the type picker and the dropdowns have no focusable field for
  // react-hook-form to jump to) and name what is missing by the button.
  function showBlockedSubmit() {
    setSubmitNotice(null);
    setTimeout(() => setSubmitNotice(scrollToFirstFormError()), 50);
  }

  async function onSubmit(formData: CompletionForm) {
    if (!token) return;
    setSubmitNotice(null);

    // A registration imported without a type is given one here.
    const mustChooseType = !!data && !data.ticketType;
    if (mustChooseType && !formData.ticketTypeId) {
      form.setError("ticketTypeId", { message: "Please choose a registration type" });
      showBlockedSubmit();
      return;
    }

    // Identity evidence, from the type's SWITCHES. When the type is being
    // chosen now, the rules follow the CHOSEN type, not the stored one. Same
    // helper the route enforces with — and the route enforces it as of today;
    // this check used to be the only one anywhere.
    const chosenType = formData.ticketTypeId
      ? data?.selectableTicketTypes?.find((t) => t.id === formData.ticketTypeId)
      : undefined;
    const submitEvidencePolicy = readIdentityEvidencePolicy(chosenType ?? data?.ticketType);
    const missingEvidence = missingIdentityEvidence(submitEvidencePolicy, {
      memberId: formData.memberId,
      studentId: formData.studentId,
      studentIdExpiry: formData.studentIdExpiry,
    });
    if (missingEvidence.length > 0) {
      if (missingEvidence.includes("Member ID")) form.setError("memberId", { message: "Member ID is required" });
      if (missingEvidence.includes("Student ID")) form.setError("studentId", { message: "Student ID is required" });
      if (missingEvidence.includes("Student ID expiry date")) {
        form.setError("studentIdExpiry", { message: "Student ID expiry date is required" });
      }
      showBlockedSubmit();
      return;
    }

    const docPolicy = chosenType ?? data?.ticketType;
    if (supportingDocumentBlocks(docPolicy) && !supportingDoc) {
      setDocError(`Please attach the ${supportingDocumentLabel(docPolicy).toLowerCase()} to continue.`);
      showBlockedSubmit();
      return;
    }
    if (!billingSame) {
      const missing = missingBillingFields(formData);
      for (const { field, label } of missing) form.setError(field, { message: `${label} is required` });
      if (missing.length > 0) {
        showBlockedSubmit();
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/complete-registration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          // "Same as personal details" (also when billing is hidden): the server fills only empty billing.
          billingSame,
          supportingDocumentUrl: requiresSupportingDocument(docPolicy) ? supportingDoc?.url : undefined,
          supportingDocumentFilename: requiresSupportingDocument(docPolicy) ? supportingDoc?.filename : undefined,
          token,
          password: formData.password || undefined,
          confirmPassword: formData.confirmPassword || undefined,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        toast.error(result.error || "Failed to complete registration");
        setSubmitting(false);
        return;
      }
      if (tablet && data) {
        const typeName =
          data.selectableTicketTypes?.find((t) => t.id === formData.ticketTypeId)?.name ?? data.ticketType?.name ?? null;
        setHandedBack({
          name: [data.attendee.firstName, data.attendee.lastName].filter(Boolean).join(" "),
          email: data.attendee.email,
          typeName,
          eventName: data.event.name,
          eventDate: data.event.startDate,
          venue: [data.event.venue, data.event.city].filter(Boolean).join(", ") || null,
          emailed: result.emailed !== false,
        });
        return;
      }
      const confirmParams = new URLSearchParams({
        id: result.registration.id,
        name: data?.attendee.firstName || "",
        ...(result.registration.status ? { status: result.registration.status } : {}),
        ...(result.registration.ticketPrice > 0 ? { price: String(result.registration.ticketPrice), currency: result.registration.ticketCurrency } : {}),
      });
      router.push(`/e/${slug}/confirmation?${confirmParams.toString()}`);
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  // Tablet mode: clear a form left untouched for 5 minutes (review of
  // cf9775fd), so an abandoned one never reaches the next person.
  useEffect(() => {
    if (!tablet || handedBack || idledOut) return;
    let timer = setTimeout(() => setIdledOut(true), TABLET_IDLE_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdledOut(true), TABLET_IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "input", "scroll"] as const;
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, reset));
    };
  }, [tablet, handedBack, idledOut]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-slate-400 text-sm">Loading your registration...</p>
        </div>
      </div>
    );
  }

  if (handedBack) return <TabletHandBack details={handedBack} />;

  if (idledOut) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <h2 className="text-lg font-semibold text-slate-900 mb-2">This form was closed</h2>
          <p className="text-slate-500 text-sm">
            It was left without activity for a few minutes, so it was cleared to keep the details private. Please ask the
            registration desk for a new link.
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Something went wrong"}</h2>
          <p className="text-slate-500 text-sm mb-4">Please check the link from your email and try again.</p>
          <Link href={`/e/${slug}/login`} className="text-primary text-sm font-medium hover:underline">
            Sign in to your account
          </Link>
        </div>
      </div>
    );
  }

  const event = data.event;
  const attendee = data.attendee;
  // When the registration arrived without a type, the person picks it here and
  // the member/student conditional fields follow that live selection.
  const selectableTypes = data.selectableTicketTypes ?? [];
  const mustChooseType = !data.ticketType;
  // A link with a rate lets the person change type, at that rate (owner D5).
  const showTypePicker = mustChooseType || (!!data.linkRate && selectableTypes.length > 0);
  const chosenTypeId = form.watch("ticketTypeId");
  const chosenType = selectableTypes.find((t) => t.id === chosenTypeId);
  const evidencePolicy = readIdentityEvidencePolicy(chosenType ?? data.ticketType);
  const isMember = evidencePolicy.requiresMemberId;
  const isStudent = evidencePolicy.requiresStudentId;
  const showStudentExpiry = evidencePolicy.requiresStudentIdExpiry;
  const docPolicy = chosenType ?? data.ticketType;
  const needsDocument = requiresSupportingDocument(docPolicy);
  // Billing is noise when there is nothing to pay: a complimentary link, or every option free (as the
  // public form hides it); "same as personal details" is the default, so it costs the person nothing.
  const allOptionsFree = selectableTypes.length > 0 && selectableTypes.every((t) => Number(t.price) <= 0);
  // With no other type offered, their own type decides: a free one (Faculty, a comp) has nothing to bill.
  const ownTypeFree = selectableTypes.length === 0 && data.ticketType?.price !== undefined && Number(data.ticketType.price) <= 0;
  const showBilling = data.linkRate?.name !== "Complimentary" && !allOptionsFree && !ownTypeFree;
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="public-form min-h-screen flex flex-col bg-[#f8f9fb] text-base">
      {/* Banner */}
      {event.bannerImage || event.bannerImageMobile ? (
        <EventBannerBand banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} />
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

      {/* Main Content */}
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-4 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">Complete Your Registration</h2>
            <p className="text-sm text-slate-500 mt-1">
              Review your details and fill in any missing information to finalize your registration.
            </p>
            {(chosenType ?? data.ticketType) && (
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-1.5">
                <CheckCircle className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium text-primary">
                  {(chosenType ?? data.ticketType)?.name}
                  {data.linkRate ? ` · ${data.linkRate.name}` : ""}
                </span>
              </div>
            )}
          </div>

          <div className="p-4 sm:p-6 sm:px-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit, showBlockedSubmit)} autoComplete={tablet ? "off" : undefined} className="space-y-8">

                {/* Section: Registration type — only when the organizer's
                    import didn't set one. Prices shown are today's rate; the
                    server re-resolves them on submit. */}
                {showTypePicker && (
                  <div className="space-y-5" data-form-error-section>
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">
                      Registration Type
                    </h3>
                    <p className="text-xs text-slate-500">
                      Choose the category that applies to you.
                      {data.linkRate ? ` Every option is at the ${data.linkRate.name} rate.` : ""}
                    </p>
                    {selectableTypes.length === 0 ? (
                      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        No registration types are available right now. Please contact the event
                        organizer.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectableTypes.map((tt) => (
                          <button
                            key={tt.id}
                            type="button"
                            disabled={!tt.available}
                            onClick={() => form.setValue("ticketTypeId", tt.id, { shouldValidate: true })}
                            className={`w-full text-left rounded-lg border p-4 transition ${
                              chosenTypeId === tt.id
                                ? "border-primary bg-primary/5 ring-1 ring-primary"
                                : "border-slate-200 hover:border-slate-300"
                            } ${!tt.available ? "opacity-50 cursor-not-allowed" : ""}`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="font-medium text-slate-800">{tt.name}</div>
                                {tt.description && (
                                  <div className="text-xs text-slate-500 mt-0.5">{tt.description}</div>
                                )}
                                {tt.tierName && (
                                  <div className="text-xs text-slate-500 mt-0.5">{tt.tierName} rate</div>
                                )}
                              </div>
                              <div className="text-sm font-semibold text-slate-800 whitespace-nowrap">
                                {tt.price > 0 ? `${tt.currency} ${tt.price.toFixed(2)}` : "Free"}
                              </div>
                            </div>
                            {!tt.available && (
                              <div className="text-xs text-slate-500 mt-1">Sold out</div>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {form.formState.errors.ticketTypeId && (
                      <p className="text-sm text-red-600" data-form-error="Registration type">
                        {form.formState.errors.ticketTypeId.message}
                      </p>
                    )}
                  </div>
                )}

                {/* Section: Your Details (Read-Only) */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Your Details</h3>
                  <p className="text-xs text-slate-500">These details were provided by the event organizer and cannot be changed here.</p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label htmlFor="cr-first-name" className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-slate-400" /> First Name
                      </label>
                      <Input id="cr-first-name" autoComplete="given-name" value={attendee.firstName} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="cr-last-name" className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-slate-400" /> Last Name
                      </label>
                      <Input id="cr-last-name" autoComplete="family-name" value={attendee.lastName} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="cr-email" className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                      <Lock className="h-3 w-3 text-slate-400" /> Email
                    </label>
                    <Input id="cr-email" autoComplete="email" value={attendee.email} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                  </div>
                </div>

                {/* Section: Complete Your Details (Editable) */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Complete Your Details</h3>

                  <div className="grid grid-cols-1 sm:grid-cols-[100px_1fr_1fr] gap-4">
                    <FormField control={form.control} name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Title <span className="text-red-400">*</span></FormLabel>
                          <FormControl>
                            <TitleSelect value={field.value || ""} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="jobTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Position <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input autoComplete={fieldAutoComplete("organization-title")} placeholder="Physician" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="organization"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Organization <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input autoComplete={fieldAutoComplete("organization")} placeholder="Acme Inc." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Mobile Number <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input type="tel" autoComplete={fieldAutoComplete("tel")} placeholder="+1 234 567 8900" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="country"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Country <span className="text-red-400">*</span></FormLabel>
                          <FormControl>
                            <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  <FormField control={form.control} name="additionalEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">Additional Email</FormLabel>
                        <FormControl><Input autoComplete="off" type="email" placeholder="alternate@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">City <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input autoComplete={fieldAutoComplete("address-level2")} placeholder="Dubai" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="role"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Role <span className="text-red-400">*</span></FormLabel>
                          <FormControl>
                            <RoleSelect value={field.value} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="specialty"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Specialty <span className="text-red-400">*</span></FormLabel>
                          <FormControl>
                            <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    {form.watch("specialty") === "Others" && (
                      <FormField control={form.control} name="customSpecialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Others (specify) <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    )}
                  </div>

                  {showsField(event.formFields, "dietaryReqs") && (
                  <FormField control={form.control} name="dietaryReqs"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">Dietary Requirements</FormLabel>
                        <FormControl><Input autoComplete="off" placeholder="e.g. Vegetarian, Halal" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}
                </div>

                {/* Section: Member Details (conditional) */}
                {isMember && (
                  <div className="space-y-5">
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Membership Details</h3>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm text-amber-800">
                        Please provide your membership details below. You will be required to present your valid member ID at the time of event attendance for verification.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="associationName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Association / Society Name</FormLabel>
                            <FormControl><Input placeholder="e.g. American Medical Association" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="memberId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Member ID <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input placeholder="e.g. MEM-12345" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                  </div>
                )}

                {/* Section: Student Details (conditional) */}
                {isStudent && (
                  <div className="space-y-5">
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Student Details</h3>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm text-amber-800">
                        Please provide your student ID details below. You will be required to present a valid student ID at the time of event attendance for verification.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField control={form.control} name="studentId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Student ID <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input placeholder="e.g. STU-2024-001" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      {/* Its own switch — an organizer can ask for the ID
                          without demanding an expiry date. */}
                      {showStudentExpiry && (
                        <FormField control={form.control} name="studentIdExpiry"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Student ID Expiry Date <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input type="date" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      )}
                    </div>
                  </div>
                )}

                {/* Section: Supporting document, from the type's own policy (as on the public form) */}
                {needsDocument && (
                  <SupportingDocumentField
                    slug={slug}
                    label={supportingDocumentLabel(docPolicy)}
                    required={supportingDocumentBlocks(docPolicy)}
                    instructions={supportingDocumentInstructions(docPolicy)}
                    value={supportingDoc}
                    onChange={setSupportingDoc}
                    error={docError}
                    onError={setDocError}
                    onBeforeUpload={() => setSubmitNotice(null)}
                  />
                )}

                {showBilling && (
                  <BillingDetailsSection control={form.control} billingSame={billingSame} onBillingSameChange={setBillingSame} autoCompleteOff={tablet} />
                )}

                {/* Section: Create Account (not on the desk's shared tablet) */}
                {!tablet && (
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Create Your Account</h3>
                  <p className="text-xs text-slate-500">Set a password to access your registration portal, view your details, and make payments online.</p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Password</FormLabel>
                          <FormControl><Input autoComplete="new-password" type="password" placeholder="Min. 6 characters" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="confirmPassword"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Confirm Password</FormLabel>
                          <FormControl><Input autoComplete="new-password" type="password" placeholder="Re-enter password" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>
                </div>

                )}

                {/* Section: Terms & Conditions */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Terms and Conditions</h3>
                  <div className="max-h-[300px] overflow-y-auto bg-slate-50 rounded-lg border border-slate-200 p-4">
                    <div className="rich-content-tables prose prose-slate max-w-none text-sm leading-relaxed [&>*]:mb-4 [&>*:last-child]:mb-0"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.registrationTermsHtml || DEFAULT_REGISTRATION_TERMS_HTML) }} />
                  </div>

                  <FormField control={form.control} name="agreeTerms"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-start gap-4">
                          {/* In FormControl so tapping the sentence ticks the box. */}
                          <FormControl>
                            <Checkbox
                              checked={field.value === true}
                              onCheckedChange={(checked) => field.onChange(checked === true ? true : undefined)}
                              className="mt-0.5"
                            />
                          </FormControl>
                          <FormLabel className="text-sm text-slate-700 font-normal cursor-pointer leading-snug">
                            I agree to the terms and conditions
                          </FormLabel>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )} />
                </div>

                {/* What stopped the last tap, next to the button. */}
                {submitNotice && (
                  <p role="alert" className="text-sm font-medium text-red-600 text-center sm:text-right">{submitNotice}</p>
                )}

                {/* Submit: full width on a phone */}
                <div className="flex items-center justify-end pt-2">
                  <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 text-base w-full sm:w-auto h-12 sm:h-10">
                    {submitting ? (
                      <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Submitting...</>
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
              </form>
            </Form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CompleteRegistrationPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    }>
      <CompleteRegistrationContent />
    </Suspense>
  );
}

const TABLET_IDLE_MS = 5 * 60_000;
const HAND_BACK_SECONDS = 20;

interface HandBackDetails {
  name: string;
  email: string;
  typeName: string | null;
  eventName: string;
  eventDate: string;
  venue: string | null;
  /** The confirmation email went out (the route says when it did not). */
  emailed: boolean;
}

/**
 * The desk tablet's screen after submitting (docs/ONSITE_DESK_PLAN.md §5.3):
 * what they registered as, where their confirmation went, and what happens
 * next. It clears itself: the desk opened this tab, so it closes; a tab the
 * desk typed in by hand cannot close, so it is blanked instead.
 */
function TabletHandBack({ details }: { details: HandBackDetails }) {
  const [left, setLeft] = useState(HAND_BACK_SECONDS);
  useEffect(() => {
    const tick = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    const close = setTimeout(() => {
      window.close();
      // Still here: the tab was not opened by script, so it cannot close.
      setTimeout(() => window.location.replace("about:blank"), 500);
    }, HAND_BACK_SECONDS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(close);
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-lg">
        <div className="bg-gradient-primary px-8 py-6 text-white">
          <p className="text-xs font-medium uppercase tracking-wider opacity-90">Registration complete</p>
          <h1 className="mt-1 text-xl font-semibold">{details.eventName}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm opacity-90">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-4 w-4" /> {format(new Date(details.eventDate), "MMM d, yyyy")}
            </span>
            {details.venue && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4" /> {details.venue}
              </span>
            )}
          </p>
        </div>
        <div className="space-y-6 p-8">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-50">
              <CheckCircle className="h-7 w-7 text-green-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">You&apos;re all set, {details.name}</h2>
              <p className="text-sm text-slate-500">Thank you for completing your registration.</p>
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
            {details.typeName && (
              <div>
                <dt className="text-xs uppercase tracking-wider text-slate-400">Registration type</dt>
                <dd className="font-medium text-slate-800">{details.typeName}</dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-slate-400">Email</dt>
              <dd className="truncate font-medium text-slate-800">{details.email}</dd>
            </div>
          </dl>

          <div className="space-y-2 text-sm text-slate-600">
            {details.emailed ? (
              <p>
                Your confirmation, with your entry barcode, has been emailed to{" "}
                <span className="font-medium text-slate-800">{details.email}</span>. Keep it for entry to the sessions.
              </p>
            ) : (
              <p>We could not email your confirmation just now. The registration desk will make sure you receive it.</p>
            )}
            <p className="font-medium text-slate-800">Please hand the tablet back to the registration desk; they will print your badge.</p>
          </div>

          <p className="text-center text-xs text-slate-400 tabular-nums">This screen clears in {left} s.</p>
        </div>
      </div>
    </div>
  );
}
