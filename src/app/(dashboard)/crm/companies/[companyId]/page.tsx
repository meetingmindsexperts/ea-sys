"use client";

/**
 * Dedicated account page — /crm/companies/[companyId].
 *
 * A company (account) is its own record with its own URL. The detail lives in
 * CompanyDetailBody (which fetches by id + guards loading/not-found); this page adds
 * the back link and sends you to the list after archiving.
 */
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { CompanyDetailBody } from "@/crm/components/company-detail-body";

export default function CrmCompanyPage() {
  const params = useParams();
  const companyId = Array.isArray(params.companyId) ? params.companyId[0] : (params.companyId ?? "");
  const router = useRouter();
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/crm/companies">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to accounts
        </Link>
      </Button>

      <CompanyDetailBody
        companyId={companyId}
        canWrite={canWrite}
        onArchived={() => router.push("/crm/companies")}
      />
    </div>
  );
}
