"use client";

import { showsField, type FormFieldVisibility } from "@/lib/registration-form-fields";
import { EventBannerBand } from "@/components/public/event-banner";
import { Suspense, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldErrors } from "react-hook-form";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { format } from "date-fns";
import Link from "next/link";
import { scrollToFirstFormError } from "@/lib/form-error-scroll";
import { clearRegisterDraft, readRegisterDraft, registerDraftKey, writeRegisterDraft } from "@/lib/register-draft";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
  Loader2,
  FileText,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  Lock,
  CheckCircle2,
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
import { BillingDetailsSection, SupportingDocumentField, billingFromPersonal, missingBillingFields } from "@/components/public/registration-form-extras";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import {
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentLabel,
  supportingDocumentInstructions,
} from "@/lib/supporting-document";
import { readIdentityEvidencePolicy, missingIdentityEvidence } from "@/lib/identity-evidence";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DEFAULT_REGISTRATION_TERMS_HTML } from "@/lib/default-terms";
import { isPresenterTierName } from "@/lib/presenter-tiers";
import { isExhibitorBadge } from "@/lib/badge-layout";
import { readDeskQrClaims } from "@/lib/desk-qr-rules";

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
  /** Either the tier or its ticket type carries a real seat limit (API-computed). */
  seatLimited?: boolean;
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
  virtualPrice: string | null;
  currency: string;
  quantity: number;
  soldCount: number;
  available: number;
  soldOut: boolean;
  /** Either the tier or its ticket type carries a real seat limit (API-computed). */
  seatLimited?: boolean;
  canPurchase: boolean;
  salesStarted: boolean;
  salesEnded: boolean;
  // Supporting-document policy — per TYPE, so the form reads it off whichever
  // type the registrant picked rather than matching the type's name.
  requiresDocument?: boolean;
  documentRequired?: boolean;
  documentLabel?: string | null;
  documentInstructions?: string | null;
  // Identity-evidence policy — same reasoning as the document block above:
  // read off the picked TYPE, never guessed from its name.
  requiresMemberId?: boolean;
  requiresStudentId?: boolean;
  requiresStudentIdExpiry?: boolean;
  pricingTiers?: PricingTierData[];
}

interface Event {
  id: string;
  name: string;
  slug: string;
  eventType?: string | null;
  description: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  bannerImageMobile?: string | null;
  footerHtml: string | null;
  registrationOpen?: boolean;
  supportEmail: string | null;
  registrationTermsHtml: string | null;
  registrationWelcomeHtml: string | null;
  taxRate: number | null;
  taxLabel: string | null;
  organization: { name: string; logo: string | null };
  ticketTypes: TicketType[];
  hasPromoCodes?: boolean;
  /** Rates whose link needs a sponsor's code, as slugs (code-required-tiers.ts). */
  codeRequiredTiers?: string[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
  agendaPublished?: boolean;
  /** "Show Remaining Tickets" toggle (opt-in, hidden by default). */
  showRemainingTickets?: boolean;
  /** Optional attendee fields the organiser left on the form (registration-form-fields.ts); absent = all shown. */
  formFields?: Partial<FormFieldVisibility>;
  /** Event-wide attendee cap reached (Settings → Maximum Attendees). */
  eventFull?: boolean;
}

// quantity >= this sentinel means "unlimited" — never show a seats-left count.
const UNLIMITED_SENTINEL = 999999;

/** A registration type option within the matched tier */
interface RegTypeOption {
  ticketTypeId: string;
  pricingTierId: string;
  regTypeName: string;
  description: string | null;
  price: number;
  /** Flat price when attending virtually (null ⇒ same as in-person `price`). */
  virtualPrice: number | null;
  currency: string;
  available: number;
  canPurchase: boolean;
  /** True when the tier/type has a real seat limit (quantity < sentinel). */
  hasSeatLimit: boolean;
  /** Supporting-document policy, carried from the ticket type. */
  requiresDocument: boolean;
  documentRequired: boolean;
  documentLabel: string | null;
  documentInstructions: string | null;
  /** Identity-evidence policy, carried from the ticket type. */
  requiresMemberId: boolean;
  requiresStudentId: boolean;
  requiresStudentIdExpiry: boolean;
}

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1, "Please select a category"),
  pricingTierId: z.string().optional(),
  attendanceMode: z.enum(["IN_PERSON", "VIRTUAL"]),
  title: z.string().min(1, "Title is required"),
  role: z.string().min(1, "Role is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  additionalEmail: z.string().email("Valid email is required").optional().or(z.literal("")),
  organization: z.string().min(1, "Organization is required"),
  jobTitle: z.string().min(1, "Position is required"),
  phone: z.string().min(1, "Mobile number is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  country: z.string().min(1, "Country is required"),
  specialty: z.string().min(1, "Specialty is required"),
  customSpecialty: z.string().optional(),
  dietaryReqs: z.string().optional(),
  // Member-specific fields
  associationName: z.string().optional(),
  memberId: z.string().optional(),
  // Student-specific fields
  studentId: z.string().optional(),
  studentIdExpiry: z.string().optional(),
  // Billing details
  taxNumber: z.string().optional(),
  billingFirstName: z.string().optional(),
  billingLastName: z.string().optional(),
  billingEmail: z.string().email().optional().or(z.literal("")),
  billingPhone: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZipCode: z.string().optional(),
  billingCountry: z.string().optional(),
  password: z.string(),
  confirmPassword: z.string(),
  // Registering by a desk QR asks for no password (docs/ONSITE_DESK_PLAN.md §8.2).
  deskMode: z.boolean(),
  agreeTerms: z.literal(true, { message: "You must agree to the terms and conditions" }),
}).superRefine((data, ctx) => {
  if (data.deskMode) return;
  if (data.password.length < 6) ctx.addIssue({ code: "custom", path: ["password"], message: "Password must be at least 6 characters" });
  if (!data.confirmPassword) ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "Please confirm your password" });
  else if (data.password !== data.confirmPassword) ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "Passwords do not match" });
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

type RegistrationForm = z.infer<typeof registrationSchema>;

function CategoryRegistrationContent() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const categorySlug = params.category as string;
  // `isPresenterTierName` slugifies its input, so the URL segment
  // ("presenter-early-bird") matches the same family the tier name does.
  const isPresenterCategory = isPresenterTierName(categorySlug);

  const searchParams = useSearchParams();
  // A desk QR for THIS form, still valid when the page opened: desk mode
  // (docs/ONSITE_DESK_PLAN.md §8.2). Only the form's look follows it; the
  // register route checks the token and every rule. Expired, or for another
  // form: the ordinary public form.
  const deskToken = searchParams.get("desk");
  const [deskQr] = useState(() => {
    const claims = readDeskQrClaims(deskToken);
    return claims && claims.rate === categorySlug && claims.expiresAt > Date.now() ? claims : null;
  });

  const [event, setEvent] = useState<Event | null>(null);
  const [formLabel, setFormLabel] = useState<string | null>(null);
  const [regTypeOptions, setRegTypeOptions] = useState<RegTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Desk mode has no account step: straight to the details.
  const [step, setStep] = useState<1 | 2>(deskQr ? 2 : 1);
  // Supporting document. Uploaded to its own endpoint BEFORE
  // submit (the registration POST is JSON and the body limit is 1MB, far under
  // a scanned letter), so what travels with the form is just the stored path.
  const [supportingDoc, setSupportingDoc] = useState<{ url: string; filename: string } | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  // What stopped the last Complete Registration tap, shown by the button.
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [billingSame, setBillingSame] = useState(true);
  const [promoCode, setPromoCode] = useState("");
  const [promoValidating, setPromoValidating] = useState(false);
  const [promoResult, setPromoResult] = useState<{ valid: boolean; code?: string; discountType?: string; discountValue?: number; discountAmount?: number; originalPrice?: number; finalPrice?: number; coveredBySponsor?: string | null; error?: string } | null>(null);
  const [showPromoInput, setShowPromoInput] = useState(false);
  const [emailCheck, setEmailCheck] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "conflict"; reason: "already_registered" }
  >({ state: "idle" });

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
    // The page scrolls to the first error itself (form-error-scroll.ts); the
    // library's jump focused a lower text field first (review L4).
    shouldFocusError: false,
    defaultValues: {
      ticketTypeId: "", pricingTierId: "", attendanceMode: "IN_PERSON", title: "", role: "",
      firstName: "", lastName: "", email: "", additionalEmail: "",
      organization: "", jobTitle: "", phone: "", city: "", state: "", zipCode: "",
      country: "", specialty: "", customSpecialty: "", dietaryReqs: "",
      associationName: "", memberId: "", studentId: "", studentIdExpiry: "",
      taxNumber: "", billingFirstName: "", billingLastName: "", billingEmail: "",
      billingPhone: "", billingAddress: "", billingCity: "", billingState: "", billingZipCode: "", billingCountry: "",
      password: "", confirmPassword: "", deskMode: !!deskQr,
      agreeTerms: undefined as unknown as true,
    },
  });
  // The form survives a reload (register-draft.ts). Saving waits until the
  // restore has been tried, or the page's own auto-selects on load would
  // overwrite the saved answers with an empty form.
  const draftKey = registerDraftKey(slug, categorySlug);
  const draftRestored = useRef(false);
  const draftState = useRef({ step: 1 as 1 | 2, billingSame: true, promoCode: "", supportingDoc: null as { url: string; filename: string } | null });
  const saveDraft = useCallback(() => {
    if (!draftRestored.current) return;
    writeRegisterDraft(draftKey, { ...draftState.current, values: form.getValues() as Record<string, unknown> });
  }, [draftKey, form]);

  // The notice describes the LAST tap; once the person changes anything it is
  // out of date (review of e7cd2b2d: picking the missing category left it up).
  useEffect(() => {
    const sub = form.watch(() => {
      setSubmitNotice(null);
      saveDraft();
    });
    return () => sub.unsubscribe();
  }, [form, saveDraft]);

  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          console.error("register:event-load-failed", res.status);
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
                virtualPrice: tt.virtualPrice != null ? Number(tt.virtualPrice) : null,
                currency: tier.currency,
                available: tier.available,
                // A rate that closed online stays open at the desk while it has
                // seats (§8.5); one not yet on sale stays closed.
                canPurchase: tier.canPurchase || (!!deskQr && tier.salesEnded && tier.salesStarted && !tier.soldOut),
                hasSeatLimit: tier.seatLimited ?? tier.quantity < UNLIMITED_SENTINEL,
                requiresDocument: tt.requiresDocument === true,
                documentRequired: tt.documentRequired === true,
                documentLabel: tt.documentLabel ?? null,
                documentInstructions: tt.documentInstructions ?? null,
                requiresMemberId: tt.requiresMemberId === true,
                requiresStudentId: tt.requiresStudentId === true,
                requiresStudentIdExpiry: tt.requiresStudentIdExpiry === true,
              });
            }
          }

          // Desk mode: an exhibitor QR offers only the Exhibitor type, a
          // complimentary one never offers it (§8.2).
          if (deskQr) {
            const deskOptions = options.filter((o) => (deskQr.kind === "exhibitor") === isExhibitorBadge(o.regTypeName));
            options.splice(0, options.length, ...deskOptions);
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
              virtualPrice: t.virtualPrice != null ? Number(t.virtualPrice) : null,
              currency: t.currency,
              available: t.available,
              canPurchase: t.canPurchase,
              hasSeatLimit: t.seatLimited ?? t.quantity < UNLIMITED_SENTINEL,
              requiresDocument: t.requiresDocument === true,
              documentRequired: t.documentRequired === true,
              documentLabel: t.documentLabel ?? null,
              documentInstructions: t.documentInstructions ?? null,
              requiresMemberId: t.requiresMemberId === true,
              requiresStudentId: t.requiresStudentId === true,
              requiresStudentIdExpiry: t.requiresStudentIdExpiry === true,
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
  }, [slug, categorySlug, form, deskQr]);

  // The draft's non-form parts, kept current for the watch callback above, and
  // saved when they change (they are not form fields, so watch never sees them).
  draftState.current = { step, billingSame, promoCode, supportingDoc };
  useEffect(() => {
    saveDraft();
  }, [step, billingSame, promoCode, supportingDoc, saveDraft]);

  // Restore once the event's options are known, so a saved category that is
  // no longer on sale is dropped instead of submitted.
  useEffect(() => {
    if (draftRestored.current || regTypeOptions.length === 0) return;
    draftRestored.current = true;
    const draft = readRegisterDraft(draftKey);
    if (!draft) return;
    const values = { ...draft.values } as Partial<RegistrationForm>;
    const savedOption = regTypeOptions.find((o) => o.ticketTypeId === values.ticketTypeId && o.canPurchase);
    if (!savedOption) {
      delete values.ticketTypeId;
      delete values.pricingTierId;
    }
    form.reset({ ...form.getValues(), ...values });
    setBillingSame(draft.billingSame);
    if (draft.promoCode) {
      setPromoCode(draft.promoCode);
      setShowPromoInput(true);
      setRestoredPromo(draft.promoCode);
    }
    if (draft.supportingDoc) setSupportingDoc(draft.supportingDoc);
    // Step 2 only when step 1 was completed (a valid email and matching password).
    // Desk mode has no step 1, and its form never asks for a password.
    if (deskQr) form.setValue("deskMode", true);
    else if (draft.step === 2 && values.email && values.password && values.password === values.confirmPassword) setStep(2);
  }, [regTypeOptions, draftKey, form, deskQr]);

  // Resolve tier-specific content with event-level fallback
  // Event-level content (shared across all tiers)
  const selectedTierContent = useMemo(() => {
    if (!event) return { welcomeHtml: null, termsHtml: null };
    return {
      welcomeHtml: event.registrationWelcomeHtml || null,
      termsHtml: event.registrationTermsHtml || null,
    };
  }, [event]);

  // A tap that did not go through: once the errors have rendered, scroll to the
  // first one (a picker or a type has no focusable field for react-hook-form to
  // jump to) and name what is missing by the button. Also react-hook-form's
  // onInvalid. The 50ms lets the messages set in onSubmit reach the page.
  // Changing step keeps the page's scroll position, and step 1 (with the
  // welcome text) is far longer than step 2, so on a phone step 2 opened at
  // its terms and button. Start each step at the top of the form instead.
  function goToStep(next: 1 | 2) {
    setStep(next);
    requestAnimationFrame(() =>
      document.getElementById(next === 2 ? "register-card" : "create-account")?.scrollIntoView({ block: "start" }),
    );
  }

  function showBlockedSubmit(errors?: FieldErrors<RegistrationForm>) {
    setSubmitNotice(null);
    const keys = errors ? Object.keys(errors) : [];
    // The account fields live on step 1, so on step 2 their messages are not
    // on the page: the tap said "Please check the highlighted fields" with
    // nothing highlighted (MMF2026, Oct 26). Go back to step 1, where they show.
    const accountKeys = keys.filter((k) => k === "email" || k === "password" || k === "confirmPassword");
    if (step === 2 && accountKeys.length > 0) {
      setStep(1);
      // At the top: a bottom toast sits over the Continue button on a phone.
      toast.error("Please check your email and password, then press Continue.", { position: "top-center" });
    }
    setTimeout(() => {
      const notice = scrollToFirstFormError();
      setSubmitNotice(notice);
      // Nothing on the page explains the refusal: report WHICH fields (never
      // their values) so the case can be found and fixed.
      if (keys.length > 0 && notice === "Please check the highlighted fields.") {
        Sentry.captureMessage("public-register:error-not-on-page", {
          level: "warning",
          tags: { form: "register" },
          extra: { fields: keys, step, slug, category: categorySlug },
        });
      }
    }, 100);
  }

  async function onSubmit(data: RegistrationForm) {
    setSubmitNotice(null);
    // Identity evidence: the SELECTED TYPE's own switches, checked with the
    // same helper the server enforces with, so the form cannot ask for
    // something the route ignores or the reverse.
    const submitEvidencePolicy = readIdentityEvidencePolicy(
      regTypeOptions.find((o) => o.ticketTypeId === data.ticketTypeId),
    );
    const missingEvidence = missingIdentityEvidence(submitEvidencePolicy, {
      memberId: data.memberId,
      studentId: data.studentId,
      studentIdExpiry: data.studentIdExpiry,
    });
    if (missingEvidence.length > 0) {
      // On the FIELD, not a form-level banner, so the page takes the
      // registrant to the box they have to fill.
      if (missingEvidence.includes("Member ID")) form.setError("memberId", { message: "Member ID is required" });
      if (missingEvidence.includes("Student ID")) form.setError("studentId", { message: "Student ID is required" });
      if (missingEvidence.includes("Student ID expiry date")) {
        form.setError("studentIdExpiry", { message: "Student ID expiry date is required" });
      }
      showBlockedSubmit();
      return;
    }

    // The upload appears whenever the type asks for one; whether a MISSING
    // one blocks is the organizer's Required/Optional choice on that type. The
    // server enforces the same rule — this is the friendly half.
    const picked = regTypeOptions.find((o) => o.ticketTypeId === data.ticketTypeId);
    // A sponsor link (this rate needs a sponsor's code): the server refuses
    // without a sponsor-covered code, so say so here and open the field rather
    // than letting the request fail.
    if (sponsorCodeRequired && !(promoResult?.valid && promoResult.coveredBySponsor)) {
      setShowPromoInput(true);
      toast.error(
        promoResult?.valid
          ? "This registration link needs the code your sponsor sent you. A discount code does not apply here."
          : "This registration link needs the code your sponsor sent you. Enter it and press Apply.",
      );
      setSubmitNotice("Enter the code your sponsor sent you and press Apply.");
      setTimeout(() => document.getElementById("promo-code-field")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      return;
    }
    if (supportingDocumentBlocks(picked) && !supportingDoc) {
      setDocError(`Please attach the ${supportingDocumentLabel(picked).toLowerCase()} to continue.`);
      showBlockedSubmit();
      return;
    }

    // Validate billing fields when not using personal details
    if (!billingSame) {
      const missing = missingBillingFields(data);
      for (const { field, label } of missing) form.setError(field, { message: `${label} is required` });
      if (missing.length > 0) {
        showBlockedSubmit();
        return;
      }
    }

    setSubmitting(true);
    // Copy personal details to billing if "same as above" is checked
    if (billingSame) Object.assign(data, billingFromPersonal(data));
    try {
      const res = await fetch(`/api/public/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          // Desk mode sends the QR's token and no password (§8.3).
          ...(deskQr && { password: undefined, confirmPassword: undefined, deskToken }),
          supportingDocumentUrl: supportingDoc?.url,
          supportingDocumentFilename: supportingDoc?.filename,
          promoCode: promoResult?.valid ? promoResult.code : undefined,
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
        // At the desk, staff can find someone already registered.
        const deskDuplicate = deskQr && result.code === "ALREADY_REGISTERED";
        toast.error(deskDuplicate ? "You are already registered. Please go to the desk." : result.error || "Registration failed");
        setSubmitting(false);
        return;
      }
      const reg = result.registration;
      const confirmParams = new URLSearchParams({
        id: reg.id,
        name: data.firstName,
        ...(reg.serialId ? { serialId: String(reg.serialId) } : {}),
        ...(reg.status ? { status: reg.status } : {}),
        ...(reg.ticketPrice > 0 ? { price: String(reg.ticketPrice), currency: reg.ticketCurrency } : {}),
      });
      // Registered: nothing left to bring back on a reload.
      clearRegisterDraft(draftKey);
      router.push(`/e/${slug}/confirmation?${confirmParams.toString()}`);
    } catch (err) {
      console.error("[register] Registration submission failed:", err);
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  const promoRequestRef = useRef(0);
  // Validate a promo code against the chosen type and tier. Shared by the
  // Apply button and the `?promo=` link.
  async function applyPromo(code: string) {
    if (!code.trim()) return;
    // Only the LATEST check may set the result (review MED 3, Sep 29, 2026):
    // switching category quickly could let an earlier "not applicable" answer
    // land last, and a registration submitted then would drop the code and be
    // saved UNPAID on a fee the sponsor was meant to cover.
    const requestId = ++promoRequestRef.current;
    setPromoValidating(true);
    try {
      const ticketTypeId = form.getValues("ticketTypeId");
      const pricingTierId = form.getValues("pricingTierId");
      const email = form.getValues("email");
      const res = await fetch(`/api/public/events/${slug}/validate-promo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, ticketTypeId, pricingTierId: pricingTierId || undefined, email: email || "check@temp.com" }),
      });
      const data = await res.json();
      if (requestId !== promoRequestRef.current) return;
      setPromoResult(data);
      // A code that now works fixes what the notice asked for (not a form
      // field, so the watch below never sees it; review L2).
      if (data?.valid) setSubmitNotice(null);
    } catch (err) {
      console.warn("[register] promo validation failed", err);
      if (requestId !== promoRequestRef.current) return;
      setPromoResult({ valid: false, error: "Failed to validate promo code" });
    } finally {
      if (requestId === promoRequestRef.current) setPromoValidating(false);
    }
  }

  // A sponsor (or anyone) shares the REGULAR registration link with
  // `?promo=CODE` (Sep 29, 2026). Applied once a registration type is chosen,
  // and again when the type changes, because a code can be limited to types.
  const linkedPromo = (searchParams.get("promo") ?? "").trim().toUpperCase();
  const linkTicketId = form.watch("ticketTypeId");
  useEffect(() => {
    if (!linkedPromo || !linkTicketId) return;
    setShowPromoInput(true);
    setPromoCode(linkedPromo);
    void applyPromo(linkedPromo);
    // applyPromo reads the form at call time; re-running on its identity
    // would re-validate on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedPromo, linkTicketId]);

  // A code brought back by a reload is checked again, as the link's code is:
  // the result is not stored, and a sponsor link needs it applied.
  const [restoredPromo, setRestoredPromo] = useState<string | null>(null);
  useEffect(() => {
    if (!restoredPromo || !linkTicketId) return;
    setRestoredPromo(null);
    void applyPromo(restoredPromo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredPromo, linkTicketId]);

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

  // Presenter rates are offered on the abstract signup, never on the delegate
  // path. The tier's form URL is shareable and the organizer UI had a copy
  // button for it, so a forwarded link used to open a working delegate form at
  // the presenter price (owner decision Aug 12, 2026). Send them where the
  // rate actually applies rather than showing a dead end. The register API
  // refuses the tier too, so this is signposting, not the gate.
  if (isPresenterCategory && event) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-sky-50 flex items-center justify-center">
            <FileText className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            This rate is for abstract presenters
          </h2>
          <p className="text-slate-500 text-sm mb-5">
            Presenter rates are offered when you sign up to submit an abstract, so that
            your submission and your registration stay together.
          </p>
          <Link
            href={`/e/${slug}/abstract/register`}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            Submit an abstract
          </Link>
          <div className="mt-4">
            <Link href={`/e/${slug}/register`} className="text-primary text-sm font-medium hover:underline">
              I am attending as a delegate
            </Link>
          </div>
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

  // On HYBRID events, when "Attend Virtually" is chosen, swap each option's
  // displayed price for its flat virtualPrice (null ⇒ keep the in-person
  // price). This keeps the card amount + tax/total in sync with what the
  // server charges. (The server is authoritative regardless.)
  const watchedMode = form.watch("attendanceMode");
  const isVirtualMode = event.eventType === "HYBRID" && watchedMode === "VIRTUAL";
  const purchasableOptions = regTypeOptions
    .filter((o) => o.canPurchase)
    .map((o) => (isVirtualMode && o.virtualPrice != null ? { ...o, price: o.virtualPrice } : o));
  const selectedTicketId = form.watch("ticketTypeId");

  const selectedSpecialty = form.watch("specialty");
  const selectedOption = regTypeOptions.find((o) => o.ticketTypeId === selectedTicketId);
  // This rate's link is a sponsor link: only a sponsor-covered code opens it.
  const sponsorCodeRequired = (event?.codeRequiredTiers ?? []).includes(categorySlug);
  // Which evidence fields to render, from the type's switches rather than its
  // name — the same correction the supporting-document block below made.
  const evidencePolicy = readIdentityEvidencePolicy(selectedOption);
  const isMember = evidencePolicy.requiresMemberId;
  const isStudent = evidencePolicy.requiresStudentId;
  const showStudentExpiry = evidencePolicy.requiresStudentIdExpiry;
  // Read off the SELECTED TYPE's own policy. This used to match the type's
  // NAME against /resident|trainee/i, which meant renaming a type silently
  // switched the requirement off, and made "ask Members but not Residents"
  // impossible to express. It is an organizer switch now.
  const needsDocument = requiresSupportingDocument(selectedOption);
  const documentRequired = supportingDocumentBlocks(selectedOption);
  const documentLabel = supportingDocumentLabel(selectedOption);
  const documentInstructions = supportingDocumentInstructions(selectedOption);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);
  // Closed when the master switch is off (Settings → Registration) OR this tier
  // has no purchasable option. The master switch wins regardless of tier state.
  const isClosed = event.registrationOpen === false || purchasableOptions.length === 0;
  // Event-wide cap reached. Virtual attendance never consumes the cap, so a
  // HYBRID event stays open (with an in-person-full notice) — the register
  // POST still enforces the cap atomically for in-person picks.
  const isHybrid = event.eventType === "HYBRID";
  const fullBlocksAll = event.eventFull === true && !isHybrid;
  const fullInPersonOnly = event.eventFull === true && isHybrid;
  // When every purchasable option is free, "Free" on each row is noise —
  // hide the price column entirely. If even one option costs money, keep
  // the per-row label so users can see which is which at a glance.
  const allOptionsFree =
    purchasableOptions.length > 0 &&
    purchasableOptions.every((o) => o.price === 0);

  return (
    <div className="public-form min-h-screen flex flex-col bg-[#f8f9fb] text-base">
      {/* Banner */}
      {event.bannerImage ? (
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
        <div id="register-card" className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden scroll-mt-4">
          {/* Header */}
          <div className="px-4 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">{formLabel} Registration</h2>
            <p className="text-sm text-slate-500 mt-1">
              {step === 1 ? "Create your account to get started." : "Fill in the details below to complete your registration."}
            </p>
            {/* Step indicator (desk mode is one step) */}
            {!deskQr && (
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
            )}
          </div>

          <div className="p-4 sm:p-6 sm:px-10">
            {isClosed || fullBlocksAll ? (
              <div className="text-center py-12">
                <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-50 flex items-center justify-center">
                  <AlertCircle className="h-7 w-7 text-slate-400" />
                </div>
                <p className="font-medium text-slate-700">
                  {fullBlocksAll && !isClosed
                    ? "This event is fully booked"
                    : `${formLabel} registration is currently closed`}
                </p>
                <p className="text-sm text-slate-400 mt-1">
                  {fullBlocksAll && !isClosed
                    ? "The event has reached its maximum number of attendees."
                    : "Check back later or contact the organizer."}
                </p>
                {/* Disabled CTA — reads "Registration Closed" whenever this tier
                    (standard / onsite / early-bird) is toggled off, instead of
                    a register button. */}
                <Button type="button" disabled aria-disabled className="mt-6 w-full max-w-xs mx-auto rounded-lg font-semibold py-3 text-base">
                  {fullBlocksAll && !isClosed ? "Registration Full" : "Registration Closed"}
                </Button>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit, showBlockedSubmit)} className="space-y-8">

                  {/* ── STEP 1: Create Account ── */}
                  {step === 1 && (
                    <div className="space-y-5">
                      {/* On a phone the welcome text and price table can run
                          2,700px before the form: a way straight to it (owner,
                          Oct 26, 2026). Desktop shows both side by side anyway. */}
                      {selectedTierContent.welcomeHtml && (
                        <Button
                          type="button"
                          className="w-full sm:hidden rounded-lg font-semibold btn-gradient text-base"
                          onClick={() => document.getElementById("create-account")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                        >
                          Start registration <ChevronRight className="ml-1 h-5 w-5" />
                        </Button>
                      )}

                      {/* Welcome text from organizer — full width */}
                      {selectedTierContent.welcomeHtml && (
                        <div className="rich-content-tables prose prose-slate max-w-none [&>*]:mb-4 [&>*:last-child]:mb-0"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(selectedTierContent.welcomeHtml!) }} />
                      )}

                      {/* Account form — narrower centered */}
                      <div id="create-account" className="max-w-md mx-auto space-y-5 pt-4 scroll-mt-4">
                      <div className="flex items-center gap-4 pb-4 mb-2">
                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <Lock className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-xl font-bold text-slate-800">Create your account</h3>
                          <p className="text-xs text-slate-500">You&apos;ll use these credentials to sign in, manage your registration, and make payments.</p>
                        </div>
                      </div>

                      <FormField control={form.control} name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Email Address <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="email" type="email" placeholder="john@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />

                      <FormField control={form.control} name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Password <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="new-password" type="password" placeholder="Min. 6 characters" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />

                      <FormField control={form.control} name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Confirm Password <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="new-password" type="password" placeholder="Re-enter password" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />

                      {emailCheck.state === "conflict" && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                          You&apos;re already registered for this event.{" "}
                          <a
                            href={`/e/${slug}/login?redirect=registration&email=${encodeURIComponent(form.getValues("email"))}`}
                            className="underline text-md font-medium"
                          >
                            Sign in to view it
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
                            // Network or 429 — fall through to step 2; the
                            // register POST is the safety net.
                            console.warn("[register] check-email failed, continuing", err);
                          }
                          setEmailCheck({ state: "idle" });
                          goToStep(2);
                        }}>
                        {emailCheck.state === "checking" ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking…</>
                        ) : (
                          <>Continue <ChevronRight className="ml-1 h-5 w-5" /></>
                        )}
                      </Button>

                      <p className="text-center  text-slate-400">
                        <span className="text-xs">Already have an account?{" "}</span>
                        <a href={`/e/${slug}/login?redirect=registration`} className="text-md text-primary hover:underline font-medium">Sign in</a>
                      </p>
                      </div>
                    </div>
                  )}

                  {/* ── STEP 2: Personal Details + Category + Terms ── */}
                  {step === 2 && (
                  <>
                  {/* Section: Contact Details */}
                  <div className="space-y-5">
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Contact Details</h3>

                    {/* Desk mode has no account step, so the email is asked here. */}
                    {deskQr && (
                      <FormField control={form.control} name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Email Address <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="email" type="email" placeholder="john@example.com" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    )}

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
                            <FormControl><Input autoComplete="organization-title" placeholder="Physician" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="organization"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Organization <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input autoComplete="organization" placeholder="Acme Inc." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
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
                    {(showsField(event.formFields, "state") || showsField(event.formFields, "zipCode")) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {showsField(event.formFields, "state") && (
                      <FormField control={form.control} name="state"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">State / Province</FormLabel>
                            <FormControl><Input autoComplete="address-level1" placeholder="State" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      )}
                      {showsField(event.formFields, "zipCode") && (
                      <FormField control={form.control} name="zipCode"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Zip / Postal Code</FormLabel>
                            <FormControl><Input autoComplete="postal-code" placeholder="00000" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      )}
                    </div>
                    )}

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

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {selectedSpecialty === "Others" && (
                        <FormField control={form.control} name="customSpecialty"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-sm font-medium text-slate-600">Others (specify) <span className="text-red-400">*</span></FormLabel>
                              <FormControl><Input placeholder="e.g. Interventional Cardiology" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                      )}
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
                  </div>

                  {/* Section: Billing Details
                      Suppressed entirely when every purchasable option for
                      this category is free. There's nothing to bill so the
                      "Billing address same as personal details" checkbox and
                      its expandable form are noise. The default billingSame
                      state is true, so on form submit the auto-copy from
                      personal details still runs and the DB columns aren't
                      left null (preserves contact-sync + invoice fallback if
                      the event ever flips to paid later). */}
                  {!allOptionsFree && (
                    <BillingDetailsSection
                      control={form.control}
                      billingSame={billingSame}
                      onBillingSameChange={(same) => {
                        setBillingSame(same);
                        setSubmitNotice(null);
                      }}
                    />
                  )}

                  {/* Section: Select Your Category */}
                  <div className="space-y-5">
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Select Your Category</h3>
                    {/* Pay-now-or-later copy only applies when at least one
                        purchasable option costs money. For wholly-free events
                        it would be misleading. */}
                    {!allOptionsFree && (
                      <p className="text-xs text-slate-500">You will have the option to pay now or you can select to pay at a later stage.</p>
                    )}

                    {/* Hybrid events: choose how to attend. Virtual gets no
                        venue barcode/badge; joining instructions are emailed
                        before the event. Drives pricing (flat virtual price)
                        and the confirmation email server-side. */}
                    {/* HYBRID + event cap reached: in-person is full but virtual
                        (uncapped) stays open — steer the registrant; the server
                        enforces the cap atomically on in-person picks. */}
                    {fullInPersonOnly && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        In-person registration is fully booked, but you can still register to attend virtually.
                      </div>
                    )}
                    {event?.eventType === "HYBRID" && (
                      <FormField control={form.control} name="attendanceMode"
                        render={({ field }) => (
                          <FormItem>
                            <p className="text-sm font-semibold text-slate-700 mb-2">How would you like to attend?</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {([
                                { value: "IN_PERSON", title: "Attend In-Person", desc: "Join us at the venue. You'll receive an entry barcode for check-in." },
                                { value: "VIRTUAL", title: "Attend Virtually", desc: "Join online. Joining instructions and your access link are emailed before the event." },
                              ] as const).map((opt) => {
                                const isSelected = field.value === opt.value;
                                return (
                                  <button key={opt.value} type="button"
                                    onClick={() => {
                                      // The rate stays selected: a type with no virtual
                                      // price charges virtual attendees the RATE's price,
                                      // and the server needs the rate to price it (and to
                                      // apply a sponsor link's code rule).
                                      field.onChange(opt.value);
                                    }}
                                    className={cn(
                                      "text-left rounded-xl border-2 p-4 transition-all duration-150",
                                      isSelected ? "border-primary bg-primary/[0.03] shadow-sm" : "border-slate-200 hover:border-slate-300"
                                    )}>
                                    <div className="flex items-center gap-2">
                                      <div className={cn("h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0", isSelected ? "border-primary bg-primary" : "border-slate-300")}>
                                        {isSelected && <div className="h-2 w-2 rounded-full bg-white" />}
                                      </div>
                                      <p className="font-semibold text-slate-900">{opt.title}</p>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-1.5 ml-7">{opt.desc}</p>
                                  </button>
                                );
                              })}
                            </div>
                          </FormItem>
                        )} />
                    )}

                    <FormField control={form.control} name="ticketTypeId"
                      render={({ field }) => (
                        <FormItem>
                          <div className="space-y-3">
                            {purchasableOptions.map((opt) => {
                              const isSelected = field.value === opt.ticketTypeId;
                              return (
                                <button key={opt.ticketTypeId} type="button"
                                  onClick={() => {
                                    // Changing the rate discards any document
                                    // staged for the PREVIOUS one. The upload
                                    // section is keyed on the selected type, so
                                    // without this the file stays attached but
                                    // invisible: the registrant believes they
                                    // sent it, the server drops it (the new
                                    // type is not asking), and the orphan is
                                    // pruned 24h later. Clearing it makes the
                                    // loss visible at the moment it happens.
                                    if (opt.ticketTypeId !== field.value) {
                                      setSupportingDoc(null);
                                      setDocError(null);
                                    }
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
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                                      <div className={cn(
                                        "h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all shrink-0",
                                        isSelected ? "border-primary bg-primary" : "border-slate-300"
                                      )}>
                                        {isSelected && <div className="h-2 w-2 rounded-full bg-white" />}
                                      </div>
                                      <div className="min-w-0 break-words">
                                        <p className="font-semibold text-slate-900">{opt.regTypeName}</p>
                                        {opt.description && (
                                          <div className="text-xs text-slate-500 mt-0.5" dangerouslySetInnerHTML={{ __html: sanitizeHtml(opt.description) }} />
                                        )}
                                      </div>
                                    </div>
                                    {!allOptionsFree && (
                                      <div className="text-right shrink-0">
                                        <div className="text-[10px] uppercase text-slate-400 font-medium">Amount</div>
                                        <div className={cn("text-lg font-bold", isSelected ? "text-primary" : "text-slate-800")}>
                                          {opt.price === 0 ? "Free" : `${opt.currency} ${opt.price.toFixed(2)}`}
                                        </div>
                                        {opt.price > 0 && event.taxRate != null && event.taxRate > 0 && (() => {
                                          const taxAmount = opt.price * event.taxRate / 100;
                                          const total = opt.price + taxAmount;
                                          const label = event.taxLabel || "VAT";
                                          return (
                                            <div className="mt-0.5 space-y-0.5">
                                              <div className="text-[11px] text-slate-400">
                                                {label} ({event.taxRate}%): {opt.currency} {taxAmount.toFixed(2)}
                                              </div>
                                              <div className="text-xs font-semibold text-slate-600">
                                                Total: {opt.currency} {total.toFixed(2)}
                                              </div>
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                  {opt.available <= 0 ? (
                                    <p className="text-xs text-red-500 mt-1 ml-8">Sold out</p>
                                  ) : (
                                    event.showRemainingTickets === true &&
                                    opt.hasSeatLimit && (
                                      <p className={`text-xs mt-1 ml-8 ${opt.available <= 10 ? "text-amber-600 font-medium" : "text-slate-400"}`}>
                                        {opt.available} seat{opt.available !== 1 ? "s" : ""} left
                                      </p>
                                    )
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          <FormMessage className="mt-2" data-form-error="Registration category" />
                        </FormItem>
                      )}
                    />

                    {selectedTicketId && (
                      <p className="text-xs text-slate-500 italic">
                        Your professional ID may be required at the time of check-in. Always carry your ID to avoid inconvenience.
                      </p>
                    )}

                    {/* Promo Code */}
                    {selectedTicketId && deskQr?.kind !== "complimentary" && (event?.hasPromoCodes || sponsorCodeRequired) && (
                      <div className="mt-2">
                        {!showPromoInput && !sponsorCodeRequired ? (
                          <button type="button" onClick={() => setShowPromoInput(true)} className="text-sm text-primary hover:underline font-medium">
                            Have a promo code?
                          </button>
                        ) : (
                          <div id="promo-code-field" className="space-y-2">
                            <label className="text-sm font-medium text-slate-600">
                              Promo Code{sponsorCodeRequired && <span className="text-red-500"> *</span>}
                            </label>
                            {sponsorCodeRequired && (
                              <p className="text-xs text-slate-500">
                                {deskQr?.kind === "exhibitor"
                                  ? "Your sponsor's code is already applied."
                                  : "This registration link is for sponsored delegates. Enter the code your sponsor sent you."}
                              </p>
                            )}
                            <div className="flex gap-2">
                              <Input
                                placeholder="Enter promo code"
                                // An exhibitor desk QR carries its sponsor's code.
                                readOnly={deskQr?.kind === "exhibitor"}
                                value={promoCode}
                                onChange={(e) => {
                                  setPromoCode(e.target.value.toUpperCase());
                                  if (promoResult) setPromoResult(null);
                                }}
                                className="rounded-lg border-slate-200 text-base uppercase"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                disabled={!promoCode.trim() || promoValidating || deskQr?.kind === "exhibitor"}
                                onClick={() => void applyPromo(promoCode)}
                                className="shrink-0"
                              >
                                {promoValidating ? "Checking..." : "Apply"}
                              </Button>
                            </div>
                            {promoResult && (
                              promoResult.valid ? (
                                <div className="flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                                  {promoResult.coveredBySponsor ? (
                                    <span>
                                      Your registration is covered by <strong>{promoResult.coveredBySponsor}</strong>. Nothing to pay.
                                    </span>
                                  ) : (
                                  <span>
                                    {promoResult.discountType === "PERCENTAGE"
                                      ? `${promoResult.discountValue}% off`
                                      : `${promoResult.originalPrice !== undefined ? `${(promoResult.originalPrice - (promoResult.finalPrice || 0)).toFixed(2)}` : promoResult.discountAmount?.toFixed(2)} off`}
                                    {": "}you save {promoResult.discountAmount?.toFixed(2)}
                                    {promoResult.finalPrice === 0 && " (Free!)"}
                                  </span>
                                  )}
                                </div>
                              ) : (
                                <p className="text-sm text-red-500">{promoResult.error || "Invalid promo code"}</p>
                              )
                            )}
                          </div>
                        )}
                      </div>
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
                        {/* Its own switch: an organizer can ask for the ID
                            without demanding an expiry date, which the name
                            match could never express. */}
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

                  {/* Section: Supporting document. Rendered from the SELECTED
                      ticket type's own policy, so the heading and instructions
                      are the organizer's words rather than hardcoded Resident
                      copy, and the requirement survives a type being renamed. */}
                  {needsDocument && (
                    <SupportingDocumentField
                      slug={slug}
                      label={documentLabel}
                      required={documentRequired}
                      instructions={documentInstructions}
                      value={supportingDoc}
                      onChange={setSupportingDoc}
                      error={docError}
                      onError={setDocError}
                      onBeforeUpload={() => setSubmitNotice(null)}
                    />
                  )}

                  {/* Section: Terms & Conditions */}
                  <div className="space-y-5">
                    <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Terms and Conditions</h3>
                    <div className="max-h-[300px] overflow-y-auto bg-slate-50 rounded-lg border border-slate-200 p-4">
                      <div className="rich-content-tables prose prose-slate max-w-none text-sm leading-relaxed [&>*]:mb-4 [&>*:last-child]:mb-0"
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(selectedTierContent.termsHtml || DEFAULT_REGISTRATION_TERMS_HTML) }} />
                    </div>

                    <FormField control={form.control} name="agreeTerms"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-start gap-4">
                            {/* In FormControl so the label's htmlFor reaches it:
                                tapping the sentence ticks the box. */}
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

                  {/* What stopped the last tap, next to the button that was tapped. */}
                  {submitNotice && (
                    <p role="alert" className="text-sm font-medium text-red-600 text-center sm:text-right">{submitNotice}</p>
                  )}

                  {/* Navigation: full width on a phone, Complete first */}
                  <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between pt-2">
                    {deskQr ? <span /> : (
                      <Button type="button" variant="outline" className="rounded-lg w-full sm:w-auto" onClick={() => goToStep(1)}>
                        <ChevronLeft className="mr-1 h-4 w-4" /> Back
                      </Button>
                    )}
                    <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 text-base w-full sm:w-auto h-12 sm:h-10">
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
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          {event.agendaPublished && (
            <Link href={`/e/${slug}/agenda`} className="block group">
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
                <div className="flex items-center gap-4">
                  <div className="h-9 w-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                    <Calendar className="h-4 w-4 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 text-sm">View Agenda</p>
                    <p className="text-xs text-slate-400">Full agenda</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary shrink-0" />
                </div>
              </div>
            </Link>
          )}
          {event.abstractSettings?.allowAbstractSubmissions && (
            <Link href={`/e/${slug}/abstract/register`} className="block group">
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
                <div className="flex items-center gap-4">
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

export default function CategoryRegistrationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-slate-500 text-sm">Loading registration form...</p>
          </div>
        </div>
      }
    >
      <CategoryRegistrationContent />
    </Suspense>
  );
}
