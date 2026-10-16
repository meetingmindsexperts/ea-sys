import { GroupRegisterPage } from "./group-register-content";

/**
 * The plain group link: it redirects to the main link's rate (and shows the
 * Stripe return). Group links name their rate: /group/register/<rate>.
 */
export default function PlainGroupRegisterPage() {
  return <GroupRegisterPage rateSlug={null} />;
}
