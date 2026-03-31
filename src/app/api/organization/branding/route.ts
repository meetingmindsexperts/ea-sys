import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.organizationId) {
      return NextResponse.json({ name: null, logo: null, primaryColor: null });
    }

    const org = await db.organization.findUnique({
      where: { id: session.user.organizationId },
      select: { name: true, logo: true, primaryColor: true },
    });

    return NextResponse.json({
      name: org?.name ?? null,
      logo: org?.logo ?? null,
      primaryColor: org?.primaryColor ?? null,
    });
  } catch {
    return NextResponse.json({ name: null, logo: null, primaryColor: null });
  }
}
