"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { CheckCircle2, Mail, ArrowLeft, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EventBranding {
  bannerImage: string | null;
  footerHtml: string | null;
}

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const params = useParams();
  const slug = params.slug as string;
  const registrationId = searchParams.get("id");
  const firstName = searchParams.get("name");

  const [branding, setBranding] = useState<EventBranding | null>(null);

  useEffect(() => {
    async function fetchEventBranding() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (res.ok) {
          const data = await res.json();
          setBranding({
            bannerImage: data.bannerImage,
            footerHtml: data.footerHtml,
          });
        }
      } catch {
        // Silently fail - branding is optional
      }
    }

    if (slug) {
      fetchEventBranding();
    }
  }, [slug]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-900">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-dot-pattern opacity-5 pointer-events-none" />

      {/* Banner image strip */}
      {branding?.bannerImage && (
        <div className="relative w-full h-32 overflow-hidden">
          <Image
            src={branding.bannerImage}
            alt="Event banner"
            width={1400}
            height={300}
            className="w-full h-full object-cover opacity-40"
            unoptimized
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-900/40 to-slate-900" />
        </div>
      )}

      <div className="flex-1 flex items-center justify-center p-4 relative">
        <div className="w-full max-w-md">
          {/* Success card */}
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            {/* Top gradient bar */}
            <div className="h-1.5 bg-gradient-primary" />

            <div className="px-8 pt-8 pb-6 text-center">
              {/* Animated check */}
              <div className="mx-auto mb-5 h-20 w-20 rounded-full bg-emerald-50 flex items-center justify-center ring-8 ring-emerald-50/50">
                <CheckCircle2 className="h-11 w-11 text-emerald-500" />
              </div>

              <h1 className="text-2xl font-bold text-slate-900 mb-1">
                {firstName ? `You're registered, ${firstName}!` : "Registration Confirmed!"}
              </h1>
              <p className="text-slate-500 text-sm leading-relaxed">
                Your spot has been secured. We look forward to seeing you there.
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

      {/* Custom Footer */}
      {branding?.footerHtml && (
        <div
          className="w-full border-t bg-white"
          dangerouslySetInnerHTML={{ __html: branding.footerHtml }}
        />
      )}
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-900 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-xl p-12 text-center w-full max-w-md mx-4">
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
