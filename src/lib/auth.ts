import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { authLogger } from "@/lib/logger";
import authConfig from "./auth.config";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  adapter: PrismaAdapter(db) as ReturnType<typeof PrismaAdapter>,
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 24 hours — forces re-authentication daily
  },
  // Trust the host header from Vercel/proxies
  trustHost: true,
  pages: authConfig.pages,
  // Override providers with full implementation (Node.js runtime)
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const validated = loginSchema.safeParse(credentials);
        if (!validated.success) return null;

        // Find user in database
        const user = await db.user.findUnique({
          where: { email: validated.data.email.toLowerCase() },
          select: {
            id: true,
            email: true,
            passwordHash: true,
            firstName: true,
            lastName: true,
            role: true,
            organizationId: true,
            organization: {
              select: { name: true, logo: true, primaryColor: true },
            },
          },
        });

        if (!user || !user.passwordHash) return null;

        // Verify password
        const isValidPassword = await bcrypt.compare(
          validated.data.password,
          user.passwordHash
        );

        if (!isValidPassword) return null;

        // Return user object with required id
        return {
          id: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          organizationId: user.organizationId ?? null,
          organizationName: user.organization?.name ?? null,
          organizationLogo: user.organization?.logo ?? null,
          organizationPrimaryColor: user.organization?.primaryColor ?? null,
          firstName: user.firstName,
          lastName: user.lastName,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn() {
      return true;
    },
    async jwt({ token, user, trigger }) {
      // On sign in, populate token from user object
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.organizationId = user.organizationId ?? null;
        token.organizationName = user.organizationName ?? null;
        token.organizationLogo = user.organizationLogo ?? null;
        token.organizationPrimaryColor = user.organizationPrimaryColor ?? null;
        token.firstName = user.firstName;
        token.lastName = user.lastName;
        token.roleCheckedAt = Date.now();
      }

      // On explicit session update (e.g., after org settings change), refetch data
      if (trigger === "update" && token.id) {
        const dbUser = await db.user.findUnique({
          where: { id: token.id as string },
          include: { organization: { select: { name: true, logo: true, primaryColor: true } } },
        });
        if (dbUser) {
          token.organizationName = dbUser.organization?.name ?? null;
          token.organizationLogo = dbUser.organization?.logo ?? null;
          token.organizationPrimaryColor = dbUser.organization?.primaryColor ?? null;
          token.firstName = dbUser.firstName;
          token.lastName = dbUser.lastName;
          token.role = dbUser.role;
          token.roleCheckedAt = Date.now();
        }
      }

      // ── Periodic role re-validation (every 5 minutes) ──
      // Prevents stale JWT tokens retaining old roles after admin changes.
      // Lightweight query: selects only `role` by primary key.
      const ROLE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
      const lastChecked = (token.roleCheckedAt as number) || 0;
      if (token.id && Date.now() - lastChecked > ROLE_CHECK_INTERVAL) {
        try {
          const dbUser = await db.user.findUnique({
            where: { id: token.id as string },
            select: { role: true },
          });
          if (dbUser) {
            token.role = dbUser.role;
          }
          token.roleCheckedAt = Date.now();
        } catch (error) {
          authLogger.warn({ err: error, msg: "Role re-validation DB error, continuing with cached role", userId: token.id });
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.organizationId = (token.organizationId as string) ?? null;
        session.user.organizationName = (token.organizationName as string) ?? null;
        session.user.organizationLogo = (token.organizationLogo as string) ?? null;
        session.user.organizationPrimaryColor = (token.organizationPrimaryColor as string) ?? null;
        session.user.firstName = token.firstName as string;
        session.user.lastName = token.lastName as string;
      }
      return session;
    },
  },
});
