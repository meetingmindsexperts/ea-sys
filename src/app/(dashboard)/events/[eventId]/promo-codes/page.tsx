import { redirect } from "next/navigation";

// Promo Codes moved into the Registration Types page as a tab.
// Kept as a redirect so existing bookmarks / MCP-generated links still work.
export default async function PromoCodesRedirectPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/tickets?tab=promos`);
}
