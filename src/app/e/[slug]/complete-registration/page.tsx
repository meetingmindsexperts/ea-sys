"use client";

import { Suspense, useState, useEffect } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { CountrySelect } from "@/components/ui/country-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { toast } from "sonner";
import { DEFAULT_REGISTRATION_TERMS_HTML } from "@/lib/default-terms";

interface PrefilledData {
  alreadyCompleted: boolean;
  registration: { id: string; status: string; ticketTypeId: string };
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
    registrationTermsHtml: string | null;
    supportEmail: string | null;
    organization: { name: string; logo: string | null };
  };
  ticketType: { id: string; name: string };
}

const completionSchema = z.object({
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

  const [data, setData] = useState<PrefilledData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CompletionForm>({
    resolver: zodResolver(completionSchema),
    defaultValues: {
      title: "", role: "", jobTitle: "", organization: "", phone: "",
      city: "", state: "", zipCode: "", country: "",
      specialty: "", customSpecialty: "", dietaryReqs: "",
      associationName: "", memberId: "", studentId: "", studentIdExpiry: "",
      password: "", confirmPassword: "",
      agreeTerms: undefined as unknown as true,
    },
  });

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
          setError("This registration has already been completed. You can sign in to manage your registration.");
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
          password: "",
          confirmPassword: "",
          agreeTerms: undefined as unknown as true,
        });
      } catch {
        setError("Failed to load registration details");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [token, slug, form]);

  async function onSubmit(formData: CompletionForm) {
    if (!token) return;

    // Validate conditional required fields
    const regTypeName = data?.ticketType.name?.toLowerCase() ?? "";
    if (regTypeName.includes("member") && !formData.memberId?.trim()) {
      form.setError("memberId", { message: "Member ID is required" });
      return;
    }
    if (regTypeName.includes("student")) {
      if (!formData.studentId?.trim()) {
        form.setError("studentId", { message: "Student ID is required" });
        return;
      }
      if (!formData.studentIdExpiry?.trim()) {
        form.setError("studentIdExpiry", { message: "Student ID expiry date is required" });
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
  const regTypeName = data.ticketType.name?.toLowerCase() ?? "";
  const isMember = regTypeName.includes("member");
  const isStudent = regTypeName.includes("student");
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
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">Complete Your Registration</h2>
            <p className="text-sm text-slate-500 mt-1">
              Review your details and fill in any missing information to finalize your registration.
            </p>
            <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-1.5">
              <CheckCircle className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-primary">{data.ticketType.name}</span>
            </div>
          </div>

          <div className="p-6 sm:px-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

                {/* Section: Your Details (Read-Only) */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Your Details</h3>
                  <p className="text-xs text-slate-500">These details were provided by the event organizer and cannot be changed here.</p>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-slate-400" /> First Name
                      </label>
                      <Input value={attendee.firstName} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-slate-400" /> Last Name
                      </label>
                      <Input value={attendee.lastName} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                      <Lock className="h-3 w-3 text-slate-400" /> Email
                    </label>
                    <Input value={attendee.email} readOnly className="rounded-lg border-slate-200 text-base bg-slate-50 text-slate-600" />
                  </div>
                </div>

                {/* Section: Complete Your Details (Editable) */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Complete Your Details</h3>

                  <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
                    <FormField control={form.control} name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Title <span className="text-red-400">*</span></FormLabel>
                          <TitleSelect value={field.value || ""} onChange={field.onChange} />
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="jobTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Position <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input placeholder="Physician" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="organization"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Organization <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input placeholder="Acme Inc." className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
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
                    <FormField control={form.control} name="country"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Country <span className="text-red-400">*</span></FormLabel>
                          <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">City <span className="text-red-400">*</span></FormLabel>
                          <FormControl><Input placeholder="Dubai" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
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

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="specialty"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Specialty <span className="text-red-400">*</span></FormLabel>
                          <SpecialtySelect value={field.value ?? ""} onChange={field.onChange} />
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

                  <FormField control={form.control} name="dietaryReqs"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-slate-600">Dietary Requirements</FormLabel>
                        <FormControl><Input placeholder="e.g. Vegetarian, Halal" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
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
                    <div className="grid grid-cols-2 gap-4">
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
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="studentId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Student ID <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input placeholder="e.g. STU-2024-001" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      <FormField control={form.control} name="studentIdExpiry"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-sm font-medium text-slate-600">Student ID Expiry Date <span className="text-red-400">*</span></FormLabel>
                            <FormControl><Input type="date" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                    </div>
                  </div>
                )}

                {/* Section: Create Account */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Create Your Account</h3>
                  <p className="text-xs text-slate-500">Set a password to access your registration portal, view your details, and make payments online.</p>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Password</FormLabel>
                          <FormControl><Input type="password" placeholder="Min. 6 characters" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    <FormField control={form.control} name="confirmPassword"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium text-slate-600">Confirm Password</FormLabel>
                          <FormControl><Input type="password" placeholder="Re-enter password" className="rounded-lg border-slate-200 text-base" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                  </div>
                </div>

                {/* Section: Terms & Conditions */}
                <div className="space-y-5">
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Terms and Conditions</h3>
                  <div className="max-h-[300px] overflow-y-auto bg-slate-50 rounded-lg border border-slate-200 p-4">
                    <div className="prose prose-slate max-w-none text-sm leading-relaxed [&>*]:mb-4 [&>*:last-child]:mb-0"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.registrationTermsHtml || DEFAULT_REGISTRATION_TERMS_HTML) }} />
                  </div>

                  <FormField control={form.control} name="agreeTerms"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-start gap-4">
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

                {/* Submit */}
                <div className="flex items-center justify-end pt-2">
                  <Button type="submit" disabled={submitting} className="rounded-lg font-semibold btn-gradient px-8 py-3 text-base">
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
