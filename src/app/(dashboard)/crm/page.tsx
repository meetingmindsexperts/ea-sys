import { redirect } from "next/navigation";

/**
 * /crm is the sidebar's single entry point. The board is the thing you actually
 * came to look at, so land there rather than on an index page that only exists to
 * be clicked through.
 */
export default function CrmIndexPage() {
  redirect("/crm/deals");
}
