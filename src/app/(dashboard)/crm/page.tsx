"use client";

/**
 * /crm is the sidebar's single entry point. It used to redirect straight to the
 * board; now it lands on an action-oriented Home — "what needs me today" — so a rep
 * opening the CRM sees their follow-ups and slipping deals first, not a raw pipeline.
 * The board is one tab click away.
 */
import { CrmOverview } from "@/crm/components/crm-overview";

export default function CrmHomePage() {
  return <CrmOverview />;
}
