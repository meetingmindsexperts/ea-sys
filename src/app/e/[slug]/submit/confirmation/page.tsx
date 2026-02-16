"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Mail } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function AbstractConfirmationPage() {
  const params = useParams();
  const slug = params.slug as string;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 rounded-full bg-green-100 p-3 w-fit">
            <CheckCircle2 className="h-8 w-8 text-green-600" />
          </div>
          <CardTitle className="text-2xl">Abstract Submitted!</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <p className="text-muted-foreground">
            Your abstract has been successfully submitted for review.
          </p>

          <div className="flex items-center gap-3 bg-blue-50 text-blue-800 p-4 rounded-lg text-sm text-left">
            <Mail className="h-5 w-5 flex-shrink-0" />
            <p>
              We&apos;ve sent you an email with a link to track your submission status,
              make edits, and view reviewer feedback. Please check your inbox.
            </p>
          </div>

          <div className="pt-4">
            <Link href={`/e/${slug}`}>
              <Button variant="outline">Back to Event Page</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
