import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import authConfig from "./auth.config";

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  adapter: PrismaAdapter(db) as ReturnType<typeof PrismaAdapter>,
  session: { strategy: "jwt" },
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      // For credentials provider, verify password
      if (account?.provider === "credentials") {
        const credentials = user as { email: string; password: string };
        const dbUser = await db.user.findUnique({
          where: { email: credentials.email },
        });

        if (!dbUser) return false;

        const isValidPassword = await bcrypt.compare(
          credentials.password,
          dbUser.passwordHash
        );

        if (!isValidPassword) return false;

        // Update user object with actual user data
        user.id = dbUser.id;
        user.email = dbUser.email;
        user.name = `${dbUser.firstName} ${dbUser.lastName}`;
      }

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        const dbUser = await db.user.findUnique({
          where: { email: user.email! },
          include: { organization: true },
        });

        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.organizationId = dbUser.organizationId;
          token.organizationName = dbUser.organization.name;
          token.firstName = dbUser.firstName;
          token.lastName = dbUser.lastName;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.organizationId = token.organizationId as string;
        session.user.organizationName = token.organizationName as string;
        session.user.firstName = token.firstName as string;
        session.user.lastName = token.lastName as string;
      }
      return session;
    },
  },
});
