"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN } from "@/lib/account-signup-rules";
import { MARKETING_CONSENT_TEXT } from "@/lib/marketing-consent";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { usePersonFieldRules } from "@/hooks/use-person-fields";
import { withPersonFieldRules } from "@/lib/person-field-check";

const signupSchema = z
  .object({
    // The public registration form's questions (owner, Nov 9, 2026), so the
    // account holds what a registration needs; the route checks the same.
    title: z.string(),
    firstName: z.string().trim().min(1, "Enter your first name").max(100),
    lastName: z.string().trim().min(1, "Enter your last name").max(100),
    email: z.string().trim().email("Please enter a valid email").max(255),
    // Role and Specialty are demanded as the organisation says: the resolver
    // adds its rules (withPersonFieldRules), as the route does.
    role: z.string(),
    specialty: z.string(),
    customSpecialty: z.string().max(255),
    organization: z.string().trim().min(1, "Enter your organization").max(255),
    jobTitle: z.string().trim().min(1, "Enter your position").max(255),
    phone: z.string().trim().min(1, "Enter your mobile number").max(50),
    country: z.string().min(1, "Choose your country"),
    city: z.string().trim().min(1, "Enter your city").max(255),
    state: z.string().max(255),
    zipCode: z.string().max(20),
    marketingConsent: z.boolean(),
    password: z
      .string()
      .min(SIGNUP_PASSWORD_MIN, `At least ${SIGNUP_PASSWORD_MIN} characters`)
      .max(SIGNUP_PASSWORD_MAX, `At most ${SIGNUP_PASSWORD_MAX} characters`),
    confirmPassword: z.string(),
    acceptTerms: z.boolean().refine((v) => v, "Please accept to continue"),
    website: z.string().optional(),
  })
  .refine((d) => d.password === d.confirmPassword, { message: "The passwords don't match", path: ["confirmPassword"] });

type SignupValues = z.infer<typeof signupSchema>;

/**
 * The /signup form and, once sent, the "check your email" screen. The answer
 * is the same whether or not the address already has an account (the route
 * explains), so the screen says "if this address can be used".
 */
export function SignupForm({
  organizationName,
  termsUrl,
  privacyUrl,
}: {
  organizationName: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
}) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // What this organisation's forms do with Title, Role and Specialty (Settings, Form fields).
  const fieldRules = usePersonFieldRules();
  const schemaWithFieldRules = useMemo(() => withPersonFieldRules(signupSchema, fieldRules), [fieldRules]);
  const form = useForm<SignupValues>({
    resolver: zodResolver(schemaWithFieldRules),
    defaultValues: {
      title: "", firstName: "", lastName: "", email: "", role: "", specialty: "", customSpecialty: "", organization: "",
      jobTitle: "", phone: "", country: "", city: "", state: "", zipCode: "",
      password: "", confirmPassword: "", acceptTerms: false, marketingConsent: false, website: "",
    },
  });
  const specialty = useWatch({ control: form.control, name: "specialty" });

  async function onSubmit(values: SignupValues) {
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: values.title,
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          role: values.role,
          specialty: values.specialty,
          customSpecialty: values.specialty === "Others" ? values.customSpecialty : "",
          organization: values.organization,
          jobTitle: values.jobTitle,
          phone: values.phone,
          country: values.country,
          city: values.city,
          state: values.state,
          zipCode: values.zipCode,
          password: values.password,
          acceptTerms: true,
          marketingConsent: values.marketingConsent,
          ...(values.website && { website: values.website }),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't create the account. Please try again.");
        return;
      }
      setSentTo(values.email.trim().toLowerCase());
    } catch (err) {
      console.error("[signup] request failed", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  if (sentTo) {
    return <CheckYourEmail email={sentTo} onStartAgain={() => setSentTo(null)} />;
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Create your account</CardTitle>
        <CardDescription>
          One account for every {organizationName ? `${organizationName} ` : ""}event: registrations, certificates and CME hours.
        </CardDescription>
      </CardHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardContent className="space-y-4">
            <SectionLabel>About you</SectionLabel>
            <div className={fieldRules.title.shown ? "grid grid-cols-1 gap-4 sm:grid-cols-[7rem_1fr_1fr]" : "grid grid-cols-1 gap-4 sm:grid-cols-2"}>
              {fieldRules.title.shown && (
                <FormField control={form.control} name="title" render={({ field }) => (
                  <FormItem><FormLabel>Title</FormLabel><TitleSelect value={field.value} onChange={field.onChange} /><FormMessage /></FormItem>
                )} />
              )}
              <TextInput form={form} name="firstName" label="First name" autoComplete="given-name" />
              <TextInput form={form} name="lastName" label="Last name" autoComplete="family-name" />
            </div>
            <TextInput form={form} name="email" label="Email" type="email" autoComplete="email" placeholder="name@example.com" />

            <SectionLabel>Work</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {fieldRules.role.shown && (
                <FormField control={form.control} name="role" render={({ field }) => (
                  <FormItem><FormLabel>Role</FormLabel><RoleSelect value={field.value} onChange={field.onChange} /><FormMessage /></FormItem>
                )} />
              )}
              {fieldRules.specialty.shown && (
                <FormField control={form.control} name="specialty" render={({ field }) => (
                  <FormItem><FormLabel>Specialty</FormLabel><SpecialtySelect value={field.value} onChange={field.onChange} /><FormMessage /></FormItem>
                )} />
              )}
              {fieldRules.specialty.shown && specialty === "Others" && <TextInput form={form} name="customSpecialty" label="Your specialty" className="sm:col-span-2" />}
              <TextInput form={form} name="organization" label="Organization" autoComplete="organization" />
              <TextInput form={form} name="jobTitle" label="Position" autoComplete="organization-title" />
            </div>

            <SectionLabel>Contact and location</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput form={form} name="phone" label="Mobile number" type="tel" autoComplete="tel" />
              <FormField control={form.control} name="country" render={({ field }) => (
                <FormItem><FormLabel>Country</FormLabel><CountrySelect value={field.value} onChange={field.onChange} /><FormMessage /></FormItem>
              )} />
              <TextInput form={form} name="city" label="City" autoComplete="address-level2" />
              <TextInput form={form} name="state" label="State / Province (optional)" autoComplete="address-level1" />
              <TextInput form={form} name="zipCode" label="Zip / Postal code (optional)" autoComplete="postal-code" />
            </div>

            <SectionLabel>Password</SectionLabel>
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">At least {SIGNUP_PASSWORD_MIN} characters.</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Never seen by a person; a bot filling every field fills this one. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="signup-website">Website</label>
              <input id="signup-website" tabIndex={-1} autoComplete="off" {...form.register("website")} />
            </div>
            <FormField
              control={form.control}
              name="acceptTerms"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-2.5">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />
                    </FormControl>
                    <FormLabel className="text-sm font-normal leading-relaxed text-muted-foreground">
                      <span>
                        I agree to {organizationName ? `${organizationName}'s` : "the"}{" "}
                        <PolicyLink href={termsUrl}>terms of use</PolicyLink> and <PolicyLink href={privacyUrl}>privacy policy</PolicyLink>.
                      </span>
                    </FormLabel>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Unticked until the person ticks it: consent is never a default. */}
            <FormField
              control={form.control}
              name="marketingConsent"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-2.5">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />
                    </FormControl>
                    <FormLabel className="text-sm font-normal leading-relaxed text-muted-foreground">{MARKETING_CONSENT_TEXT}</FormLabel>
                  </div>
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 pt-6">
            <Button type="submit" className="w-full btn-gradient" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create account
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}

/** A policy link when the organisation set one (Settings, Catalogue), else plain words. */
function PolicyLink({ href, children }: { href: string | null; children: string }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  );
}

function CheckYourEmail({ email, onStartAgain }: { email: string; onStartAgain: () => void }) {
  const [sending, setSending] = useState(false);

  async function resend() {
    setSending(true);
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Couldn't send the link. Please try again.");
        return;
      }
      toast.success("If the account is waiting for confirmation, the link is on its way.");
    } catch (err) {
      console.error("[signup] resend failed", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          If <strong className="text-foreground">{email}</strong> can be used for a new account, we have sent a link to it. Open
          the link within 7 days to confirm your account.
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          You can&apos;t sign in until you confirm. Nothing arrived after a few minutes? Check your spam folder, then send it again.
        </p>
        <Button variant="outline" onClick={resend} disabled={sending}>
          {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Send the link again
        </Button>
        <button type="button" onClick={onStartAgain} className="text-sm text-primary hover:underline">
          Wrong address? Start again
        </button>
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="border-b pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-label">{children}</p>;
}

type TextName = "firstName" | "lastName" | "email" | "customSpecialty" | "organization" | "jobTitle" | "phone" | "city" | "state" | "zipCode";

function TextInput({
  form,
  name,
  label,
  className,
  ...input
}: { form: ReturnType<typeof useForm<SignupValues>>; name: TextName; label: string; className?: string } & Omit<React.ComponentProps<typeof Input>, "form" | "name">) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...input} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
