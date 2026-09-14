/**
 * SERVER-SIDE GATE ON EVERY /procurement PAGE, the HR layout's two answers:
 *   - MODULE OFF -> notFound(): a module that is not on this deployment does
 *     not announce that it exists (the API answers 404 in the same case);
 *   - MODULE ON, WRONG PERSON -> a refusal that says what to do next.
 * `/procurement` is deliberately absent from the middleware matcher, so this
 * file is the page-level gate; every /api/procurement route refuses on its
 * own regardless.
 */
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isProcurementModuleEnabled } from "@/lib/module-flags";
import { canViewProcurement } from "@/lib/procurement-visibility";
import { ShieldAlert } from "lucide-react";

export default async function ProcurementLayout({ children }: { children: React.ReactNode }) {
  if (!isProcurementModuleEnabled()) notFound();

  const session = await auth();
  if (!canViewProcurement(session?.user)) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center dark:border-amber-900 dark:bg-amber-950">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-700 dark:text-amber-400" />
        <h2 className="font-semibold text-amber-900 dark:text-amber-100">You do not have access to Budget &amp; Procurement</h2>
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
          Org staff can read budgets. Requesting, approving and settling are granted to one person at a
          time; if you need one of those, ask a super admin to set it under Settings, Users.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
