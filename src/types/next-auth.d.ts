import { DefaultSession, DefaultUser } from "next-auth";
import { DefaultJWT } from "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      organizationId?: string | null;
      organizationName?: string | null;
      firstName: string;
      lastName: string;
      /** Explicit per-person HR grant. See User.hrAccess in the schema. */
      hrAccess?: boolean;
      /** Budget & Procurement grants (see User.procurement* in the schema). */
      procurementRequest?: boolean;
      procurementApproveCeilingAed?: number | null;
      procurementApproveUnlimited?: boolean;
      procurementSettle?: boolean;
      /** Permission keys from this person's custom roles, the union across all of them, resolved per request on the server (never in the cookie). */
      procurementPermissions?: string[];
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    role?: string;
    /** Session revocation counter — see User.tokenVersion in the schema. */
    tokenVersion?: number;
    organizationId?: string | null;
    organizationName?: string | null;
    firstName?: string;
    lastName?: string;
    hrAccess?: boolean;
    /** Budget & Procurement grants (see User.procurement* in the schema). */
    procurementRequest?: boolean;
    procurementApproveCeilingAed?: number | null;
    procurementApproveUnlimited?: boolean;
    procurementSettle?: boolean;
    /** This person's live custom roles as [id, version], read at sign-in (keys are resolved per request). */
    heldRoles?: ReadonlyArray<readonly [string, number]>;
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
    firstName?: string;
    lastName?: string;
    /**
     * Explicit per-person HR grant, refreshed on the same re-validation pass as
     * `role`. Unlike `tokenVersion` this IS exposed on Session, because the
     * sidebar and the middleware both have to decide whether to show HR.
     */
    hrAccess?: boolean;
    /** Budget & Procurement grants (see User.procurement* in the schema). */
    procurementRequest?: boolean;
    procurementApproveCeilingAed?: number | null;
    procurementApproveUnlimited?: boolean;
    procurementSettle?: boolean;
    /**
     * This person's live custom roles as [id, version], refreshed with the
     * role. The KEYS are not in the cookie (custom roles Phase 1 slice 3): the
     * Node session callback resolves them into `session.user.procurementPermissions`.
     */
    heldRoles?: ReadonlyArray<readonly [string, number]>;
    /** Carried by cookies issued before Oct 1, 2026; deleted on the next refresh. */
    procurementPermissions?: string[];
  }
}
