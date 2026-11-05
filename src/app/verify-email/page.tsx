"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

const VERIFY_HEADINGS: Record<"verifying" | "success" | "error", string> = {
  verifying: "Verifying…",
  success: "Email verified",
  error: "Verification failed",
};

/**
 * Email-confirmation landing. The link in the email opens this page; it POSTs
 * the token to /api/auth/verify-email once on load and shows the result.
 * Confirming lets registrations made earlier under the address appear on My
 * events, and attaches the organisation for a Meeting Minds address.
 *
 * It counts only for the signed-in owner of the account (the route says why),
 * so a signed-out visitor is sent to sign in and back here. A link scanner has
 * no session, so it can never confirm anything.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const email = params.get("email");
  const hasParams = !!token && !!email;
  // Derive the missing-params error at render (not via setState-in-effect); the
  // effect only sets state from the async fetch result.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // Speaker profiles this confirmation claimed: the person finishes each on
  // the event's submission page (details, presenter rate, badge registration).
  const [claimed, setClaimed] = useState<{ slug: string; name: string; door: "abstract" | "proposal" }[]>([]);
  const [state, setState] = useState<"verifying" | "success" | "error">(
    hasParams ? "verifying" : "error"
  );
  const [message, setMessage] = useState(
    hasParams ? "Verifying your email…" : "This verification link is missing information."
  );
  const ran = useRef(false);

  useEffect(() => {
    if (!hasParams || ran.current) return;
    ran.current = true;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setState("success");
          setMessage(data.message || "Your email has been verified.");
          setClaimed(Array.isArray(data.claimedEvents) ? data.claimedEvents : []);
        } else {
          // Not signed in, or signed in as someone else: the token is unspent,
          // so signing in to the right account and returning here completes it.
          setNeedsSignIn(data.code === "SIGN_IN_REQUIRED" || data.code === "WRONG_ACCOUNT");
          setState("error");
          setMessage(data.error || "We couldn't verify your email.");
        }
      })
      .catch(() => {
        setState("error");
        setMessage("Something went wrong. Please try again.");
      });
  }, [hasParams, token, email]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#f0fbff] to-[#f8fafc] px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white px-8 py-10 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-slate-50">
          {state === "verifying" && <Loader2 className="h-7 w-7 animate-spin text-[#00aade]" />}
          {state === "success" && <CheckCircle2 className="h-7 w-7 text-emerald-600" />}
          {state === "error" && <XCircle className="h-7 w-7 text-red-500" />}
        </div>
        <h1 className="text-xl font-semibold text-slate-900">
          {VERIFY_HEADINGS[state]}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{message}</p>
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
        {state !== "verifying" && (
          <Link
            href={nextHref(state, needsSignIn, token, email)}
            className="mt-6 inline-block rounded-lg bg-[#00aade] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0098c7]"
          >
            {nextLabel(state, needsSignIn)}
          </Link>
        )}
        {needsSignIn && (
          <p className="mt-4 text-sm text-slate-500">
            {/* A desk-made account has no password yet, and the real owner of an
                account someone else made takes it over here. */}
            No password, or not your account?{" "}
            <Link href="/forgot-password" className="font-medium text-[#0083ad] hover:underline">
              Reset the password
            </Link>
            , then open this link again.
          </p>
        )}
      </div>
    </main>
  );
}

/** Where the button goes: My events after a success, sign-in and back for a refusal. */
function nextHref(state: "success" | "error", needsSignIn: boolean, token: string | null, email: string | null): string {
  // /dashboard lands each role on its own home (My events for a registrant).
  if (state === "success") return "/dashboard";
  if (!needsSignIn || !token || !email) return "/login";
  const back = `/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  return `/login?callbackUrl=${encodeURIComponent(back)}`;
}

function nextLabel(state: "success" | "error", needsSignIn: boolean): string {
  if (state === "success") return "Continue";
  return needsSignIn ? "Sign in to confirm" : "Continue to sign in";
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
