"use client";

/**
 * Dedicated contact page — /crm/contacts/[crmContactId].
 *
 * The detail lives in ContactDetailBody (fetches by id + guards loading/not-found);
 * this page adds the back link and returns to the list after archiving.
 */
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { ContactDetailBody } from "@/crm/components/contact-detail-body";

export default function CrmContactPage() {
  const params = useParams();
  const crmContactId = Array.isArray(params.crmContactId) ? params.crmContactId[0] : (params.crmContactId ?? "");
  const router = useRouter();
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/crm/contacts">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to contacts
        </Link>
      </Button>

      <ContactDetailBody
        crmContactId={crmContactId}
        canWrite={canWrite}
        onArchived={() => router.push("/crm/contacts")}
      />
    </div>
  );
}
