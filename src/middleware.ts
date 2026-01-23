import NextAuth from "next-auth";
import authConfig from "@/lib/auth.config";

// Use the Edge-compatible auth config (no Node.js modules like bcrypt, prisma)
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
