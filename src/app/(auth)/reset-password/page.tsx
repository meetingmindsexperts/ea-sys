import { ResetPasswordContent } from "./reset-password-content";

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string; email?: string }>;
};

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token, email } = await searchParams;

  return <ResetPasswordContent token={token} email={email} />;
}
