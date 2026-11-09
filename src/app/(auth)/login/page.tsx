"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { signInErrorMessage } from "@/lib/sign-in-messages";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { safeInternalPath } from "@/lib/safe-redirect";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

type LoginForm = z.infer<typeof loginSchema>;

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Same-origin paths ONLY (Sep 21, 2026 security review, finding #3). This
  // was read raw and pushed, so a crafted link landed a signed-in ADMIN on an
  // attacker's page — on the real domain, with the real login, right after
  // they typed a real password, which is what makes a second "session expired"
  // prompt believable. The two sibling doors already guarded it; this one was
  // missed. Fails closed to the dashboard.
  const callbackUrl = safeInternalPath(searchParams.get("callbackUrl"), "/dashboard");
  // Set by the global session-expiry redirect (src/lib/session-expiry.ts).
  // Without it, being bounced here from a working page reads as a fault.
  const sessionExpired = searchParams.get("reason") === "expired";
  const [isLoading, setIsLoading] = useState(false);
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  async function onSubmit(data: LoginForm) {
    setIsLoading(true);
    setUnconfirmedEmail(null);

    try {
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        surface: "DASHBOARD",
        redirect: false,
      });

      if (result?.error) {
        // The server distinguishes "throttled" from "wrong password" so a
        // locked-out person isn't told their correct password is wrong. Falls
        // back to the generic message if the code isn't present.
        // An account made at /signup that is not confirmed yet gets a lasting
        // notice with a resend button rather than a toast.
        if (result.code === "EmailUnconfirmed") {
          setUnconfirmedEmail(data.email.trim().toLowerCase());
        } else {
          toast.error(signInErrorMessage(result.code));
        }
        setIsLoading(false);
        return;
      }

      toast.success("Welcome back!");
      router.push(callbackUrl);
      router.refresh();
    } catch (err) {
      console.error("[login] sign in failed", err);
      toast.error("Something went wrong. Please try again.");
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
        <CardDescription>
          Sign in to MM Group Events
        </CardDescription>
      </CardHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            {sessionExpired && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                Your session expired, so you were signed out. Sign in again and
                we&apos;ll take you straight back to where you were.
              </div>
            )}
            {unconfirmedEmail && <UnconfirmedNotice email={unconfirmedEmail} />}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="name@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="••••••••" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          {/* pt-4 on top of Card's own gap-6 — the password field is the last
              thing in CardContent, and 24px read as one continuous block with
              the submit button rather than a separate action. */}
          {/* pt-8 measured, not guessed: the event sign-in at /e/{slug}/login
                puts 40px between the password field and its button, and this
                screen sat at 16px — tighter than its own field rhythm, so the
                primary action read as cramped. The two structures differ
                (CardFooter here, a form sibling there), so the number that
                matches is not the same class. */}
          <CardFooter className="flex flex-col space-y-4 pt-8">
            <div className="w-full space-y-2">
              <Button type="submit" className="w-full btn-gradient" disabled={isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign in
              </Button>
              <div className="text-right">
                <Link href="/forgot-password" className="text-sm text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
            </div>
            {/* Accounts for attendees (Nov 5, 2026). Staff are still invited. */}
            <p className="text-sm text-muted-foreground text-center">
              New here?{" "}
              <Link href="/signup" className="text-primary hover:underline">
                Create an account
              </Link>
            </p>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}

/** "Confirm your email first", with the link sent again on request. */
function UnconfirmedNotice({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  async function resend() {
    setSending(true);
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Couldn't send the link. Please try again.");
        return;
      }
      toast.success("The link is on its way. Check your inbox.");
    } catch (err) {
      console.error("[login] resend confirmation failed", err);
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  }
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
      <p className="font-medium">Confirm your email first</p>
      <p>We sent a link to {email} when you created the account. Open it to confirm, then sign in.</p>
      <Button type="button" variant="outline" size="sm" onClick={resend} disabled={sending}>
        {sending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        Send the link again
      </Button>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <Card className="w-full max-w-md">
          <CardContent className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin" />
          </CardContent>
        </Card>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
