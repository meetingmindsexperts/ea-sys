import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function RegisterRedirectPage({ params }: Props) {
  const { slug } = await params;
  redirect(`/e/${slug}/submitAbstract`);
}
