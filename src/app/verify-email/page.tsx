"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

/**
 * Email-verification landing. The link in the verify email opens this page; it
 * POSTs the token to /api/auth/verify-email once on load and shows the result.
 * Verifying only attaches the org / marks the account internal — the person's
 * registration works regardless, so this is purely a confirmation screen.
 *
 * The fetch is JS-triggered, so email link-scanners (no JS) won't auto-verify.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const email = params.get("email");
  const hasParams = !!token && !!email;
  // Derive the missing-params error at render (not via setState-in-effect); the
  // effect only sets state from the async fetch result.
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
        } else {
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
          {state === "verifying" ? "Verifying…" : state === "success" ? "Email verified" : "Verification failed"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{message}</p>
        {state !== "verifying" && (
          <Link
            href="/login"
            className="mt-6 inline-block rounded-lg bg-[#00aade] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0098c7]"
          >
            Continue to sign in
          </Link>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
