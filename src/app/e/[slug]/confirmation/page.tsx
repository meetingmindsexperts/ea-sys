"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  Mail,
  ArrowLeft,
  Calendar,
  CreditCard,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { sanitizeHtml } from "@/lib/sanitize";
import { toast } from "sonner";

interface EventBranding {
  bannerImage: string | null;
  footerHtml: string | null;
  name: string | null;
  organization?: { name: string; logo: string | null } | null;
}

interface PaymentInfo {
  registrationStatus: string;
  paymentStatus: string;
  ticketName: string;
  ticketPrice: number;
  ticketCurrency: string;
}

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const params = useParams();
  const slug = params.slug as string;
  const registrationId = searchParams.get("id");
  const firstName = searchParams.get("name");
  const paymentParam = searchParams.get("payment"); // "success" | "cancelled" | null
  const statusParam = searchParams.get("status"); // "PENDING" | "CONFIRMED" | null

  const [branding, setBranding] = useState<EventBranding | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [loadingPayment, setLoadingPayment] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [polling, setPolling] = useState(false);

  // Fetch event branding
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/public/events/${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setBranding({
          bannerImage: data.bannerImage,
          footerHtml: data.footerHtml,
          name: data.name,
          organization: data.organization,
        });
      })
      .catch((err) => { console.error("[confirmation] branding fetch failed", err); });
  }, [slug]);

  // Fetch payment status — always fetch from server for paid tickets
  const fetchPaymentStatus = useCallback(async () => {
    if (!slug || !registrationId) return null;
    try {
      const res = await fetch(`/api/public/events/${slug}/payment-status/${registrationId}`);
      if (res.ok) {
        const data: PaymentInfo = await res.json();
        setPaymentInfo(data);
        return data;
      }
    } catch (err) {
      console.error("[confirmation] Failed to load registration details:", err);
    }
    return null;
  }, [slug, registrationId]);

  // Always fetch payment info when we have a registrationId — server is the source of truth
  useEffect(() => {
    if (registrationId) {
      setLoadingPayment(true);
      fetchPaymentStatus().finally(() => setLoadingPayment(false));
    }
  }, [registrationId, fetchPaymentStatus]);

  // Poll for payment completion after returning from Stripe
  useEffect(() => {
    if (paymentParam !== "success" || !registrationId) return;
    // If we already know it's paid, skip
    if (paymentInfo?.paymentStatus === "PAID") return;

    setPolling(true);
    let attempts = 0;
    const maxAttempts = 8;

    const interval = setInterval(async () => {
      attempts++;
      const data = await fetchPaymentStatus();
      if (data?.paymentStatus === "PAID" || attempts >= maxAttempts) {
        clearInterval(interval);
        setPolling(false);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [paymentParam, registrationId, paymentInfo?.paymentStatus, fetchPaymentStatus]);

  const handlePayNow = async () => {
    if (!registrationId) return;
    setCheckoutLoading(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to create checkout session");
        setCheckoutLoading(false);
        return;
      }
      // Redirect to Stripe Checkout
      window.location.href = data.checkoutUrl;
    } catch (err) {
      console.error("[confirmation] Checkout redirect failed:", err);
      toast.error("Something went wrong. Please try again.");
      setCheckoutLoading(false);
    }
  };

  const isPaid = paymentInfo?.paymentStatus === "PAID";
  // Derive payment display from server-fetched data only — URL params are not trusted
  const ticketPrice = paymentInfo?.ticketPrice ?? 0;
  const ticketCurrency = paymentInfo?.ticketCurrency ?? "USD";
  const hasPaidTicket = paymentInfo ? ticketPrice > 0 : false;
  // Registration status: prefer server data, fall back to URL param
  const registrationStatus = paymentInfo?.registrationStatus ?? statusParam;
  const isPending = registrationStatus === "PENDING";

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      {/* ── Banner ─────────────────────────────────────────────────────────── */}
      {branding?.bannerImage ? (
        <div className="w-full max-w-2xl mx-auto px-4 pt-6">
          <div className="relative w-full h-36 sm:h-44 overflow-hidden rounded-2xl">
            <Image
              src={branding.bannerImage}
              alt={branding.name || "Event banner"}
              width={1400}
              height={300}
              className="w-full h-full object-contain object-center"
              unoptimized
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 to-black/50" />

            {/* Event name overlay */}
            {branding.name && (
              <div className="absolute inset-0 flex flex-col justify-end">
                <div className="px-5 pb-4 text-center">
                  <p className="text-white/90 text-sm font-medium drop-shadow-sm">
                    {branding.name}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* No banner — thin gradient accent line */
        <div className="h-1 bg-gradient-primary" />
      )}

      {/* ── Main Content ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-start justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-md">
          {/* Success card */}
          <div className="bg-white rounded-2xl shadow-lg border border-slate-100 overflow-hidden">
            {/* Top gradient bar */}
            <div className="h-1 bg-gradient-primary" />

            <div className="px-8 pt-8 pb-6 text-center">
              {/* Animated check */}
              <div className={`mx-auto mb-5 h-20 w-20 rounded-full flex items-center justify-center ring-8 ${isPending ? "bg-amber-50 ring-amber-50/50" : "bg-emerald-50 ring-emerald-50/50"}`}>
                {isPending ? (
                  <Clock className="h-11 w-11 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-11 w-11 text-emerald-500" />
                )}
              </div>

              <h1 className="text-2xl font-bold text-slate-900 mb-1">
                {isPending
                  ? (firstName ? `Registration submitted, ${firstName}!` : "Registration Submitted")
                  : (firstName ? `You're registered, ${firstName}!` : "Registration Confirmed!")}
              </h1>
              <p className="text-slate-500 text-sm leading-relaxed">
                {isPending
                  ? "Your registration is pending approval. You'll receive an email once it's confirmed."
                  : "Your spot has been secured. We look forward to seeing you there."}
              </p>
            </div>

            {/* Confirmation number */}
            {registrationId && (
              <div className="mx-6 mb-5 bg-slate-50 rounded-xl border border-slate-100 p-4 text-center">
                <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-1">
                  Confirmation Number
                </p>
                <p className="font-mono font-bold text-slate-900 text-sm tracking-wider">
                  {registrationId.toUpperCase()}
                </p>
              </div>
            )}

            {/* Payment Section — only for paid tickets */}
            {hasPaidTicket && !loadingPayment && (
              <div className="mx-6 mb-5">
                {isPaid ? (
                  /* Payment Complete */
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-emerald-800">Payment Complete</p>
                        <p className="text-xs text-emerald-600 mt-0.5">
                          {ticketCurrency} {ticketPrice.toFixed(2)} — A receipt has been sent to your email.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : polling ? (
                  /* Processing payment */
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-5 w-5 text-blue-600 animate-spin shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-blue-800">Processing Payment...</p>
                        <p className="text-xs text-blue-600 mt-0.5">
                          This may take a few moments. Please don&apos;t close this page.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Pay Now / Pay Later */
                  <div className="space-y-3">
                    {paymentParam === "cancelled" && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                        <p className="text-xs text-amber-700">Payment was cancelled. You can try again below.</p>
                      </div>
                    )}

                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <CreditCard className="h-4 w-4 text-slate-500" />
                          <span className="text-sm font-medium text-slate-700">Payment Due</span>
                        </div>
                        <span className="text-sm font-bold text-slate-900">
                          {ticketCurrency} {ticketPrice.toFixed(2)}
                        </span>
                      </div>
                      {paymentInfo?.ticketName && (
                        <p className="text-xs text-slate-500 mb-3">{paymentInfo.ticketName}</p>
                      )}
                      <div className="space-y-2">
                        <Button
                          onClick={handlePayNow}
                          disabled={checkoutLoading}
                          className="w-full h-10 rounded-lg font-medium btn-gradient"
                        >
                          {checkoutLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : (
                            <CreditCard className="h-4 w-4 mr-2" />
                          )}
                          Pay Now
                        </Button>
                        <p className="text-xs text-center text-slate-400">
                          Or pay later using the link in your confirmation email.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Loading payment info */}
            {hasPaidTicket && loadingPayment && (
              <div className="mx-6 mb-5 flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            )}

            {/* Email notice */}
            <div className="mx-6 mb-6 flex items-start gap-3 bg-primary/5 border border-primary/10 rounded-xl p-4">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Mail className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">Check your inbox</p>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                  A confirmation email with your registration details and QR code is on its way.
                </p>
              </div>
            </div>

            {/* Divider */}
            <div className="mx-6 mb-5 border-t border-slate-100" />

            {/* What to expect */}
            <div className="mx-6 mb-6">
              <p className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                Before the Event
              </p>
              <div className="space-y-2.5">
                {[
                  "Save the date and add it to your calendar",
                  "Watch for updates from the organizer",
                  "Bring your QR code for check-in",
                ].map((tip, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                    <div className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                    {tip}
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="px-6 pb-8 space-y-3">
              <Link href={`/e/${slug}`} className="block">
                <Button
                  variant="outline"
                  className="w-full h-11 rounded-xl font-medium gap-2 border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Event Page
                </Button>
              </Link>
            </div>
          </div>

          {/* Organizer note */}
          <p className="text-center text-xs text-slate-500 mt-6 flex items-center justify-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            Questions? Contact the event organizer directly.
          </p>
        </div>
      </div>

      {/* ── Custom Footer ──────────────────────────────────────────────────── */}
      {branding?.footerHtml && (
        <div className="w-full border-t border-slate-100 bg-white text-center px-4 py-6">
          <div className="prose prose-slate max-w-none mx-auto [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(branding.footerHtml) }} />
        </div>
      )}
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-12 text-center w-full max-w-md mx-4">
            <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-slate-500 text-sm">Loading…</p>
          </div>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}
