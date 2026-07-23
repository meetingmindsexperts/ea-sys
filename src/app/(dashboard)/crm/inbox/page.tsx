import { Suspense } from "react";
import { CrmInbox } from "@/crm/components/crm-inbox";

/**
 * /crm/inbox — the shared CRM email inbox (staff-only; the API routes enforce
 * canViewCrmInbox, the layout hides the tab for MEMBER).
 */
export default function CrmInboxPage() {
  return (
    <div className="p-6">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-lg border bg-muted/30" />}>
        <CrmInbox />
      </Suspense>
    </div>
  );
}
