import { redirect } from "next/navigation";

// Account sign-up lives at /signup since Nov 5, 2026 (docs/ACCOUNT_CONFIRMATION_PLAN.md
// phase 2); this older address goes there. Staff accounts are still made only
// by invitation (Settings, Users).
export default function RegisterPage() {
  redirect("/signup");
}
