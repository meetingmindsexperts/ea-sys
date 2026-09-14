"use client";
/** /procurement/requests/new: the form, for the request grant; saving a draft lands on the request's page. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { canRequestProcurement } from "@/lib/procurement-visibility";
import { SpendRequestForm } from "@/procurement/components/spend-request-form";
import { ErrorState } from "@/procurement/components/budget-ui";
import { ArrowLeft, FileText } from "lucide-react";

export default function NewSpendRequestPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  if (status !== "loading" && !canRequestProcurement(session?.user)) {
    return <ErrorState title="You cannot raise a spend request" message="Raising one needs the Request grant, set per person under Settings, Users." backHref="/procurement/requests" backLabel="Spend requests" />;
  }
  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement/requests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Spend requests
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight"><FileText className="h-6 w-6 text-primary" /> New spend request</h1>
        <p className="mt-1 text-sm text-muted-foreground">Save it as a draft, attach at least one quote on the next page, then submit. The side panel shows what the line has left and where the request would go.</p>
      </div>
      <SpendRequestForm onSaved={(r) => router.push(`/procurement/requests/${r.id}`)} onCancel={() => router.push("/procurement/requests")} />
    </div>
  );
}
