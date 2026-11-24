"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSession, signIn } from "next-auth/react";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type State = "verifying" | "password" | "success" | "error";

const VERIFY_HEADINGS: Record<State, string> = {
  verifying: "Verifying…",
  password: "Confirm your account",
  success: "Email confirmed",
  error: "Verification failed",
};

type Claimed = { slug: string; name: string; door: "abstract" | "proposal" };

/**
 * Email-confirmation landing. The link in the email opens this page; it POSTs
 * the token to /api/auth/verify-email once on load and shows the result.
 * Confirming lets registrations made earlier under the address appear on My
 * events, lets an account made at /signup sign in, and attaches the
 * organisation for a Meeting Minds address.
 *
 * It counts only for the account's holder (the route says why): a signed-in
 * session of that account confirms at once; anyone else is asked for the
 * account's password here, and the page then signs them in. A link scanner
 * has neither, so it can never confirm anything.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const email = params.get("email");
  const hasParams = !!token && !!email;
  // Speaker profiles this confirmation claimed: the person finishes each on
  // the event's submission page (details, presenter rate, badge registration).
  const [claimed, setClaimed] = useState<Claimed[]>([]);
  const [state, setState] = useState<State>(hasParams ? "verifying" : "error");
  const [message, setMessage] = useState(
    hasParams ? "Verifying your email…" : "This verification link is missing information."
  );
  const [password, setPassword] = useState("");
  // A refused password, shown at the box. Until Nov 24, 2026 the only sign was
  // the grey sentence above the form changing, and a second wrong try changed
  // nothing at all: the owner typed one twice on production and saw no error.
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordBox = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const ran = useRef(false);

  /** One confirmation attempt; with a password when the person typed one. */
  const confirm = async (withPassword?: string) => {
    const res = await fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email, ...(withPassword && { password: withPassword }) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setClaimed(Array.isArray(data.claimedEvents) ? data.claimedEvents : []);
      if (withPassword) {
        // Confirmed by password: sign in with it, so Continue lands on My events.
        const result = await signIn("credentials", { email, password: withPassword, redirect: false });
        if (result?.error) console.error("[verify-email] sign-in after confirming failed", result.code);
        setSignedIn(!result?.error);
      }
      setState("success");
      setMessage(data.message || "Your email has been verified.");
      return;
    }
    // Not signed in, signed in as someone else, or a wrong password: the token
    // is unspent, so the account's password completes it here.
    if (data.code === "BAD_PASSWORD") {
      // The sentence above the form keeps saying what to do; the refusal goes
      // at the box, which is emptied so a second wrong try is seen as one.
      // Only what was SENT is emptied: someone already retyping keeps it.
      setState("password");
      setPasswordError(data.error || "That password is not right for this account.");
      setPassword((typed) => (typed === withPassword ? "" : typed));
      passwordBox.current?.focus();
      return;
    }
    // A password was sent and the answer is not about it: too many tries, or
    // the server failed. The link is unspent either way, so the form stays and
    // says so at the box (review of 7a84e8032: both used to replace the form
    // with "Verification failed", as if the link were dead).
    if (withPassword && (res.status === 429 || res.status >= 500)) {
      setState("password");
      setPasswordError(res.status === 429 ? throttleMessage(data.retryAfterSeconds) : "Something went wrong. Please try again.");
      return;
    }
    if (["SIGN_IN_REQUIRED", "WRONG_ACCOUNT"].includes(data.code)) {
      setState("password");
      setMessage(data.error || "Enter your password to confirm this account.");
      return;
    }
    setState("error");
    setMessage(data.error || "We couldn't verify your email.");
  };

  useEffect(() => {
    if (!hasParams || ran.current) return;
    ran.current = true;
    // Signed out (an account made at /signup always is): ask for the password
    // straight away rather than send a request the route can only refuse.
    getSession()
      .then((session) => {
        if (session?.user) return confirm();
        setState("password");
        setMessage("Enter your password to confirm this account.");
      })
      .catch((err) => {
        console.error("[verify-email] confirm failed", err);
        setState("error");
        setMessage("Something went wrong. Please try again.");
      });
    // Runs once on load; `confirm` reads the same token and email.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasParams]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setPasswordError(null);
    try {
      await confirm(password);
    } catch (err) {
      console.error("[verify-email] confirm with password failed", err);
      setPasswordError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // Inside the sign-in frame (layout.tsx), which centres it and carries the logo.
    <main className="w-full max-w-md">
      <div className="rounded-2xl border border-slate-200 bg-white px-5 py-8 text-center shadow-sm sm:px-8 sm:py-10">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-slate-50">
          <StateIcon state={state} />
        </div>
        <h1 className="text-xl font-semibold text-slate-900">{VERIFY_HEADINGS[state]}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{message}</p>

        {state === "password" && (
          <form onSubmit={onSubmit} className="mt-6 space-y-4 text-left">
            <div className="space-y-1.5">
              <label htmlFor="confirm-email" className="text-sm font-medium text-slate-900">Email</label>
              <input id="confirm-email" type="email" value={email ?? ""} readOnly className="h-10 w-full rounded-md border border-slate-200 bg-slate-100 px-3 text-sm text-slate-600" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm-password" className="text-sm font-medium text-slate-900">Password</label>
              <input
                id="confirm-password"
                ref={passwordBox}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  // Typing again answers the refusal: it goes as soon as they start.
                  setPasswordError(null);
                }}
                aria-invalid={passwordError ? true : undefined}
                // The hint only: the refusal below is an alert, which is read by itself.
                aria-describedby="confirm-password-hint"
                className={cn(
                  "h-10 w-full rounded-md border bg-white px-3 text-sm focus:outline-none focus:ring-2",
                  passwordError
                    ? "border-red-500 focus:border-red-500 focus:ring-red-500/30"
                    : "border-slate-200 focus:border-[#00aade] focus:ring-[#00aade]/30",
                )}
              />
              {passwordError && (
                <p role="alert" className="text-sm font-medium text-red-600">
                  {passwordError}
                </p>
              )}
              {/* Always there, and most useful beside a refusal. True however the
                  person came: a new account's password is the one they just chose. */}
              <p id="confirm-password-hint" className="text-xs text-slate-500">
                The password you sign in with. If this address already had an account before you registered, it is
                that account&apos;s password.
              </p>
            </div>
            <button
              type="submit"
              disabled={submitting || !password}
              className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-[#00aade] text-sm font-medium text-white transition-colors hover:bg-[#0098c7] disabled:opacity-60"
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm and sign in
            </button>
            <p className="border-t border-slate-100 pt-4 text-center text-sm text-slate-500">
              {/* A desk-made account has no password yet, and the real owner of an
                  account someone else made takes it over here. */}
              No password, or not your account?{" "}
              <Link href="/forgot-password" className="font-medium text-[#0083ad] hover:underline">
                Reset the password
              </Link>
              , then open this link again.
            </p>
          </form>
        )}

        {state === "success" && claimed.length > 0 && (
          <div className="mt-5 space-y-2 text-left">
            <p className="text-sm text-slate-600">Your speaker profile is now yours. Finish your submission:</p>
            {claimed.map((c) => (
              <Link
                key={c.slug}
                href={`/e/${c.slug}/${c.door}/register`}
                className="block rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-900 hover:border-[#00aade]"
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
        {(state === "success" || state === "error") && (
          <Link
            // /dashboard lands each role on its own home (My events for a registrant).
            href={state === "success" && signedIn ? "/dashboard" : "/login"}
            className="mt-6 inline-block rounded-lg bg-[#00aade] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0098c7]"
          >
            {state === "success" && signedIn ? "Continue" : "Continue to sign in"}
          </Link>
        )}
      </div>
    </main>
  );
}

/** What a throttled attempt is told, with the wait when the server gave one. */
function throttleMessage(retryAfterSeconds: unknown): string {
  if (typeof retryAfterSeconds !== "number" || retryAfterSeconds <= 0) return "Too many attempts. Please wait a few minutes and try again.";
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many attempts. Please try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

function StateIcon({ state }: { state: State }) {
  if (state === "verifying") return <Loader2 className="h-7 w-7 animate-spin text-[#00aade]" />;
  if (state === "password") return <KeyRound className="h-7 w-7 text-[#00aade]" />;
  if (state === "success") return <CheckCircle2 className="h-7 w-7 text-emerald-600" />;
  return <XCircle className="h-7 w-7 text-red-500" />;
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
