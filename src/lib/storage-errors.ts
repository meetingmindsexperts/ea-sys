/**
 * Storage failure types, in a leaf module.
 *
 * These live apart from `storage.ts` so that `api-errors.ts` (imported by
 * almost every route) can map a storage failure to a response without
 * transitively pulling in the Supabase client that `storage.ts` imports.
 *
 * `storage.ts` re-exports both, so `import { StorageError } from "@/lib/storage"`
 * keeps working and callers do not have to know this split exists.
 */

/**
 * Why a read was refused.
 *
 * These stay distinguishable because they mean different things to whoever
 * reads /logs: a traversal attempt is a security event, a missing file is an
 * operational one (commonly "uploaded on another machine under local
 * storage"), and a prefix rejection means a stored path escaped the root its
 * own route declared. Collapsing them into one error would make the first
 * invisible.
 *
 * All three map to the same 404 on the wire, so the distinction is for us and
 * never an existence oracle for a caller.
 */
export type StorageFailureReason =
  | "prefix-rejected"
  | "not-found"
  | "traversal-blocked";

export class StorageError extends Error {
  constructor(
    public readonly reason: StorageFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
