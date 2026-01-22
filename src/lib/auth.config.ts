import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export default {
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
          where: { email: validated.data.email },
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
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnDashboard = nextUrl.pathname.startsWith("/dashboard");
      const isOnEvents = nextUrl.pathname.startsWith("/events");
      const isOnSettings = nextUrl.pathname.startsWith("/settings");

      if (isOnDashboard || isOnEvents || isOnSettings) {
        if (isLoggedIn) return true;
        return false;
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
