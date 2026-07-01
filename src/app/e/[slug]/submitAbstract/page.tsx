import { redirect } from "next/navigation";

/**
 * Legacy route → redirects to the canonical abstract-submission flow.
 *
 * `/submitAbstract` was the ORIGINAL public abstract form (Feb 2026). It was
 * superseded in Mar 2026 by the 2-step `/e/[slug]/abstract/register` flow, which
 * everything now links to (the Abstract Submission URL widget, the content page,
 * the register page, the event login). Nothing links here anymore, but it had
 * to be kept in sync with the canonical form (schema drift risk — see the M2
 * finding in docs/ERRORS_AND_FIXES.md §12).
 *
 * Kept as a permanent redirect (not deleted) so any old bookmark or emailed link
 * still lands on the live form instead of a 404.
 */
export default async function SubmitAbstractRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/e/${slug}/abstract/register`);
}
