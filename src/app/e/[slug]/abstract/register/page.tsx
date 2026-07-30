"use client";

import { SubmitterRegisterPage } from "@/components/public/submitter-register";

/** Abstract-submitter registration — thin wrapper over the shared submitter
 *  register page (one implementation for abstracts + session proposals). */
export default function AbstractRegisterPage() {
  return <SubmitterRegisterPage variant="abstract" />;
}
