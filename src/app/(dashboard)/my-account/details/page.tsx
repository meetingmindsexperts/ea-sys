"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2, Lock, Mail, UserRound } from "lucide-react";
import { MARKETING_CONSENT_TEXT } from "@/lib/marketing-consent";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { PageHeader } from "@/components/ui/typography";

/**
 * My Details (/my-account/details, Nov 9, 2026): the person's own details on
 * their account, the public registration form's questions, and marketing
 * consent. A save also updates their upcoming registrations
 * (/api/registrant/account-details says exactly which).
 */

const schema = z
  .object({
    title: z.string(),
    role: z.string().min(1, "Role is required"),
    firstName: z.string().trim().min(1, "First name is required").max(100),
    lastName: z.string().trim().min(1, "Last name is required").max(100),
    organization: z.string().trim().min(1, "Organization is required").max(255),
    jobTitle: z.string().trim().min(1, "Position is required").max(255),
    phone: z.string().trim().min(1, "Mobile number is required").max(50),
    city: z.string().trim().min(1, "City is required").max(255),
    state: z.string().max(255),
    zipCode: z.string().max(20),
    country: z.string().min(1, "Country is required"),
    specialty: z.string().min(1, "Specialty is required"),
    customSpecialty: z.string().max(255),
    marketingConsent: z.boolean(),
  })
  .refine((d) => d.specialty !== "Others" || d.customSpecialty.trim().length > 0, {
    message: "Please enter your specialty",
    path: ["customSpecialty"],
  });

type FormValues = z.infer<typeof schema>;

interface Loaded {
  email: string;
  details: Record<string, string | null>;
  source: "account" | "registration" | "none";
  marketing: { consented: boolean; since: string | null };
  upcomingRegistrations: number;
}

const EMPTY: FormValues = {
  title: "", role: "", firstName: "", lastName: "", organization: "", jobTitle: "", phone: "",
  city: "", state: "", zipCode: "", country: "", specialty: "", customSpecialty: "", marketingConsent: false,
};

export default function MyDetailsPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  const { register, control, handleSubmit, reset, formState } = form;
  const { errors, isSubmitting, isDirty } = formState;
  const specialty = useWatch({ control, name: "specialty" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/registrant/account-details")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        return (await res.json()) as Loaded;
      })
      .then((data) => {
        if (cancelled) return;
        setLoaded(data);
        const d = data.details;
        reset({
          ...EMPTY,
          ...Object.fromEntries(Object.keys(EMPTY).filter((k) => k !== "marketingConsent").map((k) => [k, d[k] ?? ""])),
          marketingConsent: data.marketing.consented,
        });
      })
      .catch((err) => {
        console.error("my-details: load failed", err);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reset]);

  const onSubmit = async (values: FormValues) => {
    const res = await fetch("/api/registrant/account-details", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, customSpecialty: values.specialty === "Others" ? values.customSpecialty : "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("my-details: save refused", res.status, data.error);
      toast.error(data.error || "Could not save your details. Please try again.");
      return;
    }
    const n = data.registrations?.updated ?? 0;
    toast.success(n > 0 ? `Saved. ${n} upcoming registration${n === 1 ? "" : "s"} updated too.` : "Your details are saved.");
    reset(values);
    if (loaded) setLoaded({ ...loaded, source: "account", marketing: { consented: values.marketingConsent, since: loaded.marketing.since } });
  };

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">We could not load your details. Please refresh the page.</CardContent>
        </Card>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex justify-center py-20" role="status" aria-label="Loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const fieldError = (name: keyof FormValues) =>
    errors[name]?.message ? (
      <p id={`${name}-error`} className="text-xs text-destructive" role="alert">
        {errors[name]?.message}
      </p>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 sm:py-2">
      <PageHeader title="My details" description="The details we put on your registrations and badges." />

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
        <Card className="gap-0 py-0">
          <CardContent className="space-y-5 p-4 sm:p-6">
            <SectionTitle icon={UserRound} title="About you" />
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr_1fr]">
              <div className="space-y-1.5">
                <Label>Title</Label>
                <Controller control={control} name="title" render={({ field }) => <TitleSelect value={field.value} onChange={field.onChange} />} />
              </div>
              <TextField label="First name" required error={fieldError("firstName")} {...register("firstName")} />
              <TextField label="Last name" required error={fieldError("lastName")} {...register("lastName")} />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" aria-hidden /> Email
              </Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{loaded.email}</span>
                <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </div>
              <p className="text-xs text-muted-foreground">Your sign-in address. To change it, contact the event organiser.</p>
            </div>

            <SectionTitle title="Work" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>
                  Role <span className="text-destructive">*</span>
                </Label>
                <Controller control={control} name="role" render={({ field }) => <RoleSelect value={field.value} onChange={field.onChange} />} />
                {fieldError("role")}
              </div>
              <div className="space-y-1.5">
                <Label>
                  Specialty <span className="text-destructive">*</span>
                </Label>
                <Controller control={control} name="specialty" render={({ field }) => <SpecialtySelect value={field.value} onChange={field.onChange} />} />
                {fieldError("specialty")}
              </div>
              {specialty === "Others" && (
                <TextField className="sm:col-span-2" label="Your specialty" required error={fieldError("customSpecialty")} {...register("customSpecialty")} />
              )}
              <TextField label="Organization" required error={fieldError("organization")} {...register("organization")} />
              <TextField label="Position" required error={fieldError("jobTitle")} {...register("jobTitle")} />
            </div>

            <SectionTitle title="Contact and location" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Mobile number" required type="tel" autoComplete="tel" error={fieldError("phone")} {...register("phone")} />
              <div className="space-y-1.5">
                <Label>
                  Country <span className="text-destructive">*</span>
                </Label>
                <Controller control={control} name="country" render={({ field }) => <CountrySelect value={field.value} onChange={field.onChange} />} />
                {fieldError("country")}
              </div>
              <TextField label="City" required autoComplete="address-level2" error={fieldError("city")} {...register("city")} />
              <TextField label="State / Province" autoComplete="address-level1" error={fieldError("state")} {...register("state")} />
              <TextField label="Zip / Postal code" autoComplete="postal-code" error={fieldError("zipCode")} {...register("zipCode")} />
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardContent className="p-4 sm:p-6">
            <Controller
              control={control}
              name="marketingConsent"
              render={({ field }) => (
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">Event news</span>
                    <span className="block text-sm text-muted-foreground">{MARKETING_CONSENT_TEXT}</span>
                  </span>
                </label>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {loaded.upcomingRegistrations > 0
              ? `Saving also updates the changed details on your ${loaded.upcomingRegistrations} upcoming registration${loaded.upcomingRegistrations === 1 ? "" : "s"}. Past registrations keep their details.`
              : "Past registrations keep the details they were made with."}
          </p>
          <Button type="submit" disabled={isSubmitting || !isDirty} className="h-11 w-full sm:h-9 sm:w-auto">
            {isSubmitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
            Save details
          </Button>
        </div>
      </form>
    </div>
  );
}

function SectionTitle({ title, icon: Icon }: { title: string; icon?: typeof UserRound }) {
  return (
    <h2 className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
      {Icon && <Icon className="h-4 w-4 text-label" aria-hidden />}
      {title}
    </h2>
  );
}

type TextFieldProps = React.ComponentProps<typeof Input> & { label: string; required?: boolean; error?: React.ReactNode };

function TextField({ label, required, error, className, id, name, ...props }: TextFieldProps) {
  const inputId = id ?? `field-${name}`;
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={inputId}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      <Input id={inputId} name={name} aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined} {...props} />
      {error}
    </div>
  );
}
