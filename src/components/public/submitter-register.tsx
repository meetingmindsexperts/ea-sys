"use client";

/**
 * Shared submitter self-registration page — ONE implementation behind BOTH
 * public entry points (the no-cross-caller-duplication rule):
 *
 *   /e/[slug]/abstract/register  → variant "abstract"  (submit an abstract)
 *   /e/[slug]/proposal/register  → variant "proposal"  (propose a session)
 *
 * Both create the SAME thing server-side — a SUBMITTER account + Speaker via
 * POST /api/public/events/[slug]/submitter (or the abstract-start sign-in path
 * for existing accounts) — one login covers abstracts AND session proposals.
 * The variant only flips copy, the welcome HTML source, the abstract-only
 * gate/deadline, and where the person lands after signing in.
 *
 * NOTE (owner decision, Aug 5 2026): a PROPOSAL signup does NOT auto-create a
 * complimentary registration — the organizer grants attendance per person
 * (comp or payable) from the proposal detail / speaker page. ABSTRACT signups
 * still auto-mint the comp Faculty companion (badge/barcode), unchanged.
 */

import { useState, useEffect, useRef, type ReactNode } from "react";
import { scrollToFirstFormError } from "@/lib/form-error-scroll";
import { useParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  presenterRateOptions,
  type PresenterTicketTypeCandidate,
} from "@/lib/presenter-tiers";
import { EventBannerBand } from "@/components/public/event-banner";
import { SupportingDocumentField, type UploadedDocument } from "@/components/public/registration-form-extras";
import {
  readIdentityEvidencePolicy,
  type IdentityEvidencePolicy,
} from "@/lib/identity-evidence";
import {
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentLabel,
  supportingDocumentInstructions,
  type SupportingDocumentPolicy,
} from "@/lib/supporting-document";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { format } from "date-fns";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
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

export type SubmitterRegisterVariant = "abstract" | "proposal";

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
  bannerImageMobile?: string | null;
  footerHtml: string | null;
  abstractWelcomeHtml: string | null;
  sessionProposalWelcomeHtml?: string | null;
  organization: { name: string; logo: string | null };
  sessionProposalSettings?: {
    sessionProposalDeadline: string | null;
  };
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
  /** Used to offer presenter rates on the abstract flow (plan D2), and for the
   *  chosen type's ID and document switches (Nov 4, 2026). */
  ticketTypes?: (PresenterTicketTypeCandidate & Partial<IdentityEvidencePolicy> & SupportingDocumentPolicy)[];
}

const VARIANT_COPY: Record<
  SubmitterRegisterVariant,
  {
    pageHeading: string;
    accountHeading: string;
    accountSub: string;
    signinHeading: string;
    signinSub: string;
    successLead: string;
    nextStep3: string;
    /** login-page named redirect (see /e/[slug]/login redirect handling). */
    loginRedirect: string;
    logPrefix: string;
  }
> = {
  abstract: {
    pageHeading: "Abstract Submission: Presenter Registration",
    accountHeading: "Create your presenter account",
    accountSub: "You'll use these credentials to sign in and submit your abstract.",
    signinHeading: "Sign in to submit your abstract",
    signinSub:
      "This email already has an account from another event. Sign in and we'll add you to this one, then take you to the abstract form.",
    successLead: "Your presenter account has been created. Log in to submit your abstract for",
    nextStep3: "Submit your abstract for review",
    loginRedirect: "abstracts",
    logPrefix: "abstract/register",
  },
  proposal: {
    pageHeading: "Session Proposal: Proposer Registration",
    accountHeading: "Create your proposer account",
    accountSub: "You'll use these credentials to sign in and propose a session.",
    signinHeading: "Sign in to propose a session",
    signinSub:
      "This email already has an account from another event. Sign in and we'll add you to this one, then take you to the proposal form.",
    successLead: "Your proposer account has been created. Log in to propose a session for",
    nextStep3: "Submit your session proposal",
    loginRedirect: "session-proposals",
    logPrefix: "proposal/register",
  },
};

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
  /** Presenter rate. Only required when the event offers any (plan D4). */
  ticketTypeId: z.string().optional(),
  /** Required only when the chosen type asks for them; checked in onSubmit. */
  memberId: z.string().optional(),
  studentId: z.string().optional(),
  studentIdExpiry: z.string().optional(),
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

function stepSubheading(step: 1 | 2, hasExistingPerson: boolean): string {
  if (step === 1) return "Create your account to get started.";
  if (hasExistingPerson) return "Check your details to continue.";
  return "Fill in your details to complete registration.";
}

/**
 * Branded chrome — event banner + info strip + footer — shared by every
 * render state of this page so the loading/error/success screens carry the
 * same event branding as the main form. This markup lives here ONCE; render
 * states wrap their content in <BrandedShell> rather than re-inlining it.
 */
function BrandedShell({
  event,
  showAbstractDeadline,
  children,
}: {
  event: Event;
  showAbstractDeadline: boolean;
  children: ReactNode;
}) {
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
            <div className="flex items-center gap-1.5 text-base text-slate-500">
              <Calendar className="h-4 w-4 text-primary/70" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 text-base text-slate-500">
                <MapPin className="h-4 w-4 text-primary/70" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
            {showAbstractDeadline && event.abstractSettings?.abstractDeadline && (
              <div className="flex items-center gap-1.5 text-base text-amber-600 font-medium">
                <FileText className="h-4 w-4" />
                <span>Deadline: {format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {children}

      {/* Footer */}
      {event.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center py-6">
          {/* Footer content constrained to the BODY's width (max-w-5xl) so it
              lines up with the page content instead of running full-bleed. */}
          <div className="rich-content-tables prose prose-slate max-w-5xl mx-auto px-4 sm:px-6 [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
        </div>
      )}
    </div>
  );
}

export function SubmitterRegisterPage({ variant }: { variant: SubmitterRegisterVariant }) {
  const copy = VARIANT_COPY[variant];

  const params = useParams();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);

  /**
   * Presenter rates on offer right now (plan D2). Abstracts only: session
   * proposals create no registration at all (the Aug 5 decision) so they must
   * never show a rate.
   *
   * An EMPTY list is the D4 fallback, not an error. It means this event has no
   * presenter tiers configured, the step does not render, and the door mints
   * the complimentary Faculty registration exactly as before. Every existing
   * event is in that state until an organizer sets rates, which is what makes
   * this safe to ship.
   */
  const rateOptions =
    variant === "abstract" ? presenterRateOptions(event?.ticketTypes) : [];
  const offersRates = rateOptions.length > 0;
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // What stopped the last Create Account tap, shown by the button.
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  // Step-1 mode: "idle" = new-account sign-up; "signin" = an account already
  // exists for the entered email, so we ask for the password and sign them in
  // instead of making them re-register.
  const [emailCheck, setEmailCheck] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "signin" }
  >({ state: "idle" });
  const [signingIn, setSigningIn] = useState(false);
  // Set once an EXISTING account has signed in on an event that charges
  // presenters: step 2 then shows "Your registration" (who they are + the
  // rate picker) instead of the new-account details form.
  const [existingPerson, setExistingPerson] = useState<{ name: string; email: string } | null>(null);
  const router = useRouter();

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    // The page scrolls to the first error itself (form-error-scroll.ts); the
    // library's jump focused a lower text field first (review L4).
    shouldFocusError: false,
    defaultValues: {
      email: "", password: "", confirmPassword: "",
      title: "", role: "", firstName: "", lastName: "",
      additionalEmail: "", organization: "", jobTitle: "",
      phone: "", city: "", country: "",
      specialty: "", customSpecialty: "",
      ticketTypeId: "",
      memberId: "", studentId: "", studentIdExpiry: "",
    },
  });
  // The chosen presenter rate's type asks for these exactly as on the delegate
  // form. Someone already registered for the event keeps that registration, so
  // they are not asked (the server applies the same rule).
  const [supportingDoc, setSupportingDoc] = useState<UploadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [registeredHere, setRegisteredHere] = useState(false);
  // The rate an upload started under: a file that finishes after the person
  // picked another rate is not that rate's evidence.
  const uploadForType = useRef<string | undefined>(undefined);
  const chosenTypeId = form.watch("ticketTypeId");
  const chosenType = offersRates && !registeredHere
    ? event?.ticketTypes?.find((t) => t.id === chosenTypeId) ?? null
    : null;
  const evidencePolicy = readIdentityEvidencePolicy(chosenType);
  const needsDocument = requiresSupportingDocument(chosenType);
  // The notice describes the LAST tap; once the person changes anything it is
  // out of date (review of e7cd2b2d: picking the missing category left it up).
  useEffect(() => {
    const sub = form.watch(() => setSubmitNotice(null));
    return () => sub.unsubscribe();
  }, [form]);

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

        // The submissions-open gate + deadline are ABSTRACT settings — the
        // proposal variant has no open/close toggle in v1 (the organizer
        // controls exposure by sharing the link).
        if (variant === "abstract") {
          if (!data.abstractSettings?.allowAbstractSubmissions) {
            setError("Abstract submissions are not open for this event");
          }
          if (data.abstractSettings?.abstractDeadline) {
            const deadline = new Date(data.abstractSettings.abstractDeadline);
            if (new Date() > deadline) {
              setError("The abstract submission deadline has passed");
            }
          }
        } else if (data.sessionProposalSettings?.sessionProposalDeadline) {
          // Proposal intake ends automatically at the deadline (Aug 6, 2026).
          const deadline = new Date(data.sessionProposalSettings.sessionProposalDeadline);
          if (new Date() > deadline) {
            setError("The session proposal deadline has passed");
          }
        }
      } catch (err) {
        console.error(`[${copy.logPrefix}] Failed to load event:`, err);
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug, variant, copy.logPrefix]);

  const welcomeHtml =
    variant === "proposal" ? event?.sessionProposalWelcomeHtml : event?.abstractWelcomeHtml;

  // A tap that did not go through: scroll to the first error once it has
  // rendered (the dropdowns have no focusable field for react-hook-form to
  // jump to) and name what is missing by the button.
  function showBlockedSubmit() {
    setSubmitNotice(null);
    setTimeout(() => setSubmitNotice(scrollToFirstFormError()), 50);
  }

  async function onSubmit(data: RegisterForm) {
    setSubmitNotice(null);
    // Required only when the event actually offers rates (D4). Enforced again
    // server-side, since a form can be bypassed.
    if (offersRates && !data.ticketTypeId) {
      form.setError("ticketTypeId", { message: "Please choose a registration type" });
      showBlockedSubmit();
      return;
    }
    // The chosen type's ID and document are NOT pre-checked here: someone who
    // already holds a registration on this event is not asked for them (nothing
    // new is made), and only the server can know that without telling a stranger
    // who is registered. The server names what is missing and showEvidenceRefusal
    // marks each field.
    // An existing account fills in the SAME page, but its details go to the
    // sign-in door, which verifies the password again and sets them up.
    if (existingPerson) {
      await completeExistingSignIn(data);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/submitter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Tells the shared route which flow this is — proposal signups skip
          // the abstract-submissions gate + get the proposal-worded welcome.
          source: variant,
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
          ticketTypeId: data.ticketTypeId || undefined,
          ...evidencePayload(data),
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
        console.error(`[${copy.logPrefix}] Non-JSON response:`, res.status);
        toast.error("Server error. Please try again.");
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        console.warn(`[${copy.logPrefix}] Registration rejected:`, res.status, result.error);
        if (showEvidenceRefusal(result)) {
          setSubmitting(false);
          return;
        }
        toast.error(result.error || "Registration failed");
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error(`[${copy.logPrefix}] Submission failed:`, err);
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  // Step-1 primary action for the sign-UP path: validate the email, then check
  // whether an account already exists. If it does, flip to sign-IN mode (don't
  // make an existing user re-register); otherwise validate the password fields
  // and move to the details step.
  async function handleContinue() {
    if (!(await form.trigger(["email"]))) return;
    setEmailCheck({ state: "checking" });
    let hasAccount = false;
    try {
      const res = await fetch(`/api/public/events/${slug}/check-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.getValues("email") }),
      });
      if (res.ok) hasAccount = !!(await res.json()).hasAccount;
    } catch (err) {
      console.warn(`[${copy.logPrefix}] check-email failed, continuing as new`, err);
    }
    if (hasAccount) {
      setEmailCheck({ state: "signin" });
      return;
    }
    const pwOk = await form.trigger(["password", "confirmPassword"]);
    setEmailCheck({ state: "idle" });
    if (pwOk) setStep(2);
  }

  // Step-1 sign-IN path (existing account).
  //
  // Owner decision, Sep 29 2026: an existing account gets the SAME details
  // page as a new one. Signing in only checks the password and fetches the
  // details we already hold (`intent: "lookup"`, nothing is created); step 2
  // then shows them prefilled and editable, with the presenter rates below,
  // and submitting sets the person up with what they confirmed. Before this,
  // signing in skipped the details entirely: the speaker was built from a
  // registration on this event only (usually none, so just a name), and on an
  // event charging presenters no rate was ever asked for, which the server
  // refused (53 refusals from 9 people on MEHF2027).
  async function handleExistingSignIn() {
    if (!(await form.trigger(["email", "password"]))) return;
    setSigningIn(true);
    try {
      const email = form.getValues("email");
      const password = form.getValues("password");
      const res = await fetch(`/api/public/events/${slug}/abstract-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, source: variant, intent: "lookup" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Sign in failed. Please check your password.");
        return;
      }
      const prefill = (data.prefill ?? {}) as Partial<Record<keyof RegisterForm, string>>;
      for (const [key, value] of Object.entries(prefill)) {
        if (value) form.setValue(key as keyof RegisterForm, value, { shouldValidate: false });
      }
      // The new-account schema also checks the confirmation; the password was
      // just verified, so mirror it rather than asking twice.
      form.setValue("confirmPassword", password);
      const name = [prefill.firstName, prefill.lastName].filter(Boolean).join(" ");
      setRegisteredHere(data.registeredHere === true);
      setExistingPerson({ name, email });
      setStep(2);
    } catch (err) {
      console.error(`[${copy.logPrefix}] existing sign-in failed`, err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSigningIn(false);
    }
  }

  // Step 2 submit for an existing account: set them up as a submitter with the
  // details they confirmed and the rate they chose (abstract-start verifies the
  // password again), THEN sign in so the fresh session carries the upgraded
  // role, then go straight to the variant's home surface.
  async function completeExistingSignIn(data: RegisterForm) {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/abstract-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          source: variant,
          ticketTypeId: data.ticketTypeId || undefined,
          ...evidencePayload(data),
          details: {
            title: data.title || undefined,
            role: data.role || undefined,
            firstName: data.firstName,
            lastName: data.lastName,
            additionalEmail: data.additionalEmail || undefined,
            organization: data.organization,
            jobTitle: data.jobTitle,
            phone: data.phone,
            city: data.city,
            country: data.country,
            specialty: data.specialty,
            customSpecialty: data.customSpecialty || undefined,
          },
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (showEvidenceRefusal(result)) return;
        toast.error(result.error || "Something went wrong. Please try again.");
        return;
      }
      const signInRes = await signIn("credentials", {
        email: data.email,
        password: data.password,
        surface: "EVENT_PAGE",
        redirect: false,
      });
      if (signInRes?.error) {
        toast.error(
          signInRes.code === "RateLimited"
            ? "Too many failed sign-in attempts. Please wait a few minutes and try again."
            : "Couldn't sign you in automatically. Please sign in and try again."
        );
        return;
      }
      // Existing person signing in → land on My Details (ONE shared landing
      // for both variants, owner decision Aug 4 2026 — the page adapts its
      // actions to the person's surfaces).
      router.push(`/events/${result.eventId}/my-details`);
    } catch (err) {
      console.error(`[${copy.logPrefix}] existing sign-in failed`, err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * The server refused for the chosen type's ID or document: mark each field it
   * named and take the person there. False when the refusal was something else.
   */
  function showEvidenceRefusal(result: { error?: string; fields?: string[] } | null): boolean {
    const fields = result?.fields;
    if (!Array.isArray(fields) || fields.length === 0) return false;
    if (!chosenType) {
      // A page that does not show these fields (loaded before they existed):
      // a reload brings them.
      toast.error(`${result?.error ?? "Some details are missing."} Please reload the page.`);
      return true;
    }
    const required: Record<string, string> = {
      memberId: "Member ID is required",
      studentId: "Student ID is required",
      studentIdExpiry: "A valid student ID expiry date is required",
    };
    for (const f of fields) {
      if (f === "supportingDocument") setDocError(`Please attach your ${supportingDocumentLabel(chosenType)} to continue.`);
      else if (f in required) form.setError(f as "memberId" | "studentId" | "studentIdExpiry", { message: required[f] });
    }
    showBlockedSubmit();
    return true;
  }

  /** Only what the chosen type asks for is sent. */
  function evidencePayload(data: RegisterForm) {
    return {
      memberId: evidencePolicy.requiresMemberId ? data.memberId || undefined : undefined,
      studentId: evidencePolicy.requiresStudentId ? data.studentId || undefined : undefined,
      studentIdExpiry: evidencePolicy.requiresStudentIdExpiry ? data.studentIdExpiry || undefined : undefined,
      supportingDocumentUrl: needsDocument ? supportingDoc?.url : undefined,
      supportingDocumentFilename: needsDocument ? supportingDoc?.filename : undefined,
    };
  }

  // What the chosen rate's type asks for, worded as on the delegate form.
  const evidenceFields = chosenType ? (
    <>
      {evidencePolicy.requiresMemberId && (
        <FormField control={form.control} name="memberId"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm font-medium text-slate-600">Member ID <span className="text-red-400">*</span></FormLabel>
              <FormControl><Input placeholder="e.g. MEM-12345" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
      )}
      {evidencePolicy.requiresStudentId && (
        <div className="space-y-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Please provide your student ID details below. You will be required to present a valid student ID at the time of event attendance for verification.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField control={form.control} name="studentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-slate-600">Student ID <span className="text-red-400">*</span></FormLabel>
                  <FormControl><Input placeholder="e.g. STU-2024-001" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            {evidencePolicy.requiresStudentIdExpiry && (
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
      {needsDocument && (
        <SupportingDocumentField
          slug={slug}
          label={supportingDocumentLabel(chosenType)}
          required={supportingDocumentBlocks(chosenType)}
          instructions={supportingDocumentInstructions(chosenType)}
          value={supportingDoc}
          onChange={(doc) => {
            if (doc && uploadForType.current !== form.getValues("ticketTypeId")) return;
            setSupportingDoc(doc);
          }}
          error={docError}
          onError={setDocError}
          onBeforeUpload={() => {
            uploadForType.current = form.getValues("ticketTypeId");
            setSubmitNotice(null);
          }}
        />
      )}
    </>
  ) : null;

  // The presenter-rate picker, at the foot of step 2's details form, which new
  // and existing accounts share.
  const ratePicker = offersRates ? (
    <div className="space-y-5">
      <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">
        Registration
      </h3>
      <FormField control={form.control} name="ticketTypeId"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-sm font-medium text-slate-600">
              Registration type <span className="text-red-400">*</span>
            </FormLabel>
            <div className="space-y-2">
              {rateOptions.map((o) => (
                <label
                  key={o.ticketTypeId}
                  className={cn(
                    "flex items-center justify-between gap-4 rounded-lg border p-4 cursor-pointer transition-colors",
                    field.value === o.ticketTypeId
                      ? "border-primary bg-primary/5"
                      : "border-slate-200 hover:border-slate-300",
                  )}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <input
                      type="radio"
                      name="ticketTypeId"
                      value={o.ticketTypeId}
                      checked={field.value === o.ticketTypeId}
                      onChange={() => {
                        field.onChange(o.ticketTypeId);
                        form.clearErrors("ticketTypeId");
                        // A document uploaded for another type is not this type's evidence.
                        setSupportingDoc(null);
                        setDocError(null);
                      }}
                      className="h-4 w-4 shrink-0 accent-[#00aade]"
                    />
                    <span className="min-w-0">
                      <span className="block text-base font-medium text-slate-800 truncate">
                        {o.ticketTypeName}
                      </span>
                      <span className="block text-xs text-slate-400">{o.tierName}</span>
                    </span>
                  </span>
                  <span className="text-base font-semibold text-slate-800 whitespace-nowrap tabular-nums">
                    {o.currency} {o.price.toFixed(2)}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-sm text-slate-400">
              You will receive a quote by email. Payment is not required to
              submit your abstract, and the organizing team will confirm your
              fee once your submission has been reviewed.
            </p>
            <FormMessage />
          </FormItem>
        )} />
      {evidenceFields}
    </div>
  ) : null;

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
    const errorCard = (
      <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
        <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle className="h-7 w-7 text-red-500" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
        <p className="text-slate-500 text-base">Please check the link or contact the event organizer.</p>
      </div>
    );
    // A business error (e.g. submissions closed) has the event loaded — keep
    // the page branded. Only a hard load failure (!event) gets the bare card.
    return event ? (
      <BrandedShell event={event} showAbstractDeadline={variant === "abstract"}>
        <div className="flex-1 flex items-center justify-center p-4">{errorCard}</div>
      </BrandedShell>
    ) : (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">{errorCard}</div>
    );
  }

  if (success) {
    return (
      <BrandedShell event={event} showAbstractDeadline={variant === "abstract"}>
        <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="h-9 w-9 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Account Created!</h2>
          <p className="text-slate-500 text-base leading-relaxed mb-2">
            {copy.successLead}
          </p>
          <p className="font-semibold text-slate-800 mb-6">{event.name}</p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6 border border-slate-100">
            <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2">Next Steps</p>
            <ol className="space-y-2">
              {["Log in with your email and password", "Find this event in your dashboard", copy.nextStep3].map(
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
          <Link href={`/e/${slug}/login?redirect=${copy.loginRedirect}`}>
            <Button className="btn-gradient w-full h-11 font-semibold rounded-xl gap-2 text-base">
              Log In to Continue <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        </div>
      </BrandedShell>
    );
  }

  return (
    <BrandedShell event={event} showAbstractDeadline={variant === "abstract"}>

      {/* Main Content */}
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-4 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">{copy.pageHeading}</h2>
            <p className="text-base text-slate-500 mt-1">
              {stepSubheading(step, Boolean(existingPerson))}
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

          <div className="p-4 sm:p-6 sm:px-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit, showBlockedSubmit)} className="space-y-6">

                {/* ── STEP 1: Account ── */}
                {step === 1 && (
                  <div className="space-y-5">
                    {/* Welcome text — full width */}
                    {welcomeHtml && (
                      <div className="rich-content-tables prose prose-slate max-w-none [&>*]:mb-4 [&>*:last-child]:mb-0"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(welcomeHtml) }} />
                    )}

                    {/* Account form — narrower centered */}
                    <div className="max-w-md mx-auto space-y-5 pt-4">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Lock className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-slate-800">
                          {emailCheck.state === "signin" ? copy.signinHeading : copy.accountHeading}
                        </h3>
                        <p className="text-sm text-slate-500">
                          {emailCheck.state === "signin" ? copy.signinSub : copy.accountSub}
                        </p>
                      </div>
                    </div>

                    <FormField control={form.control} name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Email Address <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input autoComplete="email" type="email" placeholder="john@university.edu" className="rounded-lg border-slate-200 text-base" disabled={emailCheck.state === "signin"} {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                    <FormField control={form.control} name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Password <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input autoComplete={emailCheck.state === "signin" ? "current-password" : "new-password"} type="password" placeholder={emailCheck.state === "signin" ? "Your password" : "Min. 6 characters"} className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />

                    {emailCheck.state !== "signin" && (
                      <FormField control={form.control} name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Confirm Password <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="new-password" type="password" placeholder="Re-enter password" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    )}

                    {emailCheck.state === "signin" ? (
                      <>
                        <Button type="button" className="w-full rounded-lg font-semibold btn-gradient py-3 text-base"
                          disabled={signingIn}
                          onClick={handleExistingSignIn}>
                          {signingIn ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…</>
                          ) : (
                            <>Sign in &amp; continue <ChevronRight className="ml-1 h-5 w-5" /></>
                          )}
                        </Button>
                        <p className="text-center text-sm">
                          <a
                            href={`/e/${slug}/forgot-password?from=${variant}`}
                            className="text-primary hover:underline font-medium"
                          >
                            Forgot password?
                          </a>
                        </p>
                        <p className="text-center text-sm text-slate-400">
                          Not you?{" "}
                          <button
                            type="button"
                            className="text-primary hover:underline font-medium"
                            onClick={() => { form.setValue("password", ""); setEmailCheck({ state: "idle" }); }}
                          >
                            Use a different email
                          </button>
                        </p>
                      </>
                    ) : (
                      <>
                        <Button type="button" className="w-full rounded-lg font-semibold btn-gradient py-3 text-base"
                          disabled={emailCheck.state === "checking"}
                          onClick={handleContinue}>
                          {emailCheck.state === "checking" ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking…</>
                          ) : (
                            <>Continue <ChevronRight className="ml-1 h-5 w-5" /></>
                          )}
                        </Button>
                        {/*
                          Returning submitters had no way in from here. The
                          Continue button DOES flip to sign-in mode when the
                          typed email already has an account, but that is only
                          discoverable by guessing; someone who knows they have
                          an account looks for a Sign in link, exactly as on the
                          delegate register page. Lands on the branded event
                          login, which routes by variant to My Abstracts or My
                          Session Proposals.
                        */}
                        <p className="text-center text-slate-400">
                          <span className="text-xs">Already have an account?{" "}</span>
                          <a
                            href={`/e/${slug}/login?redirect=${copy.loginRedirect}`}
                            className="text-md text-primary hover:underline font-medium"
                          >
                            Sign in
                          </a>
                        </p>
                      </>
                    )}
                    </div>
                  </div>
                )}

                {/* ── STEP 2: Contact Details ── */}
                {step === 2 && (
                  <>
                    {existingPerson && (
                      <p className="text-base text-slate-700">
                        Signed in as{" "}
                        <span className="font-semibold">{existingPerson.name || existingPerson.email}</span>
                        {existingPerson.name && <span className="text-slate-400"> ({existingPerson.email})</span>}
                        . We have filled in the details we hold; please check them before you continue.
                      </p>
                    )}
                    <div className="space-y-5">
                      <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Contact Details</h3>

                      <div className="grid grid-cols-1 sm:grid-cols-[100px_1fr_1fr] gap-4">
                        <FormField control={form.control} name="title"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Title <span className="text-red-400">*</span></FormLabel>
                              <FormControl>
                                <TitleSelect value={field.value} onChange={field.onChange} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">First Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input autoComplete="given-name" placeholder="John" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Last Name <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input autoComplete="family-name" placeholder="Doe" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField control={form.control} name="jobTitle"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Position <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input autoComplete="organization-title" placeholder="Professor, Researcher..." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="organization"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Organization <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input autoComplete="organization" placeholder="University of..." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField control={form.control} name="phone"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Mobile Number <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input type="tel" autoComplete="tel" placeholder="+1 234 567 8900" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        <FormField control={form.control} name="additionalEmail"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Additional Email</FormLabel>
                              <FormControl><Input autoComplete="off" type="email" placeholder="alternate@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                        <FormField control={form.control} name="city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">City <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input autoComplete="address-level2" placeholder="Dubai" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
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

                      <FormField control={form.control} name="customSpecialty"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Specialty (Specific)</FormLabel>
                            <FormControl><Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>

                    {/*
                      Presenter rate (plan D2). Rendered only when the event has
                      presenter tiers configured: with none, the submitter still
                      gets the complimentary Faculty registration and there is
                      nothing to choose (D4).
                    */}
                    {ratePicker}

                    {/* What stopped the last tap, next to the button. */}
                    {submitNotice && (
                      <p role="alert" className="text-sm font-medium text-red-600 text-center sm:text-right">{submitNotice}</p>
                    )}

                    {/* Navigation: full width on a phone, the main button first */}
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between pt-2">
                      <Button type="button" variant="outline" className="rounded-lg text-base w-full sm:w-auto" onClick={() => { setExistingPerson(null); setRegisteredHere(false); setStep(1); }}>
                        <ChevronLeft className="mr-1 h-4 w-4" /> Back
                      </Button>
                      <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 text-base w-full sm:w-auto h-12 sm:h-10">
                        {submitting ? (
                          <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> {existingPerson ? "Setting up…" : "Creating Account…"}</>
                        ) : (
                          <>{existingPerson ? "Continue" : "Create Account"} <ChevronRight className="ml-1 h-5 w-5" /></>
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
    </BrandedShell>
  );
}
