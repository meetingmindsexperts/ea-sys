"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

// Public registration is disabled - single organization mode
// Users must be invited by an admin to join
// To enable multi-org registration later, restore the original register page

export default function RegisterPage() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to login - public registration is disabled
    router.replace("/login");
  }, [router]);

  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin" />
      </CardContent>
    </Card>
  );
}
