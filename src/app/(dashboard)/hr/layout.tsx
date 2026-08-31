/**
 * SERVER-SIDE GATE ON EVERY /hr PAGE.
 *
 * `module-flags.ts` claimed "src/proxy.ts redirects /hr* when off". It does
 * not, and never did: `/hr` is deliberately absent from the middleware matcher
 * (adding it would collide with the HR_USER rule, which redirects TO /hr and
 * would loop). So until this file existed there was no page-level gate at all
 * and any signed-in role could render the HR shells. Not a leak, because every
 * route under /api/hr refuses, but the pages were an unnecessary surface and
 * the claimed defence was fiction. A comment that describes a control which is
 * not there is worse than no comment: it stops the next person looking.
 *
 * Two answers, matching `denyNonHr` exactly rather than inventing a third
 * policy:
 *
 *   - MODULE OFF -> notFound(). A module that is not available on this
 *     deployment should not announce that it exists, which is why the API
 *     returns 404 and not 403 in the same case.
 *   - MODULE ON, WRONG PERSON -> a refusal that says what to do next. Once we
 *     have admitted the module is here, "Forbidden" is accurate and useless;
 *     the person needs to know it is granted per person and who grants it.
 */

import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isHrModuleEnabled } from "@/lib/module-flags";
import { canViewHr } from "@/hr/lib/hr-visibility";
import { ShieldAlert } from "lucide-react";

export default async function HrLayout({ children }: { children: React.ReactNode }) {
  if (!isHrModuleEnabled()) notFound();

  const session = await auth();
  if (!canViewHr(session?.user)) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center dark:border-amber-900 dark:bg-amber-950">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-700 dark:text-amber-400" />
        <h2 className="font-semibold text-amber-900 dark:text-amber-100">
          You do not have access to HR
        </h2>
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
          HR is granted to one person at a time rather than by job title, because it holds
          attendance and sick-leave records. If you need it, ask a super admin to turn it on
          for you under Settings, Users.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
