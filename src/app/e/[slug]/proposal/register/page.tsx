"use client";

import { SubmitterRegisterPage } from "@/components/public/submitter-register";

/** Session-proposal proposer registration — thin wrapper over the shared
 *  submitter register page (one implementation for abstracts + proposals).
 *  Same SUBMITTER account either way; only copy, welcome text, and the
 *  post-login destination differ. */
export default function ProposalRegisterPage() {
  return <SubmitterRegisterPage variant="proposal" />;
}
