import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth.config";

// Use the Edge-compatible auth config (no Node.js modules like bcrypt, prisma)
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isReviewer = req.auth?.user?.role === "REVIEWER";

  if (!isReviewer) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  const reviewerEventPath = pathname.match(/^\/events\/[^/]+(?:\/(.*))?$/);

  if (!reviewerEventPath) {
    return NextResponse.next();
  }

  const eventSubPath = reviewerEventPath[1] ?? "";
  const isAbstractsPath = eventSubPath === "abstracts" || eventSubPath.startsWith("abstracts/");

  if (isAbstractsPath) {
    return NextResponse.next();
  }

  const redirectUrl = req.nextUrl.clone();
  redirectUrl.pathname = `${pathname.split("/").slice(0, 3).join("/")}/abstracts`;

  return NextResponse.redirect(redirectUrl);
});

export const config = {
  matcher: [
    /*
     * Only run middleware on dashboard routes where reviewer
     * access restriction applies. Skips public pages (/e/*),
     * API routes, auth pages, and static assets.
     */
    "/events/:path*",
    "/dashboard/:path*",
    "/settings/:path*",
  ],
};
