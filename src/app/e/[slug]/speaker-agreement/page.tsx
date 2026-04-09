"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { sanitizeHtml } from "@/lib/sanitize";
import { toast } from "sonner";

interface AgreementData {
  alreadyAccepted: boolean;
  acceptedAt: string | null;
  speaker: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    title: string | null;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    bannerImage: string | null;
    organization: { name: string; logo: string | null } | null;
  };
  agreementHtml: string;
}

function SpeakerAgreementContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AgreementData | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const fetchAgreement = useCallback(async () => {
    if (!token) {
      setError("Missing token. Please use the link from your email.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/public/events/${slug}/speaker-agreement?token=${encodeURIComponent(token)}`);
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || "Failed to load agreement");
      } else {
        setData(result);
      }
    } catch {
      setError("Failed to load agreement. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [slug, token]);

  useEffect(() => {
    fetchAgreement();
  }, [fetchAgreement]);

  const handleSubmit = async () => {
    if (!accepted || !token || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/speaker-agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, accepted: true }),
      });
      const result = await res.json();
      if (!res.ok) {
        toast.error(result.error || "Failed to accept agreement");
        setSubmitting(false);
        return;
      }
      setSubmitSuccess(true);
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-slate-400 text-sm">Loading agreement...</p>
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
          <Link href={`/e/${slug}`} className="text-primary text-sm font-medium hover:underline">
            Back to event page
          </Link>
        </div>
      </div>
    );
  }

  const isAccepted = submitSuccess || data.alreadyAccepted;

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb] text-base">
      {/* Banner */}
      {data.event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="max-w-[1400px] mx-auto">
            <Image
              src={data.event.bannerImage}
              alt={data.event.name}
              width={1400}
              height={400}
              className="w-full h-auto max-h-[240px] object-contain"
              priority
              unoptimized
            />
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
          <div className="py-3">
            <h2 className="text-base font-semibold text-slate-800">{data.event.name}</h2>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6">
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-6 sm:px-10 py-6 border-b border-slate-100">
            <h2 className="text-2xl font-bold text-slate-900">Speaker Agreement</h2>
            <p className="text-sm text-slate-500 mt-1">
              Please review the agreement below and confirm your acceptance to continue as a speaker at this event.
            </p>
          </div>

          <div className="p-6 sm:px-10 space-y-6">
            {/* Speaker Info (read-only) */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Speaker</p>
              <p className="text-sm font-medium text-slate-900">
                {[data.speaker.title, data.speaker.firstName, data.speaker.lastName].filter(Boolean).join(" ")}
              </p>
              <p className="text-sm text-slate-500">{data.speaker.email}</p>
            </div>

            {isAccepted ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
                <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
                  <CheckCircle className="h-6 w-6 text-emerald-600" />
                </div>
                <h3 className="text-lg font-semibold text-emerald-900 mb-1">Agreement Accepted</h3>
                <p className="text-sm text-emerald-700">
                  Thank you! Your speaker agreement has been recorded.
                  {data.acceptedAt && (
                    <>
                      {" "}Accepted on {new Date(data.acceptedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.
                    </>
                  )}
                </p>
              </div>
            ) : (
              <>
                {/* Agreement Text */}
                <div>
                  <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-3">
                    Agreement Terms
                  </h3>
                  <div
                    className="prose prose-sm max-w-none max-h-[420px] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/50 p-5 text-slate-700 [&>*]:mb-3 [&>p:last-child]:mb-0"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.agreementHtml) }}
                  />
                </div>

                {/* Accept Checkbox */}
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <label htmlFor="accept-agreement" className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      id="accept-agreement"
                      checked={accepted}
                      onCheckedChange={(checked) => setAccepted(checked === true)}
                      className="mt-0.5"
                    />
                    <Label htmlFor="accept-agreement" className="text-sm text-slate-700 leading-relaxed cursor-pointer">
                      I have read and agree to the Speaker Agreement for <strong>{data.event.name}</strong>.
                      <span className="text-red-500 ml-0.5">*</span>
                    </Label>
                  </label>
                </div>

                {/* Submit */}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="lg"
                    disabled={!accepted || submitting}
                    onClick={handleSubmit}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      "Accept Agreement"
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SpeakerAgreementPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white flex items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      }
    >
      <SpeakerAgreementContent />
    </Suspense>
  );
}
