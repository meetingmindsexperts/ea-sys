import { DefaultSession, DefaultUser } from "next-auth";
import { DefaultJWT } from "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      organizationId?: string | null;
      organizationName?: string | null;
      organizationLogo?: string | null;
      organizationPrimaryColor?: string | null;
      firstName: string;
      lastName: string;
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    role?: string;
    /** Session revocation counter — see User.tokenVersion in the schema. */
    tokenVersion?: number;
    organizationId?: string | null;
    organizationName?: string | null;
    organizationLogo?: string | null;
    organizationPrimaryColor?: string | null;
    firstName?: string;
    lastName?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id?: string;
    role?: string;
    /**
     * Session revocation counter, stamped at sign-in and compared on the
     * periodic re-validation. Optional because tokens issued before this
     * shipped carry no claim; readers treat a missing value as 0.
     * Deliberately NOT exposed on `Session` — it is an internal auth
     * mechanism, not something a page should read.
     */
    tokenVersion?: number;
    organizationId?: string | null;
    organizationName?: string | null;
    organizationLogo?: string | null;
    organizationPrimaryColor?: string | null;
    firstName?: string;
    lastName?: string;
  }
}
