import { redirect } from "next/navigation";

export default function AuthProfileRedirect() {
  redirect("/profile");
}
