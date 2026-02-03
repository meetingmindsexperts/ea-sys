"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
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

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const registrationId = searchParams.get("id");
  const firstName = searchParams.get("name");

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
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
                  We've sent a confirmation email with your ticket details and QR
                  code.
                </p>
              </div>
            </div>
          </div>

          <div className="pt-4 space-y-3">
            <Link href="/" className="block">
              <Button variant="outline" className="w-full">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Home
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
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
