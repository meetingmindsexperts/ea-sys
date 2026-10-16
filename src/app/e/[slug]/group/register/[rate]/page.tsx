import { GroupRegisterPage } from "../group-register-content";
import { registerTierSlug } from "@/lib/main-register-tiers";

/** A group link for one rate, e.g. /e/<slug>/group/register/early-bird. */
export default async function GroupRegisterAtRatePage({ params }: { params: Promise<{ rate: string }> }) {
  const { rate } = await params;
  return <GroupRegisterPage rateSlug={registerTierSlug(decodeURIComponent(rate))} />;
}
