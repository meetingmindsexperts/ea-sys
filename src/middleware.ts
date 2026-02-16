import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth.config";

// Use the Edge-compatible auth config (no Node.js modules like bcrypt, prisma)
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const role = req.auth?.user?.role;
  const isRestricted = role === "REVIEWER" || role === "SUBMITTER";

  if (!isRestricted) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // Block restricted roles from dashboard and settings
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/settings")) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/events";
    return NextResponse.redirect(redirectUrl);
  }

  // Block restricted roles from creating new events
  if (pathname === "/events/new") {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/events";
    return NextResponse.redirect(redirectUrl);
  }

  const eventPath = pathname.match(/^\/events\/[^/]+(?:\/(.*))?$/);

  if (!eventPath) {
    return NextResponse.next();
  }

  const eventSubPath = eventPath[1] ?? "";
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
