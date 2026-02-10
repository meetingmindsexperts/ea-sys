"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Calendar, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Banner Image */}
      {branding?.bannerImage && (
        <div className="w-full">
          <img
            src={branding.bannerImage}
            alt="Event banner"
            className="w-full h-32 md:h-48 object-cover"
          />
        </div>
      )}

      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <CardTitle className="text-2xl">Registration Confirmed!</CardTitle>
            <CardDescription>
              {firstName
                ? `Thank you, ${firstName}! Your registration is complete.`
                : "Your registration is complete."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {registrationId && (
              <div className="bg-gray-50 p-4 rounded-lg text-center">
                <p className="text-sm text-muted-foreground mb-1">
                  Confirmation Number
                </p>
                <p className="font-mono font-semibold text-lg">{registrationId}</p>
              </div>
            )}

            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
                <Calendar className="h-5 w-5 text-blue-600 mt-0.5" />
                <div>
                  <p className="font-medium text-blue-900">Check your email</p>
                  <p className="text-blue-700">
                    We&apos;ve sent a confirmation email with your registration details
                    and QR code.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-4 space-y-3">
              <Link href={`/e/${slug}`} className="block">
                <Button variant="outline" className="w-full">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Event
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
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
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <Card className="w-full max-w-md">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Loading...</p>
            </CardContent>
          </Card>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}
